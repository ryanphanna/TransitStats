/**
 * TransitStats Prediction Engine V4 (Logistic Regression)
 * 
 * Runs in parallel with V3 (Shadow Mode).
 * Uses weights trained via ml/train_routes.py and ml/train_endstop.py.
 */

const model = require('./model_v4.json');
const endStopModel = require('./model_v4_endstop.json');
const { getStopFeature, normalizeRouteForMl, normalizeDirectionForMl, getGapFeatures, loadPolicies } = require('./ml_utils');
const logger = require('./logger');
const TopologyConstraints = require('./topology-constraints');

// Transfer rarity lookup: rare transfers (e.g., 506→510B) get higher weight
let _transferRarity = null;
try {
  _transferRarity = require('./transfer_rarity.json');
} catch (e) {
  logger.warn('[V4] Transfer rarity not loaded (degraded mode)');
}

loadPolicies();

let _topology = null;
try {
  _topology = require('./topology.json');
} catch (e) {
  // topology filter disabled
}

const PredictionEngineV4 = {
  VERSION: '4.5',

  /**
   * Guess the next route given the current stop and time.
   * @param {Object} context - { stopName, time, lastEndStopName, stopsLibrary }
   */
  guessTopRoutes: function (context, topN = 5) {
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
      ? model.classes.map(r => _transferRarity[`${prevRoute}→${r}`]).filter(v => v !== undefined)
      : [];
    const transferRarity = rarities.length > 0
      ? rarities.reduce((s, r) => s + r, 0) / rarities.length
      : 0.5;

    const x = new Array(model.feature_names.length).fill(0);
    for (let i = 0; i < model.feature_names.length; i++) {
      const fn = model.feature_names[i];
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

    const logits = model.classes.map((_, c) => {
      let z = model.intercept[c];
      for (let f = 0; f < x.length; f++) z += model.coef[c][f] * x[f];
      return z;
    });

    const maxLogit = Math.max(...logits);
    let sumExp = 0;
    const exps = logits.map(z => { const e = Math.exp(z - maxLogit); sumExp += e; return e; });
    const probs = exps.map(e => e / sumExp);

    return probs
      .map((p, i) => ({ route: model.classes[i].toString(), confidence: Math.round(p * 100), version: this.VERSION }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, topN);
  },

  /**
   * Predict top N exit stops.
   * @param {Object} context - { route, startStopName, direction, time, lastEndStopName, lastRoute, minutesSinceLastTrip, agency, stopsLibrary }
   */
  guessTopEndStops: function (context, topN = 3) {
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

    const x = new Array(endStopModel.feature_names.length).fill(0);
    for (let i = 0; i < endStopModel.feature_names.length; i++) {
      const fn = endStopModel.feature_names[i];
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

    const logits = endStopModel.classes.map((_, c) => {
      let z = endStopModel.intercept[c];
      for (let f = 0; f < x.length; f++) z += endStopModel.coef[c][f] * x[f];
      return z;
    });
    const rawTopIdx = logits.reduce((best, value, idx, arr) => value > arr[best] ? idx : best, 0);

    // Topology/GTFS-derived masks are the authoritative physical constraint.
    // NetworkEngine is observational and can only narrow within that legal set.
    const { NetworkEngine } = require('./network.js');
    const networkMask = NetworkEngine.getMask(context.networkGraph, endStopModel.classes, context.startStopName, context.direction);
    const topology = TopologyConstraints.getMask(_topology, context.route, context.startStopName, context.direction, endStopModel.classes);
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
        rawTopStop: endStopModel.classes[rawTopIdx],
      });
    }

    const maxL = Math.max(...logits.filter(isFinite));
    let sumExp = 0;
    const exps = logits.map(z => { const e = isFinite(z) ? Math.exp(z - maxL) : 0; sumExp += e; return e; });
    const probs = exps.map(e => sumExp > 0 ? e / sumExp : 0);

    return probs
      .map((p, i) => ({ stop: endStopModel.classes[i], prob: p }))
      .filter(v => v.prob > 0)
      .sort((a, b) => b.prob - a.prob)
      .slice(0, topN)
      .map(v => ({ stop: v.stop, confidence: Math.round(v.prob * 100), version: this.VERSION }));
  },
};

module.exports = { PredictionEngineV4 };
