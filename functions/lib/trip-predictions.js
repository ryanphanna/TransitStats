/**
 * Trip-start predictions shared by handleTripLog and handleConfirmStart (handlers-trip.js)
 * and fillPredictions (handlers-intelligence.js): V3 end-stop guesses, V4/V5 readiness and
 * guesses, the end-stop constraint, provisional transfers, and the trip fields they fill.
 */
const { db, getRecentCompletedTrips } = require('./db');
const { getConfiguredPrimaryAgency } = require('./primary-agency');
const { PredictionEngine } = require('./predict.js');
const { TransferEngine } = require('./transfer.js');
const { NetworkEngine } = require('./network.js');
const logger = require('./logger');
const { getEligibility, artifactSupportsAgency } = require('./intelligence-eligibility');
const { ELIGIBILITY_HISTORY_LIMIT, ML_ENDSTOP_LIVE } = require('./constants');
// V4/V5 only load when they run live (ML_ENDSTOP_LIVE, constants.js). Off, the sms function never
// downloads the model files or loads the ONNX runtime; the models are graded weekly instead.
const { PredictionEngineV4 } = ML_ENDSTOP_LIVE ? require('./predict_v4.js') : {};
const { PredictionEngineV5 } = ML_ENDSTOP_LIVE ? require('./predict_v5.js') : {};
const ModelStore = ML_ENDSTOP_LIVE ? require('./model-store') : null;

// PredictionEngine is a module-level singleton shared by every request on this instance, and
// texts are handled concurrently. Per-request data (stops library, network graph) goes on a
// fresh object that inherits the engine's methods, so one text never sees another's data.
function requestEngine(stopsLibrary, networkGraph) {
  const engine = Object.create(PredictionEngine);
  engine.stopsLibrary = stopsLibrary;
  engine.networkGraph = networkGraph || null;
  return engine;
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
      const confidence = TransferEngine.score(trip, nextTrip, history, networkConnections, stopsLibrary);
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

/** Agency the reply treats as the rider's own (no suffix): profile, then latest trip, then this trip. */
function replyDefaultAgency(profile, history, agency) {
  return getConfiguredPrimaryAgency(profile)
    || history.find(trip => trip.agency)?.agency
    || agency
    || null;
}

/**
 * Whether V4/V5 end-stop models run for this trip: ML_ENDSTOP_LIVE on, the rider allowlisted,
 * a clean enough history, and model artifacts that cover the agency.
 */
async function getMlReadiness(user, history, agency, experimentalIntelligence) {
  // Models are private and only trained on allowlisted users; everyone else gets rule-based predictions.
  // With ML_ENDSTOP_LIVE off nothing is loaded and V4/V5 don't run.
  const mlModels = ML_ENDSTOP_LIVE && ModelStore.isUserAllowed(user.userId) ? await ModelStore.ensure() : null;
  const { endStopV4Meta, endStopV5Meta } = mlModels || {};
  const eligibility = getEligibility(history.slice(0, ELIGIBILITY_HISTORY_LIMIT), agency);
  const mlEndStopReady = ML_ENDSTOP_LIVE && eligibility.endStopEligible &&
    artifactSupportsAgency(endStopV4Meta, agency, 'agency::end_stop') &&
    artifactSupportsAgency(endStopV5Meta, agency, 'agency::end_stop');
  return { eligibility, mlEndStopReady, mlReady: experimentalIntelligence && mlEndStopReady };
}

/** Top V4 and V5 end-stop guesses (null when a model has none). Only call when getMlReadiness says so. */
async function guessMlEndStops(endStopContext) {
  const [topV4, topV5] = await Promise.all([
    PredictionEngineV4.guessTopEndStops(endStopContext, 1),
    PredictionEngineV5.guessTopEndStops(endStopContext, 1),
  ]);
  return { v4: topV4.length > 0 ? topV4[0] : null, v5: topV5.length > 0 ? topV5[0] : null };
}

/** The end-stop constraint for this context, logged under `label` ("Trip-start", "Confirm-start"). */
function getLoggedEndStopConstraint(engine, endStopContext, label, traceId) {
  const constraint = engine.getEndStopConstraint(endStopContext);
  logger.info(`${label} end-stop constraint`, {
    route: endStopContext.route,
    startStopName: endStopContext.startStopName,
    direction: endStopContext.direction,
    constraintSource: constraint.source,
    legalStopCount: constraint.legalStops ? constraint.legalStops.size : null,
    traceId,
  }, traceId);
  return constraint;
}

/** detectProvisionalTransfer for a trip boarding now, logged under `label` when one is found. */
async function detectLoggedTransfer(label, { userId, route, startStopName, agency, stopsLibrary, now, traceId }) {
  const transfer = await detectProvisionalTransfer(userId, {
    route,
    startStopName,
    startStop: startStopName,
    startTime: now,
  }, agency, startStopName, stopsLibrary);
  if (transfer) {
    logger.info(`${label} provisional transfer detected`, {
      route,
      startStopName,
      prevTripId: transfer.prevTripId,
      prevRoute: transfer.prevRoute,
      confidence: transfer.confidence,
      traceId,
    }, traceId);
  }
  return transfer;
}

/** V3 end-stop guess (always stored), plus the top 3 shown to admins. */
function guessV3EndStops(engine, history, endStopContext, isAdmin) {
  const prediction = engine.guessEndStop(history, endStopContext);
  let predictions = null;
  if (isAdmin) {
    const top = engine.guessTopEndStops(history, endStopContext, 3);
    if (top.length > 0) predictions = top;
  }
  return { prediction, predictions };
}

/** The prediction fields every new trip stores. */
function predictionTripFields(p) {
  return {
    endStopPrediction: p.endStopPrediction || null,
    endStopPredictions: p.endStopPredictions || null,
    endStopPredictionV4: p.endStopPredictionV4 || null,
    endStopPredictionV5: p.endStopPredictionV5 || null,
    endStopConstraintSource: p.endStopConstraintSource,
    provisionalTransfer: !!p.provisionalTransfer,
    provisionalPrevTripId: p.provisionalTransfer?.prevTripId || null,
    provisionalJourneyConfidence: p.provisionalTransfer?.confidence || null,
  };
}
module.exports = {
  requestEngine,
  detectProvisionalTransfer,
  replyDefaultAgency,
  getMlReadiness,
  guessMlEndStops,
  getLoggedEndStopConstraint,
  detectLoggedTransfer,
  guessV3EndStops,
  predictionTripFields,
};
