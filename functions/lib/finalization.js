/**
 * Post-trip finalization logic.
 * Extracted from handleEndTrip so the same functions can be called
 * from both the SMS handler and future background triggers.
 */

const { randomUUID } = require('crypto');
const {
  getRecentCompletedTrips,
  getStopsLibrary,
  lookupStop,
  lookupStopCheck,
  db,
  FieldValue,
  hasBlockingCorrection,
} = require('./db');
const { PredictionEngine } = require('./predict.js');
const { NetworkEngine } = require('./network.js');
const { HabitEngine } = require('./habit');
const { TransferEngine } = require('./transfer.js');
const {
  getRouteDisplay,
} = require('./utils');
const { timezoneForAgency } = require('./constants');
const logger = require('./logger');
const text = require('./sms-text');

async function gradeAllPredictions(activeTrip, user, endStopData, duration) {
  const actualEndStop = endStopData ? endStopData.stopName : (activeTrip.endStopName || '');

  try {
    // Per-call engine so grading never depends on (or touches) another request's data.
    const engine = Object.create(PredictionEngine);
    engine.stopsLibrary = await getStopsLibrary();
    // Route guesses are no longer made (the route arrives in the texted message), so only
    // end stops are graded (V3/V4/V5/Habit). Route guesses already stored on older trips are left ungraded.
    const es = async (pred, version) => {
      if (!pred) return;
      const hit = engine._stopMatch(pred.stop, actualEndStop);
      await db.collection('predictionStats').add({
        tripId: activeTrip.id, userId: user.userId, endStopPredicted: pred.stop, endStopActual: actualEndStop,
        endStopHit: hit, endStopConfidence: pred.confidence, version, route: activeTrip.route, agency: activeTrip.agency, source: 'sms', timestamp: FieldValue.serverTimestamp()
      });
    };

    const gradingPromises = [];
    gradingPromises.push(es(activeTrip.endStopPrediction, 'v3-endstop'));
    gradingPromises.push(es(activeTrip.endStopPredictionV4, 'v4-endstop'));
    gradingPromises.push(es(activeTrip.endStopPredictionV5, 'v5-endstop'));
    // habitPrediction.stop is the STARTING stop the habit matched on, not the
    // predicted end stop — must remap to .endStop or this grades the wrong field.
    if (activeTrip.habitPrediction?.endStop) {
      gradingPromises.push(es({ stop: activeTrip.habitPrediction.endStop, confidence: activeTrip.habitPrediction.confidence }, 'habit-endstop'));
    }
    await Promise.all(gradingPromises);

  } catch (err) {
    logger.error('gradeAllPredictions failed', { error: err.message, tripId: activeTrip.id });
  }
}

async function computeJourneyLink(activeTrip, prevTrip, startTime) {
  let journeyNote = '';
  let journeyId = null;

  if (prevTrip) {
    journeyId = prevTrip.journeyId || activeTrip.journeyId || randomUUID();

    const prevEnd = prevTrip.endTime.toDate ? prevTrip.endTime.toDate() : new Date(prevTrip.endTime);
    const gapStr = Math.round((startTime - prevEnd) / 60000);
    journeyNote = text.journeyLinkedNote(getRouteDisplay(prevTrip.route), gapStr);
  }

  return { journeyNote, journeyId };
}

async function applyJourneyLink(activeTrip, prevTrip, journeyId) {
  if (!prevTrip || !journeyId) return;

  try {
    const batch = db.batch();
    batch.update(db.collection('trips').doc(prevTrip.id), { journeyId });
    batch.update(db.collection('trips').doc(activeTrip.id), { journeyId });
    await batch.commit();
  } catch (err) {
    logger.error('applyJourneyLink failed', { error: err.message, tripId: activeTrip.id });
  }
}

/**
 * Detects whether the current trip should be linked as a journey/transfer
 * with a previous trip. Returns the best matching previous trip (or null).
 * Used by both the handler (for immediate reply note) and background finalization.
 */
