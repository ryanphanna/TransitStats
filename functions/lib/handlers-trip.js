/**
 * Trip lifecycle handlers.
 */
const { randomUUID } = require('crypto');
const {
  sendSmsReply,
} = require('./twilio');
const {
  getActiveTrip,
  setPendingState,
  clearPendingState,
  getUserProfile,
  isEmailAdmin,
  isExperimentalIntelligenceEnabled,
  lookupStop,
  findMatchingStops,
  getRoutesAtStop,
  db,
  createTrip,
  getRecentCompletedTrips,
  getStopsLibrary,
  FieldValue,
  Timestamp,
} = require('./db');
const { getConfiguredPrimaryAgency } = require('./primary-agency');
const { PredictionEngine } = require('./predict.js');
const { TransferEngine } = require('./transfer.js');
const { NetworkEngine } = require('./network.js');
const { HabitEngine } = require('./habit');
const { PredictionEngineV4 } = require('./predict_v4.js');
const { PredictionEngineV5 } = require('./predict_v5.js');
const logger = require('./logger');
const finalization = require('./finalization');
const { checkMlTasks } = require('./ml-tasks');
const {
  getStopDisplay,
  getRouteDisplay,
  normalizeDirection,
  normalizeRoute,
  isValidRoute,
  determineReliability,
} = require('./utils');
const {
  lookupAgencyTimezone,
} = require('./gemini');
const { parseStopInput } = require('./parsing');
const { getEligibility, artifactSupportsAgency } = require('./intelligence-eligibility');
const routeV4Meta = require('./model_v4_meta.json');
const routeV5Meta = require('./model_v5_meta.json');
const endStopV4Meta = require('./model_v4_endstop_meta.json');
const endStopV5Meta = require('./model_v5_endstop_meta.json');
const {
  correctPredictionByGtfs,
  agencySuffix,
  isStopMatched,
  resolveTripAgency,
  maybeHandleStopDisambiguation,
  getPredictionPrompt,
  getAchievementNote,
} = require('./handlers-utils');

/**
 * Determine if an active trip is likely stale (forgotten).
 * Uses NetworkEngine data to compare elapsed time vs typical travel duration.
 */
async function determineStaleness(db, userId, activeTrip) {
  const elapsedMin = Math.round((Date.now() - activeTrip.startTime.toDate().getTime()) / 60000);

  // If > 6 hours, it's definitely stale (hard cutoff)
  if (elapsedMin > 360) return { stale: true, reason: 'hard_cutoff', elapsedMin };

  // Try route-aware staleness
  try {
    const graph = await NetworkEngine.load(db, userId, activeTrip.agency, activeTrip.route);
    const median = NetworkEngine.getMedianDuration(graph, activeTrip.startStopName, new Date().getHours());

    if (median) {
      // If elapsed time is > 2x the median duration AND at least 45 minutes
      // (guards against very short trips being flagged too early)
      if (elapsedMin > Math.max(median * 2, 45)) {
        return { stale: true, reason: 'route_aware', elapsedMin, median };
      }
    }
  } catch (err) {
    console.error('Staleness check failed', err.message);
  }

  return { stale: false, elapsedMin };
}

async function detectProvisionalTransfer(userId, nextTrip, agency, boardingStop, stopsLibrary = []) {
  try {
    const history = await getRecentCompletedTrips(userId, 100);
    const networkConnections = (agency && boardingStop)
      ? await NetworkEngine.getConnectionsAtStop(db, agency, boardingStop)
      : null;

    let best = null;
    for (const trip of history) {
      if (!trip.endTime || !trip.endStopName) continue;
      const confidence = TransferEngine.score(trip, nextTrip, history, networkConnections);
      if (confidence < TransferEngine.CONFIDENCE_THRESHOLD) continue;
      if (!best || confidence > best.confidence) best = { trip, confidence };
    }

    if (!best) return null;
    return {
      prevTripId: best.trip.id,
      confidence: best.confidence,
      prevRoute: best.trip.route || null,
    };
  } catch (err) {
    console.error('Error detecting provisional transfer:', err);
    return null;
  }
}

/**
 * Handle trip logging
 */
