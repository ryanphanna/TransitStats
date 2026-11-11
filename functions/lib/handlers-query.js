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
} = require('./gemini');
const {
  answerQueryWithClaude,
  lookupAgencyTimezone,
  ASK_PRESTO_FIELDS,
} = require('./claude');
const { buildPrestoTrips } = require('./presto-trips');
const { countedTrips } = require('./trip-stats');
const { recentRideStats } = require('./stats-summary');

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
      .orderBy('startTime', 'desc')
      .limit(200).get(),
    getConversationHistory(user.userId),
  ]);

  // The same trips the ASK tools count: every logged trip except one in progress.
  const trips = countedTrips(snapshot.docs.map((d) => d.data()));

  // A rider can have imported rides and no logged trips; the ASK tools count
  // those, so only a rider with neither is told there is nothing to ask about.
  if (trips.length === 0) {
    const imported = await db.collection('prestoTransactions')
      .where('userId', '==', user.userId)
      .select(...ASK_PRESTO_FIELDS).get();
    if (buildPrestoTrips(imported.docs.map((d) => d.data())).length === 0) {
      await sendSmsReply(phoneNumber, text.NO_COMPLETED_TRIPS);
      return;
    }
  }

  const recentAgency = trips[0]?.agency || null;
  const timezone = await lookupAgencyTimezone(recentAgency, traceId);
  const stats = aggregateTripStats(trips, timezone);
  if (await isGeminiRateLimited(phoneNumber, !!profile?.isPremium, isAdmin)) {
    await sendSmsReply(phoneNumber, text.AI_LIMIT_REACHED);
    return;
  }
  const answer = await answerQueryWithClaude(
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
  const sixtyDaysAgo = new Date(now); sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  // Both reads are filtered to this user. Imported PRESTO rides count the same
  // way they do on the dashboard and in ASK.
  const [tripDocs, prestoDocs] = await Promise.all([
    db.collection('trips')
      .where('userId', '==', user.userId)
      .where('startTime', '>=', Timestamp.fromDate(sixtyDaysAgo))
      .get(),
    db.collection('prestoTransactions')
      .where('userId', '==', user.userId)
      .select(...ASK_PRESTO_FIELDS)
      .get(),
  ]);
  const stats = recentRideStats(
    tripDocs.docs.map((d) => d.data()),
    buildPrestoTrips(prestoDocs.docs.map((d) => d.data())),
    now,
  );

  if (stats.total === 0) {
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

  await sendSmsReply(phoneNumber, text.statsSummary({
    weekCount: stats.weekCount,
    weekTrendPct: getTrendPct(stats.weekCount, stats.prevWeekCount),
    monthCount: stats.monthCount,
    monthTrendPct: getTrendPct(stats.monthCount, stats.prevMonthCount),
    routeCount: stats.routeCount,
    totalMinutes: stats.totalMinutes,
    topRoute: stats.topRoute,
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
