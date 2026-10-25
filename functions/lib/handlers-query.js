/**
 * Query, stats, and journey link handlers.
 */
const { randomUUID } = require('crypto');
const {
  sendSmsReply,
} = require('./twilio');
const {
  getActiveTrip,
  getUserProfile,
  isEmailAdmin,
  db,
  isGeminiRateLimited,
  getRecentCompletedTrips,
  getConversationHistory,
  saveConversationTurn,
  FieldValue,
  Timestamp,
} = require('./db');
const {
  getRouteDisplay,
  hasPremiumAccess,
} = require('./utils');
const text = require('./sms-text');
const {
  aggregateTripStats,
  answerQueryWithGemini,
  lookupAgencyTimezone,
} = require('./gemini');

/**
 * Handle natural-language query (premium feature)
 */
async function handleQuery(phoneNumber, user, question, traceId = null) {
  const profile = await getUserProfile(user.userId);
  const isAdmin = await isEmailAdmin(user.email);
  if (!hasPremiumAccess(profile, isAdmin)) {
    await sendSmsReply(phoneNumber, text.ASK_PREMIUM_ONLY);
    return;
  }

  if (!question) {
    await sendSmsReply(phoneNumber, text.ASK_HELP);
    return;
  }

  const [snapshot, conversationHistory] = await Promise.all([
    db.collection('trips')
      .where('userId', '==', user.userId)
      .where('endTime', '!=', null)
      .orderBy('endTime', 'desc')
      .limit(200).get(),
    getConversationHistory(user.userId),
  ]);

  const trips = snapshot.docs.map((d) => d.data());

  if (trips.length === 0) {
    await sendSmsReply(phoneNumber, text.NO_COMPLETED_TRIPS);
    return;
  }

  const recentAgency = trips[0]?.agency || null;
  const timezone = await lookupAgencyTimezone(recentAgency, traceId);
  const stats = aggregateTripStats(trips, timezone);
  if (await isGeminiRateLimited(phoneNumber, !!profile?.isPremium, isAdmin)) {
    await sendSmsReply(phoneNumber, text.AI_LIMIT_REACHED);
    return;
  }
  const answer = await answerQueryWithGemini(
    user.userId,
    question,
    trips,
    stats,
    conversationHistory,
    timezone,
    traceId
  );
  await sendSmsReply(phoneNumber, answer);

  // Fire-and-forget — never block or fail the reply
  saveConversationTurn(user.userId, question, answer)
    .catch((err) => console.error('saveConversationTurn failed:', err));
  db.collection('queryLogs').add({
    userId: user.userId,
    question,
    answer,
    tripWindowSize: trips.length,
    timestamp: FieldValue.serverTimestamp(),
    source: 'sms',
  }).catch((err) => console.error('queryLogs write failed:', err));
}

/**
 * Handle STATS command
 */