async function handleTripLog(phoneNumber, user, stopInput, route, direction, agency, options = {}, traceId = null) {
  route = normalizeRoute(route);
  const activeTrip = await getActiveTrip(user.userId);
  const parsedStop = parseStopInput(stopInput);
  if (!parsedStop.stopCode && !parsedStop.stopName) {
    await sendSmsReply(phoneNumber, 'I could not identify the boarding stop. Send the route and stop again.');
    return;
  }
  const stopDisplay = getStopDisplay(parsedStop.stopCode, parsedStop.stopName);

  const { resolvedAgency, handled } = await resolveTripAgency(
    phoneNumber,
    user.userId,
    parsedStop,
    route,
    direction,
    agency,
    options,
    stopInput,
    stopDisplay
  );
  if (handled) return;
  if (!resolvedAgency) {
    await sendSmsReply(phoneNumber, 'I could not identify the transit agency. Include it on a new line, such as TTC or GO Transit.');
    return;
  }

  // Ambiguous stop check: if the user gave a name (not a code), see if it matches
  // multiple stops in the resolved agency. If no active trip conflict, start the
  // trip immediately so boarding time is captured, then resolve the stop async.
  const disambiguationHandled = await maybeHandleStopDisambiguation({
    phoneNumber,
    user,
    activeTrip,
    parsedStop,
    route,
    direction,
    resolvedAgency,
    options,
  });
  if (disambiguationHandled) return;

  const stopData = await lookupStop(parsedStop.stopCode, parsedStop.stopName, resolvedAgency, route, direction);
  const stopMatched = stopData !== null;

  // Background: teach this stop which routes serve it, and promote gtfs→verified on first real trip
  if (stopData?.id && route) {
    const stopUpdate = { routes: FieldValue.arrayUnion(route) };
    if (stopData.source === 'gtfs') stopUpdate.source = 'verified';
    db.collection('stops').doc(stopData.id).update({
      ...stopUpdate,
    }).catch(() => {});
  }

  if (activeTrip) {
    const activeTripRouteDisplay = getRouteDisplay(activeTrip.route, activeTrip.direction);
    const newTripRouteDisplay = getRouteDisplay(route, direction);
    const { stale, elapsedMin } = await determineStaleness(db, user.userId, activeTrip);

    await setPendingState(phoneNumber, {
      type: 'confirm_start',
      activeTrip: {
        id: activeTrip.id,
        route: activeTrip.route,
        direction: activeTrip.direction || null,
        startStopCode: activeTrip.startStopCode || null,
        startStopName: activeTrip.startStopName || null,
        startStop: activeTrip.startStop || null,
        startTime: activeTrip.startTime,
        agency: activeTrip.agency || null,
      },
      newTrip: {
        stopCode: stopData ? stopData.stopCode : parsedStop.stopCode,
        stopName: stopData ? stopData.stopName : parsedStop.stopName,
        route,
        direction,
        agency,
        stopMatched,
        sentiment: options.sentiment || null,
        tags: options.tags || [],
        parsed_by: options.parsed_by || 'manual',
        vehicle: options.vehicle || null,
      },
    });

    const activeTripStopDisplay = getStopDisplay(activeTrip.startStopCode, activeTrip.startStopName, activeTrip.startStop);
    const timePhrase = `${elapsedMin} min ago`;
    const promptPrefix = stale
      ? `${activeTripRouteDisplay} from ${activeTripStopDisplay} looks like it ended (started ${timePhrase}).`
      : `${activeTripRouteDisplay} from ${activeTripStopDisplay} was not ended (started ${timePhrase}).`;

    const message = `${promptPrefix}

START to begin ${newTripRouteDisplay} from ${stopDisplay}, and save ${activeTripRouteDisplay} from ${activeTripStopDisplay} as incomplete.

FORGOT to save as incomplete. DISCARD to cancel new trip.`;

    await sendSmsReply(phoneNumber, message);
    return;
  }

  // No active trip - generate predictions before creating trip
  let prediction = null;
  let predictionV4 = null;
  let predictionV5 = null;
  let habitPrediction = null;
  let endStopPrediction = null;
  let endStopPredictions = null;
  let endStopPredictionV4 = null;
  let endStopPredictionV5 = null;
  let endStopConstraintSource = 'none';
  let provisionalTransfer = null;
  const startStopName = stopData ? stopData.stopName : parsedStop.stopName;
  const startStopCode = stopData ? stopData.stopCode : parsedStop.stopCode;
  let isAdmin = false;
  let defaultAgency = null;
  try {
    const [history, stopsLibrary, routesAtStop, profile, networkGraph, habits, adminStatus, experimentalIntelligence] = await Promise.all([
      getRecentCompletedTrips(user.userId, 100),
      getStopsLibrary(),
      getRoutesAtStop(startStopCode, resolvedAgency),
      getUserProfile(user.userId),
      NetworkEngine.load(db, user.userId, resolvedAgency, route),
      HabitEngine.load(db, user.userId),
      isEmailAdmin(user.email),
      isExperimentalIntelligenceEnabled(user.email),
    ]);
    PredictionEngine.stopsLibrary = stopsLibrary;
    PredictionEngine.networkGraph = networkGraph || null;
    isAdmin = adminStatus;
    defaultAgency = getConfiguredPrimaryAgency(profile)
      || history.find(trip => trip.agency)?.agency
      || resolvedAgency
      || null;
    const now = new Date();
    const eligibility = getEligibility(history, resolvedAgency);
    const mlRouteReady = eligibility.routeEligible &&
      artifactSupportsAgency(routeV4Meta, resolvedAgency) && artifactSupportsAgency(routeV5Meta, resolvedAgency);
    const mlEndStopReady = eligibility.endStopEligible &&
      artifactSupportsAgency(endStopV4Meta, resolvedAgency) && artifactSupportsAgency(endStopV5Meta, resolvedAgency);
    const mlReady = experimentalIntelligence && (mlRouteReady || mlEndStopReady);
    logger.info('Prediction eligibility', {
      agency: resolvedAgency,
      cleanTripCount: eligibility.cleanTripCount,
      routeEligible: eligibility.routeEligible,
      endStopEligible: eligibility.endStopEligible,
      routeArtifactReady: mlRouteReady,
      endStopArtifactReady: mlEndStopReady,
      traceId,
    }, traceId);
    const habitMatch = HabitEngine.match(habits, startStopName, now, { route, direction, agency: resolvedAgency });
    habitPrediction = habitMatch ? {
      stop: habitMatch.stop,
      route: habitMatch.route,
      direction: habitMatch.direction,
      endStop: habitMatch.endStop || null,
      confidence: habitMatch.confidence,
      count: habitMatch.count,
      version: 'habit_v1',
    } : null;
    const habitFired = habitPrediction !== null;
    const lastTrip = history.length > 0 ? history[0] : null;
    const lastEndStopName = lastTrip?.endStopName || lastTrip?.endStop || null;
    const lastRoute = lastTrip?.route || null;
    const minutesSinceLastTrip = lastTrip?.startTime?.toDate
      ? Math.max(0, Math.round((now.getTime() - lastTrip.startTime.toDate().getTime()) / 60000))
      : null;
    const routeContext = {
      stopName: startStopName,
      time: now,
      lastEndStopName,
      lastRoute,
      agency: resolvedAgency,
      stopsLibrary,
      primaryAgency: defaultAgency,
    };
    const endStopContext = {
      route,
      startStopName,
      direction,
      time: now,
      lastEndStopName,
      lastRoute,
      minutesSinceLastTrip,
      agency: resolvedAgency,
      primaryAgency: defaultAgency,
      stopsLibrary,
      networkGraph: networkGraph || null,
    };
    const endStopConstraint = PredictionEngine.getEndStopConstraint(endStopContext);
    endStopConstraintSource = endStopConstraint.source;
    logger.info('Trip-start end-stop constraint', {
      route,
      startStopName,
      direction,
      constraintSource: endStopConstraint.source,
      legalStopCount: endStopConstraint.legalStops ? endStopConstraint.legalStops.size : null,
      traceId,
    }, traceId);
    provisionalTransfer = await detectProvisionalTransfer(user.userId, {
      route,
      startStopName,
      startStop: startStopName,
      startTime: now,
    }, resolvedAgency, startStopName, stopsLibrary);
    if (provisionalTransfer) {
      logger.info('Trip-start provisional transfer detected', {
        route,
        startStopName,
        prevTripId: provisionalTransfer.prevTripId,
        prevRoute: provisionalTransfer.prevRoute,
        confidence: provisionalTransfer.confidence,
        traceId,
      }, traceId);
    }

    // When a habit fires with sufficient confidence, skip the full ML stack —
    // the habit is a memorized pattern and is more reliable than inference on routine trips.
    if (!habitFired) {
      prediction = PredictionEngine.guess(history, {
        stopName: startStopName,
        time: now,
        routesAtStop: routesAtStop || undefined,
        lastEndStopName,
        agency: resolvedAgency,
      });
      // Experimental models only run after both clean-history and artifact coverage checks.
      if (mlReady) {
        const [rawTopV4, rawTopV5, topEndV4, topEndV5] = await Promise.all([
          mlRouteReady ? Promise.resolve(PredictionEngineV4.guessTopRoutes(routeContext, 5)) : [],
          mlRouteReady ? PredictionEngineV5.guessTopRoutes(routeContext, 5) : [],
          mlEndStopReady ? PredictionEngineV4.guessTopEndStops(endStopContext, 1) : [],
          mlEndStopReady ? PredictionEngineV5.guessTopEndStops(endStopContext, 1) : [],
        ]);
        // Correct: pick best prediction that GTFS confirms serves this stop; floor at 25%
        predictionV4 = correctPredictionByGtfs(rawTopV4, routesAtStop);
        predictionV5 = correctPredictionByGtfs(rawTopV5, routesAtStop);
        if (topEndV4.length > 0) endStopPredictionV4 = topEndV4[0];
        if (topEndV5.length > 0) endStopPredictionV5 = topEndV5[0];
      }
      endStopPrediction = PredictionEngine.guessEndStop(history, endStopContext);
      if (isAdmin) {
        const top = PredictionEngine.guessTopEndStops(history, endStopContext, 3);
        if (top.length > 0) endStopPredictions = top;
      }
    }
  } catch (err) {
    console.error('Error generating prediction at trip start:', err);
  }

  try {
    await createTrip({
      userId: user.userId,
      route,
      direction: direction || null,
      startStopCode: stopData ? stopData.stopCode : parsedStop.stopCode,
      startStopName,
      stop_matched: stopMatched,
      agency: resolvedAgency,
      sentiment: options.sentiment || null,
      tags: options.tags || [],
      parsed_by: options.parsed_by || 'manual',
      vehicle: options.vehicle || null,
      startTime: options.startTime || null,
      source: options.source || null,
      timing_reliability: options.timing_reliability || null,
      prediction: prediction || null,
      predictionV4: predictionV4 || null,
      predictionV5: predictionV5 || null,
      habitPrediction: habitPrediction || null,
      endStopPrediction: endStopPrediction || null,
      endStopPredictions: endStopPredictions || null,
      endStopPredictionV4: endStopPredictionV4 || null,
      endStopPredictionV5: endStopPredictionV5 || null,
      endStopConstraintSource,
      provisionalTransfer: !!provisionalTransfer,
      provisionalPrevTripId: provisionalTransfer?.prevTripId || null,
      provisionalJourneyConfidence: provisionalTransfer?.confidence || null,
      needs_review: !isValidRoute(route) || null,
    });
  } catch (err) {
    console.error('createTrip failed', err.message, err.stack);
    await sendSmsReply(phoneNumber, 'Could not start your trip. Please try again.');
    return;
  }

  const routeDisplay = getRouteDisplay(route, direction);
  const finalStopDisplay = getStopDisplay(
    stopData ? stopData.stopCode : parsedStop.stopCode,
    stopData ? stopData.stopName : parsedStop.stopName,
  );

  // Warm agency timezone cache in background — never blocks trip confirmation
  if (resolvedAgency) lookupAgencyTimezone(resolvedAgency, traceId).catch(() => {});

  let replyBody = `Started ${routeDisplay} from ${finalStopDisplay}${agencySuffix(resolvedAgency, defaultAgency)}.`;
  if (habitPrediction?.endStop) {
    replyBody += `\n\nUsual trip to ${habitPrediction.endStop}.`;
  } else {
    replyBody += getPredictionPrompt(isAdmin ? endStopPredictions : null);
  }

  // Add achievement note if applicable
  const achievementNote = await getAchievementNote(user.userId);
  replyBody += achievementNote;

  await sendSmsReply(phoneNumber, replyBody).catch(err => {
    console.error('sendSmsReply failed after createTrip — trip created but user not notified', err.message);
  });
}

