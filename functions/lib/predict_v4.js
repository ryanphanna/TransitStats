/**
 * TransitStats Prediction Engine V4 (Logistic Regression)
 * 
 * Runs in parallel with V3 (Shadow Mode).
 * End-stop model only (weights from ml/train_endstop.py); the route model was removed.
 */

const ModelStore = require('./model-store');
const { canonicalizeStop, displayScopedStopLabel, loadPolicies, buildEndStopFeatures, toFeatureVector } = require('./ml_utils');
const logger = require('./logger');
const TopologyConstraints = require('./topology-constraints');

loadPolicies();

let _topology = null;
try {
  _topology = require('./topology.json');
} catch (e) {
  // topology filter disabled
}

const PredictionEngineV4 = {
  VERSION: '4.6',

  /**
   * Predict top N exit stops.
   * @param {Object} context - { route, startStopName, direction, time, lastEndStopName, lastRoute, minutesSinceLastTrip, agency, stopsLibrary }
   */
  guessTopEndStops: function (context, topN = 3) {
    const endStopModel = ModelStore.current()?.endStopV4;
    if (!endStopModel) return [];
    if (!context || !context.time || !context.startStopName) return [];

    // Shared with training's feature parity test; local time when the artifact was trained on it.
    const x = toFeatureVector(buildEndStopFeatures(context, endStopModel.time_basis), endStopModel.feature_names, Array);

    const logits = endStopModel.classes.map((_, c) => {
      let z = endStopModel.intercept[c];
      for (let f = 0; f < x.length; f++) z += endStopModel.coef[c][f] * x[f];
      return z;
    });
    const displayClasses = endStopModel.classes.map(displayScopedStopLabel);
    const rawTopIdx = logits.reduce((best, value, idx, arr) => value > arr[best] ? idx : best, 0);

    // Topology/GTFS-derived masks are the authoritative physical constraint.
    // NetworkEngine is observational and can only narrow within that legal set.
    const { NetworkEngine } = require('./network.js');
    const networkMask = NetworkEngine.getMask(context.networkGraph, displayClasses, context.startStopName, context.direction);
    const topology = TopologyConstraints.getMask(_topology, context.route, context.startStopName, context.direction, displayClasses, {
      // Canonicalize both sides through the stops library, as V3's own matching does.
      canonicalizeStop: name => canonicalizeStop(name, context.stopsLibrary || []),
    });
    const mask = TopologyConstraints.combineMasks(topology, networkMask);
    const constraintSource = topology && networkMask ? 'topology+network' : (topology ? 'topology' : (networkMask ? 'network' : 'none'));
    if (mask) mask.forEach((keep, i) => { if (!keep) logits[i] = -Infinity; });
    logger.info('End-stop constraint evaluated', {
      version: this.VERSION,
      constraintSource,
      route: context.route,
      startStopName: context.startStopName,
      direction: context.direction,
      legalClassCount: mask ? mask.filter(Boolean).length : null,
    });
    if (mask && !mask[rawTopIdx]) {
      logger.info('End-stop raw top masked', {
        version: this.VERSION,
        constraintSource,
        route: context.route,
        startStopName: context.startStopName,
        direction: context.direction,
        rawTopStop: displayClasses[rawTopIdx],
      });
    }

    const maxL = Math.max(...logits.filter(isFinite));
    let sumExp = 0;
    const exps = logits.map(z => { const e = isFinite(z) ? Math.exp(z - maxL) : 0; sumExp += e; return e; });
    const probs = exps.map(e => sumExp > 0 ? e / sumExp : 0);

    return probs
      .map((p, i) => ({ stop: displayClasses[i], prob: p }))
      .filter(v => v.prob > 0)
      .sort((a, b) => b.prob - a.prob)
      .slice(0, topN)
      .map(v => ({ stop: v.stop, confidence: Math.round(v.prob * 100), version: this.VERSION }));
  },
};

module.exports = { PredictionEngineV4 };
