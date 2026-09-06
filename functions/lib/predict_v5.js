/**
 * TransitStats Prediction Engine V5 (XGBoost via ONNX)
 *
 * Runs in parallel with V3 and V4 (Shadow Mode).
 * Uses models trained via ml/train_routes.py and ml/train_endstop.py.
 */

const path = require('path');
const meta = require('./model_v5_meta.json');
const endStopMeta = require('./model_v5_endstop_meta.json');
const { getStopFeature, normalizeRouteForMl, normalizeDirectionForMl, getGapFeatures, loadPolicies } = require('./ml_utils');
const logger = require('./logger');
const TopologyConstraints = require('./topology-constraints');

// Transfer rarity lookup: rare transfers (e.g., 506→510B) get higher weight
let _transferRarity = null;
try {
  _transferRarity = require('./transfer_rarity.json');
} catch (e) {
  logger.warn('[V5] Transfer rarity not loaded (degraded mode)');
}

loadPolicies();

let _session = null;
let _endStopSession = null;

let _topology = null;
try {
  _topology = require('./topology.json');
} catch (e) {
  // topology filter disabled
}

async function getSession() {
  if (_session) return _session;
  const ort = require('onnxruntime-node');
  _session = await ort.InferenceSession.create(path.join(__dirname, 'model_v5.onnx'));
  return _session;
}

async function getEndStopSession() {
  if (_endStopSession) return _endStopSession;
  const ort = require('onnxruntime-node');
  _endStopSession = await ort.InferenceSession.create(path.join(__dirname, 'model_v5_endstop.onnx'));
  return _endStopSession;
}