async function detectJourneyLink(activeTrip, recentTrips = null) {
  let history = recentTrips;

  if (!history) {
    history = await getRecentCompletedTrips(activeTrip.userId, 100);
  }

  const boardingStop = activeTrip.startStopName || activeTrip.startStop || null;
  const [networkConnections, stopsLibrary] = await Promise.all([
    (activeTrip.agency && boardingStop) ? NetworkEngine.getConnectionsAtStop(db, activeTrip.agency, boardingStop) : Promise.resolve(null),
    getStopsLibrary(),
  ]);

  let prevTrip = null;

  if (activeTrip.provisionalPrevTripId) {
    const provisional = history.find(t => t.id === activeTrip.provisionalPrevTripId);
    if (provisional && provisional.endTime && provisional.endStopName) {
      const conf = TransferEngine.score(provisional, activeTrip, history, networkConnections, stopsLibrary);
      if (conf >= TransferEngine.CONFIDENCE_THRESHOLD) {
        prevTrip = provisional;
      }
    }
  }

  if (!prevTrip) {
    prevTrip = history.find(t => {
      if (t.id === activeTrip.id) return false;
      if (!t.endTime || !t.endStopName) return false;
      const conf = TransferEngine.score(t, activeTrip, history, networkConnections, stopsLibrary);
      return conf >= TransferEngine.CONFIDENCE_THRESHOLD;
    }) || null;
  }

  return prevTrip;
}

async function detectAnomaly(activeTrip, endStopNameFinal, duration, agency) {
  try {
    const startHour = new Date(activeTrip.startTime.toDate()).getHours();
    // Use personal graph only — the global (all-users) graph would flag anomalies
    // based on other people's trips, not the user's own history.
    const personalDoc = await db.collection('networkGraph')
      .doc(NetworkEngine._docId(activeTrip.userId, agency, activeTrip.route))
      .get();
    if (!personalDoc.exists) return '';
    const graph = personalDoc.data();

    // Only use the specific start→end edge — the boarding-stop-wide fallback
    // averages across different destinations and produces misleading "typical" times.
    const typicalMinutes = NetworkEngine.getEdgeMedianDuration(graph, activeTrip.startStopName, endStopNameFinal, startHour);

    if (typicalMinutes && typicalMinutes >= 5 && duration >= typicalMinutes * 2) {
      return text.slowTripNote(duration, typicalMinutes);
    }
  } catch (err) {
    logger.error('detectAnomaly failed', { error: err.message });
  }
  return '';
}

async function getNextLegSuggestion(activeTrip, endStopNameFinal, agency, journeyNote) {
  if (journeyNote) return '';
  if (!endStopNameFinal || !agency) return '';

  try {
    const [connections, connLabels] = await Promise.all([
      NetworkEngine.getConnectionsAtStop(db, agency, endStopNameFinal),
      NetworkEngine.getConnectionLabels(db, agency, endStopNameFinal),
    ]);
    const fromKey = NetworkEngine._key(activeTrip.route.toString());
    const prefix = `${fromKey}_to_`;
    let bestConnKey = null;
    let bestCount = 0;

    for (const [k, count] of Object.entries(connections)) {
      if (k.startsWith(prefix) && count > bestCount) {
        bestCount = count;
        bestConnKey = k;
      }
    }
    if (bestConnKey && bestCount >= 2) {
      const toLabel = connLabels[bestConnKey] || bestConnKey.slice(prefix.length);
      return text.nextLegNote(toLabel);
    }
  } catch (err) {
    logger.error('getNextLegSuggestion failed', { error: err.message });
  }
  return '';
}

async function triggerPostEndLearning(activeTrip, user, endStopData, prevTrip, duration) {
  // Support being called from background trigger (where endStopData may be null)
  const endStop = endStopData || {
    stopCode: activeTrip.endStopCode,
    stopName: activeTrip.endStopName,
  };

  // Teach the network graph
  if (activeTrip.startStopName && activeTrip.direction && endStop.stopName) {
    const startStopCanonical = await lookupStop(activeTrip.startStopCode, activeTrip.startStopName, activeTrip.agency);
    if (startStopCanonical) {
      NetworkEngine.observe(db, user.userId, {
        route: activeTrip.route,
        agency: activeTrip.agency,
        direction: activeTrip.direction,
        startStop: startStopCanonical,
        endStop: endStop,
        duration,
      }, prevTrip?.route || null).catch(err => logger.error('NetworkEngine.observe failed', { error: err.message }));
    }
  }

  // Rebuild habit model (non-blocking)
  getRecentCompletedTrips(user.userId, 200)
    .then(allTrips => HabitEngine.rebuild(db, user.userId, allTrips))
    .catch(err => logger.error('HabitEngine.rebuild failed', { error: err.message }));
}

