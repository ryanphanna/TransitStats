/**
 * Shared handler utilities — no exported command handlers.
 */
const {
  sendSmsReply,
} = require('./twilio');
const {
  setPendingState,
  lookupStopCheck,
  findMatchingStops,
  getRoutesAtStop,
  getUserProfile,
  createTrip,
  getLastTripAgency,
  getTripCount,
} = require('./db');
const { getConfiguredPrimaryAgency } = require('./primary-agency');
const {
  getStopDisplay,
  getRouteDisplay,
  getStopCandidateDirection,
  collapseEquivalentStopCandidates,
  normalizeRoute,
  isValidRoute,
} = require('./utils');
const { AGENCY_CITY } = require('./constants');
const { phoneTag } = require('./phone-confirmation');
const text = require('./sms-text');
const { normalizeStopLabel } = require('./topology-constraints');

/**
 * Returns " via [Agency]" if the trip agency differs from the user's default, otherwise "".
 * @param {string} tripAgency
 * @param {string} defaultAgency
 * @returns {string}
 */
function agencySuffix(tripAgency, defaultAgency) {
  if (!tripAgency || !defaultAgency || tripAgency === defaultAgency) return '';
  return text.viaAgency(tripAgency);
}

// Returns the city label for an agency to use in disambiguation prompts.
// Falls back to the agency name if both options share the same city (e.g. LA Metro vs LADOT).
function getDisambiguationLabel(agency, otherAgency) {
  const city = AGENCY_CITY[agency];
  const otherCity = AGENCY_CITY[otherAgency];
  if (!city || city === otherCity) return agency;
  return city;
}

async function promptAgencyChoice(
  phoneNumber, stopDisplay, route, direction, stopInput, options, lastAgency, defaultAgency
) {
  await setPendingState(phoneNumber, {
    type: 'confirm_agency',
    route,
    direction,
    stopInput,
    options,
    agencyOptions: [lastAgency, defaultAgency],
  });
  await sendSmsReply(phoneNumber, text.agencyChoicePrompt(stopDisplay, lastAgency, defaultAgency));
}

async function resolveTripAgency(
  phoneNumber, userId, parsedStop, route, direction, agency, options, stopInput, stopDisplay
) {
  // An unconfirmed number gets no help from the owner's profile or history.
  const userProfile = options.unconfirmed ? undefined : await getUserProfile(userId);
  const configuredAgency = getConfiguredPrimaryAgency(userProfile);
  let resolvedAgency = agency || configuredAgency;
  if (options.agencyExplicit || options.unconfirmed) return { resolvedAgency, handled: false };

  const lastAgency = await getLastTripAgency(userId);
  if (!lastAgency || lastAgency === resolvedAgency) return { resolvedAgency, handled: false };

  // Guessing which agency a stop belongs to must never write or depend on Atlas (numeric codes
  // resolve through Atlas almost anywhere): read-only check against the library only.
  const [defaultCheck, lastCheck] = await Promise.all([
    lookupStopCheck(parsedStop.stopCode, parsedStop.stopName, resolvedAgency, route, direction, { atlas: false }),
    lookupStopCheck(parsedStop.stopCode, parsedStop.stopName, lastAgency, route, direction, { atlas: false }),
  ]);
  const stopInDefault = defaultCheck.status === 'found' ? defaultCheck.stop : null;
  const stopInLast = lastCheck.status === 'found' ? lastCheck.stop : null;

  if (stopInDefault && stopInLast) {
    const defaultAgency = configuredAgency || resolvedAgency;
    await promptAgencyChoice(phoneNumber, stopDisplay, route, direction, stopInput, options, lastAgency, defaultAgency);
    return { resolvedAgency, handled: true };
  }

  if (stopInLast) {
    resolvedAgency = lastAgency;
    return { resolvedAgency, handled: false };
  }

  if (stopInDefault) {
    // Stop only exists in the default agency — use it silently, no prompt needed.
    return { resolvedAgency, handled: false };
  }

  // Neither has it — infer last trip's agency (unverified).
  resolvedAgency = lastAgency;
  return { resolvedAgency, handled: false };
}

