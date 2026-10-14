/**
 * Unit tests for post-trip finalization logic (functions/lib/finalization.js).
 * Run with: node test_finalization.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadFinalization(overrides = {}) {
  const finalizationPath = require.resolve('./lib/finalization');
  delete require.cache[finalizationPath];

  const calls = {
    docUpdates: [],
    collectionAdds: [],
    batchUpdates: [],
    batchCommits: 0,
    loggerInfo: [],
    loggerError: [],
  };

  const dbModule = {
    getRecentCompletedTrips: async () => [],
    getStopsLibrary: async () => [],
    lookupStop: async () => ({
      id: 'stop_1',
      stopCode: '1',
      stopName: 'Stop A',
      source: 'verified',
    }),
    hasBlockingCorrection: () => false,
    db: {
      collection: (name) => ({
        add: async (data) => { calls.collectionAdds.push({ collection: name, data }); },
        doc: (id) => ({
          id,
          update: async (data) => { calls.docUpdates.push({ collection: name, id, data }); },
          set: async () => {},
          get: async () => ({ exists: false, data: () => ({}) }),
        }),
        where: () => ({
          where: () => ({
            limit: () => ({ get: async () => ({ empty: true, docs: [], forEach: () => {} }) }),
          }),
        }),
      }),
      batch: () => ({
        update: (ref, data) => { calls.batchUpdates.push({ ref, data }); },
        commit: async () => { calls.batchCommits++; },
      }),
    },
    FieldValue: {
      increment: (v) => ({ _op: 'increment', v }),
      serverTimestamp: () => new Date('2026-07-19T00:00:00Z'),
    },
    ...overrides.dbModule,
  };

  const predict = {
    PredictionEngine: {
      _normalizeDirection: (d) => d,
      _stopMatch: () => false,
      ...(overrides.predict?.PredictionEngine || {}),
    },
  };
  const network = {
    NetworkEngine: {
      getConnectionsAtStop: async () => ({}),
      getConnectionLabels: async () => ({}),
      getEdgeMedianDuration: () => null,
      observe: async () => {},
      _key: (s) => s.toString().toLowerCase(),
      _docId: (userId, agency, route) => [userId, agency, route].join('_'),
      ...(overrides.network?.NetworkEngine || {}),
    },
  };
  const habit = {
    HabitEngine: { rebuild: async () => {}, ...(overrides.habit?.HabitEngine || {}) },
  };
  const transfer = {
    TransferEngine: {
      score: () => 0,
      CONFIDENCE_THRESHOLD: 0.55,
      ...(overrides.transfer?.TransferEngine || {}),
    },
  };
  const utils = {
    getRouteDisplay: (route) => String(route),
    normalizeRouteForGrading: (route) => String(route).trim().toLowerCase(),
    ...overrides.utils,
  };
  const logger = {
    info: (message, data) => { calls.loggerInfo.push({ message, data }); },
    error: (message, data) => { calls.loggerError.push({ message, data }); },
    warn: () => {},
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.id === finalizationPath) {
      if (request === './db') return dbModule;
      if (request === './predict.js') return predict;
      if (request === './network.js') return network;
      if (request === './habit') return habit;
      if (request === './transfer.js') return transfer;
      if (request === './utils') return utils;
      if (request === './logger') return logger;
    }
    return originalLoad(request, parent, isMain);
  };

  let finalization;
  try {
    finalization = require('./lib/finalization');
  } finally {
    Module._load = originalLoad;
  }

  return { finalization, calls };
}

// --- runPostEndFinalization: idempotency guard ---

test('runPostEndFinalization skips already-finalized trip without force', async () => {
  const { finalization, calls } = loadFinalization();
  await finalization.runPostEndFinalization({ id: 't1', userId: 'u1', backgroundFinalizedAt: new Date() });
  assert.equal(calls.docUpdates.length, 0, 'should not write anything when skipped');
});

test('runPostEndFinalization re-runs when force=true even if already finalized', async () => {
  const { finalization, calls } = loadFinalization();
  await finalization.runPostEndFinalization(
    { id: 't1', userId: 'u1', backgroundFinalizedAt: new Date(), duration: 10 },
    { force: true }
  );
  const finalWrite = calls.docUpdates.find((u) => u.data.backgroundFinalizedAt);
  assert.ok(finalWrite, 'should write backgroundFinalizedAt when forced');
  assert.deepEqual(finalWrite.data.finalization.steps, ['learning', 'grading']);
});

test('runPostEndFinalization confirms a code-matched trip without changing stop text', async () => {
  const { finalization, calls } = loadFinalization();
  await finalization.runPostEndFinalization({
    id: 't-code-only',
    userId: 'u1',
    agency: 'TTC',
    route: '52g',
    direction: 'Eastbound',
    startStopCode: '5394',
    startStopName: null,
    endStopCode: '12203',
    endStopName: 'Lawrence West Station',
    stop_matched: false,
    duration: 20,
  });
  const finalWrite = calls.docUpdates.find((u) => u.data.backgroundFinalizedAt);
  assert.equal(finalWrite.data.stop_matched, true);
});

// --- computeJourneyLink: pure output ---

test('computeJourneyLink returns empty note/id when there is no previous trip', async () => {
  const { finalization } = loadFinalization();
  const result = await finalization.computeJourneyLink({ id: 't2' }, null, new Date());
  assert.deepEqual(result, { journeyNote: '', journeyId: null });
});

test('computeJourneyLink builds a transfer note and reuses prevTrip.journeyId', async () => {
  const { finalization } = loadFinalization();
  const prevTrip = { id: 'p1', route: '510', journeyId: 'existing-journey', endTime: new Date('2026-07-19T12:00:00Z') };
  const startTime = new Date('2026-07-19T12:04:00Z');
  const { journeyNote, journeyId } = await finalization.computeJourneyLink({ id: 't2' }, prevTrip, startTime);
  assert.equal(journeyId, 'existing-journey');
  assert.match(journeyNote, /4 min transfer/);
});

// --- detectJourneyLink: matching/fallback + uncaught-error behavior ---

test('detectJourneyLink prefers a scored provisionalPrevTripId over history scan', async () => {
  const provisional = { id: 'prev1', endTime: new Date(), endStopName: 'Union' };
  const { finalization } = loadFinalization({
    dbModule: { getRecentCompletedTrips: async () => [provisional] },
    transfer: { TransferEngine: { score: () => 0.9, CONFIDENCE_THRESHOLD: 0.55 } },
  });
  const result = await finalization.detectJourneyLink({ id: 't2', userId: 'u1', provisionalPrevTripId: 'prev1' });
  assert.equal(result.id, 'prev1');
});

test('detectJourneyLink falls back to history scan when no provisional match scores high enough', async () => {
  const candidate = { id: 'histTrip', endTime: new Date(), endStopName: 'Union' };
  const { finalization } = loadFinalization({
    dbModule: { getRecentCompletedTrips: async () => [candidate] },
    transfer: { TransferEngine: { score: () => 0.9, CONFIDENCE_THRESHOLD: 0.55 } },
  });
  const result = await finalization.detectJourneyLink({ id: 't2', userId: 'u1' });
  assert.equal(result.id, 'histTrip');
});

test('detectJourneyLink returns null when nothing scores high enough', async () => {
  const { finalization } = loadFinalization({
    transfer: { TransferEngine: { score: () => 0.1, CONFIDENCE_THRESHOLD: 0.55 } },
  });
  const result = await finalization.detectJourneyLink({ id: 't2', userId: 'u1' });
  assert.equal(result, null);
});

test('detectJourneyLink propagates errors instead of swallowing them (unlike its siblings)', async () => {
  const { finalization } = loadFinalization({
    dbModule: { getRecentCompletedTrips: async () => [{ id: 'histTrip', endTime: new Date(), endStopName: 'Union' }] },
    network: { NetworkEngine: { getConnectionsAtStop: async () => { throw new Error('boom'); } } },
  });
  await assert.rejects(
    () => finalization.detectJourneyLink({ id: 't2', userId: 'u1', agency: 'TTC', startStopName: 'X' }),
    /boom/
  );
});

// --- applyJourneyLink: batch write ---

test('applyJourneyLink writes journeyId to both trips via a single batch commit', async () => {
  const { finalization, calls } = loadFinalization();
  await finalization.applyJourneyLink({ id: 't2' }, { id: 't1' }, 'journey-xyz');
  assert.equal(calls.batchCommits, 1);
  assert.equal(calls.batchUpdates.length, 2);
  assert.deepEqual(calls.batchUpdates.map((u) => u.data.journeyId), ['journey-xyz', 'journey-xyz']);
});

test('applyJourneyLink is a no-op when prevTrip or journeyId is missing', async () => {
  const { finalization, calls } = loadFinalization();
  await finalization.applyJourneyLink({ id: 't2' }, null, 'journey-xyz');
  assert.equal(calls.batchCommits, 0);
});

// --- gradeAllPredictions: light smoke test only ---

test('gradeAllPredictions does not throw or log an error for a trip with no predictions', async () => {
  const { finalization, calls } = loadFinalization();
  await finalization.gradeAllPredictions({ id: 't1', route: '510', agency: 'TTC' }, { userId: 'u1' }, null, 12);
  assert.equal(calls.loggerError.length, 0);
});

test('gradeAllPredictions writes a predictionStats doc when a V3 prediction is present', async () => {
  const { finalization, calls } = loadFinalization();
  const activeTrip = {
    id: 't1',
    route: '510',
    agency: 'TTC',
    startStopName: 'Union',
    prediction: { route: '510', stop: 'Union', confidence: 0.8, version: 'v3' },
  };
  await finalization.gradeAllPredictions(activeTrip, { userId: 'u1' }, null, 12);
  assert.equal(calls.loggerError.length, 0);
  assert.ok(calls.collectionAdds.some((c) => c.collection === 'predictionStats'));
});

test('gradeAllPredictions grades V3 and the habit separately on a habit trip', async () => {
  const { finalization, calls } = loadFinalization();
  const activeTrip = {
    id: 't2', route: '510', agency: 'TTC', startStopName: 'King / Spadina',
    endStopPrediction: { stop: 'Bathurst', confidence: 70 },
    endStopPredictionV4: { stop: 'Bathurst', confidence: 55 },
    endStopPredictionV5: { stop: 'Strachan', confidence: 50 },
    habitPrediction: { stop: 'King / Spadina', endStop: 'Spadina Station', confidence: 0.8 },
  };
  await finalization.gradeAllPredictions(activeTrip, { userId: 'u1' }, { stopName: 'Spadina Station' }, 12);
  const stats = calls.collectionAdds.filter((c) => c.collection === 'predictionStats').map((c) => c.data || c.doc || c);
  const byVersion = (v) => stats.filter((d) => d.version === v);
  assert.equal(byVersion('v3-endstop').length, 1);
  assert.equal(byVersion('v3-endstop')[0].endStopPredicted, 'Bathurst');
  assert.equal(byVersion('v4-endstop').length, 1);
  assert.equal(byVersion('v5-endstop').length, 1);
  assert.equal(byVersion('habit-endstop').length, 1);
  assert.equal(byVersion('habit-endstop')[0].endStopPredicted, 'Spadina Station');
});

// --- triggerManualFinalization: throw paths ---

test('triggerManualFinalization throws when tripId is missing', async () => {
  const { finalization } = loadFinalization();
  await assert.rejects(() => finalization.triggerManualFinalization(), /tripId is required/);
});

test('triggerManualFinalization throws when trip does not exist', async () => {
  const { finalization } = loadFinalization({
    dbModule: {
      db: {
        collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
      },
    },
  });
  await assert.rejects(() => finalization.triggerManualFinalization('missing-id'), /Trip not found/);
});

// --- refreshStopMatchAfterCorrection ---

const endedTrip = (overrides = {}) => ({
  route: '506', agency: 'TTC', direction: 'Westbound',
  startStopName: 'College', endStopName: 'High Park', endTime: 1, stop_matched: false,
  ...overrides,
});
const found = async () => ({ status: 'found', stop: { id: 's' } });
const notFound = async () => ({ status: 'notFound', stop: null });
const errored = async () => ({ status: 'error', stop: null });

test('a corrected stop that now resolves flips the trip to matched', async () => {
  const { finalization } = loadFinalization();
  const before = endedTrip({ startStopName: 'Colleg' });
  assert.deepEqual(await finalization.refreshStopMatchAfterCorrection(before, endedTrip(), found), { changed: true, matched: true });
});

test('a correction that no longer resolves flips a matched trip back to unmatched', async () => {
  const { finalization } = loadFinalization();
  const before = endedTrip({ stop_matched: true });
  const after = endedTrip({ stop_matched: true, endStopName: 'Nowhere Station' });
  const check = async (code, name) => (name === 'Nowhere Station' ? { status: 'notFound' } : { status: 'found' });
  assert.deepEqual(await finalization.refreshStopMatchAfterCorrection(before, after, check), { changed: true, matched: false });
});

test('a lookup error never writes: the trip is left untouched', async () => {
  const { finalization } = loadFinalization();
  const before = endedTrip({ stop_matched: true, startStopName: 'Colleg' });
  const after = endedTrip({ stop_matched: true });
  assert.equal((await finalization.refreshStopMatchAfterCorrection(before, after, errored)).changed, false);
  const mixed = async (code, name) => (name === 'High Park' ? { status: 'error' } : { status: 'notFound' });
  assert.equal((await finalization.refreshStopMatchAfterCorrection(before, after, mixed)).changed, false);
});

test('skips when the same write already changed stop_matched, on route-only edits, and on unfinished trips', async () => {
  const { finalization } = loadFinalization();
  const check = async () => { throw new Error('should not look anything up'); };
  const trip = endedTrip();
  assert.equal((await finalization.refreshStopMatchAfterCorrection(trip, { ...trip, notes: 'hi' }, check)).changed, false);
  assert.equal((await finalization.refreshStopMatchAfterCorrection(trip, { ...trip, route: '505' }, check)).changed, false);
  assert.equal((await finalization.refreshStopMatchAfterCorrection(trip, { ...trip, direction: 'Eastbound' }, check)).changed, false);
  assert.equal((await finalization.refreshStopMatchAfterCorrection(trip, { ...trip, startStopName: 'X', stop_matched: true }, check)).changed, false);
  const active = endedTrip({ endTime: null });
  assert.equal((await finalization.refreshStopMatchAfterCorrection(active, { ...active, startStopName: 'X' }, check)).changed, false);
});

test('writing stop_matched itself does not count as a stop input change', () => {
  const { finalization } = loadFinalization();
  const trip = endedTrip();
  assert.equal(finalization.stopMatchInputsChanged(trip, { ...trip, stop_matched: true }), false);
  assert.equal(finalization.stopMatchInputsChanged(trip, { ...trip, endStopName: 'Other' }), true);
});