async function autoConfirmStopMatch(tripData, endStopData) {
  if (!tripData || tripData.stop_matched === true || !endStopData) return false;

  const [startStop, endStop] = await Promise.all([
    lookupStop(
      tripData.startStopCode,
      tripData.startStopName || tripData.startStop,
      tripData.agency,
      tripData.route,
      tripData.direction
    ),
    lookupStop(
      endStopData.stopCode,
      endStopData.stopName,
      tripData.agency,
      tripData.route,
      tripData.direction
    ),
  ]);

  if (!startStop || !endStop) return false;
  tripData.stop_matched = true;
  return true;
}

// Fields whose change can alter whether a trip's stops resolve to known stops. Route-only and
// direction-only edits are skipped on purpose (they do not change which stops were named).
const STOP_MATCH_INPUT_FIELDS = [
  'startStopCode', 'startStopName', 'startStop',
  'endStopCode', 'endStopName', 'endStop',
  'agency',
];

function stopMatchInputsChanged(before, after) {
  return STOP_MATCH_INPUT_FIELDS.some(field => (before?.[field] ?? null) !== (after?.[field] ?? null));
}

/**
 * Re-checks whether an ended trip's boarding and exit stops resolve to known stops after a
 * correction changed the stop or agency fields. Unlike the one-way auto-confirm at END, this can
 * also flip a trip back to unmatched when the corrected values no longer resolve. It never writes
 * a result it could not establish: if either lookup errors, the trip is left untouched. Uses the
 * read-only lookup (no writes, no whole-collection scan).
 * @returns {Promise<{changed: boolean, matched: boolean}>}
 */
async function refreshStopMatchAfterCorrection(before, after, check = lookupStopCheck) {
  const unchanged = { changed: false, matched: after?.stop_matched === true };
  if (!before || !after || after.endTime == null) return unchanged;
  // This very write already changed stop_matched (e.g. the auto-confirm): nothing to redo.
  if (before.stop_matched !== after.stop_matched) return unchanged;
  if (!stopMatchInputsChanged(before, after)) return unchanged;

  const hasEnd = after.endStopCode || after.endStopName || after.endStop;
  const hasStart = after.startStopCode || after.startStopName || after.startStop;
  let matched = false;
  if (hasStart && hasEnd) {
    const [start, end] = await Promise.all([
      check(after.startStopCode, after.startStopName || after.startStop, after.agency, after.route, after.direction),
      check(after.endStopCode, after.endStopName || after.endStop, after.agency, after.route, after.direction),
    ]);
    if (start.status === 'error' || end.status === 'error') return unchanged;
    matched = start.status === 'found' && end.status === 'found';
  }
  return { changed: matched !== (after.stop_matched === true), matched };
}

/**
 * The timezone a trip should carry after its agency changed (a correction or any later edit):
 * the new agency's zone from constants.js AGENCY_TIMEZONE, or no timezone when the new agency
 * isn't in the table, so readers fall back to their own default instead of the old agency's zone.
 * @returns {object|null} the update to write ({ timezone }), or null when nothing needs to change
 */
function timezoneUpdateAfterAgencyChange(before, after) {
  if (!before || !after) return null;
  if ((before.agency ?? null) === (after.agency ?? null)) return null;
  const timezone = timezoneForAgency(after.agency);
  if (timezone) return after.timezone === timezone ? null : { timezone };
  return after.timezone == null ? null : { timezone: FieldValue.delete() };
}

