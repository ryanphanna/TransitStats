/**
 * SMS Command Dispatcher
 * Breaks down the complex SMS handling logic into manageable flows.
 */

const logger = require('./logger');

/** Local short trace ID generator (tests sometimes mock the logger module) */
function generateTraceIdLocal() {
  try {
    const { randomUUID } = require('crypto');
    return randomUUID().replace(/-/g, '').slice(0, 8);
  } catch {
    return Date.now().toString(36).slice(-8);
  }
}
const {
  isRateLimited,
  checkIdempotency,
  checkContentDuplicate,
  getFirestore,
  getPendingState,
  getUserByPhone,
  getUserProfile,
  shouldRespondToUnknown,
  clearPendingState,
  setPendingState,
  getLastTripAgency,
  storeVerificationCode,
  db,
  FieldValue,
} = require('./db');
const { sendSmsReply, getTwilioPhoneNumber } = require('./twilio');
const { parseWithGemini, constructStopInput } = require('./gemini');
const { parseMultiLineTripFormat, parseSingleLineTripFormat, parseCasualTripFormat, parseEndTripFormat } = require('./parsing');
const { isValidRoute, normalizeDirection, getRouteDisplay, getStopDisplay, normalizeAgency, generateVerificationCode } = require('./utils');
const { getConfiguredPrimaryAgency } = require('./primary-agency');
const handlers = require('./handlers');
const { createInviteHandlers } = require('./sms-invite');
const { getAuth } = require('firebase-admin/auth');

let inviteHandlers = null;
function getInviteHandlers() {
  if (!inviteHandlers) {
    inviteHandlers = createInviteHandlers({
      db, adminAuth: getAuth(), sendSmsReply, shouldRespondToUnknown, FieldValue, logger,
      storeVerificationCode, setPendingState, generateVerificationCode,
    });
  }
  return inviteHandlers;
}

// The opt-out / opt-in keywords configured in the Twilio console (Advanced
// Opt-Out). END is deliberately not one of them: it finishes a trip.
const OPT_OUT_KEYWORDS = /^(STOP|STOPALL)$/;
const OPT_IN_KEYWORDS = /^(START|STARTUP|UNSTOP)$/;

/** Keep our own opt-out list in step with Twilio's STOP / START handling. */
async function syncOptOutKeyword(phoneNumber, upperBody) {
  try {
    if (OPT_IN_KEYWORDS.test(upperBody)) {
      await db.collection('smsOptOuts').doc(phoneNumber).delete();
    } else if (OPT_OUT_KEYWORDS.test(upperBody)) {
      await getInviteHandlers().markOptedOut(phoneNumber, 'inbound-keyword');
    }
  } catch (error) {
    logger.warn('Could not sync SMS opt-out', { error: error.message });
  }
}

/** Number with no linked account texted us. */
async function handleUnknownNumber(phoneNumber, upperBody, trace) {
  // Opt-out / opt-in keywords were already recorded by syncOptOutKeyword; they
  // get no reply.
  if (OPT_OUT_KEYWORDS.test(upperBody) || OPT_IN_KEYWORDS.test(upperBody)) return;
  await getInviteHandlers().handleUnknownSender(phoneNumber, trace);
}

/** Commands that are allowed to fall through pending-state handlers to normal dispatch. */
const PENDING_PASSTHROUGH = new Set(['STATUS', 'STATS', 'FORGOT', 'INFO', 'COMMANDS', 'HELP', '?']);

/**
 * Main dispatch logic for an SMS message
 * @param {string} phoneNumber
 * @param {string} body
 * @param {string} messageSid
 * @param {object} [media]
 * @param {string} [traceId] - optional correlation ID from the webhook entry
 */
