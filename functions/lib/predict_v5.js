/**
 * TransitStats Prediction Engine V5 (XGBoost via ONNX)
 *
 * Runs in parallel with V3 and V4 (Shadow Mode).
 * End-stop model only (trained by ml/train_endstop.py); the route model was removed.
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

const PredictionEngineV5 = {
  VERSION: '5.6',

  /**
   * Predict top N exit stops using the V5 XGBoost model.
   * @param {Object} context - { route, startStopName, direction, time, lastEndStopName, lastRoute, minutesSinceLastTrip, agency, stopsLibrary }
   */
  guessTopEndStops: async function (context, topN = 3) {
    if (!context || !context.time || !context.startStopName) return [];
    const endStopMeta = ModelStore.current()?.endStopV5Meta;
    if (!endStopMeta) return [];

    // Shared with training's feature parity test; local time when the artifact was trained on it.
    const x = toFeatureVector(buildEndStopFeatures(context, endStopMeta.time_basis), endStopMeta.feature_names, Float32Array);

    try {
      const ort = require('onnxruntime-node');
      const session = await ModelStore.getOnnxSession('endStop');
      const tensor = new ort.Tensor('float32', x, [1, endStopMeta.feature_names.length]);
      const results = await session.run({ float_input: tensor });
      const probs = Array.from(results.probabilities.data);
      const displayClasses = endStopMeta.classes.map(displayScopedStopLabel);
      const rawTopIdx = probs.reduce((best, value, idx, arr) => value > arr[best] ? idx : best, 0);

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
      if (mask) mask.forEach((keep, i) => { if (!keep) probs[i] = 0; });
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

      const total = probs.reduce((s, p) => s + p, 0);
      return probs
        .map((p, i) => ({ stop: displayClasses[i], prob: total > 0 ? p / total : 0 }))
        .filter(v => v.prob > 0)
        .sort((a, b) => b.prob - a.prob)
        .slice(0, topN)
        .map(v => ({ stop: v.stop, confidence: Math.round(v.prob * 100), version: this.VERSION }));
    } catch (err) {
      console.error('[V5 endstop] Inference error:', err.message);
      return [];
    }
  },
};

module.exports = { PredictionEngineV5 };
