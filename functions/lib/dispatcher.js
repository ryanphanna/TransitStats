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
const { constructStopInput } = require('./gemini');
const { parseWithClaude } = require('./claude');
const { parseMultiLineTripFormat, parseSingleLineTripFormat, parseCasualTripFormat, parseEndTripFormat } = require('./parsing');
const { isValidRoute, normalizeDirection, getRouteDisplay, getStopDisplay, normalizeAgency, generateVerificationCode } = require('./utils');
const { getConfiguredPrimaryAgency } = require('./primary-agency');
const handlers = require('./handlers');
const { createInviteHandlers } = require('./sms-invite');
const { getAuth } = require('firebase-admin/auth');
const { isPhoneConfirmed } = require('./phone-confirmation');
const text = require('./sms-text');
const { createPendingHandlers } = require('./dispatcher-pending');

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

// Replies to an open question (agency / stop / route choice, photo follow-ups, etc.).
const { handlePendingState } = createPendingHandlers({
  handlers, db, FieldValue, sendSmsReply, clearPendingState, setPendingState,
  getRouteDisplay, getStopDisplay, logger, generateTraceId: generateTraceIdLocal,
});

// The opt-out / opt-in keywords configured in the Twilio console (Advanced
// Opt-Out). END is deliberately not one of them: it finishes a trip. YES is
// one of Twilio's default opt-in words. A missed opt-in is the costly side
// (we'd skip texts Twilio would deliver); a missed opt-out fixes itself when
// the next send fails with 21610.
const OPT_OUT_KEYWORDS = /^(STOP|STOPALL)$/;
const OPT_IN_KEYWORDS = /^(START|STARTUP|UNSTOP|YES)$/;

