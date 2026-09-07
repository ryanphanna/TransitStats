/**
 * Simple SMS command handlers.
 */
const {
  sendSmsReply,
} = require('./twilio');
const {
  getActiveTrip,
  getRecentCompletedTrips,
  clearPendingState,
  consumeQuickLinkCode,
  getUserByPhone,
  getUserProfile,
  isEmailAdmin,
  db,
  FieldValue,
} = require('./db');
const {
  getStopDisplay,
  getRouteDisplay,
  normalizeAgency,
  hasPremiumAccess,
} = require('./utils');
const { getConfiguredPrimaryAgency } = require('./primary-agency');
const { KNOWN_AGENCIES } = require('./constants');
const {
  lookupAgencyTimezone,
} = require('./gemini');

/**
 * Handle HELP command
 */
async function handleHelp(phoneNumber, traceId = null) {
  const user = await getUserByPhone(phoneNumber);
  const profile = user ? await getUserProfile(user.userId) : null;
  const isAdmin = user ? await isEmailAdmin(user.email) : false;

  const commands = [
    'STATUS - view active trip',
    'STATS - your last 30 days',
    'FORGOT - forgot to end a trip',
    'DISCARD - didn\'t board, delete the trip',
    'UNLINK - separate a linked journey',
    'SETTINGS - view/change settings',
  ];
  if (hasPremiumAccess(profile, isAdmin)) commands.push('ASK [question] - AI stats');

  await sendSmsReply(phoneNumber,
    `TransitStats

To start a trip, send:

ROUTE STOP DIRECTION
or on separate lines:
ROUTE
STOP
DIRECTION (optional)
AGENCY (optional)

To end a trip, send:
END
STOP
NOTES (optional)

Commands:
${commands.join('\n')}`,
  );
}

/**
 * Handle STATUS command
 */
async function handleStatus(phoneNumber, user, traceId = null) {
  const activeTrip = await getActiveTrip(user.userId);

  if (!activeTrip) {
    await sendSmsReply(phoneNumber, 'No active trip.');
    return;
  }

  const startTime = activeTrip.startTime.toDate();
  const elapsedMs = Date.now() - startTime.getTime();
  const elapsedMin = Math.round(elapsedMs / 60000);
  const statusTimezone = activeTrip.agency
    ? await lookupAgencyTimezone(activeTrip.agency, traceId)
    : 'America/Toronto';
  const timeStr = startTime.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: statusTimezone || 'America/Toronto',
  });

  const startStopDisplay = getStopDisplay(
    activeTrip.startStopCode,
    activeTrip.startStopName,
    activeTrip.startStop,
  );

  const routeDisplay = getRouteDisplay(activeTrip.route, activeTrip.direction);

  const message = `Active trip:
${routeDisplay} from ${startStopDisplay}
Started ${timeStr} (${elapsedMin} min ago)

END [stop] to finish. FORGOT if you forgot to end. INFO for help.`;

  await sendSmsReply(phoneNumber, message);
}

/**
 * Handle DISCARD command - permanently deletes active trip
 */
async function handleDiscard(phoneNumber, user, traceId = null) {
  const activeTrip = await getActiveTrip(user.userId);

  if (!activeTrip) {
    await sendSmsReply(phoneNumber, 'No active trip.');
    return;
  }

  const routeDisplay = getRouteDisplay(activeTrip.route, activeTrip.direction);

  // If this active trip was linked into a journey, clean up the partner's journeyId
  if (activeTrip.journeyId) {
    const partnerSnap = await db.collection('trips')
      .where('userId', '==', user.userId)
      .where('journeyId', '==', activeTrip.journeyId)
      .get();
    const batch = db.batch();
    partnerSnap.docs.forEach(doc => {
      if (doc.id !== activeTrip.id) {
        batch.update(doc.ref, { journeyId: FieldValue.delete() });
      }
    });
    batch.delete(db.collection('trips').doc(activeTrip.id));
    await batch.commit();
  } else {
    await db.collection('trips').doc(activeTrip.id).delete();
  }
  await clearPendingState(phoneNumber);

  await sendSmsReply(phoneNumber, `Deleted ${routeDisplay}.`);
}

async function handleAddNotes(phoneNumber, user, notes, traceId = null) {
  const cleanNotes = notes?.trim();
  if (!cleanNotes) {
    await sendSmsReply(phoneNumber, 'Send NOTES followed by your note text.');
    return;
  }

  const [latestTrip] = await getRecentCompletedTrips(user.userId, 1);
  if (!latestTrip) {
    await sendSmsReply(phoneNumber, 'No recent completed trip to attach notes to.');
    return;
  }

  await db.collection('trips').doc(latestTrip.id).update({
    notes: cleanNotes,
  });

  const routeDisplay = getRouteDisplay(latestTrip.route, latestTrip.direction);
  await sendSmsReply(phoneNumber, `Added notes to ${routeDisplay}.`);
}

/**
 * Handle UNLINK command - removes journey link from the most recently ended trip
 */