const PredictionEngineV5 = {
  VERSION: '5.5',

  /**
   * Guess top N routes using the V5 XGBoost model.
   * @param {Object} context - { stopName, time, lastEndStopName, stopsLibrary }
   */
  guessTopRoutes: async function (context, topN = 5) {
    if (!context || !context.time) return [];

    const date = context.time instanceof Date ? context.time : new Date(context.time);
    const hour = date.getHours();
    const pyDay = (date.getDay() + 6) % 7;

    const hour_sin = Math.sin(2 * Math.PI * hour / 24);
    const hour_cos = Math.cos(2 * Math.PI * hour / 24);
    const day_sin  = Math.sin(2 * Math.PI * pyDay / 7);
    const day_cos  = Math.cos(2 * Math.PI * pyDay / 7);

    const stopFeature = getStopFeature(context.stopName, context.stopsLibrary);
    const lastStopKey = context.lastEndStopName
      ? getStopFeature(context.lastEndStopName, context.stopsLibrary).replace('stop_', '')
      : 'none';
    const lastStopFeature = `last_stop_${lastStopKey}`;
    const prevRoute = normalizeRouteForMl(context.lastRoute, context.agency, context.primaryAgency || context.defaultAgency) || 'none';
    const prevRouteFeature = `prev_route_${prevRoute.toString().toLowerCase()}`;
    const agencyFeature = `agency_${String(context.agency || 'unknown').toLowerCase().trim().replace(/[^a-z0-9]/g, '_')}`;

    const rarities = _transferRarity
      ? meta.classes.map(r => _transferRarity[`${prevRoute}→${r}`]).filter(v => v !== undefined)
      : [];
    const transferRarity = rarities.length > 0
      ? rarities.reduce((s, r) => s + r, 0) / rarities.length
      : 0.5;

    const x = new Float32Array(meta.feature_names.length);
    for (let i = 0; i < meta.feature_names.length; i++) {
      const fn = meta.feature_names[i];
      if      (fn === 'hour_sin')         x[i] = hour_sin;
      else if (fn === 'hour_cos')         x[i] = hour_cos;
      else if (fn === 'day_sin')          x[i] = day_sin;
      else if (fn === 'day_cos')          x[i] = day_cos;
      else if (fn === agencyFeature)      x[i] = 1.0;
      else if (fn === 'transfer_rarity')  x[i] = transferRarity;
      else if (fn === stopFeature)        x[i] = 1.0;
      else if (fn === lastStopFeature)    x[i] = 1.0;
      else if (fn === prevRouteFeature)   x[i] = 1.0;
    }

    try {
      const ort = require('onnxruntime-node');
      const session = await getSession();
      const tensor = new ort.Tensor('float32', x, [1, meta.feature_names.length]);
      const results = await session.run({ float_input: tensor });
      const probs = results.probabilities.data;

      return Array.from(probs)
        .map((p, i) => ({ route: String(meta.classes[i]), confidence: Math.round(p * 100), version: this.VERSION }))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, topN);
    } catch (err) {
      console.error('[V5] guessTopRoutes error:', err.message);
      return [];
    }
  },

  /**
   * Predict top N exit stops using the V5 XGBoost model.
   * @param {Object} context - { route, startStopName, direction, time, lastEndStopName, lastRoute, minutesSinceLastTrip, agency, stopsLibrary }
   */
  guessTopEndStops: async function (context, topN = 3) {
    if (!context || !context.time || !context.startStopName) return [];

    const date = context.time instanceof Date ? context.time : new Date(context.time);
    const hour  = date.getHours();
    const pyDay = (date.getDay() + 6) % 7;

    const hour_sin = Math.sin(2 * Math.PI * hour / 24);
    const hour_cos = Math.cos(2 * Math.PI * hour / 24);
    const day_sin  = Math.sin(2 * Math.PI * pyDay / 7);
    const day_cos  = Math.cos(2 * Math.PI * pyDay / 7);

    const cleanRoute = normalizeRouteForMl(context.route, context.agency, context.primaryAgency || context.defaultAgency).toString().toLowerCase();
    const prevRoute = normalizeRouteForMl(context.lastRoute, context.agency, context.primaryAgency || context.defaultAgency) || 'none';
    const stopFeature = getStopFeature(context.startStopName, context.stopsLibrary);
    const lastStopKey = context.lastEndStopName
      ? getStopFeature(context.lastEndStopName, context.stopsLibrary).replace('stop_', '')
      : 'none';
    const lastStopFeature = `last_stop_${lastStopKey}`;
    const prevRouteFeature = `prev_route_${prevRoute.toString().toLowerCase()}`;
    const { gapLog, gapMissing } = getGapFeatures(context.minutesSinceLastTrip);
    const dirNorm = normalizeDirectionForMl(context.direction);
    const dirFeature = dirNorm ? `dir_${dirNorm}` : null;
    const agencyFeature = `agency_${String(context.agency || 'unknown').toLowerCase().trim().replace(/[^a-z0-9]/g, '_')}`;

    const x = new Float32Array(endStopMeta.feature_names.length);
    for (let i = 0; i < endStopMeta.feature_names.length; i++) {
      const fn = endStopMeta.feature_names[i];
      if      (fn === 'hour_sin')            x[i] = hour_sin;
      else if (fn === 'hour_cos')            x[i] = hour_cos;
      else if (fn === 'day_sin')             x[i] = day_sin;
      else if (fn === 'day_cos')             x[i] = day_cos;
      else if (fn === 'gap_log')             x[i] = gapLog;
      else if (fn === 'gap_missing')         x[i] = gapMissing;
      else if (fn === agencyFeature)         x[i] = 1.0;
      else if (fn === stopFeature)           x[i] = 1.0;
      else if (fn === `route_${cleanRoute}`) x[i] = 1.0;
      else if (fn === prevRouteFeature)      x[i] = 1.0;
      else if (fn === lastStopFeature)       x[i] = 1.0;
      else if (dirFeature && fn === dirFeature) x[i] = 1.0;
    }

    try {
      const ort = require('onnxruntime-node');
      const session = await getEndStopSession();
      const tensor = new ort.Tensor('float32', x, [1, endStopMeta.feature_names.length]);
      const results = await session.run({ float_input: tensor });
      const probs = Array.from(results.probabilities.data);
      const rawTopIdx = probs.reduce((best, value, idx, arr) => value > arr[best] ? idx : best, 0);

      // Topology/GTFS-derived masks are the authoritative physical constraint.
      // NetworkEngine is observational and can only narrow within that legal set.
      const { NetworkEngine } = require('./network.js');
      const networkMask = NetworkEngine.getMask(context.networkGraph, endStopMeta.classes, context.startStopName, context.direction);
      const topology = TopologyConstraints.getMask(_topology, context.route, context.startStopName, context.direction, endStopMeta.classes);
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
          rawTopStop: endStopMeta.classes[rawTopIdx],
        });
      }

      const total = probs.reduce((s, p) => s + p, 0);
      return probs
        .map((p, i) => ({ stop: endStopMeta.classes[i], prob: total > 0 ? p / total : 0 }))
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