async function dispatch(phoneNumber, body, messageSid, media = {}, traceId = null) {
  const receivedAt = Date.now();
  const { numMedia = 0, mediaUrl = null } = media;
  const isMms = numMedia > 0 && !!mediaUrl;

  // Ensure we always have a traceId for this request lifecycle
  const trace = traceId || generateTraceIdLocal();

  // 1. Basic Validation
  if (!phoneNumber || (!body && !isMms)) {
    throw new Error('Missing phone number or message body');
  }

  // Drop messages sent from our own number — self-loop guard
  if (phoneNumber === getTwilioPhoneNumber()) {
    logger.info('Self-loop detected — dropping', { From: phoneNumber, traceId: trace }, trace);
    return '';
  }

  // 1.5. Spam Filter: Drop texts containing URLs (text messages only)
  if (body && !isMms) {
    const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/i;
    if (urlRegex.test(body)) {
      logger.info('Spam URL dropped', { From: phoneNumber, Body: body, traceId: trace }, trace);
      return '';
    }
  }

  const upperBody = body ? body.toUpperCase() : '';
  logger.info('Dispatching SMS', { From: phoneNumber, Body: body, isMms, traceId: trace }, trace);

  // 2. Pre-auth Checks
  if (await isRateLimited(phoneNumber)) {
    logger.info('Rate limited', { From: phoneNumber, traceId: trace }, trace);
    return '';
  }

  if (messageSid && await checkIdempotency(messageSid)) {
    logger.info('Duplicate Message', { MessageSid: messageSid, traceId: trace }, trace);
    return '';
  }

  // Content dedup and outbound loop checks don't apply to MMS
  if (!isMms) {
    // END/STOP commands bypass content dedup — if an end attempt fails, the user
    // must be able to retry immediately without waiting 60 seconds.
    const isEndCommand = /^(END|STOP)(\s|$)/i.test(body);
    if (!isEndCommand && await checkContentDuplicate(phoneNumber, body)) {
      logger.info('Duplicate content within window', { From: phoneNumber, traceId: trace }, trace);
      return '';
    }

    if (await checkOutboundLoop(body)) {
      logger.info('Outbound loop detected — dropping', { From: phoneNumber, traceId: trace }, trace);
      return '';
    }
  }

  // Opt-in / opt-out keywords update our own list for everyone, linked or not.
  await syncOptOutKeyword(phoneNumber, upperBody);

  // 3. Contextual/Pending State Logic
  const pendingState = await getPendingState(phoneNumber);
  if (pendingState) {
    const handled = await handlePendingState(phoneNumber, body, upperBody, pendingState, trace);
    if (handled) return '';
  }

  // 3.5. MMS: authenticate then hand off to photo-based trip start
  if (isMms) {
    const user = await getUserByPhone(phoneNumber);
    if (!user) {
      await handleUnknownNumber(phoneNumber, upperBody, trace);
      return '';
    }
    await handlers.handleMmsTrip(phoneNumber, user, mediaUrl, receivedAt, trace);
    return '';
  }

  // 4. Public Commands (No Auth Required)
  const publicHandled = await handlePublicCommands(phoneNumber, upperBody, body, trace);
  if (publicHandled) return '';

  // 5. User Authentication
  const user = await getUserByPhone(phoneNumber);
  if (!user) {
    await handleUnknownNumber(phoneNumber, upperBody, trace);
    return '';
  }

  // 6. Private/Member Commands
  const privateHandled = await handlePrivateCommands(phoneNumber, user, upperBody, body, trace);
  if (privateHandled) return '';

  // 7. Core Trip Logic (Parsing & Heuristics)
  // Strip optional "START " prefix so "Start 2 Spadina West" works the same as "2 Spadina West"
  const startPrefixMatch = body.match(/^START\s+(.{1,160})$/i);
  const tripBody = startPrefixMatch ? startPrefixMatch[1] : body;

  const tripHandled = await handleTripFlow(phoneNumber, user, tripBody, receivedAt, trace);
  if (tripHandled) return '';

  // 8. AI Intent Recognition (Gemini)
  const aiHandled = await handleAIIntent(phoneNumber, user, tripBody, receivedAt, trace);
  if (aiHandled) return '';

  // 9. Final Fallback
  await handleFallback(phoneNumber, user, body);
  return '';
}

/**
 * Handles states like verification codes or start-trip confirmations
 */
