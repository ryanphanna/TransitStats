/**
 * Shared handler utilities — no exported command handlers.
 */
const {
  sendSmsReply,
} = require('./twilio');
const {
  setPendingState,
  lookupStop,
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

/**
 * Pick the best V4/V5 route prediction that GTFS confirms actually serves this stop.
 * If routesAtStop is empty/null (no GTFS data), fall back to the top prediction.
 * Suppresses predictions below 25% confidence regardless.
 *
 * @param {Array} topRoutes - Sorted [{route, confidence, version}] from guessTopRoutes()
 * @param {Array|null} routesAtStop - Routes known to serve this stop from GTFS, or null
 * @returns {Object|null}
 */
function correctPredictionByGtfs(topRoutes, routesAtStop) {
  if (!topRoutes || topRoutes.length === 0) return null;
  const baseRoute = r => r.toString().replace(/[a-zA-Z]+$/, '').trim();
  if (routesAtStop && routesAtStop.length > 0) {
    const known = new Set(routesAtStop.map(r => baseRoute(r)));
    return topRoutes.find(p => p.confidence >= 25 && known.has(baseRoute(p.route))) || null;
  }
  const top = topRoutes[0];
  return top.confidence >= 25 ? top : null;
}

/**
 * Returns " via [Agency]" if the trip agency differs from the user's default, otherwise "".
 * @param {string} tripAgency
 * @param {string} defaultAgency
 * @returns {string}
 */
function agencySuffix(tripAgency, defaultAgency) {
  if (!tripAgency || !defaultAgency || tripAgency === defaultAgency) return '';
  return ` via ${tripAgency}`;
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
  await sendSmsReply(
    phoneNumber,
    `Which ${stopDisplay}?
1. ${lastAgency}
2. ${defaultAgency}

Reply 1, 2, or SKIP to use default.`
  );
}

async function resolveTripAgency(
  phoneNumber, userId, parsedStop, route, direction, agency, options, stopInput, stopDisplay
) {
  const userProfile = await getUserProfile(userId);
  const configuredAgency = getConfiguredPrimaryAgency(userProfile);
  let resolvedAgency = agency || configuredAgency;
  if (options.agencyExplicit) return { resolvedAgency, handled: false };

  const lastAgency = await getLastTripAgency(userId);
  if (!lastAgency || lastAgency === resolvedAgency) return { resolvedAgency, handled: false };

  const [stopInDefault, stopInLast] = await Promise.all([
    lookupStop(parsedStop.stopCode, parsedStop.stopName, resolvedAgency, route, direction),
    lookupStop(parsedStop.stopCode, parsedStop.stopName, lastAgency, route, direction),
  ]);

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
  let narrowed = await enrichStopCandidatesWithRoutes(candidates, agency);
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
  if (hasRouteEvidence) narrowed = collapseEquivalentStopCandidates(narrowed);
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
        agency: resolvedAgency,
        sentiment: options.sentiment || null,
        tags: options.tags || [],
        parsed_by: options.parsed_by || 'manual',
        startTime: options.startTime || null,
        source: options.source || null,
        timing_reliability: options.timing_reliability || null,
        prediction: null,
        predictionV4: null,
        predictionV5: null,
        endStopPrediction: null,
        endStopPredictions: null,
        endStopPredictionV4: null,
        endStopPredictionV5: null,
        needs_review: !isValidRoute(route) || null,
      });
    } catch (err) {
      console.error('createTrip failed during stop disambiguation', err.message);
      await sendSmsReply(phoneNumber, 'Could not start your trip. Please try again.');
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
    const candidateList = candidates
      .map((candidate, index) => `${index + 1}. ${candidate.stopName || candidate.name}${candidate.stopCode ? ` (${candidate.stopCode})` : ''}`)
      .join('\n');
    await sendSmsReply(
      phoneNumber,
      `${routeDisplay} started from ${stopDisplay}, but I found multiple possible boarding stops:\n${candidateList}\n\nReply with a number to set the stop, SKIP to leave it unverified, or DISCARD to cancel the trip.`
    );
    return true;
  }

  // An ambiguous stop must never block a new trip or require a follow-up.
  // Keep the active-trip conflict flow intact; handleTripLog will ask whether
  // the existing trip should be completed before starting this one.
  return false;
}

/**
 * Build a conversational prediction prompt for the user.
 */
function getPredictionPrompt(predictions) {
  if (!predictions || predictions.length === 0) {
    return '\n\nEND [stop] to finish. FORGOT if forgot to end.';
  }

  const shortcutNums = predictions.map((_, i) => i + 1).join('/');

  if (predictions.length === 1) {
    const p = predictions[0];
    return `\n\nHeading to ${p.stop}? END 1 to end.\n\nEND [stop] to finish. FORGOT if forgot to end.`;
  }

  const predLines = predictions.map((p, i) => `${i + 1}. ${p.stop}`).join('\n');
  const shortcuts = predictions.map((_, i) => `END ${i + 1}`).join(', ');
  const lastComma = shortcuts.lastIndexOf(', ');
  const shortcutStr = lastComma >= 0
    ? shortcuts.slice(0, lastComma) + ', or ' + shortcuts.slice(lastComma + 2)
    : shortcuts;
  return `\n\nWhere to?\n${predLines}\n\n${shortcutStr} to end.\n\nEND [stop] to finish. FORGOT if forgot to end.`;
}

/**
 * Checks for transit milestones and returns a celebratory note if reached.
 * @param {string} userId
 * @returns {Promise<string>}
 */
async function getAchievementNote(userId) {
  try {
    const count = await getTripCount(userId);
    const milestones = {
      1: '🎉 Your 1st trip! Welcome to the network.',
      10: '🔟 Your 10th trip! Frequent Rider status.',
      25: '🏅 Your 25th trip! System Regular status.',
      50: '🥈 Your 50th trip! Commuter Pro status.',
      100: '🥇 Your 100th trip! Network Veteran status.',
      250: '👑 Your 250th trip! Elite Commuter status.',
      500: '🏟️ Your 500th trip! System Analyst status.',
      1000: '🌌 Your 1,000th trip! Transit Authority status.',
    };
    return milestones[count] ? `\n\n${milestones[count]}` : '';
  } catch (err) {
    console.error('getAchievementNote failed', err);
    return '';
  }
}

module.exports = {
  correctPredictionByGtfs,
  agencySuffix,
  getDisambiguationLabel,
  promptAgencyChoice,
  resolveTripAgency,
  narrowStopCandidates,
  isStopMatched,
  maybeHandleStopDisambiguation,
  getPredictionPrompt,
  getAchievementNote,
};
