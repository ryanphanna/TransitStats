/**
 * Trip lifecycle handlers.
 */
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
  db,
  createTrip,
  getRecentCompletedTrips,
  getStopsLibrary,
  getRoutesAtStop,
  FieldValue,
  Timestamp,
} = require('./db');
const { getConfiguredPrimaryAgency } = require('./primary-agency');
const { PredictionEngineV3 } = require('./predict_v3');
const { NetworkEngine } = require('./network.js');
const { HabitEngine } = require('./habit');
const { isPhoneConfirmed, phoneTag, tripStartedByPhone } = require('./phone-confirmation');
const text = require('./sms-text');
const { incompleteTripUpdate, teachStopRoute } = require('./trip-updates');
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
} = require('./claude');
const { parseStopInput } = require('./parsing');

// V3 votes over a longer window (3.5.0): the eval showed the 100-trip window was V3's main
// coverage gap. V4/V5 eligibility keeps its original 100-trip window.
const { PREDICTION_HISTORY_LIMIT } = require('./constants');
const { buildEndStopContext } = require('./endstop-context');
const { suggestRouteCorrection } = require('./route-typo');
const {
  requestEngine,
  replyDefaultAgency,
  getMlReadiness,
  guessMlEndStops,
  getLoggedEndStopConstraint,
  detectLoggedTransfer,
  guessV3EndStops,
  predictionTripFields,
} = require('./trip-predictions');
const {
  agencySuffix,
  isStopMatched,
  resolveTripAgency,
  maybeHandleStopDisambiguation,
  getPredictionPrompt,
  getShownEndStopPredictions,
  getShownEndStopChoices,
  formatPredictionPrompt,
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



/** The trip-started reply. The trip is saved either way, so a failed send is only logged. */
function replyAfterTripCreated(phoneNumber, body, options) {
  return sendSmsReply(phoneNumber, body, options).catch(err => {
    console.error('sendSmsReply failed after createTrip — trip created but user not notified', err.message);
  });
}

/**
 * Handle trip logging
 */
async function handleTripLog(phoneNumber, user, stopInput, route, direction, agency, options = {}, traceId = null) {
  route = normalizeRoute(route);
  // A number the owner hasn't confirmed may only log trips: no history-based
  // help, and nothing that touches or reveals a trip it didn't start.
  const unconfirmed = !isPhoneConfirmed(user);
  if (unconfirmed) options = { ...options, unconfirmed: true };
  const activeTrip = await getActiveTrip(user.userId);
  if (unconfirmed && activeTrip) {
    await sendSmsReply(phoneNumber, text.LOCKED_TRIP_TEXT);
    return;
  }
  const parsedStop = parseStopInput(stopInput);
  if (!parsedStop.stopCode && !parsedStop.stopName) {
    await sendSmsReply(phoneNumber, text.BOARDING_STOP_UNKNOWN);
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
    await sendSmsReply(phoneNumber, text.AGENCY_UNKNOWN);
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
  const startStopCode = stopData ? stopData.stopCode : parsedStop.stopCode;
  const startStopName = stopData ? stopData.stopName : parsedStop.stopName;

  // Background: teach this stop which routes serve it, and promote gtfs→verified on first real trip.
  // Held back while the route-typo question is open, so a typo isn't learned as a route here.
  const teachStop = () => teachStopRoute(db, FieldValue, stopData?.id, stopData?.source, route);

  if (activeTrip) {
    teachStop();
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
        stopCode: startStopCode,
        stopName: startStopName,
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
    const message = text.activeTripConflict(
      stale, activeTripRouteDisplay, activeTripStopDisplay, elapsedMin, newTripRouteDisplay, stopDisplay
    );

    await sendSmsReply(phoneNumber, message);
    return;
  }

  // No active trip - generate predictions before creating trip
  let habitPrediction = null;
  const predictions = { endStopConstraintSource: 'none' };
  let isAdmin = false;
  let defaultAgency = null;
  let routeSuggestion = null;
  // Predictions read the owner's history, so an unconfirmed number skips them.
  if (!unconfirmed) try {
    const [history, stopsLibrary, profile, networkGraph, habits, adminStatus, experimentalIntelligence] = await Promise.all([
      getRecentCompletedTrips(user.userId, PREDICTION_HISTORY_LIMIT),
      getStopsLibrary(),
      getUserProfile(user.userId),
      NetworkEngine.load(db, user.userId, resolvedAgency, route),
      HabitEngine.load(db, user.userId),
      isEmailAdmin(user.email),
      isExperimentalIntelligenceEnabled(user.email),
    ]);
    const engine = requestEngine(stopsLibrary, networkGraph);
    isAdmin = adminStatus;
    defaultAgency = replyDefaultAgency(profile, history, resolvedAgency);
    const { eligibility, mlEndStopReady, mlReady } = await getMlReadiness(
      user, history, resolvedAgency, experimentalIntelligence
    );
    const now = new Date();
    logger.info('Prediction eligibility', {
      agency: resolvedAgency,
      cleanTripCount: eligibility.cleanTripCount,
      endStopEligible: eligibility.endStopEligible,
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
      version: `habit_v${HabitEngine.VERSION.split('.')[0]}`,
    } : null;
    // Shared with the weekly V4/V5 grading replay (scripts/weekly-shadow-grade.js), so both build
    // the same inputs.
    const endStopContext = buildEndStopContext({
      route,
      startStopName,
      direction,
      now,
      history,
      agency: resolvedAgency,
      primaryAgency: defaultAgency,
      stopsLibrary,
      networkGraph,
    });
    predictions.endStopConstraintSource = getLoggedEndStopConstraint(
      engine, endStopContext, 'Trip-start', traceId
    ).source;
    predictions.provisionalTransfer = await detectLoggedTransfer('Trip-start', {
      userId: user.userId, route, startStopName, agency: resolvedAgency, stopsLibrary, now, traceId,
    });

    // V3 end-stop guesses always run and are stored, even when a habit fires, so live
    // predictionStats stay complete and comparable. Only the SMS reply changes.
    // Route guesses are not made: the route arrives in the texted message.
    // V4/V5 only run when ML_ENDSTOP_LIVE is on, after the clean-history and artifact coverage checks.
    if (mlReady) {
      const { v4, v5 } = await guessMlEndStops(endStopContext);
      predictions.endStopPredictionV4 = v4;
      predictions.endStopPredictionV5 = v5;
    }
    const v3 = guessV3EndStops(engine, history, endStopContext, isAdmin);
    predictions.endStopPrediction = v3.prediction;
    predictions.endStopPredictions = v3.predictions;
    // Route typo check (RYN-42): admin-only for now, like end-stop suggestions. GTFS routes
    // at the stop are read only when the rider's history already points at a likely typo.
    if (isAdmin && isValidRoute(route)) {
      const typoArgs = { engine, history, startStopName, agency: resolvedAgency, route, now };
      if (suggestRouteCorrection(typoArgs)) {
        const routesAtStop = startStopCode ? await getRoutesAtStop(startStopCode, resolvedAgency) : null;
        routeSuggestion = suggestRouteCorrection({ ...typoArgs, routesAtStop });
      }
    }
  } catch (err) {
    console.error('Error generating prediction at trip start:', err);
  }
  if (!routeSuggestion) teachStop();

  let tripId;
  try {
    tripId = await createTrip({
      userId: user.userId,
      route,
      direction: direction || null,
      startStopCode,
      startStopName,
      stop_matched: stopMatched,
      sourcePhone: phoneTag(phoneNumber),
      agency: resolvedAgency,
      sentiment: options.sentiment || null,
      tags: options.tags || [],
      parsed_by: options.parsed_by || 'manual',
      vehicle: options.vehicle || null,
      startTime: options.startTime || null,
      source: options.source || null,
      timing_reliability: options.timing_reliability || null,
      habitPrediction: habitPrediction || null,
      ...predictionTripFields(predictions),
      needs_review: !isValidRoute(route) || null,
      // The route-typo question replaced the end-stop list, so END 1/2/3 must not pick from it.
      ...(routeSuggestion ? { routeTypoQuestion: true } : {}),
    });
  } catch (err) {
    console.error('createTrip failed', err.message, err.stack);
    await sendSmsReply(phoneNumber, text.TRIP_START_FAILED);
    return;
  }

  const routeDisplay = getRouteDisplay(route, direction);
  const finalStopDisplay = getStopDisplay(startStopCode, startStopName);

  // Warm agency timezone cache in background — never blocks trip confirmation
  if (resolvedAgency) lookupAgencyTimezone(resolvedAgency, traceId).catch(() => {});

  if (routeSuggestion && tripId) {
    // The trip is already saved with the texted route; the question only offers to change it.
    // It replaces the end-stop list, whose END 1/2/3 numbers would clash with these.
    const routeOptions = [routeSuggestion.route, route];
    await setPendingState(phoneNumber, {
      type: 'confirm_route',
      tripId,
      routeOptions,
      textedRoute: route,
      direction: direction || null,
      agency: resolvedAgency,
      stopId: stopData?.id || null,
      stopSource: stopData?.source || null,
    });
    let typoReply = text.routeTypoPrompt(
      routeDisplay, finalStopDisplay, agencySuffix(resolvedAgency, defaultAgency), routeOptions
    );
    typoReply += await getAchievementNote(user.userId);
    await replyAfterTripCreated(phoneNumber, typoReply);
    return;
  }

  let replyBody = text.tripStarted(routeDisplay, finalStopDisplay, agencySuffix(resolvedAgency, defaultAgency));
  // End-stop suggestions are admin-only; non-admins always get the plain END/FORGOT prompt.
  // On a habit trip the usual end stop leads the list; END n in handleEndTrip uses the same list.
  // The same list sets the RCS END n buttons (switched off unless config/rcsButtons enables it).
  const shownChoices = isAdmin ? getShownEndStopChoices(predictions.endStopPredictions, habitPrediction) : [];
  replyBody += isAdmin
    ? formatPredictionPrompt(shownChoices)
    : getPredictionPrompt(null);

  // Add achievement note if applicable
  if (!unconfirmed) replyBody += await getAchievementNote(user.userId);

  const startReplyOptions = shownChoices?.length ? { endButtons: shownChoices.length } : undefined;
  await replyAfterTripCreated(phoneNumber, replyBody, startReplyOptions);
}

/**
 * Handle confirmation of start after active trip
 */
async function handleConfirmStart(phoneNumber, user, state, traceId = null) {
  // Starting over would mark the owner's active trip incomplete.
  if (!isPhoneConfirmed(user)) {
    await sendSmsReply(phoneNumber, text.LOCKED_TRIP_TEXT);
    return;
  }
  const activeTrip = state.activeTrip;
  const newTrip = state.newTrip;

  const oldTripRouteDisplay = getRouteDisplay(activeTrip.route, activeTrip.direction);

  let confirmDefaultAgency = 'TTC';
  const predictions = { endStopConstraintSource: 'none' };
  let confirmIsAdmin = false;
  let newStopData = null;
  try {
    const [history, stopsLibrary, confirmProfile, confirmNetworkGraph, confirmAdminStatus, experimentalIntelligence] = await Promise.all([
      getRecentCompletedTrips(user.userId, PREDICTION_HISTORY_LIMIT),
      getStopsLibrary(),
      getUserProfile(user.userId),
      NetworkEngine.load(db, user.userId, newTrip.agency, newTrip.route),
      isEmailAdmin(user.email),
      isExperimentalIntelligenceEnabled(user.email),
    ]);
    const engine = requestEngine(stopsLibrary, confirmNetworkGraph);
    confirmIsAdmin = confirmAdminStatus;
    confirmDefaultAgency = replyDefaultAgency(confirmProfile, history, newTrip.agency);
    const { mlReady } = await getMlReadiness(user, history, newTrip.agency, experimentalIntelligence);
    const now = new Date();
    const lastTrip = history.length > 0 ? history[0] : null;
    const lastEndStopName = lastTrip?.endStopName || lastTrip?.endStop || null;

    // Resolve hubId for the new trip
    newStopData = await lookupStop(newTrip.stopCode, newTrip.stopName, newTrip.agency, newTrip.route, newTrip.direction);

    const confirmEndStopContext = { route: newTrip.route, startStopName: newTrip.stopName, direction: newTrip.direction, time: now, lastEndStopName, agency: newTrip.agency, stopsLibrary, networkGraph: confirmNetworkGraph || null };
    predictions.endStopConstraintSource = getLoggedEndStopConstraint(
      engine, confirmEndStopContext, 'Confirm-start', traceId
    ).source;
    predictions.provisionalTransfer = await detectLoggedTransfer('Confirm-start', {
      userId: user.userId,
      route: newTrip.route,
      startStopName: newTrip.stopName,
      agency: newTrip.agency,
      stopsLibrary,
      now,
      traceId,
    });
    if (mlReady) {
      const { v4, v5 } = await guessMlEndStops(confirmEndStopContext);
      predictions.endStopPredictionV4 = v4;
      predictions.endStopPredictionV5 = v5;
    }
    const v3 = guessV3EndStops(engine, history, confirmEndStopContext, confirmIsAdmin);
    predictions.endStopPrediction = v3.prediction;
    predictions.endStopPredictions = v3.predictions;
  } catch (err) {
    console.error('Error generating prediction at confirm start:', err);
  }

  await db.collection('trips').doc(activeTrip.id).update(incompleteTripUpdate(activeTrip));

  await createTrip({
    sourcePhone: phoneTag(phoneNumber),
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
    ...predictionTripFields(predictions),
  });
  await clearPendingState(phoneNumber);

  const newStopDisplay = getStopDisplay(newTrip.stopCode, newTrip.stopName);
  const newRouteDisplay = getRouteDisplay(newTrip.route, normalizeDirection(newTrip.direction));

  let confirmReplyBody = text.startedAfterIncomplete(
    oldTripRouteDisplay, newRouteDisplay, newStopDisplay, agencySuffix(newTrip.agency, confirmDefaultAgency)
  );
  const confirmShown = confirmIsAdmin ? getShownEndStopPredictions(predictions.endStopPredictions) : [];
  confirmReplyBody += formatPredictionPrompt(confirmShown);

  // Add achievement note if applicable
  const achievementNote = await getAchievementNote(user.userId);
  confirmReplyBody += achievementNote;

  await sendSmsReply(phoneNumber, confirmReplyBody,
    confirmShown?.length ? { endButtons: confirmShown.length } : undefined);
}

/**
 * Handle ending a trip
 */
/**
 * Whether the route typed with END fits the open trip: the same route in any case, or the base
 * route of a branch ("END 510" ends a 510A or 510B trip). A branch never ends a different branch
 * or the plain route ("END 510A" does not end a 510B or 510 trip).
 */
function endRouteMatches(activeRoute, typedRoute) {
  const active = String(activeRoute ?? '').trim().toLowerCase();
  const typed = String(typedRoute ?? '').trim().toLowerCase();
  if (!active || !typed) return false;
  if (active === typed) return true;
  return /^\d+$/.test(typed) && PredictionEngineV3._baseRoute(active) === typed;
}

async function handleEndTrip(phoneNumber, user, endStopInput, routeVerification = null, notes = null, traceId = null) {
  const activeTrip = await getActiveTrip(user.userId);
  const unconfirmed = !isPhoneConfirmed(user);

  // An unconfirmed number can only end a trip it started itself; anything else
  // gets the same neutral reply, so it can't tell whether a trip exists.
  if (unconfirmed && (!activeTrip || !tripStartedByPhone(activeTrip, phoneNumber))) {
    await sendSmsReply(phoneNumber, text.LOCKED_TRIP_TEXT);
    return;
  }

  if (!activeTrip) {
    await sendSmsReply(phoneNumber, text.NO_ACTIVE_TRIP_TO_END);
    return;
  }

  const routeDisplay = getRouteDisplay(activeTrip.route, activeTrip.direction);

  if (routeVerification && !endRouteMatches(activeTrip.route, routeVerification)) {
    await sendSmsReply(phoneNumber, text.routeMismatch(routeDisplay, routeVerification));
    return;
  }

  const [endProfile, endIsAdmin] = await Promise.all([
    getUserProfile(user.userId),
    isEmailAdmin(user.email),
  ]);
  const endDefaultAgency = getConfiguredPrimaryAgency(endProfile) || activeTrip.agency || null;

  // Resolve numbered shortcut (admin only): END 1/2/3 → the stop list shown at boarding.
  // A habit trip listed the usual end stop first; getShownEndStopChoices rebuilds that exact list.
  if (/^[123]$/.test((endStopInput || '').trim())) {
    const shown = getShownEndStopChoices(activeTrip.endStopPredictions, activeTrip.habitPrediction);
    if (endIsAdmin && shown?.length && !activeTrip.routeTypoQuestion) {
      const idx = parseInt(endStopInput.trim(), 10) - 1;
      const predicted = shown[idx];
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

  const endStopCodeFinal = endStopData ? endStopData.stopCode : parsedEndStop.stopCode;
  const endStopNameFinal = endStopData ? endStopData.stopName : parsedEndStop.stopName;
  const endStopDisplay = getStopDisplay(endStopCodeFinal, endStopNameFinal);

  await db.collection('trips').doc(activeTrip.id).update({
    endStopCode: endStopCodeFinal,
    endStopName: endStopNameFinal,
    endHubId: endStopData?.hubId || null,
    endTime: endTime,
    duration: duration,
    notes: notes || null,
    stop_matched: isStopMatched(activeTrip) && (endStopData !== null),
  });

  if (unconfirmed) {
    // Just the facts of the trip this number started: no journey, anomaly or
    // suggestion notes (they draw on the owner's history), no profile updates.
    await sendSmsReply(phoneNumber, text.tripEndedBasic(routeDisplay, endStopDisplay, duration));
    return;
  }

  // Detect previous trip for journey linking (used only for the immediate reply note).
  // The actual linking write happens in the background finalizer.
  let prevTrip = null;
  try {
    prevTrip = await finalization.detectJourneyLink(activeTrip);
  } catch (err) {
    console.error('Error detecting journey link for reply note:', err);
  }

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
    text.tripEnded(
      routeDisplay, endStopDisplay, agencySuffix(agency, endDefaultAgency), duration,
      `${journeyNote}${anomalyNote}${nextLegNote}`
    )
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
  endRouteMatches,
  handleTripLog,
  handleConfirmStart,
  handleEndTrip,
  recomputeAndUpdatePrimaryAgency,
};