async function handleUnlink(phoneNumber, user, traceId = null) {
  // Find the most recently completed trip with a journeyId
  const snap = await db.collection('trips')
    .where('userId', '==', user.userId)
    .where('endTime', '!=', null)
    .orderBy('endTime', 'desc')
    .limit(10)
    .get();

  const linked = snap.docs.find(d => d.data().journeyId);
  if (!linked) {
    await sendSmsReply(phoneNumber, 'No linked trip to unlink.');
    return;
  }

  const trip = linked.data();
  const journeyId = trip.journeyId;
  const routeDisplay = getRouteDisplay(trip.route, trip.direction);

  // Remove journeyId from all trips sharing this journey
  const journeySnap = await db.collection('trips')
    .where('userId', '==', user.userId)
    .where('journeyId', '==', journeyId)
    .get();

  const batch = db.batch();
  journeySnap.docs.forEach(doc => {
    batch.update(doc.ref, { journeyId: FieldValue.delete() });
  });
  await batch.commit();

  await sendSmsReply(phoneNumber, `Unlinked ${routeDisplay} journey.`);
}

/**
 * Handle FORGOT command - marks end as unknown
 */
async function handleIncomplete(phoneNumber, user, traceId = null) {
  const activeTrip = await getActiveTrip(user.userId);

  if (!activeTrip) {
    await sendSmsReply(phoneNumber, 'No active trip.');
    return;
  }

  const routeDisplay = getRouteDisplay(activeTrip.route, activeTrip.direction);

  await db.collection('trips').doc(activeTrip.id).update({
    incomplete: true,
    endTime: activeTrip.startTime,
    exitLocation: null,
    duration: null,
  });

  await sendSmsReply(phoneNumber, `${routeDisplay} saved as incomplete.`);
}

/**
 * Handle a one-time SMS quick-link code sent from an unregistered phone number
 * (e.g. "Hey TransitStats! 206214" via the tap-to-text button in Settings).
 * The code was generated by the authenticated web app, so a single incoming
 * text both proves the sender and reveals which phone to link — no reply
 * needed from the bot before this can complete.
 * @returns {boolean} true if a matching code was found and the phone was linked
 */
async function handleQuickLinkCode(phoneNumber, code, traceId = null) {
  const data = await consumeQuickLinkCode(code);
  if (!data) return false;

  await db.collection('phoneNumbers').doc(phoneNumber).set({
    userId: data.userId,
    email: data.email,
    registeredAt: FieldValue.serverTimestamp(),
  });

  await sendSmsReply(
    phoneNumber,
    'You\'re all set! Text a route and stop to log a trip, e.g. "504 King West". Text INFO any time for the full command list.'
  );
  return true;
}

/**
 * Handle SETTINGS command — view or change user settings via SMS.
 * SETTINGS → show current settings
 * SETTINGS AGENCY [name] → set a primary agency
 * SETTINGS AGENCY AUTO → detect the agency automatically
 */
async function handleSettings(phoneNumber, user, rawArgs, traceId = null) {
  const profile = await getUserProfile(user.userId);
  const currentAgency = profile?.defaultAgencyMode === 'automatic'
    ? 'Automatic'
    : (getConfiguredPrimaryAgency(profile) || 'Automatic');

  if (!rawArgs) {
    await sendSmsReply(phoneNumber,
      `Settings:\nPrimary agency: ${currentAgency}\n\nTo change: SETTINGS AGENCY [name]\nUse SETTINGS AGENCY AUTO to detect it automatically.\nExample: SETTINGS AGENCY GO Transit`
    );
    return;
  }

  const agencyMatch = rawArgs.match(/^AGENCY\s+(\S.*)$/i);
  if (agencyMatch) {
    if (/^(AUTO|AUTOMATIC)$/i.test(agencyMatch[1].trim())) {
      await db.collection('profiles').doc(user.userId).update({
        defaultAgency: null,
        defaultAgencyMode: 'automatic',
        primaryAgency: null,
      });
      await sendSmsReply(phoneNumber, 'Primary agency set to automatic detection.');
      return;
    }
    const normalized = normalizeAgency(agencyMatch[1].trim());
    const isKnown = KNOWN_AGENCIES.includes(normalized);
    if (!isKnown) {
      await sendSmsReply(phoneNumber,
        `Unknown agency "${agencyMatch[1].trim()}". Try: TTC, GO Transit, MiWay, YRT, OC Transpo, etc.`
      );
      return;
    }
    await db.collection('profiles').doc(user.userId).update({
      defaultAgency: normalized,
      defaultAgencyMode: 'manual',
    });
    await sendSmsReply(phoneNumber, `Primary agency set to ${normalized}.`);
    return;
  }

  await sendSmsReply(phoneNumber, 'Usage: SETTINGS AGENCY [name|AUTO]\nExample: SETTINGS AGENCY GO Transit');
}

module.exports = {
  handleHelp,
  handleStatus,
  handleDiscard,
  handleAddNotes,
  handleUnlink,
  handleIncomplete,
  handleQuickLinkCode,
  handleSettings,
};
