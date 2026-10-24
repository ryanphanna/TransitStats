#!/usr/bin/env node
/**
 * Weekly shadow grading for the V4/V5 end-stop models (CIV-425).
 *
 * V4/V5 no longer run on every trip (ML_ENDSTOP_LIVE in lib/constants.js). Instead, once a week,
 * this replays the past week's real trips through V3, V4 and V5 and records each one's top-1
 * accuracy, so we can see whether the ML models pull ahead of V3 and switch them back on.
 *
 *   TZ=UTC node scripts/weekly-shadow-grade.js [--days 7] [--end <ISO time>] [--dry-run] [--json-out <path>]
 *
 * - Users: TRAIN_USER_IDS (comma-separated), the same users the models are trained on.
 * - Models: the PUBLISHED set (models/latest.json in private storage), i.e. the set that served
 *   during the week. Run it before the retrain publishes, so the models never saw these trips.
 * - Each trip is replayed the way live does it at trip start: the newest PREDICTION_HISTORY_LIMIT
 *   completed trips before it with the serving filter, the same V4/V5 eligibility gate, the same
 *   context builder (lib/endstop-context.js), and hits scored with V3's _stopMatch like
 *   finalization's grading. The learned network graph can't be rewound, so it is left out
 *   (networkGraph null) for all three engines.
 * - Trips: texted trips only (sms, sms_fallback, mms; so no outage-recovery or imports), finished,
 *   and clean (no needs_review, no blocking correction, stop matched).
 * - Read-only on trips. Writes one summary doc per user to mlShadowGrades/{endDate}__{userId}
 *   (skipped with --dry-run) and, with --json-out, a summary with counts and rates only (no stop
 *   names) for the MODEL_LOG entry.
 *
 * Needs Admin credentials (GOOGLE_APPLICATION_CREDENTIALS).
 */
process.env.TZ = process.env.TZ || 'UTC';

const fs = require('fs');
const { PredictionEngine } = require('../lib/predict.js');
const { buildEndStopContext } = require('../lib/endstop-context');
const { getEligibility, artifactSupportsAgency } = require('../lib/intelligence-eligibility');
const { getConfiguredPrimaryAgency } = require('../lib/primary-agency');
const { PREDICTION_HISTORY_LIMIT, ELIGIBILITY_HISTORY_LIMIT } = require('../lib/constants');

// Texted trips: the ones live grading covers. Excludes outage-recovery and legacy imports.
const EVAL_SOURCES = new Set(['sms', 'sms_fallback', 'mms']);
const ENGINES = ['v3', 'v4', 'v5'];
const DAY_MS = 24 * 60 * 60 * 1000;

function toMs(value) {
  if (!value) return NaN;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  return new Date(value).getTime();
}

/** db/trips.js getRecentCompletedTrips() filter: what live prediction history may contain. */
function servesAsHistory(trip, hasBlockingCorrection) {
  if (trip.incomplete || trip.discarded || trip.needs_review) return false;
  if (hasBlockingCorrection(trip)) return false;
  return trip.stop_matched != null ? !!trip.stop_matched : !!trip.verified;
}

function isGradableTrip(trip, startMs, endMs, hasBlockingCorrection) {
  const start = toMs(trip.startTime);
  if (!(start >= startMs && start < endMs)) return false;
  if (!Number.isFinite(toMs(trip.endTime))) return false;
  if (!EVAL_SOURCES.has(trip.source)) return false;
  if (!trip.route || !trip.startStopName || !trip.endStopName) return false;
  return servesAsHistory(trip, hasBlockingCorrection);
}

function emptyEngine() {
  return { answered: 0, hits: 0 };
}

function rate(num, den) {
  return den > 0 ? num / den : null;
}

/**
 * Replays one user's trips in [start, end). Pure apart from the injected engines.
 * `trips` is the user's full trip list (history needs trips from before the window).
 * Returns counts only; `rows` (per trip) is for tests and local inspection, never stored.
 */