async function narrowStopCandidates(candidates, route, direction, agency = null) {
  // Fold duplicate records of one station first (platforms, punctuation twins), keeping their routes.
  let narrowed = collapseEquivalentStopCandidates(await enrichStopCandidatesWithRoutes(candidates, agency), { strict: true, direction });
  if (narrowed.length > 1 && route) {
    // Filter by route — keep stops that serve this route (or have no route data)
    const routeFiltered = narrowed.filter(c =>
      !c.routes || c.routes.length === 0 ||
      c.routes.some(r => normalizeRoute(r) === normalizeRoute(route))
    );
    if (routeFiltered.length >= 1) narrowed = routeFiltered;
  }
  const hasRouteEvidence = !route || narrowed.every(candidate => (
    Array.isArray(candidate.routes) &&
    candidate.routes.some(r => normalizeRoute(r) === normalizeRoute(route))
  ));
  if (hasRouteEvidence) narrowed = collapseEquivalentStopCandidates(narrowed, { direction });
  // Further narrow by direction if provided and candidates still ambiguous
  if (narrowed.length > 1 && direction) {
    const normalize = value => value?.toString().trim().toLowerCase().replace(/bound$/, '');
    const requestedDirection = normalize(direction);
    const compatible = narrowed.filter(candidate => {
      const candidateDirection = normalize(getStopCandidateDirection(candidate));
      return !candidateDirection || candidateDirection === requestedDirection;
    });
    const dirFiltered = compatible.filter(candidate => (
      normalize(getStopCandidateDirection(candidate)) === requestedDirection
    ));
    // Prefer an exact direction match when one exists; otherwise keep neutral
    // station records and discard explicitly opposite-direction platforms.
    if (dirFiltered.length >= 1) narrowed = dirFiltered;
    else if (compatible.length >= 1) narrowed = compatible;
  }
  if (narrowed.length > 1 && route) {
    const modePreferred = preferCandidatesByRouteMode(narrowed, route);
    if (modePreferred.length >= 1) narrowed = modePreferred;
  }
  return narrowed;
}

async function enrichStopCandidatesWithRoutes(candidates, agency) {
  if (!agency || !Array.isArray(candidates) || candidates.length === 0) return candidates;

  return Promise.all(candidates.map(async (candidate) => {
    if (!candidate.stopCode || (candidate.routes && candidate.routes.length > 0)) return candidate;

    try {
      const routes = await getRoutesAtStop(candidate.stopCode, agency);
      return routes && routes.length > 0 ? { ...candidate, routes } : candidate;
    } catch (_) {
      return candidate;
    }
  }));
}

function preferCandidatesByRouteMode(candidates, route) {
  const routeMode = inferRouteMode(route);
  if (routeMode === 'unknown') return candidates;

  const preferred = candidates.filter(candidate => candidateMatchesRouteMode(candidate, routeMode));
  return preferred.length > 0 ? preferred : candidates;
}

function inferRouteMode(route) {
  const routeStr = route?.toString().trim();
  if (!routeStr) return 'unknown';
  if (/^[1-6]$/.test(routeStr)) return 'rapid';
  if (/^5\d\d/.test(routeStr)) return 'surface';
  if (/^\d+/.test(routeStr)) return 'surface';
  return 'unknown';
}

function candidateMatchesRouteMode(candidate, routeMode) {
  const stopName = candidate?.stopName?.toString() || '';
  const hasDirection = !!getStopCandidateDirection(candidate);
  const isStationLike = /\bstation\b/i.test(stopName);
  const isSurfaceNamed = /\/| at |&/i.test(stopName);

  if (routeMode === 'rapid') {
    return isStationLike || !hasDirection;
  }

  if (routeMode === 'surface') {
    if (hasDirection) return true;
    if (isSurfaceNamed) return true;
    return !isStationLike;
  }

  return true;
}

function isStopMatched(trip) {
  if (!trip) return false;
  if (trip.stop_matched != null) return !!trip.stop_matched;
  return !!trip.verified;
}