async function runPostEndFinalization(tripData, options = {}) {
  const { force = false } = options;
  const tripId = tripData.id;
  const hasBlockingCorrectionFlag = hasBlockingCorrection(tripData);

  logger.info('Background finalization started', { tripId, hasBlockingCorrection: hasBlockingCorrectionFlag, force });

  // Idempotency: skip if already processed unless forcing (manual reprocess only).
  // High-impact corrections set exclusion flags (needs_reprocess / exclude_from_* / correctedFields)
  // but do NOT auto re-run learning/grading/journey to avoid tainting accuracy % and models
  // with known-bad original data. Explicit reprocess uses triggerManualFinalization(force=true).
  if (tripData.backgroundFinalizedAt && !force) {
    logger.info('Background finalization skipped (already processed)', { tripId });
    return;
  }

  const user = { userId: tripData.userId };
  const duration = tripData.duration;

  const endStopData = tripData.endStopCode || tripData.endStopName ? {
    stopCode: tripData.endStopCode,
    stopName: tripData.endStopName,
  } : null;

  try {
    if (await autoConfirmStopMatch(tripData, endStopData)) {
      logger.info('Stop match confirmed from unique stop lookups', { tripId });
    }
  } catch (err) {
    logger.error('Automatic stop matching failed', { tripId, error: err.message });
  }

  const stepsRun = [];

  // === Learning side-effects (Network + Habit) ===
  try {
    await triggerPostEndLearning(tripData, user, endStopData, null, duration);
    stepsRun.push('learning');
    logger.info('Background learning side-effects completed', { tripId });
  } catch (err) {
    logger.error('Background learning side-effects failed', { tripId, error: err.message });
  }

  // === Grading ===
  try {
    await gradeAllPredictions(tripData, user, endStopData, duration);
    stepsRun.push('grading');
    logger.info('Background grading completed', { tripId });
  } catch (err) {
    logger.error('Background grading failed', { tripId, error: err.message });
  }

  // === Journey linking ===
  try {
    const prevTrip = await detectJourneyLink(tripData);
    if (prevTrip) {
      const journeyId = prevTrip.journeyId || tripData.journeyId || randomUUID();
      await applyJourneyLink(tripData, prevTrip, journeyId);

      await db.collection('trips').doc(tripId).update({
        journeyLinked: true,
        linkedJourneyId: journeyId,
      }).catch(() => {});

      stepsRun.push('journey');
      logger.info('Background journey linking completed', { tripId, journeyId });
    } else {
      logger.info('No journey link detected in background', { tripId });
    }
  } catch (err) {
    logger.error('Background journey linking failed', { tripId, error: err.message });
  }

  // === Promote gtfs stop to verified (moved from synchronous handler) ===
  try {
    const endStop = endStopData || {
      id: null,
      source: null,
    };

    if (endStop.id && endStop.source === 'gtfs') {
      await db.collection('stops').doc(endStop.id).update({ source: 'verified' });
      stepsRun.push('gtfs-stop-verification');
      logger.info('Background gtfs stop verification promotion completed', { tripId });
    }
  } catch (err) {
    logger.error('Background gtfs stop verification promotion failed', { tripId, error: err.message });
  }

  // Mark as processed + store execution metadata
  const now = FieldValue.serverTimestamp();
  const finalUpdate = {
    backgroundFinalizedAt: now,
    finalization: {
      ranAt: now,
      steps: stepsRun,
    },
  };
  if (tripData.stop_matched === true) finalUpdate.stop_matched = true;
  await db.collection('trips').doc(tripId || '').update(finalUpdate).catch(() => {});

  logger.info('Background finalization finished', { tripId, steps: stepsRun });
}

/**
 * Manually trigger background finalization for a specific trip.
 * Bypasses idempotency. Useful for corrections, admin repair, or future scheduled jobs.
 */
async function triggerManualFinalization(tripId) {
  if (!tripId) {
    throw new Error('tripId is required');
  }

  const doc = await db.collection('trips').doc(tripId).get();
  if (!doc.exists) {
    throw new Error(`Trip not found: ${tripId}`);
  }

  const tripData = { id: doc.id, ...doc.data() };
  await runPostEndFinalization(tripData, { force: true });

  return { success: true, tripId };
}

module.exports = {
  gradeAllPredictions,
  computeJourneyLink,
  applyJourneyLink,
  detectJourneyLink,
  detectAnomaly,
  getNextLegSuggestion,
  triggerPostEndLearning,
  runPostEndFinalization,
  triggerManualFinalization,
  refreshStopMatchAfterCorrection,
  stopMatchInputsChanged,
  timezoneUpdateAfterAgencyChange,
};