async function handleStatsCommand(phoneNumber, user, traceId = null) {
  const now = new Date();

  // Windows
  const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const fourteenDaysAgo = new Date(now); fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const sixtyDaysAgo = new Date(now); sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  const snapshot = await db.collection('trips')
    .where('userId', '==', user.userId)
    .where('startTime', '>=', Timestamp.fromDate(sixtyDaysAgo))
    .get();

  const toDate = (t) => t.startTime?.toDate ? t.startTime.toDate() : new Date(t.startTime);
  const allTrips = snapshot.docs.map((d) => d.data()).filter((t) => t.endStopName != null || t.endStopCode != null);

  // Filter buckets
  const thisWeek = allTrips.filter((t) => toDate(t) >= sevenDaysAgo);
  const lastWeek = allTrips.filter((t) => {
    const d = toDate(t);
    return d >= fourteenDaysAgo && d < sevenDaysAgo;
  });
  const last30 = allTrips.filter((t) => toDate(t) >= thirtyDaysAgo);
  const prev30 = allTrips.filter((t) => {
    const d = toDate(t);
    return d >= sixtyDaysAgo && d < thirtyDaysAgo;
  });

  if (allTrips.length === 0) {
    await sendSmsReply(phoneNumber, text.NO_RECENT_TRIPS);
    return;
  }

  const profile = await getUserProfile(user.userId);
  const isAdmin = await isEmailAdmin(user.email);
  const canSeeTrends = hasPremiumAccess(profile, isAdmin);

  // Percent change, or null when the trend is not shown.
  const getTrendPct = (current, previous) => {
    if (!canSeeTrends || previous === 0) return null;
    return Math.round(((current - previous) / previous) * 100);
  };

  const totalMin30 = last30.reduce((sum, t) => sum + (t.duration || 0), 0);
  const uniqueRoutes30 = new Set(last30.map((t) => t.route).filter(Boolean)).size;

  // Top route in the last 30 days
  const routeCounts30 = {};
  for (const t of last30) {
    if (t.route) routeCounts30[t.route] = (routeCounts30[t.route] || 0) + 1;
  }
  const topRoute = Object.entries(routeCounts30).sort((a, b) => b[1] - a[1])[0];

  await sendSmsReply(phoneNumber, text.statsSummary({
    weekCount: thisWeek.length,
    weekTrendPct: getTrendPct(thisWeek.length, lastWeek.length),
    monthCount: last30.length,
    monthTrendPct: getTrendPct(last30.length, prev30.length),
    routeCount: uniqueRoutes30,
    totalMinutes: totalMin30,
    topRoute,
  }));
}

/**
 * Handle LINK command — join the most recent pair of consecutive trips as a journey.
 *
 * Case A (active trip exists): links the last completed trip → current active trip.
 * Case B (no active trip): links the last two completed trips.
 *
 * A journeyId (UUID) is shared across all legs. If either trip already belongs to a
 * journey, that ID is reused so the journey can grow leg by leg.
 * Only trips within a 60-minute gap are eligible.
 */
async function handleJourneyLink(phoneNumber, user) {
  const [activeTrip, history] = await Promise.all([
    getActiveTrip(user.userId),
    getRecentCompletedTrips(user.userId, 2),
  ]);

  let earlierTrip, laterTrip;

  if (activeTrip && history.length >= 1) {
    // Case A: last completed trip → active trip
    earlierTrip = history[0];
    laterTrip = activeTrip;
  } else if (!activeTrip && history.length >= 2) {
    // Case B: second-to-last completed → last completed
    earlierTrip = history[1]; // older (lower endTime)
    laterTrip = history[0];   // newer
  } else {
    await sendSmsReply(phoneNumber, text.NOT_ENOUGH_TRIPS_TO_LINK);
    return;
  }

  // Validate temporal gap
  const earlierEnd = earlierTrip.endTime?.toDate
    ? earlierTrip.endTime.toDate() : new Date(earlierTrip.endTime);
  const laterStart = laterTrip.startTime?.toDate
    ? laterTrip.startTime.toDate() : new Date(laterTrip.startTime);
  const gapMinutes = (laterStart - earlierEnd) / 60000;

  if (gapMinutes < 0) {
    await sendSmsReply(phoneNumber, text.TRIPS_OVERLAP);
    return;
  }
  if (gapMinutes > 60) {
    await sendSmsReply(phoneNumber, text.journeyGapTooLong(gapMinutes));
    return;
  }

  // Reuse an existing journeyId if one leg already belongs to a journey
  const journeyId = earlierTrip.journeyId || laterTrip.journeyId || randomUUID();

  // Guard: already linked together
  if (earlierTrip.journeyId && laterTrip.journeyId && earlierTrip.journeyId === laterTrip.journeyId) {
    await sendSmsReply(phoneNumber, text.ALREADY_LINKED);
    return;
  }

  const batch = db.batch();
  batch.update(db.collection('trips').doc(earlierTrip.id), { journeyId });
  batch.update(db.collection('trips').doc(laterTrip.id), { journeyId });
  await batch.commit();

  await sendSmsReply(
    phoneNumber,
    text.journeyLinked(getRouteDisplay(earlierTrip.route), getRouteDisplay(laterTrip.route), gapMinutes),
  );
}

module.exports = {
  handleQuery,
  handleStatsCommand,
  handleJourneyLink,
};