async function handleConfirmAgencyState(phoneNumber, body, upperBody, state, traceId = null) {
  const trace = traceId || generateTraceIdLocal();
  if (/^[12]$/.test(body.trim())) {
    const user = await getUserByPhone(phoneNumber);
    if (user) {
      const chosenAgency = state.agencyOptions[parseInt(body.trim(), 10) - 1];
      await clearPendingState(phoneNumber);
      await handlers.handleTripLog(
        phoneNumber, user, state.stopInput, state.route, state.direction,
        chosenAgency, { ...state.options, agencyExplicit: true }, trace
      );
    }
    return true;
  }

  if (upperBody === 'DISCARD') {
    await clearPendingState(phoneNumber);
    await sendSmsReply(phoneNumber, 'Trip cancelled.');
    return true;
  }

  if (upperBody === 'SKIP') {
    const user = await getUserByPhone(phoneNumber);
    if (user) {
      // SKIP uses the default agency (index 1 in agencyOptions)
      const skippedAgency = state.agencyOptions[1] || state.agencyOptions[0];
      await clearPendingState(phoneNumber);
      await handlers.handleTripLog(
        phoneNumber, user, state.stopInput, state.route, state.direction,
        skippedAgency, { ...state.options, agencyExplicit: true }, trace
      );
    }
    return true;
  }

  if (PENDING_PASSTHROUGH.has(upperBody) || upperBody.startsWith('ASK ')) return false;

  await sendSmsReply(phoneNumber, 'Reply 1 or 2 to select an agency, SKIP for default, or DISCARD to cancel.');
  return true;
}

async function handleConfirmStopState(phoneNumber, body, upperBody, state, traceId = null) {
  const trace = traceId || generateTraceIdLocal();
  const num = parseInt(body.trim(), 10);
  if (!isNaN(num) && num >= 1 && num <= state.stopCandidates.length) {
    const user = await getUserByPhone(phoneNumber);
    if (user) {
      const chosen = state.stopCandidates[num - 1];
      await clearPendingState(phoneNumber);
      if (state.tripId) {
        // Trip already started — update the stop fields now that we know which stop
        await db.collection('trips').doc(state.tripId).update({
          startStopCode: chosen.stopCode,
          startStopName: chosen.stopName,
          startStop: chosen.stopName,
          stop_matched: true,
        });
        // Run V4/V5 predictions now that the stop is known — fire-and-forget
        handlers.fillPredictions(
          user, state.tripId, chosen.stopName, state.route, state.direction, state.agency, trace
        ).catch(() => {});
        await sendSmsReply(
          phoneNumber,
          `Stop set to ${chosen.stopName}.\n\nEND [stop] to finish. FORGOT if you forgot to end.`
        );
      } else {
        // No trip started yet (active-trip conflict path) — pass stop code so lookupStop resolves unambiguously
        await handlers.handleTripLog(
          phoneNumber, user, chosen.stopCode, state.route, state.direction,
          state.agency, { ...state.options, agencyExplicit: true }, trace
        );
      }
    }
    return true;
  }

  if (upperBody === 'DISCARD') {
    await clearPendingState(phoneNumber);
    if (state.tripId) {
      await db.collection('trips').doc(state.tripId).delete();
    }
    await sendSmsReply(phoneNumber, 'Trip cancelled.');
    return true;
  }

  // SKIP dismisses the stop clarification without touching the trip —
  // DISCARD is too destructive when the rider just doesn't care which
  // physical stop it was.
  if (upperBody === 'SKIP') {
    await clearPendingState(phoneNumber);
    if (state.tripId) {
      await sendSmsReply(phoneNumber, 'No problem — trip continues.\n\nEND [stop] to finish.');
    } else {
      const user = await getUserByPhone(phoneNumber);
      if (user) {
        await handlers.handleTripLog(
          phoneNumber, user, state.stopInput, state.route, state.direction,
          state.agency, { ...state.options, skipDisambiguation: true }, trace
        );
      }
    }
    return true;
  }

  // Stop clarification is optional. If the rider sends another command or
  // starts another trip instead, discard the old prompt and process the new
  // message normally.
  if (PENDING_PASSTHROUGH.has(upperBody) || upperBody === 'NOTES' || upperBody.startsWith('NOTES ') || upperBody.startsWith('ASK ')) {
    await clearPendingState(phoneNumber);
    return false;
  }

  // END/STOP must work mid-disambiguation — the trip already exists and the
  // rider may reach their destination before ever picking a start stop.
  if (/^(END|STOP)(\s|$)/i.test(body)) {
    await clearPendingState(phoneNumber);
    return false;
  }

  await clearPendingState(phoneNumber);
  return false;
}

