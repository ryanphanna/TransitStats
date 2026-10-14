/**
 * Simple SMS command handlers.
 */
const {
  sendSmsReply,
} = require('./twilio');
const {
  getActiveTrip,
  getRecentCompletedTrips,
  setPendingState,
  clearPendingState,
  storeVerificationCode,
  getVerificationData,
  isEmailAllowed,
  getAuthUidByEmail,
  getUserByPhone,
  getUserProfile,
  isEmailAdmin,
  db,
  FieldValue,
  Timestamp,
} = require('./db');
const {
  getStopDisplay,
  getRouteDisplay,
  generateVerificationCode,
  normalizeAgency,
  hasPremiumAccess,
} = require('./utils');
const { getConfiguredPrimaryAgency } = require('./primary-agency');
const { isPhoneConfirmed, UNLOCKED_TEXT, LINKED_NEUTRAL_TEXT } = require('./phone-confirmation');
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
STOP NAME
DIRECTION (optional)
AGENCY (optional)

To end a trip, send:
END
WHERE YOU GOT OFF
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
 * Handle REGISTER command
 */
async function handleRegister(phoneNumber, email, traceId = null) {
  const emailRegex = /^[^\s@]{1,64}@[^\s@.]{1,63}(?:\.[^\s@.]{1,63}){1,10}$/;
  let candidate = email.trim();
  if (!emailRegex.test(candidate)) {
    // Pull an embedded address out of natural replies ("it's foo@bar.com") and out of a
    // redundant "REGISTER foo@bar.com" retry sent while already awaiting an email — both
    // otherwise fail this regex and loop on the same "Invalid email format" reply forever.
    const embedded = candidate.match(/[^\s@]{1,64}@[^\s@.]{1,63}(?:\.[^\s@.]{1,63}){1,10}/);
    if (embedded) candidate = embedded[0];
  }
  if (!emailRegex.test(candidate)) {
    await sendSmsReply(phoneNumber, 'Invalid email format. Text REGISTER [email].');
    return;
  }
  email = candidate;

  const allowed = await isEmailAllowed(email);
  if (!allowed) {
    await sendSmsReply(phoneNumber, 'We couldn\'t find an account for that email. Try the one you signed in with, or visit transitstats.fyi.');
    return;
  }

  const existingUser = await getUserByPhone(phoneNumber);
  if (existingUser) {
    // Only a confirmed number may see which account it belongs to.
    await sendSmsReply(
      phoneNumber,
      isPhoneConfirmed(existingUser) ? `Phone already linked to ${existingUser.email}.` : LINKED_NEUTRAL_TEXT
    );
    return;
  }

  // Check if this phone is locked out from too many failed verification attempts
  const existingVerification = await getVerificationData(phoneNumber);
  if (existingVerification?.lockedUntil && existingVerification.lockedUntil.toDate() > new Date()) {
    const minutesLeft = Math.ceil((existingVerification.lockedUntil.toDate() - new Date()) / 60000);
    await sendSmsReply(phoneNumber, `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`);
    return;
  }

  // Resolve the account through Firebase Auth. The profile `email` field is not
  // trustworthy (clients could write it), so it must never pick the account.
  if (!(await getAuthUidByEmail(email))) {
    await sendSmsReply(phoneNumber, `No account found for ${email}. Sign up at transitstats.fyi, then text REGISTER again.`);
    return;
  }

  const code = generateVerificationCode();
  await storeVerificationCode(phoneNumber, email.toLowerCase(), code, 20 * 60 * 1000);

  try {
    await db.collection('mail').add({
      to: email.toLowerCase(),
      message: {
        subject: 'TransitStats SMS Verification Code',
        text: `Your code is: ${code}\n\nReply to SMS with this code.`,
        html: `<p>Your code is: <strong>${code}</strong></p>`,
      },
    });
  } catch (error) {
    console.error('Error queuing verification email:', error);
  }

  await sendSmsReply(phoneNumber, `Code sent to ${email}. Reply with the 6-digit code within 20 minutes.`);

  await setPendingState(phoneNumber, {
    type: 'awaiting_verification',
    email: email.toLowerCase(),
  }, 20 * 60 * 1000);
}

/**
 * Handle verification code input
 */
async function handleVerificationCode(phoneNumber, code, traceId = null) {
  const verificationRef = db.collection('smsVerification').doc(phoneNumber);

  // Check, count and consume the code in ONE transaction, so parallel guesses
  // can't each see the same attempts value and exceed the 3-attempt limit, and
  // one correct code can't be used twice.
  const result = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(verificationRef);
    if (!snapshot.exists) return { status: 'missing' };
    const data = snapshot.data();
    // An expired code is dropped, but a lockout must run out on its own.
    const isLocked = data.lockedUntil?.toDate && data.lockedUntil.toDate() > new Date();
    if (!isLocked && data.expiresAt?.toDate && data.expiresAt.toDate() < new Date()) {
      transaction.delete(verificationRef);
      return { status: 'missing' };
    }
    if (data.attempts >= 3) {
      transaction.update(verificationRef, {
        lockedUntil: Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
      });
      return { status: 'locked' };
    }
    if (code !== data.code) {
      transaction.update(verificationRef, { attempts: FieldValue.increment(1) });
      return { status: 'invalid' };
    }
    transaction.delete(verificationRef);
    return { status: 'ok', email: data.email };
  });

  if (result.status === 'missing') {
    await sendSmsReply(phoneNumber, 'No pending registration.');
    return;
  }

  if (result.status === 'locked') {
    await clearPendingState(phoneNumber);
    await sendSmsReply(phoneNumber, 'Too many failed attempts. Try again in 10 minutes.');
    return;
  }

  if (result.status === 'invalid') {
    await sendSmsReply(phoneNumber, 'Invalid code.');
    return;
  }

  const verificationData = { email: result.email };

  // An existing link (e.g. from an invite text) is confirmed in place: the code
  // went to that link's own email, so it proves the number. Update just that one
  // field; never rewrite the document, and never resolve the account by email
  // (an invite account's email isn't verified yet).
  const existingLink = await getUserByPhone(phoneNumber);
  if (existingLink) {
    if (String(existingLink.email || '').toLowerCase() !== String(verificationData.email || '').toLowerCase()) {
      await sendSmsReply(phoneNumber, 'Invalid code.');
      return;
    }
    await db.collection('phoneNumbers').doc(phoneNumber).update({ loginConfirmed: true });
    await clearPendingState(phoneNumber);
    await sendSmsReply(phoneNumber, UNLOCKED_TEXT);
    return;
  }

  const userId = await getAuthUidByEmail(verificationData.email);

  if (!userId) {
    await sendSmsReply(phoneNumber, 'Account not found.');
    return;
  }

  await db.collection('phoneNumbers').doc(phoneNumber).set({
    userId,
    email: verificationData.email,
    registeredAt: FieldValue.serverTimestamp(),
    // The code went to the account's own email, so this number is proven.
    loginConfirmed: true,
  });

  await clearPendingState(phoneNumber);

  await sendSmsReply(phoneNumber, `Phone linked! Text "[route] [stop]" to log trips.`);
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
  handleRegister,
  handleVerificationCode,
  handleSettings,
};
