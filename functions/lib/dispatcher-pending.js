/**
 * Pending-question handlers for the SMS dispatcher: replies to a question the
 * previous text asked (verification code, email, agency / stop / route choice,
 * photo follow-ups, start-over confirmation).
 *
 * Built by dispatcher.js with its own db / handler / reply functions (like
 * sms-invite.js), so this file loads nothing that touches Firestore itself.
 * Each handler returns true when the text was answered here, false to let the
 * dispatcher handle it normally.
 */
const text = require('./sms-text');
const { isPhoneConfirmed } = require('./phone-confirmation');
const { incompleteTripUpdate, mmsTripOptions, teachStopRoute } = require('./trip-updates');

/** Commands that are allowed to fall through pending-state handlers to normal dispatch. */
const PENDING_PASSTHROUGH = new Set(['STATUS', 'STATS', 'FORGOT', 'INFO', 'COMMANDS', 'HELP', '?']);

/**
 * Whether a reply is a command that skips the open question. Every question lets the
 * PENDING_PASSTHROUGH commands and ASK through; some also let NOTES or REGISTER through.
 */
function passesThrough(upperBody, { notes = false, register = false } = {}) {
  if (PENDING_PASSTHROUGH.has(upperBody) || upperBody.startsWith('ASK ')) return true;
  if (notes && (upperBody === 'NOTES' || upperBody.startsWith('NOTES '))) return true;
  if (register && upperBody.startsWith('REGISTER ')) return true;
  return false;
}

/**
 * The option a numbered reply picks, or null. Lenient (the default) reads a leading
 * number ("2 King" picks 2); strict needs the reply to be digits only.
 */
function numberedChoice(body, options, { strict = false } = {}) {
  const reply = body.trim();
  if (strict && !/^\d+$/.test(reply)) return null;
  const num = parseInt(reply, 10);
  if (isNaN(num) || num < 1 || num > options.length) return null;
  return options[num - 1];
}