async function handleMmsStopNeededState(phoneNumber, body, upperBody, state, traceId = null) {
  const trace = traceId || generateTraceIdLocal();
  if (upperBody === 'DISCARD') {
    await clearPendingState(phoneNumber);
    await sendSmsReply(phoneNumber, 'Trip cancelled.');
    return true;
  }
  const user = await getUserByPhone(phoneNumber);
  if (user && body.trim()) {
    await clearPendingState(phoneNumber);
    const stopReply = body.trim();
    const mmsOptions = {
      parsed_by: 'mms',
      startTime: state.receivedAt,
      source: 'mms',
      timing_reliability: 'approximate',
    };
    if (state.routeCandidates.length === 1) {
      const chosen = state.routeCandidates[0];
      await handlers.handleTripLog(
        phoneNumber, user, stopReply, chosen.route, null, chosen.agency, mmsOptions, trace
      );
    } else {
      const list = state.routeCandidates.map((r, i) => `${i + 1}. Route ${r.route}`).join('\n');
      await setPendingState(phoneNumber, {
        type: 'confirm_mms_route',
        routeCandidates: state.routeCandidates,
        stopInput: stopReply,
        defaultAgency: state.defaultAgency,
        receivedAt: state.receivedAt,
      });
      await sendSmsReply(phoneNumber, `Which route?\n${list}\nor DISCARD to cancel`);
    }
  }
  return true;
}

async function handleConfirmMmsRouteState(phoneNumber, body, upperBody, state, traceId = null) {
  const trace = traceId || generateTraceIdLocal();
  const num = parseInt(body.trim(), 10);
  if (!isNaN(num) && num >= 1 && num <= state.routeCandidates.length) {
    const user = await getUserByPhone(phoneNumber);
    if (user) {
      const chosen = state.routeCandidates[num - 1];
      await clearPendingState(phoneNumber);
      await handlers.handleTripLog(
        phoneNumber, user, state.stopInput, chosen.route, null,
        chosen.agency || state.defaultAgency,
        {
          parsed_by: 'mms',
          startTime: state.receivedAt,
          source: 'mms',
          timing_reliability: 'approximate',
        },
        trace
      );
    }
    return true;
  }

  if (upperBody === 'DISCARD') {
    await clearPendingState(phoneNumber);
    await sendSmsReply(phoneNumber, 'Trip cancelled.');
    return true;
  }

  if (PENDING_PASSTHROUGH.has(upperBody) || upperBody === 'NOTES' || upperBody.startsWith('NOTES ') || upperBody.startsWith('ASK ')) return false;

  const count = (state.routeCandidates || []).length;
  await sendSmsReply(phoneNumber, `Reply with a number (1–${count}) to select a route, or DISCARD to cancel.`);
  return true;
}