async function gradeWindow({
  trips, start, end, stopsLibrary = [], profile = null, engines, metas = {},
  hasBlockingCorrection, historyLimit = PREDICTION_HISTORY_LIMIT, eligibilityLimit = ELIGIBILITY_HISTORY_LIMIT,
}) {
  const startMs = start.getTime();
  const endMs = end.getTime();
  // Newest first by end time, as the Firestore query in getRecentCompletedTrips returns them.
  const completed = trips.filter(t => Number.isFinite(toMs(t.endTime)))
    .sort((a, b) => toMs(b.endTime) - toMs(a.endTime));
  const targets = trips.filter(t => isGradableTrip(t, startMs, endMs, hasBlockingCorrection))
    .sort((a, b) => toMs(a.startTime) - toMs(b.startTime));

  // Per-call V3 engine, like handlers-trip.js requestEngine(): no network graph in a replay.
  const v3 = Object.create(engines.v3);
  v3.stopsLibrary = stopsLibrary;
  v3.networkGraph = null;
  const stopMatch = (predicted, actual) => !!predicted && v3._stopMatch(predicted, actual);

  const result = {
    window: { start: start.toISOString(), end: end.toISOString() },
    tripsInWindow: targets.length,
    ineligible: 0,
    graded: 0,
    engines: Object.fromEntries(ENGINES.map(e => [e, emptyEngine()])),
    paired: { n: 0, v3: 0, v4: 0, v5: 0 },
    rows: [],
  };

  for (const trip of targets) {
    const nowMs = toMs(trip.startTime);
    const now = new Date(nowMs);
    const history = completed
      .filter(t => toMs(t.endTime) < nowMs && t.id !== trip.id)
      .slice(0, historyLimit)
      .filter(t => servesAsHistory(t, hasBlockingCorrection));

    // Live V4/V5 eligibility gate (handlers-trip.js mlEndStopReady).
    const eligible = getEligibility(history.slice(0, eligibilityLimit), trip.agency).endStopEligible &&
      artifactSupportsAgency(metas.v4, trip.agency, 'agency::end_stop') &&
      artifactSupportsAgency(metas.v5, trip.agency, 'agency::end_stop');
    if (!eligible) {
      result.ineligible += 1;
      continue;
    }

    const primaryAgency = (profile ? getConfiguredPrimaryAgency(profile) : null)
      || history.find(t => t.agency)?.agency
      || trip.agency
      || null;
    const context = buildEndStopContext({
      route: trip.route,
      startStopName: trip.startStopName,
      direction: trip.direction || null,
      now,
      history,
      agency: trip.agency || null,
      primaryAgency,
      stopsLibrary,
      networkGraph: null,
    });

    const [v4Top, v5Top] = await Promise.all([
      engines.v4.guessTopEndStops(context, 1),
      engines.v5.guessTopEndStops(context, 1),
    ]);
    const predictions = {
      v3: v3.guessEndStop(history, context) || null,
      v4: v4Top?.[0] || null,
      v5: v5Top?.[0] || null,
    };

    result.graded += 1;
    const hits = {};
    for (const engine of ENGINES) {
      const prediction = predictions[engine];
      if (!prediction?.stop) continue;
      hits[engine] = stopMatch(prediction.stop, trip.endStopName);
      result.engines[engine].answered += 1;
      if (hits[engine]) result.engines[engine].hits += 1;
    }
    if (ENGINES.every(engine => engine in hits)) {
      result.paired.n += 1;
      for (const engine of ENGINES) if (hits[engine]) result.paired[engine] += 1;
    }
    result.rows.push({ id: trip.id, hits });
  }

  for (const engine of ENGINES) {
    const stats = result.engines[engine];
    stats.coverage = rate(stats.answered, result.graded);
    // Hits over all graded trips (a miss when it gave no answer).
    stats.top1 = rate(stats.hits, result.graded);
    // Hits over the trips it answered: what live predictionStats grading measured.
    stats.top1WhenAnswered = rate(stats.hits, stats.answered);
  }
  for (const engine of ENGINES) {
    result.paired[`${engine}Top1`] = rate(result.paired[engine], result.paired.n);
  }
  return result;
}

/** Counts and rates only: safe for the committed MODEL_LOG. */
function publicSummary(result) {
  const { rows, ...rest } = result;
  return rest;
}