/**
 * Handle confirmation of start after active trip
 */
async function handleConfirmStart(phoneNumber, user, state, traceId = null) {
  const activeTrip = state.activeTrip;
  const newTrip = state.newTrip;

  const oldTripRouteDisplay = getRouteDisplay(activeTrip.route, activeTrip.direction);

  let confirmDefaultAgency = 'TTC';
  let confirmPrediction = null;
  let confirmPredictionV4 = null;
  let confirmPredictionV5 = null;
  let confirmEndStopPrediction = null;
  let confirmEndStopPredictions = null;
  let confirmEndStopPredictionV4 = null;
  let confirmEndStopPredictionV5 = null;
  let confirmEndStopConstraintSource = 'none';
  let confirmIsAdmin = false;
  let confirmProvisionalTransfer = null;
  let newStopData = null;
  try {
    const [history, stopsLibrary, routesAtStop, confirmProfile, confirmNetworkGraph, confirmAdminStatus, experimentalIntelligence] = await Promise.all([
      getRecentCompletedTrips(user.userId, 100),
      getStopsLibrary(),
      getRoutesAtStop(newTrip.stopCode, newTrip.agency),
      getUserProfile(user.userId),
      NetworkEngine.load(db, user.userId, newTrip.agency, newTrip.route),
      isEmailAdmin(user.email),
      isExperimentalIntelligenceEnabled(user.email),
    ]);
    PredictionEngine.stopsLibrary = stopsLibrary;
    confirmIsAdmin = confirmAdminStatus;
    confirmDefaultAgency = getConfiguredPrimaryAgency(confirmProfile)
      || history.find(trip => trip.agency)?.agency
      || newTrip.agency
      || null;
    const now = new Date();
    const confirmEligibility = getEligibility(history, newTrip.agency);
    const confirmMlRouteReady = confirmEligibility.routeEligible &&
      artifactSupportsAgency(routeV4Meta, newTrip.agency) && artifactSupportsAgency(routeV5Meta, newTrip.agency);
    const confirmMlEndStopReady = confirmEligibility.endStopEligible &&
      artifactSupportsAgency(endStopV4Meta, newTrip.agency) && artifactSupportsAgency(endStopV5Meta, newTrip.agency);
    const confirmMlReady = experimentalIntelligence && (confirmMlRouteReady || confirmMlEndStopReady);
    const lastTrip = history.length > 0 ? history[0] : null;
    const lastEndStopName = lastTrip?.endStopName || lastTrip?.endStop || null;
    
    // Resolve hubId for the new trip
    newStopData = await lookupStop(newTrip.stopCode, newTrip.stopName, newTrip.agency, newTrip.route, newTrip.direction);
    
    const confirmRouteContext = { stopName: newTrip.stopName, time: now, lastEndStopName, agency: newTrip.agency, stopsLibrary };
    const confirmEndStopContext = { route: newTrip.route, startStopName: newTrip.stopName, direction: newTrip.direction, time: now, lastEndStopName, agency: newTrip.agency, stopsLibrary, networkGraph: confirmNetworkGraph || null };
    const confirmEndStopConstraint = PredictionEngine.getEndStopConstraint(confirmEndStopContext);
    confirmEndStopConstraintSource = confirmEndStopConstraint.source;
    logger.info('Confirm-start end-stop constraint', {
      route: newTrip.route,
      startStopName: newTrip.stopName,
      direction: newTrip.direction,
      constraintSource: confirmEndStopConstraint.source,
      legalStopCount: confirmEndStopConstraint.legalStops ? confirmEndStopConstraint.legalStops.size : null,
      traceId,
    }, traceId);
    confirmProvisionalTransfer = await detectProvisionalTransfer(user.userId, {
      route: newTrip.route,
      startStopName: newTrip.stopName,
      startStop: newTrip.stopName,
      startTime: now,
    }, newTrip.agency, newTrip.stopName, stopsLibrary);
    if (confirmProvisionalTransfer) {
      logger.info('Confirm-start provisional transfer detected', {
        route: newTrip.route,
        startStopName: newTrip.stopName,
        prevTripId: confirmProvisionalTransfer.prevTripId,
        prevRoute: confirmProvisionalTransfer.prevRoute,
        confidence: confirmProvisionalTransfer.confidence,
        traceId,
      });
    }
    confirmPrediction = PredictionEngine.guess(history, {
      stopName: newTrip.stopName,
      time: now,
      routesAtStop: routesAtStop || undefined,
      lastEndStopName,
      agency: newTrip.agency,
    });
    if (confirmMlReady) {
      const [confirmRawV4, confirmRawV5, confirmTopV4, confirmTopV5] = await Promise.all([
        confirmMlRouteReady ? Promise.resolve(PredictionEngineV4.guessTopRoutes(confirmRouteContext, 5)) : [],
        confirmMlRouteReady ? PredictionEngineV5.guessTopRoutes(confirmRouteContext, 5) : [],
        confirmMlEndStopReady ? PredictionEngineV4.guessTopEndStops(confirmEndStopContext, 1) : [],
        confirmMlEndStopReady ? PredictionEngineV5.guessTopEndStops(confirmEndStopContext, 1) : [],
      ]);
      confirmPredictionV4 = correctPredictionByGtfs(confirmRawV4, routesAtStop);
      confirmPredictionV5 = correctPredictionByGtfs(confirmRawV5, routesAtStop);
      if (confirmTopV4.length > 0) confirmEndStopPredictionV4 = confirmTopV4[0];
      if (confirmTopV5.length > 0) confirmEndStopPredictionV5 = confirmTopV5[0];
    }
    confirmEndStopPrediction = PredictionEngine.guessEndStop(history, confirmEndStopContext);
    if (confirmIsAdmin) {
      const top = PredictionEngine.guessTopEndStops(history, confirmEndStopContext, 3);
      if (top.length > 0) confirmEndStopPredictions = top;
    }
  } catch (err) {
    console.error('Error generating prediction at confirm start:', err);
  }

  await db.collection('trips').doc(activeTrip.id).update({
    incomplete: true,
    endTime: activeTrip.startTime,
    exitLocation: null,
    duration: null,
  });

  await createTrip({
    userId: user.userId,
    route: newTrip.route,
    direction: newTrip.direction || null,
    startStopCode: newTrip.stopCode,
    startStopName: newTrip.stopName,
    startHubId: newStopData?.hubId || null,
    stop_matched: newTrip.stopMatched || false,
    agency: newTrip.agency,
    timing_reliability: determineReliability(state.expiresAt),
    sentiment: newTrip.sentiment || null,
    tags: newTrip.tags || [],
    parsed_by: newTrip.parsed_by || 'manual',
    vehicle: newTrip.vehicle || null,
    prediction: confirmPrediction || null,
    predictionV4: confirmPredictionV4 || null,
    predictionV5: confirmPredictionV5 || null,
    endStopPrediction: confirmEndStopPrediction || null,
    endStopPredictions: confirmEndStopPredictions || null,
    endStopPredictionV4: confirmEndStopPredictionV4 || null,
    endStopPredictionV5: confirmEndStopPredictionV5 || null,
    endStopConstraintSource: confirmEndStopConstraintSource,
    provisionalTransfer: !!confirmProvisionalTransfer,
    provisionalPrevTripId: confirmProvisionalTransfer?.prevTripId || null,
    provisionalJourneyConfidence: confirmProvisionalTransfer?.confidence || null,
  });
  await clearPendingState(phoneNumber);

  const newStopDisplay = getStopDisplay(newTrip.stopCode, newTrip.stopName);
  const newRouteDisplay = getRouteDisplay(newTrip.route, normalizeDirection(newTrip.direction));

  let confirmReplyBody = `${oldTripRouteDisplay} marked as incomplete.\n\nStarted ${newRouteDisplay} from ${newStopDisplay}${agencySuffix(newTrip.agency, confirmDefaultAgency)}.`;
  confirmReplyBody += getPredictionPrompt(confirmIsAdmin ? confirmEndStopPredictions : null);

  // Add achievement note if applicable
  const achievementNote = await getAchievementNote(user.userId);
  confirmReplyBody += achievementNote;

  await sendSmsReply(phoneNumber, confirmReplyBody);
}