function createPendingHandlers({
  handlers,
  db,
  FieldValue,
  sendSmsReply,
  clearPendingState,
  setPendingState,
  getRouteDisplay,
  getStopDisplay,
  logger,
  generateTraceId,
}) {
  /** DISCARD: drop the question (and the trip it was about, when there is one). */
  async function cancelPending(phoneNumber, tripId = null) {
    await clearPendingState(phoneNumber);
    if (tripId) {
      await db.collection('trips').doc(tripId).delete();
    }
    await sendSmsReply(phoneNumber, text.TRIP_CANCELLED);
    return true;
  }

  async function handleConfirmAgencyState(phoneNumber, body, upperBody, state, traceId = null, user = null) {
    const trace = traceId || generateTraceId();
    const logWithAgency = async (agency) => {
      await clearPendingState(phoneNumber);
      await handlers.handleTripLog(
        phoneNumber, user, state.stopInput, state.route, state.direction,
        agency, { ...state.options, agencyExplicit: true }, trace
      );
    };

    if (/^[12]$/.test(body.trim())) {
      if (user) await logWithAgency(state.agencyOptions[parseInt(body.trim(), 10) - 1]);
      return true;
    }

    if (upperBody === 'DISCARD') return cancelPending(phoneNumber);

    if (upperBody === 'SKIP') {
      // SKIP uses the default agency (index 1 in agencyOptions)
      if (user) await logWithAgency(state.agencyOptions[1] || state.agencyOptions[0]);
      return true;
    }

    if (passesThrough(upperBody)) return false;

    await sendSmsReply(phoneNumber, text.AGENCY_CHOICE_REMINDER);
    return true;
  }

  async function handleConfirmStopState(phoneNumber, body, upperBody, state, traceId = null, user = null) {
    const trace = traceId || generateTraceId();
    const chosen = numberedChoice(body, state.stopCandidates);
    if (chosen) {
      if (user) {
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
          if (isPhoneConfirmed(user)) {
            handlers.fillPredictions(
              user, state.tripId, chosen.stopName, state.route, state.direction, state.agency, trace
            ).catch(() => {});
          }
          await sendSmsReply(phoneNumber, text.stopSet(chosen.stopName));
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

    if (upperBody === 'DISCARD') return cancelPending(phoneNumber, state.tripId);

    // SKIP dismisses the stop clarification without touching the trip —
    // DISCARD is too destructive when the rider just doesn't care which
    // physical stop it was.
    if (upperBody === 'SKIP') {
      await clearPendingState(phoneNumber);
      if (state.tripId) {
        await sendSmsReply(phoneNumber, text.STOP_SKIPPED);
      } else if (user) {
        await handlers.handleTripLog(
          phoneNumber, user, state.stopInput, state.route, state.direction,
          state.agency, { ...state.options, skipDisambiguation: true }, trace
        );
      }
      return true;
    }

    // Stop clarification is optional. Another command, another trip, or END/STOP
    // (the trip already exists and the rider may reach their destination before
    // ever picking a start stop) discards the old prompt and is processed normally.
    await clearPendingState(phoneNumber);
    return false;
  }

  /**
   * Route typo question (RYN-42). The trip already started with the texted route; a number
   * sets the route, and anything else leaves the trip as texted and is handled normally.
   * The boarding stop learns the route the trip ends up with (held back by handleTripLog
   * while the question is open, so a typo isn't learned as a route at that stop).
   */
  async function handleConfirmRouteState(phoneNumber, body, upperBody, state, traceId = null, user = null) {
    const chosen = numberedChoice(body, state.routeOptions || [], { strict: true });
    if (chosen) {
      if (user) {
        await clearPendingState(phoneNumber);
        if (chosen !== state.textedRoute && state.tripId) {
          await db.collection('trips').doc(state.tripId).update({
            route: chosen,
            routeTypoFrom: state.textedRoute,
          });
        }
        teachStopRoute(db, FieldValue, state.stopId, state.stopSource, chosen);
        await sendSmsReply(phoneNumber, text.routeSet(getRouteDisplay(chosen, state.direction)));
      }
      return true;
    }

    if (upperBody === 'DISCARD') return cancelPending(phoneNumber, state.tripId);

    // The question is optional: END, another trip, or any other command keeps the texted
    // route and is processed normally.
    teachStopRoute(db, FieldValue, state.stopId, state.stopSource, state.textedRoute);
    await clearPendingState(phoneNumber);
    return false;
  }

  async function handleMmsStopNeededState(phoneNumber, body, upperBody, state, traceId = null, user = null) {
    const trace = traceId || generateTraceId();
    if (upperBody === 'DISCARD') return cancelPending(phoneNumber);
    if (user && body.trim()) {
      await clearPendingState(phoneNumber);
      const stopReply = body.trim();
      if (state.routeCandidates.length === 1) {
        const chosen = state.routeCandidates[0];
        await handlers.handleTripLog(
          phoneNumber, user, stopReply, chosen.route, null, chosen.agency, mmsTripOptions(state.receivedAt), trace
        );
      } else {
        await setPendingState(phoneNumber, {
          type: 'confirm_mms_route',
          routeCandidates: state.routeCandidates,
          stopInput: stopReply,
          defaultAgency: state.defaultAgency,
          receivedAt: state.receivedAt,
        });
        await sendSmsReply(phoneNumber, text.mmsWhichRoute(state.routeCandidates.map(r => r.route)));
      }
    }
    return true;
  }

  async function handleConfirmMmsRouteState(phoneNumber, body, upperBody, state, traceId = null, user = null) {
    const trace = traceId || generateTraceId();
    const chosen = numberedChoice(body, state.routeCandidates);
    if (chosen) {
      if (user) {
        await clearPendingState(phoneNumber);
        await handlers.handleTripLog(
          phoneNumber, user, state.stopInput, chosen.route, null,
          chosen.agency || state.defaultAgency,
          mmsTripOptions(state.receivedAt),
          trace
        );
      }
      return true;
    }

    if (upperBody === 'DISCARD') return cancelPending(phoneNumber);

    if (passesThrough(upperBody, { notes: true })) return false;

    const count = (state.routeCandidates || []).length;
    await sendSmsReply(phoneNumber, text.mmsRouteReminder(count));
    return true;
  }

  async function handleConfirmStartState(phoneNumber, upperBody, state, traceId = null, user = null) {
    const trace = traceId || generateTraceId();
    if (upperBody === 'START') {
      if (user) await handlers.handleConfirmStart(phoneNumber, user, state, trace);
      return true;
    }

    const active = state.activeTrip;
    const activeDisplays = () => [
      getRouteDisplay(active.route, active.direction),
      getStopDisplay(active.startStopCode, active.startStopName, active.startStop),
    ];

    if (upperBody === 'DISCARD') {
      // Cancel the new trip attempt — old trip stays active
      const [routeDisplay, stopDisplay] = activeDisplays();
      await clearPendingState(phoneNumber);
      await sendSmsReply(phoneNumber, text.newTripCancelled(routeDisplay, stopDisplay));
      return true;
    }

    if (upperBody === 'FORGOT') {
      // Mark old trip incomplete and cancel the new trip attempt
      await db.collection('trips').doc(active.id).update(incompleteTripUpdate(active));
      const [routeDisplay, stopDisplay] = activeDisplays();
      await clearPendingState(phoneNumber);
      await sendSmsReply(phoneNumber, text.activeSavedNewCancelled(routeDisplay, stopDisplay));
      return true;
    }

    // STATUS/STATS/ASK/INFO fall through so their normal handlers can respond.
    if (passesThrough(upperBody)) return false;

    // Anything else (e.g. "1", another trip attempt) gets a reminder instead of
    // falling through to "Could not understand."
    const newTripDisplay = getRouteDisplay(state.newTrip?.route, state.newTrip?.direction);
    await sendSmsReply(phoneNumber, text.confirmStartReminder(newTripDisplay));
    return true;
  }

  async function handlePendingState(phoneNumber, body, upperBody, state, traceId = null, { locked = false, user = null } = {}) {
    const trace = traceId || generateTraceId();

    if (state.type === 'awaiting_verification' && /^\d{4,6}$/.test(body)) {
      await handlers.handleVerificationCode(phoneNumber, body, trace);
      return true;
    }

    if (state.type === 'awaiting_email') {
      // Let HELP/STATUS/etc. and an explicit "REGISTER [email]" retry fall through to their
      // normal handlers instead of being swallowed as a (malformed) email attempt — this is
      // the only pending state that used to lack this bypass.
      if (passesThrough(upperBody, { register: true })) return false;
      await handlers.handleRegister(phoneNumber, body.trim(), trace);
      return true;
    }

    const stateHandlers = {
      confirm_agency: () => handleConfirmAgencyState(phoneNumber, body, upperBody, state, trace, user),
      confirm_stop: () => handleConfirmStopState(phoneNumber, body, upperBody, state, trace, user),
      confirm_route: () => handleConfirmRouteState(phoneNumber, body, upperBody, state, trace, user),
      mms_stop_needed: () => handleMmsStopNeededState(phoneNumber, body, upperBody, state, trace, user),
      confirm_mms_route: () => handleConfirmMmsRouteState(phoneNumber, body, upperBody, state, trace, user),
      confirm_start: () => handleConfirmStartState(phoneNumber, upperBody, state, trace, user),
    };

    if (stateHandlers[state.type]) {
      // An unconfirmed number may only answer a trip prompt with a choice. DISCARD,
      // FORGOT, START (which would end the owner's trip) and the rest are left to
      // the main gate, and a prompt about the owner's active trip is never honoured.
      if (locked && (state.type === 'confirm_start' || !/^(\d+|SKIP)$/.test(upperBody.trim()))) return false;
      return stateHandlers[state.type]();
    }

    logger.warn('handlePendingState: unknown state type, falling through', { type: state.type, traceId: trace }, trace);
    return false;
  }

  return { handlePendingState };
}

module.exports = {
  createPendingHandlers,
};