/** Keep our own opt-out list in step with Twilio's STOP / START handling. */
async function syncOptOutKeyword(phoneNumber, upperBody) {
  try {
    if (OPT_IN_KEYWORDS.test(upperBody.trim())) {
      await db.collection('smsOptOuts').doc(phoneNumber).delete();
    } else if (OPT_OUT_KEYWORDS.test(upperBody.trim())) {
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
  if (OPT_OUT_KEYWORDS.test(upperBody.trim()) || OPT_IN_KEYWORDS.test(upperBody.trim())) return;
  await getInviteHandlers().handleUnknownSender(phoneNumber, trace);
}

// Commands that read or change existing data. An unconfirmed number (see
// phone-confirmation.js) never reaches these; it may only log trips.
const DATA_COMMANDS = /^(NOTES|ASK|SETTINGS|STATUS|STATS|FORGOT|DISCARD|UNLINK)\b/i;

/**
 * An unconfirmed number asked for something beyond logging a trip: email the
 * code now (under the usual per-number limit) and tell them how to unlock.
 */
async function promptUnlock(phoneNumber, link) {
  // Everything below is limited to one reply per number per window.
  if (!(await shouldRespondToUnknown(phoneNumber))) return;
  if (!link.email) {
    await sendSmsReply(phoneNumber, text.UNLOCK_UNAVAILABLE_TEXT);
    return;
  }
  await getInviteHandlers().startPhoneConfirmation(phoneNumber, link.email);
  await sendSmsReply(phoneNumber, text.UNLOCK_PROMPT_TEXT);
}

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
  const { numMedia = 0, mediaUrl = null, apiOwner = null } = media;
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

  // Opt-in / opt-out keywords update our own list for everyone, linked or not.
  // Twilio acts on them whatever we do next, so record them before the rate
  // limit and duplicate checks below can drop the message (CIV-348).
  await syncOptOutKeyword(phoneNumber, upperBody);

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

  // A bare STOP / STOPALL is an opt-out and nothing else: no trip action and no
  // reply to a number that just asked us to stop. ("STOP <stop>" still ends a
  // trip, since Twilio only matches whole-message keywords.)
  if (OPT_OUT_KEYWORDS.test(upperBody.trim())) return '';

  // Who is acting. A web or app request (apiOwner, set only by api-command.js
  // after verifying the owner's email) is the owner themselves: it has its own
  // identity key ("web:<uid>", never a phone), so its pending prompts and trips
  // can't be reached from, or attributed to, any phone number. A text is
  // whoever the sending number is linked to.
  const link = apiOwner
    ? { userId: apiOwner.userId, email: apiOwner.email, loginConfirmed: true }
    : await getUserByPhone(phoneNumber);
  const locked = !!link && !apiOwner && !isPhoneConfirmed(link);
  const actor = link;

  // 3. Contextual/Pending State Logic
  const pendingState = await getPendingState(phoneNumber);
  // The phone-linking exchanges are for a real phone only.
  const apiBlocked = !!apiOwner && ['awaiting_verification', 'awaiting_email'].includes(pendingState?.type);
  if (pendingState && !apiBlocked) {
    const handled = await handlePendingState(phoneNumber, body, upperBody, pendingState, trace, { locked, user: actor });
    if (handled) return '';
  }

  // 3.5. MMS: authenticate then hand off to photo-based trip start
  if (isMms) {
    const user = actor;
    if (!user) {
      await handleUnknownNumber(phoneNumber, upperBody, trace);
      return '';
    }
    if (locked) {
      await promptUnlock(phoneNumber, user);
      return '';
    }
    await handlers.handleMmsTrip(phoneNumber, user, mediaUrl, receivedAt, trace);
    return '';
  }

  if (apiOwner && /^REGISTER\b/.test(upperBody)) {
    await sendSmsReply(phoneNumber, text.REGISTER_FROM_PHONE);
    return '';
  }

  // 4. Public Commands (No Auth Required)
  const publicHandled = await handlePublicCommands(phoneNumber, upperBody, body, trace);
  if (publicHandled) return '';

  // 5. User Authentication
  const user = actor;
  if (!user) {
    await handleUnknownNumber(phoneNumber, upperBody, trace);
    return '';
  }

  // 5.5 Unconfirmed number: trip logging only, nothing that reads or changes
  // existing data (including the AI and fallback paths).
  if (locked) {
    if (!DATA_COMMANDS.test(body.trim())) {
      const prefixed = body.match(/^START\s+(.{1,160})$/i);
      if (await handleTripFlow(phoneNumber, user, prefixed ? prefixed[1] : body, receivedAt, trace)) return '';
    }
    await promptUnlock(phoneNumber, user);
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

  // 8. AI Intent Recognition (Claude)
  const aiHandled = await handleAIIntent(phoneNumber, user, tripBody, receivedAt, trace);
  if (aiHandled) return '';

  // 9. Final Fallback
  await handleFallback(phoneNumber, user, body);
  return '';
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

/** The agency a texted trip defaults to: the profile's primary agency, else the last trip's. */
async function getDefaultAgency(userId) {
  const configuredAgency = getConfiguredPrimaryAgency(await getUserProfile(userId));
  return configuredAgency || (getLastTripAgency ? await getLastTripAgency(userId) : null);
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
      await sendSmsReply(phoneNumber, text.END_TRIP_FAILED);
    }
    return true;
  }

  // Start Trip check (Multi-line or single-line with direction)
  // An unconfirmed number gets no default agency from the owner's profile or history.
  const defaultAgency = isPhoneConfirmed(user) ? await getDefaultAgency(user.userId) : null;
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
  const aiResult = await parseWithClaude(body, trace);

  // If the AI missed a query (returned OTHER/null), fall back to a word-count
  // heuristic. By this point in the dispatch chain all trip command formats
  // have already been ruled out, so a multi-word sentence is almost certainly
  // a natural-language question that the AI mis-classified.
  if (!aiResult || aiResult.intent === 'OTHER') {
    if (body.trim().split(/\s+/).length >= 2) {
      await handlers.handleQuery(phoneNumber, user, body.trim(), trace);
      return true;
    }
    return false;
  }

  const defaultAgency = await getDefaultAgency(user.userId);

  switch (aiResult.intent) {
  case 'START_TRIP': {
    const startStop = constructStopInput(aiResult);
    if (aiResult.route && startStop && isValidRoute(aiResult.route)) {
      const CANONICAL_DIRECTIONS = new Set([
        'Northbound', 'Southbound', 'Eastbound', 'Westbound',
        'Clockwise', 'Counterclockwise', 'Inbound', 'Outbound',
      ]);
      const normalizedDir = normalizeDirection(aiResult.direction);
      const safeDir = CANONICAL_DIRECTIONS.has(normalizedDir) ? normalizedDir : null;
      const aiAgency = aiResult.agency ? normalizeAgency(aiResult.agency) : null;
      await handlers.handleTripLog(
        phoneNumber,
        user,
        startStop,
        aiResult.route,
        safeDir,
        aiAgency || defaultAgency,
        { parsed_by: 'ai', agencyExplicit: !!aiAgency, startTime: receivedAt, vehicle: aiResult.vehicle },
        trace
      );
      return true;
    }
    break;
  }
  case 'END_TRIP': {
    const endStop = constructStopInput(aiResult);
    await handlers.handleEndTrip(phoneNumber, user, endStop || null, null, aiResult.notes, trace);
    return true;
  }
  case 'DISCARD_TRIP':
    await handlers.handleDiscard(phoneNumber, user, trace);
    return true;
  case 'INCOMPLETE_TRIP':
    await handlers.handleIncomplete(phoneNumber, user, trace); // internal AI intent, maps to FORGOT
    return true;
  case 'QUERY':
    await handlers.handleQuery(phoneNumber, user, aiResult.question || body, trace);
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
    await sendSmsReply(phoneNumber, text.CHOICE_EXPIRED);
    return;
  }

  await db.collection('trips').add({
    userId: user.userId,
    raw_text: body,
    needs_review: true,
    timestamp: FieldValue.serverTimestamp(),
    source: 'sms_fallback',
  });

  await sendSmsReply(phoneNumber, text.NOT_UNDERSTOOD);
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
