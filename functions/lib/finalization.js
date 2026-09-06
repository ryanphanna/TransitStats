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
  normalizeRouteForGrading,
} = require('./utils');
const logger = require('./logger');

async function gradeAllPredictions(activeTrip, user, endStopData, duration) {
  const actualEndStop = endStopData ? endStopData.stopName : (activeTrip.endStopName || '');
  const inc = FieldValue.increment;
  const normalize = normalizeRouteForGrading;

  try {
    // V3
    const s = activeTrip.prediction;
    if (s) {
      const hit = normalize(s.route, activeTrip.agency) === normalize(activeTrip.route, activeTrip.agency) &&
        (!s.direction || !activeTrip.direction || PredictionEngine._normalizeDirection(s.direction) === PredictionEngine._normalizeDirection(activeTrip.direction));
      const partial = !hit && /* simplified */ false;

      await db.collection('predictionStats').add({
        tripId: activeTrip.id, userId: user.userId, isHit: !!hit, isPartialHit: !!partial,
        predicted: s.route + (s.direction ? ' ' + s.direction : '') + ' from ' + s.stop,
        actual: activeTrip.route + (activeTrip.direction ? ' ' + activeTrip.direction : '') + ' from ' + (activeTrip.startStopName || '?'),
        confidence: s.confidence, version: s.version, route: activeTrip.route, agency: activeTrip.agency, source: 'sms',
        timestamp: FieldValue.serverTimestamp()
      });
      await db.collection('predictionAccuracy').doc(user.userId).set({
        total: inc(1), hits: inc(hit ? 1 : 0), partialHits: inc(partial ? 1 : 0), lastUpdated: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    // V4
    const v4 = activeTrip.predictionV4;
    if (v4) {
      const hit = normalize(v4.route, activeTrip.agency) === normalize(activeTrip.route, activeTrip.agency);
      await db.collection('predictionStats').add({ tripId: activeTrip.id, userId: user.userId, isHit: hit, version: v4.version, route: activeTrip.route, agency: activeTrip.agency, source: 'sms', timestamp: FieldValue.serverTimestamp() });
      await db.collection('predictionAccuracy').doc(user.userId).set({ v4Total: inc(1), v4Hits: inc(hit ? 1 : 0), lastUpdated: FieldValue.serverTimestamp() }, { merge: true });
    }

    // V5 (similar pattern)
    const v5 = activeTrip.predictionV5;
    if (v5) {
      const hit = normalize(v5.route, activeTrip.agency) === normalize(activeTrip.route, activeTrip.agency);
      await db.collection('predictionStats').add({ tripId: activeTrip.id, userId: user.userId, isHit: hit, version: v5.version, route: activeTrip.route, agency: activeTrip.agency, source: 'sms', timestamp: FieldValue.serverTimestamp() });
      await db.collection('predictionAccuracy').doc(user.userId).set({ v5Total: inc(1), v5Hits: inc(hit ? 1 : 0), lastUpdated: FieldValue.serverTimestamp() }, { merge: true });
    }

    // End stop predictions (V3/V4/V5/Habit)
    const es = async (pred, version) => {
      if (!pred) return;
      const hit = PredictionEngine._stopMatch(pred.stop, actualEndStop);
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
    journeyNote = `\n\nLinked to your ${getRouteDisplay(prevTrip.route)} trip ` +
      `(${gapStr < 1 ? '<1' : gapStr} min transfer). UNLINK to separate.`;
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
      const conf = TransferEngine.score(provisional, activeTrip, history, networkConnections);
      if (conf >= TransferEngine.CONFIDENCE_THRESHOLD) {
        prevTrip = provisional;
      }
    }
  }

  if (!prevTrip) {
    prevTrip = history.find(t => {
      if (t.id === activeTrip.id) return false;
      if (!t.endTime || !t.endStopName) return false;
      const conf = TransferEngine.score(t, activeTrip, history, networkConnections);
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
      return `\n\nThis trip took longer than usual (${duration} min vs. typical ${typicalMinutes} min).`;
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
      return `\n\nUsually take the ${toLabel} from here.`;
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
  await db.collection('trips').doc(tripId || '').update({
    backgroundFinalizedAt: now,
    finalization: {
      ranAt: now,
      steps: stepsRun,
    },
  }).catch(() => {});

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
};