/**
 * Handle ending a trip
 */
async function handleEndTrip(phoneNumber, user, endStopInput, routeVerification = null, notes = null, traceId = null) {
  const activeTrip = await getActiveTrip(user.userId);

  if (!activeTrip) {
    await sendSmsReply(phoneNumber, 'No active trip to end.');
    return;
  }

  if (routeVerification) {
    const activeRoute = activeTrip.route.toString().toLowerCase();
    const verifyRoute = routeVerification.toString().toLowerCase();
    if (activeRoute !== verifyRoute) {
      await sendSmsReply(
        phoneNumber,
        `Route mismatch. Active trip is ${getRouteDisplay(activeTrip.route, activeTrip.direction)}, ` +
        `not Route ${routeVerification}.`,
      );
      return;
    }
  }

  const [endProfile, endIsAdmin] = await Promise.all([
    getUserProfile(user.userId),
    isEmailAdmin(user.email),
  ]);
  const endDefaultAgency = getConfiguredPrimaryAgency(endProfile) || activeTrip.agency || null;

  // Resolve numbered shortcut (admin only): END 1/2/3 → predicted stop name
  if (/^[123]$/.test((endStopInput || '').trim())) {
    if (endIsAdmin && activeTrip.endStopPredictions?.length) {
      const idx = parseInt(endStopInput.trim(), 10) - 1;
      const predicted = activeTrip.endStopPredictions[idx];
      if (predicted) endStopInput = predicted.stop;
    }
  }

  const parsedEndStop = parseStopInput(endStopInput);
  const endTime = Timestamp.now();
  const startTime = activeTrip.startTime.toDate();
  const duration = Math.round((endTime.toDate().getTime() - startTime.getTime()) / 60000);

  const agency = activeTrip.agency || null;
  const tripRoute = activeTrip.route || null;
  const tripDirection = activeTrip.direction || null;

  // Apply the same route+direction candidate filtering used at boarding — the
  // active trip already has both, so we can almost always auto-select with no prompt.
  let endStopData = null;
  if (!parsedEndStop.stopCode && parsedEndStop.stopName) {
    let endCandidates = await findMatchingStops(parsedEndStop.stopName, agency, tripRoute, null);
    if (endCandidates.length > 1 && tripRoute) {
      const routeFiltered = endCandidates.filter(c =>
        !c.routes || c.routes.length === 0 ||
        c.routes.some(r => normalizeRoute(r) === normalizeRoute(tripRoute))
      );
      if (routeFiltered.length >= 1) endCandidates = routeFiltered;
    }
    if (endCandidates.length > 1 && tripDirection) {
      const dirFiltered = endCandidates.filter(c =>
        !c.direction || c.direction.toLowerCase() === tripDirection.toLowerCase()
      );
      if (dirFiltered.length >= 1) endCandidates = dirFiltered;
    }
    if (endCandidates.length === 1) {
      endStopData = endCandidates[0];
    }
  }
  if (!endStopData) {
    endStopData = await lookupStop(parsedEndStop.stopCode, parsedEndStop.stopName, agency, tripRoute, null);
  }

  const endStopDisplay = getStopDisplay(
    endStopData ? endStopData.stopCode : parsedEndStop.stopCode,
    endStopData ? endStopData.stopName : parsedEndStop.stopName,
  );

  const endStopNameFinal = endStopData ? endStopData.stopName : parsedEndStop.stopName;

  await db.collection('trips').doc(activeTrip.id).update({
    endStopCode: endStopData ? endStopData.stopCode : parsedEndStop.stopCode,
    endStopName: endStopNameFinal,
    endHubId: endStopData?.hubId || null,
    endTime: endTime,
    duration: duration,
    notes: notes || null,
    stop_matched: isStopMatched(activeTrip) && (endStopData !== null),
  });

  // Detect previous trip for journey linking (used only for the immediate reply note).
  // The actual linking write happens in the background finalizer.
  let prevTrip = null;
  try {
    prevTrip = await finalization.detectJourneyLink(activeTrip);
  } catch (err) {
    console.error('Error detecting journey link for reply note:', err);
  }

  const routeDisplay = getRouteDisplay(activeTrip.route, activeTrip.direction);

  // === Post-end architecture note ===
  // All heavy side effects (grading, network learning, habit rebuild, journey write)
  // now run in the background via the Firestore trigger + runPostEndFinalization.
  // The handler below only computes the minimal data needed for the immediate SMS reply.
  const { journeyNote } = await finalization.computeJourneyLink(activeTrip, prevTrip, startTime);

  const [anomalyNote, nextLegNote] = await Promise.all([
    finalization.detectAnomaly(activeTrip, endStopNameFinal, duration, agency),
    finalization.getNextLegSuggestion(activeTrip, endStopNameFinal, agency, journeyNote),
  ]);

  await sendSmsReply(
    phoneNumber,
    `Ended ${routeDisplay} at ${endStopDisplay}${agencySuffix(agency, endDefaultAgency)} (${duration} min trip)` +
    `${journeyNote}${anomalyNote}${nextLegNote}\n\nReply NOTES (your note) to add a note.`
  );

  // Recompute the user's primary agency from recent trips (makes defaultAgency dynamic)
  recomputeAndUpdatePrimaryAgency(user.userId).catch(() => {});

  // Check if any ML check-in tasks have hit their trip threshold
  checkMlTasks(user.userId).catch(() => {});
}