async function handleConfirmStartState(phoneNumber, upperBody, state, traceId = null) {
  const trace = traceId || generateTraceIdLocal();
  if (upperBody === 'START') {
    const user = await getUserByPhone(phoneNumber);
    if (user) await handlers.handleConfirmStart(phoneNumber, user, state, trace);
    return true;
  }

  if (upperBody === 'DISCARD') {
    // Cancel the new trip attempt — old trip stays active
    const activeRouteDisplay = getRouteDisplay(state.activeTrip.route, state.activeTrip.direction);
    const activeStopDisplay = getStopDisplay(
      state.activeTrip.startStopCode, state.activeTrip.startStopName, state.activeTrip.startStop
    );
    await clearPendingState(phoneNumber);
    await sendSmsReply(
      phoneNumber,
      `New trip cancelled. ${activeRouteDisplay} from ${activeStopDisplay} still active.\n\n` +
      'END [stop] to finish. FORGOT if you forgot to end.'
    );
    return true;
  }

  if (upperBody === 'FORGOT') {
    // Mark old trip incomplete and cancel the new trip attempt
    await db.collection('trips').doc(state.activeTrip.id).update({
      incomplete: true,
      endTime: state.activeTrip.startTime,
      exitLocation: null,
      duration: null,
    });
    const activeRouteDisplay = getRouteDisplay(state.activeTrip.route, state.activeTrip.direction);
    const activeStopDisplay = getStopDisplay(
      state.activeTrip.startStopCode, state.activeTrip.startStopName, state.activeTrip.startStop
    );
    await clearPendingState(phoneNumber);
    await sendSmsReply(
      phoneNumber,
      `${activeRouteDisplay} from ${activeStopDisplay} saved as incomplete. New trip cancelled.`
    );
    return true;
  }

  // STATUS/STATS/ASK/INFO fall through so their normal handlers can respond.
  if (PENDING_PASSTHROUGH.has(upperBody) || upperBody.startsWith('ASK ')) return false;

  // Anything else (e.g. "1", another trip attempt) gets a reminder instead of
  // falling through to "Could not understand."
  const newTripDisplay = getRouteDisplay(state.newTrip?.route, state.newTrip?.direction);
  await sendSmsReply(
    phoneNumber,
    `Reply START to begin ${newTripDisplay}, DISCARD to cancel, or FORGOT to save existing trip as incomplete.`
  );
  return true;
}

async function handlePendingState(phoneNumber, body, upperBody, state, traceId = null) {
  const trace = traceId || generateTraceIdLocal();

  if (state.type === 'awaiting_verification' && /^\d{4,6}$/.test(body)) {
    await handlers.handleVerificationCode(phoneNumber, body, trace);
    return true;
  }

  if (state.type === 'awaiting_email') {
    // Let HELP/STATUS/etc. and an explicit "REGISTER [email]" retry fall through to their
    // normal handlers instead of being swallowed as a (malformed) email attempt — this is
    // the only pending state that used to lack this bypass.
    if (PENDING_PASSTHROUGH.has(upperBody) || upperBody.startsWith('ASK ') || upperBody.startsWith('REGISTER ')) return false;
    await handlers.handleRegister(phoneNumber, body.trim(), trace);
    return true;
  }

  const stateHandlers = {
    confirm_agency: () => handleConfirmAgencyState(phoneNumber, body, upperBody, state, trace),
    confirm_stop: () => handleConfirmStopState(phoneNumber, body, upperBody, state, trace),
    mms_stop_needed: () => handleMmsStopNeededState(phoneNumber, body, upperBody, state, trace),
    confirm_mms_route: () => handleConfirmMmsRouteState(phoneNumber, body, upperBody, state, trace),
    confirm_start: () => handleConfirmStartState(phoneNumber, upperBody, state, trace),
  };

  if (stateHandlers[state.type]) {
    return stateHandlers[state.type]();
  }

  logger.warn('handlePendingState: unknown state type, falling through', { type: state.type, traceId: trace }, trace);
  return false;
}

/**
 * Commands accessible to everyone (HELP, REGISTER)
 */
async function handlePublicCommands(phoneNumber, upperBody, rawBody, traceId = null) {
  const trace = traceId || generateTraceIdLocal();

  if (['INFO', 'COMMANDS', '?', 'HELP', 'COMMAND'].includes(upperBody)) {
    await handlers.handleHelp(phoneNumber, trace);
    return true;
  }

  if (upperBody.startsWith('REGISTER ')) {
    await handlers.handleRegister(phoneNumber, rawBody.substring(9).trim(), trace);
    return true;
  }

  return false;
}

