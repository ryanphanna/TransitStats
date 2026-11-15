#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const REPO_ROOT = path.resolve(__dirname, '..');
const KEY_PATH = path.join(process.env.HOME, 'Desktop/Dev/Credentials/Firebase for Transit Stats.json');

const logger = require('../functions/lib/logger');
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

const { PredictionEngineV3 } = require('../functions/lib/predict_v3');
const { PredictionEngineV4 } = require('../functions/lib/predict_v4');
const { PredictionEngineV5 } = require('../functions/lib/predict_v5');
const { NetworkEngine } = require('../functions/lib/network');
const TopologyConstraints = require('../functions/lib/topology-constraints');
const topology = require('../functions/lib/topology.json');
const { normalizeStopName } = require('../functions/lib/stop-names');
const { canonicalizeStop, normalizeRouteForMl, normalizeDirectionForMl, loadPolicies } = require('../functions/lib/ml_utils');

loadPolicies();

const HIGH_IMPACT_FIELDS = new Set([
  'route',
  'direction',
  'agency',
  'startStop',
  'startStopCode',
  'startStopName',
  'endStop',
  'endStopCode',
  'endStopName',
]);

function parseArgs(argv) {
  const args = {
    userId: null,
    agency: null,
    source: null,
    since: null,
    recent: null,
    minHistory: 5,
    jsonOut: null,
    network: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (!args.userId) args.userId = arg;
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    if (rawKey === 'network') {
      args.network = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }
    if (rawKey === 'no-network') {
      args.network = false;
      continue;
    }
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = inlineValue !== undefined ? inlineValue : argv[++i];
    if (key === 'recent' || key === 'minHistory') args[key] = Number(value);
    else if (key in args) args[key] = value === '' ? null : value;
    else throw new Error(`Unknown option: --${rawKey}`);
  }

  if (!args.userId) throw new Error('Usage: node Tools/replay-endstop-generations.js <userId> [--agency=TTC] [--source=sms] [--since=YYYY-MM-DD] [--json-out=path]');
  return args;
}