async function maybeHandleStopDisambiguation({
  phoneNumber, user, activeTrip, parsedStop, route, direction, resolvedAgency, options,
}) {
  if (options?.skipDisambiguation) return false;
  if (parsedStop.stopCode || !parsedStop.stopName) return false;

  const candidates = await narrowStopCandidates(
    await findMatchingStops(parsedStop.stopName, resolvedAgency, route, direction),
    route,
    direction,
    resolvedAgency
  );
  if (candidates.length <= 1) return false;
  const stopDisplay = getStopDisplay(parsedStop.stopCode, parsedStop.stopName);

  if (!activeTrip) {
    let tripId;
    try {
      tripId = await createTrip({
        userId: user.userId,
        route,
        direction: direction || null,
        startStopCode: null,
        startStopName: parsedStop.stopName || null,
        startStop: null,
        stop_matched: false,
        sourcePhone: phoneTag(phoneNumber),
        agency: resolvedAgency,
        sentiment: options.sentiment || null,
        tags: options.tags || [],
        parsed_by: options.parsed_by || 'manual',
        startTime: options.startTime || null,
        source: options.source || null,
        timing_reliability: options.timing_reliability || null,
        endStopPrediction: null,
        endStopPredictions: null,
        endStopPredictionV4: null,
        endStopPredictionV5: null,
        needs_review: !isValidRoute(route) || null,
      });
    } catch (err) {
      console.error('createTrip failed during stop disambiguation', err.message);
      await sendSmsReply(phoneNumber, text.TRIP_START_FAILED);
      return true;
    }
    await setPendingState(phoneNumber, {
      type: 'confirm_stop',
      tripId,
      stopCandidates: candidates.map(candidate => ({
        stopCode: candidate.stopCode || null,
        stopName: candidate.stopName || candidate.name || stopDisplay,
      })),
      route,
      direction: direction || null,
      agency: resolvedAgency,
    });
    const routeDisplay = getRouteDisplay(route, direction);
    const listed = candidates.map(candidate => ({
      name: candidate.stopName || candidate.name,
      code: candidate.stopCode,
    }));
    await sendSmsReply(phoneNumber, text.stopMatchesMultiple(routeDisplay, stopDisplay, listed));
    return true;
  }

  // An ambiguous stop must never block a new trip or require a follow-up.
  // Keep the active-trip conflict flow intact; handleTripLog will ask whether
  // the existing trip should be completed before starting this one.
  return false;
}

// Admin SMS only lists end-stop guesses this confident. Weaker guesses (mostly V3 backoff
// tiers) are still stored and graded, but never shown, so END n can't pick one either.
// 60 since V3 3.6.0 (sample-size-scaled confidence): the lowest gate where the first shown
// suggestion is still right about 3 times in 4 on the replay (ml/EVAL.md). The habit's usual
// stop is shown whenever it fires, independent of this gate.
const SHOWN_END_STOP_MIN_CONFIDENCE = 60;

/**
 * The stored end-stop guesses an admin is shown, in stored order. END 1/2/3 resolve
 * against this same list, so the numbers always match the SMS.
 */
function getShownEndStopPredictions(predictions) {
  return (predictions || []).filter(p => p && p.confidence >= SHOWN_END_STOP_MIN_CONFIDENCE);
}

/**
 * The numbered end-stop list an admin sees at boarding. On a habit trip the usual end stop
 * is #1, then the shown stored guesses that aren't the same stop, max 3. The start reply and
 * END 1/2/3 both use this, so the numbers can't drift apart.
 */
function getShownEndStopChoices(predictions, habitPrediction) {
  const shown = getShownEndStopPredictions(predictions);
  const habitStop = habitPrediction?.endStop;
  if (!habitStop) return shown;
  const habitKey = normalizeStopLabel(habitStop);
  const others = shown.filter(p => normalizeStopLabel(p.stop) !== habitKey);
  return [{ stop: habitStop }, ...others].slice(0, 3);
}

/**
 * Build a conversational prediction prompt for the user.
 */
function getPredictionPrompt(rawPredictions) {
  return formatPredictionPrompt(getShownEndStopPredictions(rawPredictions));
}

/** Prompt text for an already-filtered list of shown stops (see getShownEndStopChoices). */
function formatPredictionPrompt(predictions) {
  return text.endStopPrompt((predictions || []).map(p => p.stop));
}

/**
 * Checks for transit milestones and returns a celebratory note if reached.
 * @param {string} userId
 * @returns {Promise<string>}
 */
async function getAchievementNote(userId) {
  try {
    const count = await getTripCount(userId);
    return text.achievementNote(count);
  } catch (err) {
    console.error('getAchievementNote failed', err);
    return '';
  }
}

module.exports = {
  agencySuffix,
  getDisambiguationLabel,
  promptAgencyChoice,
  resolveTripAgency,
  narrowStopCandidates,
  isStopMatched,
  maybeHandleStopDisambiguation,
  getPredictionPrompt,
  getShownEndStopPredictions,
  getShownEndStopChoices,
  formatPredictionPrompt,
  SHOWN_END_STOP_MIN_CONFIDENCE,
  getAchievementNote,
};