/**
 * Commands for registered users (STATUS, STATS, etc.)
 */
async function handlePrivateCommands(phoneNumber, user, upperBody, rawBody, traceId = null) {
  const trace = traceId || generateTraceIdLocal();
  const notesMatch = rawBody.match(/^NOTES\b[\s:]*([\s\S]*)$/i);
  if (notesMatch) {
    await handlers.handleAddNotes(phoneNumber, user, notesMatch[1] || '', trace);
    return true;
  }

  if (upperBody === 'ASK') {
    await handlers.handleQuery(phoneNumber, user, '', trace);
    return true;
  }

  if (upperBody.startsWith('ASK ')) {
    await handlers.handleQuery(phoneNumber, user, rawBody.substring(4).trim(), trace);
    return true;
  }

  if (upperBody === 'SETTINGS') {
    await handlers.handleSettings(phoneNumber, user, '', trace);
    return true;
  }

  if (upperBody.startsWith('SETTINGS ')) {
    await handlers.handleSettings(phoneNumber, user, rawBody.substring(9).trim(), trace);
    return true;
  }

  const commands = {
    'STATUS': handlers.handleStatus,
    'STATS': handlers.handleStatsCommand,
    'FORGOT': handlers.handleIncomplete,
    'DISCARD': handlers.handleDiscard,
    'UNLINK': handlers.handleUnlink,
  };

  // Strict whitelist to avoid unvalidated dynamic method invocation
  if (['STATUS', 'STATS', 'FORGOT', 'DISCARD', 'UNLINK'].includes(upperBody)) {
    await commands[upperBody](phoneNumber, user, trace);
    return true;
  }

  return false;
}

/**
 * Handles explicit stop/start formats
 */
async function handleTripFlow(phoneNumber, user, body, receivedAt = Date.now(), traceId = null) {
  const trace = traceId || generateTraceIdLocal();

  // End Trip check
  const endTripData = parseEndTripFormat(body);
  const singleLineEndMatch = body.match(/^(END|STOP)\s+(\S.*)$/i);

  if (endTripData || singleLineEndMatch) {
    const stopInput = singleLineEndMatch ? singleLineEndMatch[2] : endTripData?.stop;
    try {
      await handlers.handleEndTrip(phoneNumber, user, stopInput, endTripData?.route, endTripData?.notes, trace);
    } catch (err) {
      logger.error('handleEndTrip failed', { error: err.message, stack: err.stack, traceId: trace }, trace);
      await sendSmsReply(phoneNumber, 'Could not end your trip. Please try again.');
    }
    return true;
  }

  // Start Trip check (Multi-line or single-line with direction)
  const userProfile = await getUserProfile(user.userId);
  const configuredAgency = getConfiguredPrimaryAgency(userProfile);
  const defaultAgency = configuredAgency || (getLastTripAgency ? await getLastTripAgency(user.userId) : null);
  const multiLineTrip = parseMultiLineTripFormat(body, defaultAgency);
  const singleLineTrip = !multiLineTrip ? parseSingleLineTripFormat(body, defaultAgency) : null;
  const casualTrip = !multiLineTrip && !singleLineTrip ? parseCasualTripFormat(body, defaultAgency) : null;
  const tripData = multiLineTrip || singleLineTrip || casualTrip;

  if (tripData) {
    await handlers.handleTripLog(
      phoneNumber,
      user,
      tripData.stop,
      tripData.route,
      tripData.direction,
      tripData.agency,
      { agencyExplicit: tripData.agencyExplicit, startTime: receivedAt, vehicle: tripData.vehicle },
      trace
    );
    return true;
  }

  return false;
}

/**
 * AI fallback for unstructured messages
 */