function pct(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatSummary(result) {
  const lines = [
    `Window ${result.window.start} to ${result.window.end}: ${result.tripsInWindow} texted trips, ` +
      `${result.graded} graded, ${result.ineligible} not eligible for V4/V5.`,
  ];
  for (const engine of ENGINES) {
    const s = result.engines[engine];
    lines.push(`  ${engine.toUpperCase()}: top-1 ${s.hits}/${result.graded} (${pct(s.top1)}), ` +
      `answered ${s.answered} (${pct(s.coverage)}), right when answered ${pct(s.top1WhenAnswered)}`);
  }
  const p = result.paired;
  lines.push(`  Paired (all three answered, n=${p.n}): V3 ${pct(p.v3Top1)}, V4 ${pct(p.v4Top1)}, V5 ${pct(p.v5Top1)}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { days: 7, end: null, dryRun: false, jsonOut: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') args.days = Number(argv[++i]);
    else if (argv[i] === '--end') args.end = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--json-out') args.jsonOut = argv[++i];
  }
  if (!(args.days > 0)) throw new Error('--days must be positive');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userIds = String(process.env.TRAIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (userIds.length === 0) throw new Error('TRAIN_USER_IDS is empty');

  // Initializes the Admin app (credentials from GOOGLE_APPLICATION_CREDENTIALS).
  const { db, FieldValue } = require('../lib/db/core');
  const { hasBlockingCorrection } = require('../lib/db/trips');
  const { getStopsLibrary } = require('../lib/db/stops');
  const ModelStore = require('../lib/model-store');
  const { PredictionEngineV4 } = require('../lib/predict_v4.js');
  const { PredictionEngineV5 } = require('../lib/predict_v5.js');
  const logger = require('../lib/logger');
  logger.info = () => {}; // per-trip constraint logs drown the summary

  const models = await ModelStore.ensure();
  if (!models) throw new Error('Published models could not be loaded');
  let modelVersion = process.env.ML_MODEL_DIR ? 'local' : null;
  if (!modelVersion) {
    const bucket = require('firebase-admin/storage').getStorage().bucket(ModelStore.bucketName());
    const [pointer] = await bucket.file(ModelStore.POINTER).download();
    modelVersion = JSON.parse(pointer.toString('utf8')).version || null;
  }

  const end = args.end ? new Date(args.end) : new Date();
  const start = new Date(end.getTime() - args.days * DAY_MS);
  const stopsLibrary = await getStopsLibrary(); // the same library live trip starts read

  const summaries = [];
  for (const userId of userIds) {
    const [tripsSnap, profileSnap] = await Promise.all([
      db.collection('trips').where('userId', '==', userId).get(),
      db.collection('profiles').doc(userId).get(),
    ]);
    const trips = tripsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const result = await gradeWindow({
      trips, start, end, stopsLibrary,
      profile: profileSnap.exists ? profileSnap.data() : null,
      engines: { v3: PredictionEngine, v4: PredictionEngineV4, v5: PredictionEngineV5 },
      metas: { v4: models.endStopV4Meta, v5: models.endStopV5Meta },
      hasBlockingCorrection,
    });
    const summary = {
      ...publicSummary(result),
      modelVersion,
      versions: { v3: PredictionEngine.VERSION, v4: PredictionEngineV4.VERSION, v5: PredictionEngineV5.VERSION },
      networkGraph: 'off (not replayable)',
    };
    console.log(formatSummary(result));
    summaries.push(summary);
    if (!args.dryRun) {
      const docId = `${end.toISOString().slice(0, 10)}__${userId}`;
      await db.collection('mlShadowGrades').doc(docId).set({ ...summary, userId, createdAt: FieldValue.serverTimestamp() });
      console.log(`Wrote mlShadowGrades/${docId}`);
    }
  }

  if (args.jsonOut) {
    fs.writeFileSync(args.jsonOut, JSON.stringify({ users: summaries.length, summaries }, null, 2));
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { gradeWindow, publicSummary, formatSummary, servesAsHistory, isGradableTrip, parseArgs, EVAL_SOURCES };
