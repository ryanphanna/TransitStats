#!/usr/bin/env node
/**
 * Replays the serving-side JS predictors (V3 heuristic, habit engine, topology
 * constraints) over an exported trip history, reconstructing the history each
 * trip would have seen at its start time. Output feeds ml/eval/harness.py.
 *
 * Usage (TZ controls getHours()/getDay(), exactly as in Cloud Functions):
 *   TZ=UTC node ml/eval/replay_js.js --trips <trips.jsonl> --stops <stops.json> --out <out.jsonl> [--from 2026-01-01]
 *     [--limit N]            history window (newest N completed trips; 0 = all).
 *                            Default = serving's PREDICTION_HISTORY_LIMIT (functions/lib/constants.js).
 *     [--config '{"K":v}']   override PredictionEngineV3.CONFIG keys (tuning experiments only)
 *
 * Inputs and outputs contain private trip data: keep them under ml/artifacts/.
 */
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'functions', 'lib');
const { PredictionEngineV3 } = require(path.join(LIB, 'predict_v3.js'));
const { HabitEngine } = require(path.join(LIB, 'habit.js'));
const { PREDICTION_HISTORY_LIMIT } = require(path.join(LIB, 'constants.js'));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const HIGH_IMPACT = new Set(['route', 'direction', 'agency', 'startStop', 'startStopCode', 'startStopName', 'endStop', 'endStopCode', 'endStopName']);

// Mirrors hasBlockingCorrection() + the filter in db/trips.js getRecentCompletedTrips().
function servesAsHistory(t) {
  if (t.incomplete || t.discarded || t.needs_review) return false;
  if (t.exclude_from_training || t.exclude_from_accuracy || t.needs_reprocess) return false;
  if ((t.correctedFields || []).some(f => HIGH_IMPACT.has(f))) return false;
  return t.stop_matched != null ? !!t.stop_matched : !!t.verified;
}

const ms = v => (v ? new Date(v).getTime() : NaN);

function main() {
  const trips = fs.readFileSync(arg('trips'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const stops = JSON.parse(fs.readFileSync(arg('stops'), 'utf8'));
  const fromMs = ms(arg('from', '2026-01-01'));
  const out = fs.createWriteStream(arg('out'));

  const limitArg = Number(arg('limit', String(PREDICTION_HISTORY_LIMIT)));
  const limit = limitArg > 0 ? limitArg : Infinity;
  if (arg('config')) Object.assign(PredictionEngineV3.CONFIG, JSON.parse(arg('config')));

  PredictionEngineV3.stopsLibrary = stops;
  PredictionEngineV3.networkGraph = null; // learned Firestore graph can't be time-travelled offline
  // Canonicalization is a pure function of (name, library) and scans the whole library per
  // call; memoize it so replay finishes in seconds. Behaviour is unchanged.
  const canon = PredictionEngineV3._canonicalizeStop.bind(PredictionEngineV3);
  const canonCache = new Map();
  PredictionEngineV3._canonicalizeStop = name => {
    if (!canonCache.has(name)) canonCache.set(name, canon(name));
    return canonCache.get(name);
  };

  // Completed trips ordered by endTime desc, as the Firestore query returns them.
  const completed = trips.filter(t => t.endTime && Number.isFinite(ms(t.endTime)))
    .sort((a, b) => ms(b.endTime) - ms(a.endTime));

  const habitDb = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };

  const targets = trips.filter(t => t.startTime && ms(t.startTime) >= fromMs && t.route && t.startStopName);
  let done = 0;
  (async () => {
    for (const trip of targets) {
      const now = new Date(trip.startTime);
      const nowMs = now.getTime();
      const before = completed.filter(t => ms(t.endTime) < nowMs && t._id !== trip._id);
      const history = before.slice(0, limit).filter(servesAsHistory);
      const habitHistory = before.slice(0, 200).filter(servesAsHistory);

      const lastTrip = history[0] || null;
      const lastEndStopName = lastTrip ? (lastTrip.endStopName || lastTrip.endStop || null) : null;

      const habits = await HabitEngine.rebuild(habitDb, 'replay', habitHistory);
      const habit = HabitEngine.match(habits, trip.startStopName, now, { route: trip.route, direction: trip.direction, agency: trip.agency });

      const routeGuess = PredictionEngineV3.guess(history, {
        stopName: trip.startStopName, time: now, lastEndStopName, agency: trip.agency,
      });
      const endCtx = {
        route: trip.route, startStopName: trip.startStopName, direction: trip.direction, time: now,
        lastEndStopName, lastRoute: lastTrip ? lastTrip.route : null, agency: trip.agency,
      };
      const endTop = PredictionEngineV3.guessTopEndStops(history, endCtx, 3);
      const constraint = PredictionEngineV3.getEndStopConstraint(endCtx);

      out.write(JSON.stringify({
        id: trip._id,
        tz: process.env.TZ || null,
        v3Version: PredictionEngineV3.VERSION,
        historyLen: history.length,
        lastEndStop: lastEndStopName,
        lastRoute: lastTrip ? lastTrip.route : null,
        lastStartTime: lastTrip ? lastTrip.startTime : null,
        habitCount: habits.length,
        habitLive: habits.filter(h => !h.stale).length,
        habit: habit ? { route: habit.route, direction: habit.direction, endStop: habit.endStop, confidence: habit.confidence } : null,
        v3Route: routeGuess ? { route: routeGuess.route, direction: routeGuess.direction, confidence: routeGuess.confidence } : null,
        v3EndTop: endTop.map(p => ({ stop: p.stop, confidence: p.confidence })),
        constraintSource: constraint.source,
        legalStops: constraint.legalStops ? [...constraint.legalStops] : null,
      }) + '\n');
      done += 1;
      if (done % 200 === 0) console.error(`  ${done}/${targets.length}`);
    }
    out.end();
    console.error(`replayed ${done} trips (TZ=${process.env.TZ || 'unset'})`);
  })();
}

main();