async function handleAIIntent(phoneNumber, user, body, receivedAt = Date.now(), traceId = null) {
  const trace = traceId || generateTraceIdLocal();
  const geminiResult = await parseWithGemini(body, trace);

  // If Gemini missed a query (returned OTHER/null), fall back to a word-count
  // heuristic. By this point in the dispatch chain all trip command formats
  // have already been ruled out, so a multi-word sentence is almost certainly
  // a natural-language question that Gemini mis-classified.
  if (!geminiResult || geminiResult.intent === 'OTHER') {
    if (body.trim().split(/\s+/).length >= 2) {
      await handlers.handleQuery(phoneNumber, user, body.trim(), trace);
      return true;
    }
    return false;
  }

  const userProfile = await getUserProfile(user.userId);
  const configuredAgency = getConfiguredPrimaryAgency(userProfile);
  const defaultAgency = configuredAgency || (getLastTripAgency ? await getLastTripAgency(user.userId) : null);

  switch (geminiResult.intent) {
  case 'START_TRIP': {
    const startStop = constructStopInput(geminiResult);
    if (geminiResult.route && startStop && isValidRoute(geminiResult.route)) {
      const CANONICAL_DIRECTIONS = new Set([
        'Northbound', 'Southbound', 'Eastbound', 'Westbound',
        'Clockwise', 'Counterclockwise', 'Inbound', 'Outbound',
      ]);
      const normalizedDir = normalizeDirection(geminiResult.direction);
      const safeDir = CANONICAL_DIRECTIONS.has(normalizedDir) ? normalizedDir : null;
      const aiAgency = geminiResult.agency ? normalizeAgency(geminiResult.agency) : null;
      await handlers.handleTripLog(
        phoneNumber,
        user,
        startStop,
        geminiResult.route,
        safeDir,
        aiAgency || defaultAgency,
        { parsed_by: 'ai', agencyExplicit: !!aiAgency, startTime: receivedAt, vehicle: geminiResult.vehicle },
        trace
      );
      return true;
    }
    break;
  }
  case 'END_TRIP': {
    const endStop = constructStopInput(geminiResult);
    await handlers.handleEndTrip(phoneNumber, user, endStop || null, null, geminiResult.notes, trace);
    return true;
  }
  case 'DISCARD_TRIP':
    await handlers.handleDiscard(phoneNumber, user, trace);
    return true;
  case 'INCOMPLETE_TRIP':
    await handlers.handleIncomplete(phoneNumber, user, trace); // internal Gemini intent, maps to FORGOT
    return true;
  case 'QUERY':
    await handlers.handleQuery(phoneNumber, user, geminiResult.question || body, trace);
    return true;
  }

  return false;
}

/**
 * Final safety net for unrecognized input
 */
async function handleFallback(phoneNumber, user, body) {
  // A bare small number is almost certainly a reply to a disambiguation
  // prompt whose pending state expired. Explain instead of "Could not
  // understand", and don't log a junk needs_review trip for it.
  if (/^\d{1,2}$/.test(body.trim())) {
    await sendSmsReply(
      phoneNumber,
      'That choice expired, so there is nothing to select. Text STATUS to check your trip.'
    );
    return;
  }

  await db.collection('trips').add({
    userId: user.userId,
    raw_text: body,
    needs_review: true,
    timestamp: FieldValue.serverTimestamp(),
    source: 'sms_fallback',
  });

  await sendSmsReply(phoneNumber, `Could not understand. Try:\n[Route]\n[Stop]`);
}

/**
 * Check if an incoming message body matches a recently sent outbound message.
 * Catches loops where the app's own reply comes back as an incoming SMS.
 * @param {string} body
 * @returns {boolean} true if this looks like a looped outbound message
 */
async function checkOutboundLoop(body) {
  if (!body) return false;
  try {
    const crypto = require('crypto');
    const db = getFirestore();
    const key = crypto.createHash('sha256').update('outbound|' + body).digest('hex');
    const doc = await db.collection('processedMessages').doc('outbound_' + key).get();
    if (!doc.exists) return false;
    const processedAt = doc.data().processedAt?.toDate?.();
    return processedAt && (Date.now() - processedAt.getTime()) < 120000;
  } catch (e) {
    logger.error('checkOutboundLoop error', { error: e.message });
    return false;
  }
}

module.exports = {
  dispatch,
};