function parseTimestamp(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseSince(value) {
  if (!value) return null;
  const dt = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function tripHasBlockingCorrection(data) {
  if (!data) return false;
  if (data.exclude_from_training || data.exclude_from_accuracy || data.needs_reprocess) return true;
  const corrected = Array.isArray(data.correctedFields) ? data.correctedFields : [];
  return corrected.some(field => HIGH_IMPACT_FIELDS.has(field));
}

function isStopMatched(data) {
  if (data.stop_matched !== undefined && data.stop_matched !== null) return Boolean(data.stop_matched);
  return Boolean(data.verified);
}

function cleanTrip(id, data, args) {
  if (data.userId !== args.userId) return null;
  if (args.agency && data.agency !== args.agency) return null;
  if (args.source && data.source !== args.source) return null;
  if (data.discarded || data.incomplete || data.needs_review) return null;
  if (tripHasBlockingCorrection(data)) return null;
  if (!data.endTime || !isStopMatched(data)) return null;

  const startTime = parseTimestamp(data.startTime);
  const endTime = parseTimestamp(data.endTime);
  const route = String(data.route || '').trim();
  const startStopName = String(data.startStopName || data.startStop || '').trim();
  const endStopName = String(data.endStopName || data.endStop || '').trim();
  if (!startTime || !route || !startStopName || !endStopName) return null;

  return {
    id,
    userId: String(data.userId || ''),
    route,
    agency: data.agency || null,
    direction: data.direction || null,
    startStopName,
    endStopName,
    startTime,
    endTime,
    duration: data.duration || (endTime ? Math.round((endTime - startTime) / 60000) : null),
    raw: data,
  };
}

function normalizeStop(name) {
  if (!name) return '';
  // The shared stop-name rule (RYN-541), plus collapsed inner spaces.
  return normalizeStopName(name).replace(/\s+/g, ' ');
}

function stopLabelForms(name) {
  const value = normalizeStop(name);
  if (!value) return new Set();
  const forms = new Set([value]);
  if (value.endsWith(' station')) forms.add(value.slice(0, -8).trim());
  else forms.add(`${value} station`);
  return forms;
}

function stopLabelsMatch(a, b) {
  const aForms = stopLabelForms(a);
  for (const form of stopLabelForms(b)) {
    if (aForms.has(form)) return true;
  }
  return false;
}

function topologyCanonicalStop(route, stopName, direction, agency) {
  const normalized = normalizeStop(stopName);
  const line = TopologyConstraints.getLine(topology, route, { agency });
  if (!line || !normalized) return normalized;

  const normDir = TopologyConstraints.normalizeDirection(direction);
  for (const canon of line.stops || []) {
    const variants = (line.directional_stops && line.directional_stops[canon]) || [];
    if (variants.length > 0) {
      let matchedVariant = null;
      for (const variant of variants) {
        const labels = [variant.name, ...(variant.aliases || [])].filter(Boolean);
        if (!labels.some(label => stopLabelsMatch(stopName, label))) continue;
        const variantName = normalizeStop(variant.name);
        if (normDir && (!variant.directions || variant.directions.includes(normDir))) return variantName;
        matchedVariant = matchedVariant || variantName;
      }
      if (matchedVariant) return matchedVariant;
    }

    const labels = [canon, ...(((line.aliases || {})[canon]) || [])];
    if (labels.some(label => stopLabelsMatch(stopName, label))) return normalizeStop(canon);
  }
  return normalized;
}

function scoreLabel(route, stopName, direction, agency, stopsLibrary) {
  const topo = topologyCanonicalStop(route, stopName, direction, agency);
  if (topo) return topo;
  return canonicalizeStop(stopName, stopsLibrary);
}

function actualMatchesPrediction(trip, predictedStop, stopsLibrary) {
  if (!predictedStop) return false;
  return scoreLabel(trip.route, predictedStop, trip.direction, trip.agency, stopsLibrary) ===
    scoreLabel(trip.route, trip.endStopName, trip.direction, trip.agency, stopsLibrary);
}

function gapMinutes(previousTrip, trip) {
  if (!previousTrip) return null;
  return Math.max(0, Math.round((trip.startTime - previousTrip.startTime) / 60000));
}

function gapBucket(previousTrip, trip) {
  const minutes = gapMinutes(previousTrip, trip);
  if (minutes === null) return 'none';
  if (minutes <= 30) return 'transfer';
  if (minutes <= 120) return 'stopover';
  return 'separate';
}

function hourBucket(dt) {
  return String(Math.floor(dt.getHours() / 3) * 3);
}

function dayType(dt) {
  return dt.getDay() === 0 || dt.getDay() === 6 ? 'weekend' : 'weekday';
}

function mapKey(parts) {
  return JSON.stringify(parts);
}

function inc(map, parts, value) {
  if (!parts.every(Boolean) || !value) return;
  const key = mapKey(parts);
  if (!map.has(key)) map.set(key, new Map());
  const counter = map.get(key);
  counter.set(value, (counter.get(value) || 0) + 1);
}

function choose(counter, minBucket, legal, topN = 3) {
  if (!counter) return null;
  const rows = [...counter.entries()].filter(([stop]) => !legal || legal.has(stop));
  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  if (total < minBucket) return null;
  rows.sort((a, b) => b[1] - a[1]);
  return {
    stops: rows.slice(0, topN).map(([stop, count]) => ({ stop, confidence: Math.round((count / total) * 100), version: '6-replay' })),
    confidence: rows[0][1] / total,
  };
}

function legalEndStops(route, startStopName, direction, agency) {
  const constraint = TopologyConstraints.getConstraint(topology, { route, startStopName, direction }, { agency });
  if (!constraint.legalStops) return null;
  const labels = new Set();
  for (const label of constraint.legalStops) {
    labels.add(scoreLabel(route, label, direction, agency, []));
  }
  return labels.size > 0 ? labels : null;
}

function combineLegalSets(primary, secondary) {
  if (!primary) return secondary || null;
  if (!secondary) return primary;
  const combined = new Set([...primary].filter(label => secondary.has(label)));
  return combined.size > 0 ? combined : primary;
}

function chooseWithNetworkFallback(counter, bucket, topologyLegal, networkLegal) {
  const topologyAndNetwork = combineLegalSets(topologyLegal, networkLegal);
  const narrowed = choose(counter, bucket, topologyAndNetwork);
  if (narrowed) {
    return {
      choice: narrowed,
      constraintSource: networkLegal ? (topologyLegal ? 'topology+network' : 'network') : (topologyLegal ? 'topology' : 'none'),
    };
  }

  if (!networkLegal) return { choice: null, constraintSource: topologyLegal ? 'topology' : 'none' };

  const fallbackLegal = topologyLegal || null;
  const fallback = choose(counter, bucket, fallbackLegal);
  return {
    choice: fallback,
    constraintSource: fallback ? (topologyLegal ? 'topology+network-fallback' : 'network-fallback') : null,
  };
}

function graphKey(userId, agency, route) {
  return `${userId || 'global'}:${agency || ''}:${NetworkEngine._baseRoute(route || '')}`;
}

function getReplayGraph(networkState, userId, agency, route) {
  const personal = networkState.graphs.get(graphKey(userId, agency, route)) || null;
  const global = networkState.graphs.get(graphKey('global', agency, route)) || null;
  const personalConfident = personal && Object.values(personal.edges || {})
    .some(edge => NetworkEngine._getConfidence(edge) >= NetworkEngine.MIN_TRIPS);
  return personalConfident ? personal : (global || personal);
}

function networkLegalEndStops(trip, state, ctx) {
  if (!state.useNetwork) return null;
  const graph = getReplayGraph(state.network, trip.userId, trip.agency || state.primaryAgency, trip.route);
  if (!graph) return null;
  const classes = [...state.global.get(mapKey(['global'])).keys()];
  if (classes.length === 0) return null;
  const mask = NetworkEngine.getMask(graph, classes, trip.startStopName, trip.direction, 2, trip.startTime);
  if (!mask) return null;
  const legal = new Set();
  mask.forEach((keep, index) => {
    if (keep) legal.add(scoreLabel(ctx.route, classes[index], ctx.direction, trip.agency || state.primaryAgency, []));
  });
  return legal.size > 0 ? legal : null;
}

function observeReplayGraph(networkState, trip, previousTrip) {
  if (!trip.route || !trip.agency || !trip.direction || !trip.startStopName || !trip.endStopName || !trip.duration) return;
  if (trip.duration <= 0 || trip.duration > 180) return;
  const normDir = NetworkEngine._normalizeDirection(trip.direction);
  if (!normDir) return;

  const edgeKey = NetworkEngine._edgeKey(trip.startStopName, normDir, trip.endStopName);
  const hourKey = String(trip.startTime.getHours());
  const graphKeys = [
    graphKey(trip.userId, trip.agency, trip.route),
    graphKey('global', trip.agency, trip.route),
  ];

  for (const key of graphKeys) {
    let graph = networkState.graphs.get(key);
    if (!graph) {
      graph = {
        userId: key.startsWith('global:') ? undefined : trip.userId,
        agency: trip.agency,
        route: NetworkEngine._baseRoute(trip.route),
        global: key.startsWith('global:') || undefined,
        edges: {},
      };
      networkState.graphs.set(key, graph);
    }

    const edge = graph.edges[edgeKey] || {
      fromStop: trip.startStopName,
      toStop: trip.endStopName,
      direction: normDir,
      durations: [],
      durationsByHour: {},
      tripCount: 0,
      edgeType: 'observed',
    };
    const duration = Math.round(trip.duration);
    edge.durations = [...(edge.durations || []).slice(-49), duration];
    const bucket = edge.durationsByHour[hourKey] || [];
    edge.durationsByHour[hourKey] = [...bucket.slice(-19), duration];
    edge.tripCount = (edge.tripCount || 0) + 1;
    edge.medianMinutes = NetworkEngine._median(edge.durations);
    edge.updatedAt = (trip.endTime || trip.startTime).toISOString();
    edge.lastObservedAt = edge.updatedAt;
    graph.edges[edgeKey] = edge;
  }

  if (previousTrip) {
    const transferKey = `${trip.agency}:${normalizeStop(trip.startStopName)}:${previousTrip.route}_to_${trip.route}`;
    networkState.transfers.set(transferKey, (networkState.transfers.get(transferKey) || 0) + 1);
  }
}

function createV6State(primaryAgency, useNetwork = false) {
  return {
    primaryAgency,
    useNetwork,
    routeStartDirPrevGapRich: new Map(),
    routeStartDirPrevRich: new Map(),
    routeStartDirPrevGap: new Map(),
    routeStartDirPrevEnd: new Map(),
    routeStartDirPrev: new Map(),
    routeStartDir: new Map(),
    routeStart: new Map(),
    startPrev: new Map(),
    byRoute: new Map(),
    global: new Map([[mapKey(['global']), new Map()]]),
    lastByUser: new Map(),
    network: {
      graphs: new Map(),
      transfers: new Map(),
    },
  };
}

function v6Context(trip, state) {
  const route = String(normalizeRouteForMl(trip.route, trip.agency, state.primaryAgency) || '').trim();
  const direction = normalizeDirectionForMl(trip.direction) || '';
  const startStop = topologyCanonicalStop(route, trip.startStopName, direction, trip.agency || state.primaryAgency);
  const endStop = topologyCanonicalStop(route, trip.endStopName, direction, trip.agency || state.primaryAgency);
  const previous = state.lastByUser.get(trip.userId) || null;
  return {
    route,
    direction,
    startStop,
    endStop,
    prevRoute: previous?.route || '',
    prevEnd: previous?.endStop || '',
    gap: gapBucket(previous, trip),
    hour: hourBucket(trip.startTime),
    day: dayType(trip.startTime),
  };
}

function predictV6(trip, state, minBucket) {
  const ctx = v6Context(trip, state);
  const topologyLegal = legalEndStops(ctx.route, ctx.startStop, ctx.direction, trip.agency || state.primaryAgency);
  const networkLegal = networkLegalEndStops(trip, state, ctx);
  const source = networkLegal ? (topologyLegal ? 'topology+network' : 'network') : (topologyLegal ? 'topology' : 'none');
  const choices = [
    [state.routeStartDirPrevGapRich.get(mapKey([ctx.route, ctx.startStop, ctx.direction, ctx.prevRoute, ctx.prevEnd, ctx.gap, ctx.hour, ctx.day])), Math.max(minBucket + 1, 3), 'route+start_stop+direction+prev_route+prev_end+gap+hour+day'],
    [state.routeStartDirPrevRich.get(mapKey([ctx.route, ctx.startStop, ctx.direction, ctx.prevRoute, ctx.prevEnd, ctx.hour, ctx.day])), Math.max(minBucket + 1, 3), 'route+start_stop+direction+prev_route+prev_end+hour+day'],
    [state.routeStartDirPrevGap.get(mapKey([ctx.route, ctx.startStop, ctx.direction, ctx.prevRoute, ctx.prevEnd, ctx.gap])), minBucket, 'route+start_stop+direction+prev_route+prev_end+gap'],
    [state.routeStartDirPrevEnd.get(mapKey([ctx.route, ctx.startStop, ctx.direction, ctx.prevRoute, ctx.prevEnd])), minBucket, 'route+start_stop+direction+prev_route+prev_end'],
    [state.routeStartDirPrev.get(mapKey([ctx.route, ctx.startStop, ctx.direction, ctx.prevRoute])), minBucket, 'route+start_stop+direction+prev_route'],
    [state.routeStartDir.get(mapKey([ctx.route, ctx.startStop, ctx.direction])), minBucket, 'route+start_stop+direction'],
    [state.routeStart.get(mapKey([ctx.route, ctx.startStop])), minBucket, 'route+start_stop'],
    [state.startPrev.get(mapKey([ctx.startStop, ctx.prevRoute])), minBucket, 'start_stop+prev_route'],
    [state.byRoute.get(mapKey([ctx.route])), minBucket, 'route'],
    [state.global.get(mapKey(['global'])), 1, 'global'],
  ];

  for (const [counter, bucket, strategy] of choices) {
    const { choice, constraintSource } = chooseWithNetworkFallback(counter, bucket, topologyLegal, networkLegal);
    if (choice) return { predictions: choice.stops, strategy, constraintSource, actual: ctx.endStop };
  }
  return { predictions: [], strategy: null, constraintSource: source, actual: ctx.endStop };
}

function updateV6(trip, state) {
  const ctx = v6Context(trip, state);
  if (ctx.endStop) {
    inc(state.routeStartDirPrevGapRich, [ctx.route, ctx.startStop, ctx.direction, ctx.prevRoute, ctx.prevEnd, ctx.gap, ctx.hour, ctx.day], ctx.endStop);
    inc(state.routeStartDirPrevRich, [ctx.route, ctx.startStop, ctx.direction, ctx.prevRoute, ctx.prevEnd, ctx.hour, ctx.day], ctx.endStop);
    inc(state.routeStartDirPrevGap, [ctx.route, ctx.startStop, ctx.direction, ctx.prevRoute, ctx.prevEnd, ctx.gap], ctx.endStop);
    inc(state.routeStartDirPrevEnd, [ctx.route, ctx.startStop, ctx.direction, ctx.prevRoute, ctx.prevEnd], ctx.endStop);
    inc(state.routeStartDirPrev, [ctx.route, ctx.startStop, ctx.direction, ctx.prevRoute], ctx.endStop);
    inc(state.routeStartDir, [ctx.route, ctx.startStop, ctx.direction], ctx.endStop);
    inc(state.routeStart, [ctx.route, ctx.startStop], ctx.endStop);
    inc(state.startPrev, [ctx.startStop, ctx.prevRoute], ctx.endStop);
    inc(state.byRoute, [ctx.route], ctx.endStop);
    inc(state.global, ['global'], ctx.endStop);
  }
  state.lastByUser.set(trip.userId, {
    route: ctx.route,
    endStop: ctx.endStop,
    startTime: trip.startTime,
  });
}

function emptyMetric() {
  return { total: 0, coverage: 0, top1: 0, top3: 0, strategies: {}, constraintSources: {} };
}

function addPrediction(metric, trip, predictions, stopsLibrary, strategy = null, constraintSource = null) {
  metric.total += 1;
  if (!predictions || predictions.length === 0) return;
  metric.coverage += 1;
  if (actualMatchesPrediction(trip, predictions[0].stop, stopsLibrary)) metric.top1 += 1;
  if (predictions.slice(0, 3).some(pred => actualMatchesPrediction(trip, pred.stop, stopsLibrary))) metric.top3 += 1;
  if (strategy) metric.strategies[strategy] = (metric.strategies[strategy] || 0) + 1;
  if (constraintSource) metric.constraintSources[constraintSource] = (metric.constraintSources[constraintSource] || 0) + 1;
}

function summarizeMetric(metric) {
  return {
    total: metric.total,
    coverage: metric.coverage,
    coverageRate: metric.total ? metric.coverage / metric.total : null,
    top1: metric.top1,
    top1Accuracy: metric.total ? metric.top1 / metric.total : null,
    top1WhenPredicted: metric.coverage ? metric.top1 / metric.coverage : null,
    top3: metric.top3,
    top3Accuracy: metric.total ? metric.top3 / metric.total : null,
    top3WhenPredicted: metric.coverage ? metric.top3 / metric.coverage : null,
    strategies: metric.strategies,
    constraintSources: metric.constraintSources,
  };
}

function fmt(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

async function loadFirestore() {
  if (!fs.existsSync(KEY_PATH)) throw new Error(`Service account key not found at ${KEY_PATH}`);
  if (!getApps().length) {
    initializeApp({ credential: cert(require(KEY_PATH)) });
  }
  return getFirestore();
}

async function main() {
  const args = parseArgs(process.argv);
  const since = parseSince(args.since);
  const db = await loadFirestore();

  const [tripSnap, stopsSnap] = await Promise.all([
    db.collection('trips').get(),
    db.collection('stops').get(),
  ]);

  const stopsLibrary = stopsSnap.docs.map(doc => {
    const data = doc.data();
    return { name: data.name, aliases: data.aliases || [] };
  });
  PredictionEngineV3.stopsLibrary = stopsLibrary;
  PredictionEngineV3.networkGraph = null;

  const trips = tripSnap.docs
    .map(doc => cleanTrip(doc.id, doc.data(), args))
    .filter(Boolean)
    .sort((a, b) => a.startTime - b.startTime);

  const primaryAgency = args.agency || 'TTC';
  const v6State = createV6State(primaryAgency, args.network);
  const historyByUser = new Map();
  const metrics = {
    V3: emptyMetric(),
    V4: emptyMetric(),
    V5: emptyMetric(),
    V6: emptyMetric(),
  };
  const rows = [];

  for (const trip of trips) {
    const historyAsc = historyByUser.get(trip.userId) || [];
    const historyDesc = [...historyAsc].reverse();
    const previousTrip = historyAsc[historyAsc.length - 1] || null;
    const inEvalWindow = (!since || trip.startTime >= since) && historyAsc.length >= args.minHistory;

    if (inEvalWindow) {
      const minutesSinceLastTrip = gapMinutes(previousTrip, trip);
      const context = {
        route: trip.route,
        startStopName: trip.startStopName,
        direction: trip.direction,
        time: trip.startTime,
        duration: trip.duration,
        lastEndStopName: previousTrip?.endStopName || null,
        lastRoute: previousTrip?.route || null,
        minutesSinceLastTrip,
        agency: trip.agency,
        primaryAgency,
        defaultAgency: primaryAgency,
        stopsLibrary,
        networkGraph: null,
      };

      const v3 = PredictionEngineV3.guessTopEndStops(historyDesc, context, 3);
      const v4 = PredictionEngineV4.guessTopEndStops(context, 3);
      const v5 = await PredictionEngineV5.guessTopEndStops(context, 3);
      const v6 = predictV6(trip, v6State, 2);

      addPrediction(metrics.V3, trip, v3, stopsLibrary);
      addPrediction(metrics.V4, trip, v4, stopsLibrary);
      addPrediction(metrics.V5, trip, v5, stopsLibrary);
      addPrediction(metrics.V6, trip, v6.predictions, stopsLibrary, v6.strategy, v6.constraintSource);

      rows.push({
        tripId: trip.id,
        startTime: trip.startTime.toISOString(),
        route: trip.route,
        direction: trip.direction,
        startStopName: trip.startStopName,
        actual: scoreLabel(trip.route, trip.endStopName, trip.direction, trip.agency, stopsLibrary),
        predictions: {
          V3: v3,
          V4: v4,
          V5: v5,
          V6: v6.predictions,
        },
        v6Strategy: v6.strategy,
        v6ConstraintSource: v6.constraintSource,
      });
    }

    updateV6(trip, v6State);
    observeReplayGraph(v6State.network, trip, previousTrip);
    historyAsc.push(trip);
    historyByUser.set(trip.userId, historyAsc);
  }

  let evalRows = rows;
  if (args.recent) {
    evalRows = rows.slice(-args.recent);
  }

  const resultMetrics = {};
  if (evalRows.length !== rows.length) {
    for (const key of Object.keys(metrics)) resultMetrics[key] = emptyMetric();
    for (const row of evalRows) {
      const trip = trips.find(t => t.id === row.tripId);
      addPrediction(resultMetrics.V3, trip, row.predictions.V3, stopsLibrary);
      addPrediction(resultMetrics.V4, trip, row.predictions.V4, stopsLibrary);
      addPrediction(resultMetrics.V5, trip, row.predictions.V5, stopsLibrary);
      addPrediction(resultMetrics.V6, trip, row.predictions.V6, stopsLibrary, row.v6Strategy, row.v6ConstraintSource);
    }
  } else {
    Object.assign(resultMetrics, metrics);
  }

  const summary = Object.fromEntries(
    Object.entries(resultMetrics).map(([key, metric]) => [key, summarizeMetric(metric)])
  );

  console.log('\nHistorical End-Stop Replay');
  console.log(`  userId: ${args.userId}`);
  console.log(`  agency: ${args.agency || '*'}`);
  console.log(`  source: ${args.source || '*'}`);
  console.log(`  since: ${args.since || '*'}`);
  console.log(`  network replay: ${args.network ? 'on' : 'off'}`);
  console.log(`  clean trips loaded: ${trips.length}`);
  console.log(`  eval trips: ${evalRows.length}`);
  console.log('  caveat: V3/V6 are chronological; V4/V5 use current trained artifacts for backtest scoring.');
  for (const [key, metric] of Object.entries(summary)) {
    console.log(`  ${key}: top1 ${metric.top1}/${metric.total} (${fmt(metric.top1Accuracy)}), top3 ${metric.top3}/${metric.total} (${fmt(metric.top3Accuracy)}), coverage ${metric.coverage}/${metric.total} (${fmt(metric.coverageRate)})`);
  }
  console.log(`  V6 strategies: ${JSON.stringify(summary.V6.strategies)}`);
  console.log(`  V6 constraints: ${JSON.stringify(summary.V6.constraintSources)}`);

  if (args.jsonOut) {
    const outPath = path.isAbsolute(args.jsonOut) ? args.jsonOut : path.join(REPO_ROOT, args.jsonOut);
    fs.writeFileSync(outPath, JSON.stringify({
      scope: args,
      caveat: 'V3/V6 are chronological; V4/V5 use current trained artifacts for backtest scoring.',
      cleanTripCount: trips.length,
      evalTripCount: evalRows.length,
      summary,
      rows: evalRows,
    }, null, 2));
    console.log(`\nWrote JSON results to ${outPath}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  createV6State,
  chooseWithNetworkFallback,
  predictV6,
  updateV6,
  observeReplayGraph,
};
