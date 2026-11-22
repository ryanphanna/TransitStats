/**
 * Tests for NetworkEngine fallback behavior.
 * Run with: node test_network.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NetworkEngine } = require('./lib/network');

function makeDb(docsById) {
  return {
    collection(name) {
      assert.equal(name, 'networkGraph');
      return {
        doc(id) {
          return {
            get: async () => {
              const data = docsById[id];
              return {
                exists: !!data,
                data: () => data,
              };
            },
          };
        },
      };
    },
  };
}

test('load: returns personal graph when it has confident edges', async () => {
  const personalId = NetworkEngine._docId('u1', 'TTC', '510');
  const globalId = NetworkEngine._globalDocId('TTC', '510');
  const db = makeDb({
    [personalId]: {
      source: 'personal',
      edges: {
        e1: { fromStop: 'A', toStop: 'B', direction: 'Northbound', tripCount: 3 },
      },
    },
    [globalId]: {
      source: 'global',
      edges: {
        e2: { fromStop: 'A', toStop: 'C', direction: 'Northbound', tripCount: 9 },
      },
    },
  });

  const graph = await NetworkEngine.load(db, 'u1', 'TTC', '510');
  assert.equal(graph.source, 'personal');
});

test('load: falls back to global graph when personal graph has no confident edges', async () => {
  const personalId = NetworkEngine._docId('u1', 'TTC', '510');
  const globalId = NetworkEngine._globalDocId('TTC', '510');
  const db = makeDb({
    [personalId]: {
      source: 'personal',
      edges: {
        e1: { fromStop: 'A', toStop: 'B', direction: 'Northbound', tripCount: 1 },
      },
    },
    [globalId]: {
      source: 'global',
      edges: {
        e2: { fromStop: 'A', toStop: 'C', direction: 'Northbound', tripCount: 6 },
      },
    },
  });

  const graph = await NetworkEngine.load(db, 'u1', 'TTC', '510');
  assert.equal(graph.source, 'global');
});

test('loadGlobal: returns global graph by agency+route key', async () => {
  const globalId = NetworkEngine._globalDocId('TTC', '510');
  const db = makeDb({
    [globalId]: {
      source: 'global',
      edges: {},
    },
  });

  const graph = await NetworkEngine.loadGlobal(db, 'TTC', '510');
  assert.equal(graph.source, 'global');
});

// ---------------------------------------------------------------------------
// Writable in-memory mock — supports multiple collections, transactions, writes
// ---------------------------------------------------------------------------

function makeWriteableDb() {
  const store = {};
  const ref = (path) => ({
    _path: path,
    get: async () => ({
      exists: path in store,
      data: () => (path in store ? { ...store[path] } : undefined),
    }),
    set: async (data) => { store[path] = { ...data }; },
  });
  return {
    _store: store,
    collection: (c) => ({ doc: (id) => ref(`${c}/${id}`) }),
    runTransaction: async (fn) => {
      const tx = {
        get: async (r) => r.get(),
        set: (r, data) => { store[r._path] = { ...data }; },
      };
      await fn(tx);
    },
  };
}

// Valid trip for observe()
function observeTrip(overrides = {}) {
  return {
    route: '510',
    agency: 'TTC',
    direction: 'Northbound',
    startStopName: 'Spadina / College',
    endStopName: 'Spadina Station',
    duration: 8,
    ...overrides,
  };
}

// ─── _key ────────────────────────────────────────────────────────────────────

test('_key: lowercases and replaces spaces with underscores', () => {
  assert.equal(NetworkEngine._key('Spadina Station'), 'spadina_station');
});

test('_key: strips special characters', () => {
  assert.equal(NetworkEngine._key('Spadina / College'), 'spadina__college');
});

test('_key: handles route labels', () => {
  assert.equal(NetworkEngine._key('510'), '510');
  assert.equal(NetworkEngine._key('510A'), '510a');
  assert.equal(NetworkEngine._key('Red'), 'red');
});

// ─── getRoutesAtStop ─────────────────────────────────────────────────────────

test('getRoutesAtStop: returns empty object for unknown stop', async () => {
  const db = makeWriteableDb();
  assert.deepEqual(await NetworkEngine.getRoutesAtStop(db, 'TTC', 'Unknown Stop'), {});
});

test('getRoutesAtStop: returns empty object for missing args', async () => {
  const db = makeWriteableDb();
  assert.deepEqual(await NetworkEngine.getRoutesAtStop(db, null, 'Spadina Station'), {});
  assert.deepEqual(await NetworkEngine.getRoutesAtStop(db, 'TTC', null), {});
});

// ─── getConnectionsAtStop ────────────────────────────────────────────────────

test('getConnectionsAtStop: returns empty object for unknown stop', async () => {
  const db = makeWriteableDb();
  assert.deepEqual(await NetworkEngine.getConnectionsAtStop(db, 'TTC', 'Unknown Stop'), {});
});

// ─── _writeRouteStopIndex ────────────────────────────────────────────────────

test('_writeRouteStopIndex: writes a route with count 1', async () => {
  const db = makeWriteableDb();
  await NetworkEngine._writeRouteStopIndex(db, 'TTC', 'Spadina Station', '510');
  const result = await NetworkEngine.getRoutesAtStop(db, 'TTC', 'Spadina Station');
  assert.equal(result['510'], 1);
});

test('_writeRouteStopIndex: increments on repeated writes', async () => {
  const db = makeWriteableDb();
  await NetworkEngine._writeRouteStopIndex(db, 'TTC', 'Spadina Station', '510');
  await NetworkEngine._writeRouteStopIndex(db, 'TTC', 'Spadina Station', '510');
  await NetworkEngine._writeRouteStopIndex(db, 'TTC', 'Spadina Station', '510');
  assert.equal((await NetworkEngine.getRoutesAtStop(db, 'TTC', 'Spadina Station'))['510'], 3);
});

test('_writeRouteStopIndex: tracks multiple routes at the same stop', async () => {
  const db = makeWriteableDb();
  await NetworkEngine._writeRouteStopIndex(db, 'TTC', 'Spadina Station', '510');
  await NetworkEngine._writeRouteStopIndex(db, 'TTC', 'Spadina Station', '2');
  const result = await NetworkEngine.getRoutesAtStop(db, 'TTC', 'Spadina Station');
  assert.equal(result['510'], 1);
  assert.equal(result['2'], 1);
});

test('_writeRouteStopIndex: skips when any required arg is missing', async () => {
  const db = makeWriteableDb();
  await NetworkEngine._writeRouteStopIndex(db, null, 'Spadina Station', '510');
  await NetworkEngine._writeRouteStopIndex(db, 'TTC', null, '510');
  await NetworkEngine._writeRouteStopIndex(db, 'TTC', 'Spadina Station', null);
  assert.equal(Object.keys(db._store).length, 0);
});

// ─── _writeTransferIndex ─────────────────────────────────────────────────────

test('_writeTransferIndex: writes correct route pair key', async () => {
  const db = makeWriteableDb();
  await NetworkEngine._writeTransferIndex(db, 'TTC', 'Spadina Station', '510', '2');
  const result = await NetworkEngine.getConnectionsAtStop(db, 'TTC', 'Spadina Station');
  assert.equal(result['510_to_2'], 1);
});

test('_writeTransferIndex: increments on repeated transfers', async () => {
  const db = makeWriteableDb();
  await NetworkEngine._writeTransferIndex(db, 'TTC', 'Spadina Station', '510', '2');
  await NetworkEngine._writeTransferIndex(db, 'TTC', 'Spadina Station', '510', '2');
  assert.equal((await NetworkEngine.getConnectionsAtStop(db, 'TTC', 'Spadina Station'))['510_to_2'], 2);
});

test('_writeTransferIndex: tracks multiple transfer pairs at the same stop', async () => {
  const db = makeWriteableDb();
  await NetworkEngine._writeTransferIndex(db, 'TTC', 'Spadina Station', '510', '2');
  await NetworkEngine._writeTransferIndex(db, 'TTC', 'Spadina Station', '2', '510');
  const result = await NetworkEngine.getConnectionsAtStop(db, 'TTC', 'Spadina Station');
  assert.equal(result['510_to_2'], 1);
  assert.equal(result['2_to_510'], 1);
});

test('_writeTransferIndex: skips when any required arg is missing', async () => {
  const db = makeWriteableDb();
  await NetworkEngine._writeTransferIndex(db, null, 'Spadina Station', '510', '2');
  await NetworkEngine._writeTransferIndex(db, 'TTC', null, '510', '2');
  await NetworkEngine._writeTransferIndex(db, 'TTC', 'Spadina Station', null, '2');
  await NetworkEngine._writeTransferIndex(db, 'TTC', 'Spadina Station', '510', null);
  assert.equal(Object.keys(db._store).length, 0);
});

// ─── observe ─────────────────────────────────────────────────────────────────

test('observe: writes to routeStopIndex for boarding and alighting stops', async () => {
  const db = makeWriteableDb();
  await NetworkEngine.observe(db, 'user1', observeTrip());
  const boarding = await NetworkEngine.getRoutesAtStop(db, 'TTC', 'Spadina / College');
  const alighting = await NetworkEngine.getRoutesAtStop(db, 'TTC', 'Spadina Station');
  assert.equal(boarding['510'], 1, 'boarding stop should have route count');
  assert.equal(alighting['510'], 1, 'alighting stop should have route count');
});

test('observe: writes to transferIndex when prevRoute is provided', async () => {
  const db = makeWriteableDb();
  await NetworkEngine.observe(db, 'user1', observeTrip(), '506');
  const connections = await NetworkEngine.getConnectionsAtStop(db, 'TTC', 'Spadina / College');
  assert.equal(connections['506_to_510'], 1);
});

test('observe: does not write to transferIndex when prevRoute is null', async () => {
  const db = makeWriteableDb();
  await NetworkEngine.observe(db, 'user1', observeTrip(), null);
  const connections = await NetworkEngine.getConnectionsAtStop(db, 'TTC', 'Spadina / College');
  assert.deepEqual(connections, {});
});

test('observe: writes to both personal and global networkGraph', async () => {
  const db = makeWriteableDb();
  await NetworkEngine.observe(db, 'user1', observeTrip());
  const personalKey = NetworkEngine._docId('user1', 'TTC', '510');
  const globalKey = NetworkEngine._globalDocId('TTC', '510');
  assert.ok(`networkGraph/${personalKey}` in db._store, 'personal graph missing');
  assert.ok(`networkGraph/${globalKey}` in db._store, 'global graph missing');
});

test('observe: skips entirely when a required trip field is missing', async () => {
  const db = makeWriteableDb();
  await NetworkEngine.observe(db, 'user1', observeTrip({ route: null }));
  assert.equal(Object.keys(db._store).length, 0);
});

test('observe: skips when duration is 0', async () => {
  const db = makeWriteableDb();
  await NetworkEngine.observe(db, 'user1', observeTrip({ duration: 0 }));
  assert.equal(Object.keys(db._store).length, 0);
});

test('observe: skips when duration exceeds 180 min', async () => {
  const db = makeWriteableDb();
  await NetworkEngine.observe(db, 'user1', observeTrip({ duration: 181 }));
  assert.equal(Object.keys(db._store).length, 0);
});

test('observe: skips when direction is unrecognized', async () => {
  const db = makeWriteableDb();
  await NetworkEngine.observe(db, 'user1', observeTrip({ direction: 'diagonal' }));
  assert.equal(Object.keys(db._store).length, 0);
});

test('observe: normalizes direction aliases before writing', async () => {
  const db = makeWriteableDb();
  await NetworkEngine.observe(db, 'user1', observeTrip({ direction: 'nb' }));
  const globalKey = NetworkEngine._globalDocId('TTC', '510');
  const doc = db._store[`networkGraph/${globalKey}`];
  const edge = Object.values(doc.edges)[0];
  assert.equal(edge.direction, 'Northbound');
});

// ─── getMask ─────────────────────────────────────────────────────────────────

test('getMask: returns null when graph has no edges', () => {
  const graph = { edges: {} };
  assert.equal(NetworkEngine.getMask(graph, ['Stop A', 'Stop B'], 'Boarding Stop', 'Northbound'), null);
});

test('getMask: keeps reachable stops, filters known-unreachable, keeps unknown', () => {
  const graph = {
    edges: {
      e1: { fromStop: 'Boarding Stop', toStop: 'Stop A', direction: 'Northbound', tripCount: 3 },
      e2: { fromStop: 'Boarding Stop', toStop: 'Stop B', direction: 'Northbound', tripCount: 1 },
    },
  };
  // Stop A: reachable (tripCount 3 >= getMask default minTrips 2)
  // Stop B: known but not reachable (tripCount 1 < 2)
  // Stop C: unknown to graph — kept so model can still predict new stops
  const mask = NetworkEngine.getMask(graph, ['Stop A', 'Stop B', 'Stop C'], 'Boarding Stop', 'Northbound');
  assert.ok(mask !== null);
  assert.equal(mask[0], true,  'Stop A should be reachable');
  assert.equal(mask[1], false, 'Stop B known but below threshold — filtered');
  assert.equal(mask[2], true,  'Stop C unknown to graph — kept');
});

test('getMask: returns null when boarding stop has no edges from it', () => {
  const graph = {
    edges: {
      e1: { fromStop: 'Other Stop', toStop: 'Stop A', direction: 'Northbound', tripCount: 5 },
    },
  };
  assert.equal(NetworkEngine.getMask(graph, ['Stop A'], 'Boarding Stop', 'Northbound'), null);
});

test('getMask: infers reachability from reverse edges', () => {
  // Went B→BoardingStop southbound → BoardingStop→B northbound is reachable
  const graph = {
    edges: {
      e1: { fromStop: 'Stop B', toStop: 'Boarding Stop', direction: 'Southbound', tripCount: 3 },
    },
  };
  const mask = NetworkEngine.getMask(graph, ['Stop B', 'Stop C'], 'Boarding Stop', 'Northbound');
  assert.ok(mask !== null);
  assert.equal(mask[0], true, 'Stop B reachable via reverse southbound edge');
});

// ─── hour-slot travel time buckets ─────────────────────────────────────────

test('getMedianDuration: returns aggregate median when no hour specified', () => {
  const graph = {
    edges: {
      e1: {
        fromStop: 'King / Spadina',
        toStop: 'Spadina Station',
        direction: 'Westbound',
        durations: [10, 12, 14],
        medianMinutes: 12,
        durationsByHour: { '8': [8, 9, 10], '17': [15, 16, 17] },
        tripCount: 3,
      },
    },
  };
  assert.equal(NetworkEngine.getMedianDuration(graph, 'King / Spadina'), 12);
});

test('getMedianDuration: prefers hour bucket when it has ≥3 observations', () => {
  const graph = {
    edges: {
      e1: {
        fromStop: 'King / Spadina',
        toStop: 'Spadina Station',
        direction: 'Westbound',
        durations: [8, 10, 12, 14, 16],
        medianMinutes: 12,
        durationsByHour: { '8': [8, 9, 10] }, // median 9
        tripCount: 5,
      },
    },
  };
  // Hour 8 bucket has 3 observations — should use its median (9), not aggregate (12)
  assert.equal(NetworkEngine.getMedianDuration(graph, 'King / Spadina', 8), 9);
});

test('getMedianDuration: falls back to aggregate when hour bucket has <3 observations', () => {
  const graph = {
    edges: {
      e1: {
        fromStop: 'King / Spadina',
        toStop: 'Spadina Station',
        direction: 'Westbound',
        durations: [10, 12, 14],
        medianMinutes: 12,
        durationsByHour: { '8': [9] }, // only 1 observation — sparse
        tripCount: 3,
      },
    },
  };
  assert.equal(NetworkEngine.getMedianDuration(graph, 'King / Spadina', 8), 12);
});

test('getMedianDuration: falls back to aggregate when hour bucket missing entirely', () => {
  const graph = {
    edges: {
      e1: {
        fromStop: 'King / Spadina',
        toStop: 'Spadina Station',
        direction: 'Westbound',
        durations: [10, 12, 14],
        medianMinutes: 12,
        durationsByHour: {},
        tripCount: 3,
      },
    },
  };
  assert.equal(NetworkEngine.getMedianDuration(graph, 'King / Spadina', 22), 12);
});

// ─── getConnectionLabels ─────────────────────────────────────────────────────

test('getConnectionLabels: returns empty object for unknown stop', async () => {
  const db = makeWriteableDb();
  assert.deepEqual(await NetworkEngine.getConnectionLabels(db, 'TTC', 'Unknown Stop'), {});
});

test('getConnectionLabels: returns original route label as written', async () => {
  const db = makeWriteableDb();
  await NetworkEngine._writeTransferIndex(db, 'TTC', 'Spadina Station', '510A', '2');
  const labels = await NetworkEngine.getConnectionLabels(db, 'TTC', 'Spadina Station');
  const key = `${NetworkEngine._key('510A')}_to_${NetworkEngine._key('2')}`;
  assert.equal(labels[key], '2', 'toLabel should preserve original route string');
});

test('getConnectionLabels: preserves original capitalization and spacing', async () => {
  const db = makeWriteableDb();
  await NetworkEngine._writeTransferIndex(db, 'TTC', 'Union Station', 'Green Line', 'Red');
  const labels = await NetworkEngine.getConnectionLabels(db, 'TTC', 'Union Station');
  const key = `${NetworkEngine._key('Green Line')}_to_${NetworkEngine._key('Red')}`;
  assert.equal(labels[key], 'Red');
});

// ─── getEdgeMedianDuration ────────────────────────────────────────────────────

test('getEdgeMedianDuration: returns null when pair has no observations', () => {
  const graph = {
    edges: {
      e1: { fromStop: 'A', toStop: 'B', direction: 'Northbound', medianMinutes: 12 },
    },
  };
  assert.equal(NetworkEngine.getEdgeMedianDuration(graph, 'A', 'C'), null);
});

test('getEdgeMedianDuration: returns aggregate median for matching pair', () => {
  const graph = {
    edges: {
      e1: { fromStop: 'King', toStop: 'Queen', direction: 'Westbound', medianMinutes: 8, durationsByHour: {} },
      e2: { fromStop: 'King', toStop: 'Bloor', direction: 'Westbound', medianMinutes: 25, durationsByHour: {} },
    },
  };
  assert.equal(NetworkEngine.getEdgeMedianDuration(graph, 'King', 'Queen'), 8);
  assert.equal(NetworkEngine.getEdgeMedianDuration(graph, 'King', 'Bloor'), 25);
});

test('getEdgeMedianDuration: prefers hour bucket when ≥3 observations', () => {
  const graph = {
    edges: {
      e1: {
        fromStop: 'King', toStop: 'Queen', direction: 'Westbound',
        medianMinutes: 12,
        durationsByHour: { '8': [7, 8, 9] }, // median 8
      },
    },
  };
  assert.equal(NetworkEngine.getEdgeMedianDuration(graph, 'King', 'Queen', 8), 8);
});

test('getEdgeMedianDuration: falls back to aggregate when hour bucket sparse', () => {
  const graph = {
    edges: {
      e1: {
        fromStop: 'King', toStop: 'Queen', direction: 'Westbound',
        medianMinutes: 12,
        durationsByHour: { '8': [7] }, // only 1 — sparse
      },
    },
  };
  assert.equal(NetworkEngine.getEdgeMedianDuration(graph, 'King', 'Queen', 8), 12);
});

// ─── transitive reachability ──────────────────────────────────────────────────

test('_getTransitiveEdges: infers A→C from A→B + B→C in same direction', () => {
  const graph = {
    edges: {
      e1: { fromStop: 'A', toStop: 'B', direction: 'Northbound', tripCount: 4, medianMinutes: 5, inferred: false },
      e2: { fromStop: 'B', toStop: 'C', direction: 'Northbound', tripCount: 6, medianMinutes: 8, inferred: false },
    },
  };
  const inferred = NetworkEngine._getTransitiveEdges(graph);
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].fromStop, 'A');
  assert.equal(inferred[0].toStop, 'C');
  assert.equal(inferred[0].direction, 'Northbound');
  assert.equal(inferred[0].tripCount, 4); // min(4, 6)
  assert.equal(inferred[0].medianMinutes, 13); // 5 + 8
  assert.equal(inferred[0].inferred, true);
});

test('_getTransitiveEdges: does not infer across direction mismatch', () => {
  const graph = {
    edges: {
      e1: { fromStop: 'A', toStop: 'B', direction: 'Eastbound', tripCount: 4, medianMinutes: 5 },
      e2: { fromStop: 'B', toStop: 'C', direction: 'Westbound', tripCount: 4, medianMinutes: 5 },
    },
  };
  assert.equal(NetworkEngine._getTransitiveEdges(graph).length, 0);
});

test('_getTransitiveEdges: does not infer A→A cycles', () => {
  const graph = {
    edges: {
      e1: { fromStop: 'A', toStop: 'B', direction: 'Northbound', tripCount: 4, medianMinutes: 5 },
      e2: { fromStop: 'B', toStop: 'A', direction: 'Northbound', tripCount: 4, medianMinutes: 5 },
    },
  };
  const inferred = NetworkEngine._getTransitiveEdges(graph);
  // A→B→A is a cycle — should be excluded. B→A→B is also a cycle.
  assert.ok(inferred.every(e => !(e.fromStop === 'A' && e.toStop === 'A')));
  assert.ok(inferred.every(e => !(e.fromStop === 'B' && e.toStop === 'B')));
});

test('_getTransitiveEdges: does not use inferred edges as inputs', () => {
  const graph = {
    edges: {
      e1: { fromStop: 'A', toStop: 'B', direction: 'Northbound', tripCount: 4, medianMinutes: 5 },
      e2: { fromStop: 'B', toStop: 'C', direction: 'Northbound', tripCount: 4, medianMinutes: 5, inferred: true },
      e3: { fromStop: 'C', toStop: 'D', direction: 'Northbound', tripCount: 4, medianMinutes: 5 },
    },
  };
  // e2 is already inferred — only real edges chain. A→B is real, B→C is inferred (skipped as source).
  // So we should get A→B chains with C→D only if B→C were real, which it isn't.
  // We also get nothing from B→C (inferred) → C→D.
  const inferred = NetworkEngine._getTransitiveEdges(graph);
  // Only real→real chains: A→B + (no real edge from B), C→D has nothing feeding into it from a real B→C
  assert.ok(!inferred.some(e => e.fromStop === 'B' && e.toStop === 'D'),
    'should not chain through inferred edge');
});

test('_withTransitiveEdges: inferred edges fill gaps without overwriting real edges', () => {
  // Use real edgeKey format (as observe() does) so the key-lookup guard works
  const abKey = NetworkEngine._edgeKey('A', 'Northbound', 'B');
  const bcKey = NetworkEngine._edgeKey('B', 'Northbound', 'C');
  const acKey = NetworkEngine._edgeKey('A', 'Northbound', 'C');
  const graph = {
    edges: {
      [abKey]: { fromStop: 'A', toStop: 'B', direction: 'Northbound', tripCount: 5, medianMinutes: 10 },
      [bcKey]: { fromStop: 'B', toStop: 'C', direction: 'Northbound', tripCount: 5, medianMinutes: 10 },
      [acKey]: { fromStop: 'A', toStop: 'C', direction: 'Northbound', tripCount: 99, medianMinutes: 25 },
    },
  };
  const augGraph = NetworkEngine._withTransitiveEdges(graph);
  // Real A→C edge should survive unchanged; inferred A→C (tripCount 5) must not overwrite it
  assert.equal(augGraph.edges[acKey].tripCount, 99);
});

// ─── Phase 3: Temporal Deduction ─────────────────────────────────────────────

test('observe: deduces surface route adjacency from durations', async () => {
  const db = makeWriteableDb();
  
  // Trip 1: A -> C (20 mins)
  await NetworkEngine.observe(db, 'u1', {
    route: '510',
    agency: 'TTC',
    direction: 'Northbound',
    startStopName: 'Stop A',
    endStopName: 'Stop C',
    duration: 20,
  });

  // Trip 2: A -> B (10 mins)
  await NetworkEngine.observe(db, 'u1', {
    route: '510',
    agency: 'TTC',
    direction: 'Northbound',
    startStopName: 'Stop A',
    endStopName: 'Stop B',
    duration: 10,
  });

  const globalKey = NetworkEngine._globalDocId('TTC', '510');
  const graph = db._store[`networkGraph/${globalKey}`];
  
  // Should have inferred B -> C because B is 10m from A and C is 20m from A
  const edges = Object.values(graph.edges);
  const temporal = edges.find(e => e.edgeType === 'inferred_temporal');
  assert.ok(temporal, 'should have inferred a temporal edge');
  assert.equal(temporal.fromStop, 'Stop B');
  assert.equal(temporal.toStop, 'Stop C');
  assert.equal(temporal.medianMinutes, 10);
});

// ─── Phase 4: Confidence Model ───────────────────────────────────────────────

test('_getConfidence: stop source metadata does not boost score', () => {
  const edge = { tripCount: 1, fromStopSource: 'verified' };
  assert.equal(NetworkEngine._getConfidence(edge), 1);
});

test('_getConfidence: topology-labeled edges do not boost score', () => {
  const edge = { tripCount: 1, edgeType: 'inferred_topology' };
  assert.equal(NetworkEngine._getConfidence(edge), 1);
});

test('_getConfidence: old edges are penalized', () => {
  const edge = { 
    tripCount: 10, 
    lastObservedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() // 100 days old
  };
  assert.equal(NetworkEngine._getConfidence(edge), 5); // 10 * 0.5
});

test('getMask: includes transitively reachable stops', () => {
  // A→B + B→C are real edges; boarding at A should include C in the mask
  const graph = {
    edges: {
      e1: { fromStop: 'A', toStop: 'B', direction: 'Eastbound', tripCount: 5 },
      e2: { fromStop: 'B', toStop: 'C', direction: 'Eastbound', tripCount: 5 },
    },
  };
  const mask = NetworkEngine.getMask(graph, ['B', 'C', 'D'], 'A', 'Eastbound');
  assert.ok(mask !== null, 'mask should not be null');
  assert.equal(mask[0], true,  'B directly reachable');
  assert.equal(mask[1], true,  'C transitively reachable via B');
  assert.equal(mask[2], true,  'D unknown to graph — kept');
});

test('getMask: infers intermediate stops from shared-destination durations', () => {
  // A->C and B->C are both real trips. If A->C takes longer, B is an
  // intermediate stop reachable from A using only trip-observed durations.
  const graph = {
    edges: {
      e1: { fromStop: 'Spadina', toStop: 'Castle Frank', direction: 'Eastbound', tripCount: 5, medianMinutes: 11 },
      e2: { fromStop: 'Bay', toStop: 'Castle Frank', direction: 'Eastbound', tripCount: 5, medianMinutes: 7 },
    },
  };
  const mask = NetworkEngine.getMask(graph, ['Bay', 'Castle Frank', 'Ossington'], 'Spadina', 'Eastbound');
  assert.ok(mask !== null, 'mask should not be null');
  assert.equal(mask[0], true, 'Bay inferred as an intermediate reachable stop');
  assert.equal(mask[1], true, 'Castle Frank directly reachable');
  assert.equal(mask[2], true, 'Ossington unknown to graph — kept');
});

test('filterCandidates: includes trips ending at transitively reachable stops', () => {
  const graph = {
    edges: {
      e1: { fromStop: 'King', toStop: 'Queen', direction: 'Westbound', tripCount: 4 },
      e2: { fromStop: 'Queen', toStop: 'Dundas', direction: 'Westbound', tripCount: 4 },
    },
  };
  const candidates = [
    { endStopName: 'Queen' },
    { endStopName: 'Dundas' },   // reachable transitively
    { endStopName: 'Bloor' },    // unknown to graph — kept
  ];
  const filtered = NetworkEngine.filterCandidates(candidates, graph, 'King', 'Westbound');
  assert.ok(filtered !== null);
  assert.equal(filtered.length, 3, 'all three should pass: Queen direct, Dundas transitive, Bloor unknown');
});

test('observe: writes durationsByHour alongside flat durations', async () => {
  const db = makeWriteableDb();
  await NetworkEngine.observe(db, 'u1', {
    route: '510', agency: 'TTC', direction: 'Westbound',
    startStopName: 'King / Spadina', endStopName: 'Spadina Station', duration: 12,
  });

  const graphDoc = Object.values(db._store).find(d => d && d.edges);
  assert.ok(graphDoc, 'graph doc should have been written');
  const edge = Object.values(graphDoc.edges)[0];
  assert.ok(edge.durationsByHour, 'durationsByHour should exist on edge');
  const hourKey = new Date().getHours().toString();
  assert.ok(Array.isArray(edge.durationsByHour[hourKey]), 'current hour bucket should be an array');
  assert.ok(edge.durationsByHour[hourKey].includes(12), 'duration should be in hour bucket');
});

// ─── inferStopSequence — synthetic graphs only, never real trip data ──────

function edge(fromStop, toStop, direction, medianMinutes) {
  return { fromStop, toStop, direction, medianMinutes };
}

test('inferStopSequence: reconstructs a 4-stop line from mostly non-adjacent observations', () => {
  // True line: A -> B -> C -> D (2, 3, 2 min segments). Mostly "skip" trips
  // a rider would actually produce (A->C, A->D, B->D) plus one adjacent hop
  // (A->B) so every stop has a path back to the anchor — a stop that's
  // NEVER a trip endpoint alongside anything already anchored genuinely
  // can't be placed from duration data alone (see the sparse-data test below).
  const graph = {
    edges: {
      e1: edge('A', 'C', 'Northbound', 5),  // 2+3
      e2: edge('A', 'D', 'Northbound', 7),  // 2+3+2
      e3: edge('B', 'D', 'Northbound', 5),  // 3+2
      e4: edge('A', 'B', 'Northbound', 2),  // 2
    },
  };

  const result = NetworkEngine.inferStopSequence(graph, 'Northbound');
  assert.ok(result, 'should produce a result from 4 edges');
  assert.equal(result.stopCount, 4);

  const idx = Object.fromEntries(result.order.map((s, i) => [s, i]));
  const trueOrder = ['A', 'B', 'C', 'D'];
  const trueIdx = Object.fromEntries(trueOrder.map((s, i) => [s, i]));
  // Accept either reading direction — a line has no inherent "which end is first"
  let forward = 0, total = 0;
  for (let i = 0; i < result.order.length; i++) {
    for (let j = i + 1; j < result.order.length; j++) {
      total++;
      if (trueIdx[result.order[i]] < trueIdx[result.order[j]]) forward++;
    }
  }
  assert.ok(Math.max(forward, total - forward) === total, `should be perfectly ordered (forward or reversed), got ${result.order.join(' -> ')}`);
});

test('inferStopSequence: honestly omits a stop with no real or transitive path to the anchor, rather than guessing', () => {
  // B only appears in a disconnected edge. There is genuinely no duration
  // information linking A and B in this dataset.
  const graph = {
    edges: {
      e1: edge('A', 'C', 'Northbound', 5),
      e2: edge('A', 'D', 'Northbound', 7),
      e3: edge('B', 'E', 'Northbound', 5),
    },
  };
  const result = NetworkEngine.inferStopSequence(graph, 'Northbound');
  assert.equal(result.stopCount, 3, 'B should be omitted, not guessed');
  assert.ok(!result.order.includes('B'));
  assert.ok(!result.order.includes('E'));
  assert.deepEqual(new Set(result.order), new Set(['A', 'C', 'D']));
});

test('inferStopSequence: returns null with fewer than 2 stops observed', () => {
  assert.equal(NetworkEngine.inferStopSequence({ edges: {} }, 'Northbound'), null);
  assert.equal(NetworkEngine.inferStopSequence(null, 'Northbound'), null);
});

test('inferStopSequence: ignores edges in the opposite direction', () => {
  const graph = {
    edges: {
      e1: edge('A', 'B', 'Northbound', 5),
      e2: edge('X', 'Y', 'Southbound', 5),
    },
  };
  const result = NetworkEngine.inferStopSequence(graph, 'Northbound');
  assert.equal(result.stopCount, 2);
  assert.ok(result.order.includes('A') && result.order.includes('B'));
  assert.ok(!result.order.includes('X') && !result.order.includes('Y'));
});

// ─── observe: hour bucket is the trip's start hour in its timezone ───────────

test('observe: buckets by the trip start hour in the trip timezone, not the hour it was processed', async () => {
  const db = makeWriteableDb();
  // 13:30 UTC is 09:30 in Toronto (EDT).
  await NetworkEngine.observe(db, 'user1', observeTrip({
    startTime: { toDate: () => new Date('2026-07-19T13:30:00Z') },
    timezone: 'America/Toronto',
  }));
  const graph = db._store[`networkGraph/${NetworkEngine._docId('user1', 'TTC', '510')}`];
  const edge = Object.values(graph.edges)[0];
  assert.deepEqual(Object.keys(edge.durationsByHour), ['9']);
});

test('tripStartHour: the same hour detectAnomaly looks up (agency timezone when the trip has none)', () => {
  const { tripStartHour } = require('./lib/trip-hour');
  const start = { toDate: () => new Date('2026-01-19T02:15:00Z') }; // 21:15 Toronto (EST), the day before
  assert.equal(tripStartHour(start, { agency: 'TTC' }), 21);
  assert.equal(tripStartHour(start, { timezone: 'America/Vancouver' }), 18);
});