/**
 * Recomputes a user's primary/default agency from their most recent completed trips
 * and updates the profile if it has changed.
 *
 * This makes defaultAgency dynamic and based on actual recent behavior
 * instead of only manual UI selection.
 */
async function recomputeAndUpdatePrimaryAgency(userId, dbClient = null) {
  if (!userId) return;

  const dbToUse = dbClient || db;
  if (!dbToUse) return;

  try {
    const snapshot = await dbToUse.collection('trips')
      .where('userId', '==', userId)
      .orderBy('endTime', 'desc')
      .limit(100)
      .get();

    if (snapshot.empty) return;

    const completedTrips = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.endStopName !== null && data.endStopName !== undefined) {
        completedTrips.push(data);
      }
    });

    const recentCompleted = completedTrips.slice(0, 25);
    if (recentCompleted.length === 0) return;

    const agencyCounts = {};
    let mostRecentAgency = null;

    recentCompleted.forEach(data => {
      const ag = data.agency;
      if (!ag) return;
      agencyCounts[ag] = (agencyCounts[ag] || 0) + 1;
      if (!mostRecentAgency) mostRecentAgency = ag;
    });

    // Pick the agency with highest count; tie-break by most recent
    let bestAgency = mostRecentAgency;
    let bestCount = -1;
    for (const [ag, count] of Object.entries(agencyCounts)) {
      if (count > bestCount) {
        bestCount = count;
        bestAgency = ag;
      }
    }

    if (!bestAgency) return;

    // Read current profile
    const profileRef = dbToUse.collection('profiles').doc(userId);
    const profileSnap = await profileRef.get();
    const profile = profileSnap.exists ? profileSnap.data() : {};
    if (profile.defaultAgencyMode === 'automatic') {
      const current = profile.primaryAgency || null;
      if (current !== bestAgency) {
        await profileRef.set({ primaryAgency: bestAgency, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        console.log(`[primary-agency] Updated user ${userId} primaryAgency: ${current || 'none'} → ${bestAgency}`);
      }
    }
  } catch (err) {
    console.error('[primary-agency] Failed to recompute for user', userId, err);
  }
}

module.exports = {
  determineStaleness,
  handleTripLog,
  handleConfirmStart,
  handleEndTrip,
  recomputeAndUpdatePrimaryAgency,
};
