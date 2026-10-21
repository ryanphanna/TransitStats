/**
 * Focused tests for handlers disambiguation + MMS timing metadata.
 * Run with: node test_handlers.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadHandlers(overrides = {}) {
  const handlersPath = require.resolve('./lib/handlers');
  const handlerPaths = new Set([
    handlersPath,
    require.resolve('./lib/handlers-utils'),
    require.resolve('./lib/handlers-commands'),
    require.resolve('./lib/handlers-trip'),
    require.resolve('./lib/handlers-query'),
    require.resolve('./lib/handlers-intelligence'),
    require.resolve('./lib/finalization'),
  ]);
  // Bust the entire handler module graph so mocks take effect
  for (const p of handlerPaths) delete require.cache[p];

  const calls = {
    setPendingState: [],
    sendSmsReply: [],
    createTrip: [],
    batchUpdates: [],
    docUpdates: [],
    docGets: [],
    loggerInfo: [],
    loggerWarn: [],
    loggerError: [],
  };

  const dbModule = {
    getActiveTrip: async () => null,
    setPendingState: async (_phone, state) => { calls.setPendingState.push(state); },
    clearPendingState: async () => {},
    storeVerificationCode: async () => {},
    getVerificationData: async () => null,
    isEmailAllowed: async () => true,
    isEmailAdmin: async () => false,
    isExperimentalIntelligenceEnabled: async () => true,
    getUserByPhone: async () => ({ userId: 'u1', email: 'user@example.com' }),
    getUserProfile: async () => ({ defaultAgency: 'TTC', isAdmin: false }),
    lookupStop: async () => ({
      id: 'stop_1',
      stopCode: '11985',
      stopName: 'Spadina / College',
      lat: 43.1,
      lng: -79.1,
      source: 'verified',
    }),
    findMatchingStops: async () => [],
    getRoutesAtStop: async () => null,
    db: {
      collection: (name) => ({
        add: async () => {},
        doc: () => ({
          update: async (data) => { calls.docUpdates.push(data); },
          set: async () => {},
          get: async () => {
            // detectAnomaly reads the personal graph doc directly (v1.44.0);
            // tests provide it via overrides.networkGraphDoc.
            if (name === 'networkGraph' && overrides.networkGraphDoc) {
              return { exists: true, data: () => overrides.networkGraphDoc };
            }
            calls.docGets.push(true);
            return { exists: false, data: () => ({}) };
          },
          delete: async () => {},
        }),
        where: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                get: async () => ({ empty: true, docs: [], forEach: () => {} }),
              }),
            }),
          }),
          orderBy: () => ({
            limit: () => ({
              get: async () => ({ empty: true, docs: [], forEach: () => {} }),
            }),
          }),
          limit: () => ({
            get: async () => ({ empty: true, docs: [], forEach: () => {} }),
          }),
          get: async () => ({ empty: true, docs: [], forEach: () => {} }),
        }),
      }),
      batch: () => ({
        update: (ref, data) => { calls.batchUpdates.push({ type: 'update', ref, data }); },
        delete: (ref) => { calls.batchUpdates.push({ type: 'delete', ref }); },
        commit: async () => {},
      }),
    },
    hasBlockingCorrection: () => false,
    isGeminiRateLimited: async () => false,
    createTrip: async (payload) => {
      calls.createTrip.push(payload);
      return `trip_${calls.createTrip.length}`;
    },
    getRecentCompletedTrips: async () => [],
    getStopsLibrary: async () => [],
    getConversationHistory: async () => [],
    saveConversationTurn: async () => {},
    getLastTripAgency: async () => null,
    getTripCount: async () => 0,
    FieldValue: {
      delete: () => ({ _op: 'delete' }),
      increment: v => ({ _op: 'increment', v }),
      serverTimestamp: () => new Date(),
      arrayUnion: (...vals) => ({ _op: 'arrayUnion', vals }),
    },
    Timestamp: {
      now: () => ({ toDate: () => new Date() }),
      fromDate: (d) => ({ toDate: () => d }),
    },
    ...overrides.dbModule,
  };
  // lookupStopCheck (the read-only agency guess) follows whatever lookupStop the test supplies.
  dbModule.lookupStopCheck = overrides.dbModule?.lookupStopCheck || (async (...args) => {
    const stop = await dbModule.lookupStop(...args);
    return stop ? { status: 'found', stop } : { status: 'notFound', stop: null };
  });

  const twilio = {
    sendSmsReply: async (phone, message, options) => { calls.sendSmsReply.push({ phone, message, options }); },
    ...overrides.twilio,
  };

  const utils = {
    getStopDisplay: (code, name, fallback) => code || name || fallback || 'Unknown',
    getRouteDisplay: (route, direction) => direction ? `${route} ${direction}` : `${route}`,
    getStopCandidateDirection: (candidate) => {
      if (candidate?.direction) return candidate.direction;
      const match = String(candidate?.stopName || '').match(/\b(northbound|southbound|eastbound|westbound)\b/i);
      return match ? `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}` : null;
    },
    collapseEquivalentStopCandidates: (candidates, options = {}) => {
      const seen = new Set();
      return candidates.filter((candidate) => {
        const name = String(candidate?.stopName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const direction = candidate?.direction || '';
        // Strict (pre-route) collapsing never merges records that carry different stop codes.
        const code = options.strict ? (candidate?.stopCode || '') : '';
        const key = `${name}|${direction.toLowerCase()}|${code}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    normalizeDirection: (v) => {
      if (!v) return null;
      const s = v.toString().toLowerCase();
      if (s.startsWith('north')) return 'Northbound';
      if (s.startsWith('south')) return 'Southbound';
      if (s.startsWith('east')) return 'Eastbound';
      if (s.startsWith('west')) return 'Westbound';
      return v;
    },
    normalizeRoute: (r) => (r == null ? r : r.toString().trim()),
    isValidRoute: () => true,
    generateVerificationCode: () => '123456',
    determineReliability: () => 'approximate',
    normalizeAgency: (a) => a,
    ...overrides.utils,
  };

  const gemini = {
    aggregateTripStats: () => ({}),
    answerQueryWithGemini: async () => 'ok',
    lookupAgencyTimezone: async () => 'America/Toronto',
    parseStopSignImage: async () => ({ routes: [{ route: '510', agency: 'TTC' }], stopCode: '11985' }),
    ...overrides.gemini,
  };

  const parsing = {
    parseStopInput: (input) => (/^\d+$/.test(String(input))
      ? { stopCode: String(input), stopName: null }
      : { stopCode: null, stopName: String(input) }),
    ...overrides.parsing,
  };

  const firebaseAdmin = {
    firestore: {
      FieldValue: {
        delete: () => ({ _op: 'delete' }),
        increment: v => ({ _op: 'increment', v }),
        serverTimestamp: () => new Date(),
        arrayUnion: (...vals) => ({ _op: 'arrayUnion', vals }),
      },
      Timestamp: {
        now: () => ({ toDate: () => new Date() }),
      },
    },
  };

  const predict = {
    PredictionEngine: {
      stopsLibrary: [],
      networkGraph: null,
      guess: () => null,
      guessEndStop: () => null,
      guessTopEndStops: () => [],
      getEndStopConstraint: () => ({ source: 'none', legalStops: null }),
      _stopMatch: () => false,
    },
    ...overrides.predict,
  };

  const transfer = {
    TransferEngine: {
      score: () => 0,
      CONFIDENCE_THRESHOLD: 0.5,
      ...(overrides.transfer?.TransferEngine || {}),
    },
  };
  const network = {
    NetworkEngine: {
      load: async () => null,
      observe: async () => {},
      filterCandidates: () => null,
      getEdgeMedianDuration: () => null,
      getMedianDuration: () => null,
      getConnectionsAtStop: async () => ({}),
      getConnectionLabels: async () => ({}),
      _key: (s) => s.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
      _docId: (userId, agency, route) => [userId, agency, route].join('_'),
      ...(overrides.network?.NetworkEngine || {}),
    },
  };
  const predictV4 = {
    PredictionEngineV4: {
      guessTopEndStops: () => [],
      ...(overrides.predictV4?.PredictionEngineV4 || {}),
    },
  };
  const predictV5 = {
    PredictionEngineV5: {
      guessTopEndStops: async () => [],
      ...(overrides.predictV5?.PredictionEngineV5 || {}),
    },
  };
  const constants = { AGENCY_CITY: { TTC: 'Toronto' } };

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'image/jpeg' },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && handlerPaths.has(parent.id)) {
      if (request === './db') return dbModule;
      if (request === './twilio') return twilio;
      if (request === './utils') return utils;
      if (request === './gemini') return gemini;
      if (request === './parsing') return parsing;
      if (request === './predict.js') return predict;
      if (request === './transfer.js') return transfer;
      if (request === './network.js') return network;
      if (request === './predict_v4.js') return predictV4;
      if (request === './predict_v5.js') return predictV5;
      if (request === './constants') return constants;
      if (request === './habit' && overrides.habit) return overrides.habit;
      if (request === './intelligence-eligibility' && overrides.eligibility) return overrides.eligibility;
      if (request === 'firebase-admin') return firebaseAdmin;
      if (request === './logger') {
        return {
          warn: (message, data) => { calls.loggerWarn.push({ message, data }); },
          info: (message, data) => { calls.loggerInfo.push({ message, data }); },
          error: (message, data) => { calls.loggerError.push({ message, data }); },
        };
      }
    }
    return originalLoad(request, parent, isMain);
  };

  let handlers;
  try {
    handlers = require('./lib/handlers');
  } finally {
    Module._load = originalLoad;
  }

  const restore = () => {
    global.fetch = originalFetch;
  };

  return { handlers, calls, restore };
}

test('handleTripLog: refuses to start without a boarding stop', async () => {
  const { handlers, calls, restore } = loadHandlers();

  try {
    await handlers.handleTripLog('+14165550000', { userId: 'u0' }, '', '506', 'Westbound', 'TTC');
  } finally {
    restore();
  }

  assert.equal(calls.createTrip.length, 0);
  assert.match(calls.sendSmsReply[0]?.message || '', /boarding stop/i);
});

test('handleTripLog: ambiguous stop starts and offers the existing stop choice flow', async () => {
  const startTime = 1778770440000;
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      findMatchingStops: async () => [
        { id: 's1', stopCode: '2069', stopName: 'Grove / Juniper', routes: ['29'], direction: 'Northbound' },
        { id: 's2', stopCode: '2070', stopName: 'Grove / Juniper', routes: ['29'], direction: 'Southbound' },
      ],
    },
  });

  try {
    await handlers.handleTripLog(
      '+14165550001',
      { userId: 'u1' },
      'Grove / Juniper',
      '29',
      null,
      'TTC',
      { startTime }
    );
  } finally {
    restore();
  }

  assert.equal(calls.createTrip.length, 1);
  assert.equal(calls.createTrip[0].startTime, startTime);
  assert.equal(calls.setPendingState.length, 1);
  assert.equal(calls.setPendingState[0].type, 'confirm_stop');
  assert.deepEqual(calls.setPendingState[0].stopCandidates, [
    { stopCode: '2069', stopName: 'Grove / Juniper' },
    { stopCode: '2070', stopName: 'Grove / Juniper' },
  ]);
  const msg = calls.sendSmsReply[0]?.message || '';
  assert.match(msg, /multiple possible boarding stops/i);
  assert.match(msg, /Reply with a number/);
});

test('handleTripLog: 506 College Westbound auto-resolves to one surface stop', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      findMatchingStops: async () => [
        { id: 'station', stopCode: null, stopName: 'College Station', routes: ['1', '506'], direction: null },
        { id: 's760', stopCode: '760', stopName: 'College Station', routes: ['506'], direction: 'Westbound' },
        { id: 's761', stopCode: '761', stopName: 'College Station', routes: ['506'], direction: 'Eastbound' },
      ],
      lookupStop: async (_code, stopName, _agency, route, direction) => {
        if (stopName === 'College' && route === '506' && direction === 'Westbound') {
          return { id: 's760', stopCode: '760', stopName: 'College Station', source: 'verified' };
        }
        return null;
      },
    },
  });

  try {
    await handlers.handleTripLog('+14165550011', { userId: 'u11' }, 'College', '506', 'Westbound', 'TTC');
  } finally {
    restore();
  }

  assert.equal(calls.setPendingState.length, 0);
  assert.equal(calls.createTrip.length, 1);
  assert.equal(calls.createTrip[0].startStopCode, '760');
  assert.equal(calls.createTrip[0].startStopName, 'College Station');
});

test('handleTripLog: 506 College with no direction leaves the stop unverified', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      findMatchingStops: async () => [
        { id: 's760', stopCode: '760', stopName: 'College Station', routes: ['506'], direction: 'Westbound' },
        { id: 's761', stopCode: '761', stopName: 'College Station', routes: ['506'], direction: 'Eastbound' },
      ],
      lookupStop: async () => null,
    },
  });

  try {
    await handlers.handleTripLog('+14165550012', { userId: 'u12' }, 'College', '506', null, 'TTC');
  } finally {
    restore();
  }

  assert.equal(calls.createTrip.length, 1);
  assert.equal(calls.setPendingState.length, 1);
  const msg = calls.sendSmsReply[0]?.message || '';
  assert.match(msg, /multiple possible boarding stops/i);
});

test('handleTripLog: identical names with no direction data offer the stop choice flow', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      findMatchingStops: async () => [
        { id: 'sA', stopCode: '8121', stopName: 'Spadina / Dundas', routes: [], direction: null },
        { id: 'sB', stopCode: '7349', stopName: 'Spadina / Dundas', routes: [], direction: null },
        { id: 'sC', stopCode: '2190', stopName: 'Spadina / Dundas', routes: [], direction: null },
      ],
      lookupStop: async () => null,
    },
  });

  try {
    await handlers.handleTripLog('+14165550013', { userId: 'u13' }, 'Aspen/Rowan', '510', 'Northbound', 'TTC');
  } finally {
    restore();
  }

  assert.equal(calls.setPendingState.length, 1, 'should offer the existing stop choice flow');
  assert.equal(calls.createTrip.length, 1, 'trip should still start');
  assert.equal(calls.createTrip[0].startStopName, 'Aspen/Rowan');
  const msg = calls.sendSmsReply[0]?.message || '';
  assert.match(msg, /multiple possible boarding stops/i);
});

test('handleTripLog: 506 Grove / Hazel Eastbound uses stopRoutes before prompting', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      findMatchingStops: async () => [
        { id: 's2033', stopCode: '2033', stopName: 'Grove / Hazel', routes: ['29'], direction: null },
        { id: 's827', stopCode: '827', stopName: 'Grove / Hazel', routes: [], direction: 'Westbound' },
        { id: 's826', stopCode: '826', stopName: 'Grove / Hazel', routes: [], direction: 'Eastbound' },
        { id: 's2034', stopCode: '2034', stopName: 'Grove / Hazel', routes: [], direction: null },
      ],
      getRoutesAtStop: async (code) => ({
        827: ['506'],
        826: ['506'],
        2034: ['29'],
      }[code] || []),
      lookupStop: async (_code, stopName, _agency, route, direction) => {
        if (stopName === 'Grove / Hazel' && route === '506' && direction === 'Eastbound') {
          return { id: 's826', stopCode: '826', stopName: 'Grove / Hazel', source: 'verified' };
        }
        return null;
      },
    },
  });

  try {
    await handlers.handleTripLog('+14165550014', { userId: 'u14' }, 'Grove / Hazel', '506', 'Eastbound', 'TTC');
  } finally {
    restore();
  }

  assert.equal(calls.setPendingState.length, 0);
  assert.equal(calls.createTrip.length, 1);
  assert.equal(calls.createTrip[0].startStopCode, '826');
  assert.equal(calls.createTrip[0].startStopName, 'Grove / Hazel');
});

test('handleTripLog: Line 1 College auto-resolves to subway station', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      findMatchingStops: async () => [
        { id: 'line1_college', stopCode: '9001', stopName: 'College', routes: ['1'] },
        { id: 'surface_west', stopCode: '760', stopName: 'College Station', routes: ['506'], direction: 'Westbound' },
        { id: 'surface_east', stopCode: '761', stopName: 'College Station', routes: ['506'], direction: 'Eastbound' },
      ],
      lookupStop: async (_code, stopName, _agency, route, direction) => {
        if (stopName === 'College' && route === '1' && direction === 'Northbound') {
          return { id: 'line1_college', stopCode: '9001', stopName: 'College', source: 'verified' };
        }
        return null;
      },
    },
  });

  try {
    await handlers.handleTripLog('+14165550013', { userId: 'u13' }, 'College', '1', 'Northbound', 'TTC');
  } finally {
    restore();
  }

  assert.equal(calls.setPendingState.length, 0);
  assert.equal(calls.createTrip.length, 1);
  assert.equal(calls.createTrip[0].startStopCode, '9001');
  assert.equal(calls.createTrip[0].startStopName, 'College');
});

test('handleTripLog: a firing habit changes only the reply; V3/V4/V5 end-stop guesses still run and are stored', async () => {
  let matchArgs = null;
  const v3End = { stop: 'Bathurst', confidence: 70 };
  const { handlers, calls, restore } = loadHandlers({
    dbModule: { isEmailAdmin: async () => true },
    habit: {
      HabitEngine: {
        VERSION: '2.0.0',
        load: async () => [{ schema: 2 }],
        match: (habits, stop, now, filters) => {
          matchArgs = { stop, filters };
          return { stop, route: '510', direction: 'Westbound', endStop: 'Spadina Station', confidence: 0.8, count: 4 };
        },
        rebuild: async () => [],
      },
    },
    eligibility: {
      getEligibility: () => ({ endStopEligible: true, cleanTripCount: 50 }),
      artifactSupportsAgency: () => true,
    },
    predict: {
      PredictionEngine: {
        stopsLibrary: [], networkGraph: null,
        guess: () => { throw new Error('route guesses are no longer made'); },
        guessEndStop: () => v3End,
        guessTopEndStops: () => [v3End, { stop: 'Dufferin', confidence: 20 }],
        getEndStopConstraint: () => ({ source: 'none', legalStops: null }),
        _stopMatch: () => false,
      },
    },
    predictV4: { PredictionEngineV4: {
      guessTopEndStops: () => [{ stop: 'Bathurst', confidence: 55 }],
    } },
    predictV5: { PredictionEngineV5: {
      guessTopEndStops: async () => [{ stop: 'Strachan', confidence: 50 }],
    } },
  });

  try {
    await handlers.handleTripLog('+14165550031', { userId: 'u31' }, '11985', '510', 'Westbound', 'TTC');
  } finally {
    restore();
  }

  assert.equal(matchArgs.filters.agency, 'TTC');
  assert.equal(calls.createTrip.length, 1);
  const trip = calls.createTrip[0];
  assert.equal(trip.habitPrediction.endStop, 'Spadina Station');
  assert.equal(trip.habitPrediction.version, 'habit_v2');
  // V3's own predictions stay separate from the habit.
  assert.deepEqual(trip.endStopPrediction, v3End);
  assert.equal(trip.endStopPredictions.length, 2);
  assert.equal(trip.endStopPredictions[0].stop, 'Bathurst');
  assert.equal(trip.endStopPredictionV4.stop, 'Bathurst');
  assert.equal(trip.endStopPredictionV5.stop, 'Strachan');
  // Route guesses are not made or stored at all (the route arrives in the text).
  for (const key of ['prediction', 'predictionV4', 'predictionV5']) assert.ok(!(key in trip), key);
  // The habit stop leads the normal list; V3's guesses here are all below the shown cutoff.
  const reply = calls.sendSmsReply[0]?.message || '';
  assert.match(reply, /Heading to Spadina Station\? END 1 to end\./);
  assert.match(reply, /END \[stop\] to finish/);
  assert.doesNotMatch(reply, /Usual trip|Bathurst/);
});

async function habitStartReply(top) {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: { isEmailAdmin: async () => true },
    habit: {
      HabitEngine: {
        VERSION: '2.0.0',
        load: async () => [{ schema: 2 }],
        match: (habits, stop) => ({ stop, route: '510', direction: 'Westbound', endStop: 'Spadina Station', confidence: 0.8, count: 4 }),
        rebuild: async () => [],
      },
    },
    eligibility: {
      getEligibility: () => ({ endStopEligible: true, cleanTripCount: 50 }),
      artifactSupportsAgency: () => true,
    },
    predict: {
      PredictionEngine: {
        stopsLibrary: [], networkGraph: null,
        guessEndStop: () => top[0] || null,
        guessTopEndStops: () => top,
        getEndStopConstraint: () => ({ source: 'none', legalStops: null }),
        _stopMatch: () => false,
      },
    },
  });
  try {
    await handlers.handleTripLog('+14165550034', { userId: 'u34' }, '11985', '510', 'Westbound', 'TTC');
  } finally {
    restore();
  }
  return { reply: calls.sendSmsReply[0]?.message || '', options: calls.sendSmsReply[0]?.options, trip: calls.createTrip[0] };
}

test('handleTripLog: admin start reply asks for one END button per numbered stop shown', async () => {
  const three = await habitStartReply([
    { stop: 'Bathurst', confidence: 90 }, { stop: 'Dufferin', confidence: 80 },
  ]);
  assert.deepEqual(three.options, { endButtons: 3 });
  const one = await habitStartReply([]);
  assert.deepEqual(one.options, { endButtons: 1 });
});

test('handleTripLog: admin habit trip lists the habit stop first, then other shown guesses', async () => {
  const { reply } = await habitStartReply([
    { stop: 'Bathurst', confidence: 90 }, { stop: 'Dufferin', confidence: 80 },
  ]);
  assert.match(reply, /Where to\?\n1\. Spadina Station\n2\. Bathurst\n3\. Dufferin\n\nEND 1, END 2, or END 3 to end\./);
  assert.doesNotMatch(reply, /Usual trip/);
});

test('handleTripLog: admin habit stop also in the V3 list is shown once', async () => {
  const { reply } = await habitStartReply([
    { stop: 'spadina station', confidence: 95 }, { stop: 'Bathurst', confidence: 90 },
  ]);
  assert.match(reply, /Where to\?\n1\. Spadina Station\n2\. Bathurst\n\nEND 1, or END 2 to end\./);
  assert.equal((reply.match(/spadina station/gi) || []).length, 1);
});

test('handleTripLog: admin habit with no other guesses uses the one-stop prompt', async () => {
  const { reply } = await habitStartReply([]);
  assert.match(reply, /\n\nHeading to Spadina Station\? END 1 to end\.\n\nEND \[stop\] to finish\. FORGOT if forgot to end\./);
});

test('handleTripLog: non-admin on a habit trip gets the unchanged reply, habit still stored', async () => {
  const habitEngine = {
    VERSION: '2.0.0',
    load: async () => [{ schema: 2 }],
    match: (habits, stop) => ({ stop, route: '510', direction: 'Westbound', endStop: 'Spadina Station', confidence: 0.8, count: 4 }),
    rebuild: async () => [],
  };
  const run = async (habit) => {
    const { handlers, calls, restore } = loadHandlers({
      dbModule: { isEmailAdmin: async () => false },
      habit: { HabitEngine: { ...habitEngine, match: habit ? habitEngine.match : () => null } },
    });
    try {
      await handlers.handleTripLog('+14165550033', { userId: 'u33' }, '11985', '510', 'Westbound', 'TTC');
    } finally {
      restore();
    }
    return calls;
  };
  const withHabit = await run(true);
  const without = await run(false);
  assert.equal(withHabit.createTrip[0].habitPrediction.endStop, 'Spadina Station');
  assert.equal(without.createTrip[0].habitPrediction, null);
  const reply = withHabit.sendSmsReply[0].message;
  assert.equal(reply, without.sendSmsReply[0].message);
  assert.equal(withHabit.sendSmsReply[0].options, undefined, 'non-admins never get END buttons');
  assert.doesNotMatch(reply, /Usual trip|Spadina Station/);
  assert.match(reply, /\n\nEND \[stop\] to finish\. FORGOT if forgot to end\.$/);
});

function habitActiveTrip(overrides = {}) {
  return {
    id: 'trip_h', userId: 'u32', route: '510', direction: 'Westbound', agency: 'TTC',
    startStopName: 'King / Spadina', startStopCode: '11985',
    startTime: { toDate: () => new Date(Date.now() - 20 * 60000) },
    prediction: null, predictionV4: null, predictionV5: null,
    habitPrediction: { stop: 'King / Spadina', route: '510', direction: 'Westbound', endStop: 'Spadina Station', confidence: 0.8 },
    endStopPrediction: { stop: 'Bathurst', confidence: 70 },
    endStopPredictionV4: null, endStopPredictionV5: null,
    endStopPredictions: [{ stop: 'Bathurst', confidence: 80 }, { stop: 'Dufferin', confidence: 20 }],
    stop_matched: true,
    ...overrides,
  };
}

async function endWith(input, { admin = true, trip = habitActiveTrip() } = {}) {
  const looked = [];
  const { handlers, restore } = loadHandlers({
    dbModule: {
      isEmailAdmin: async () => admin,
      getActiveTrip: async () => trip,
      lookupStop: async (_code, stopName) => { looked.push(stopName); return null; },
      findMatchingStops: async (name) => { looked.push(name); return []; },
    },
  });
  try {
    await handlers.handleEndTrip('+14165550032', { userId: 'u32' }, input);
  } finally {
    restore();
  }
  return looked;
}

test('handleEndTrip: admin END 1 on a habit trip resolves to the habit end stop, not V3', async () => {
  const looked = await endWith('1');
  assert.ok(looked.includes('Spadina Station'), `looked up: ${looked.join(', ')}`);
  assert.ok(!looked.includes('Bathurst'));
});

test('handleEndTrip: admin END 2 on a habit trip resolves to the second shown stop', async () => {
  const looked = await endWith('2', { trip: habitActiveTrip({
    endStopPredictions: [{ stop: 'Spadina Station', confidence: 95 }, { stop: 'Bathurst', confidence: 80 }, { stop: 'Dufferin', confidence: 78 }],
  }) });
  assert.ok(looked.includes('Bathurst'), `looked up: ${looked.join(', ')}`);
  assert.ok(!looked.includes('Spadina Station'));
});

test('handleEndTrip: admin END 3 on a habit trip matches the start list (habit + 2 others)', async () => {
  const looked = await endWith('3', { trip: habitActiveTrip({
    endStopPredictions: [{ stop: 'Bathurst', confidence: 90 }, { stop: 'Dufferin', confidence: 80 }, { stop: 'Ossington', confidence: 76 }],
  }) });
  assert.ok(looked.includes('Dufferin'), `looked up: ${looked.join(', ')}`);
  assert.ok(!looked.includes('Ossington'));
});

test('handleEndTrip: admin END 1 on a non-habit trip still uses V3 list', async () => {
  const looked = await endWith('1', { trip: habitActiveTrip({ habitPrediction: null }) });
  assert.ok(looked.includes('Bathurst'), `looked up: ${looked.join(', ')}`);
});

test('handleEndTrip: non-admin END 1 is not resolved from the habit', async () => {
  const looked = await endWith('1', { admin: false });
  assert.ok(!looked.includes('Spadina Station'));
});

test('handleTripLog: direction in a platform name resolves without prompting', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      findMatchingStops: async () => [
        {
          id: 'north_platform',
          stopCode: '9001-N',
          stopName: 'College Station - Northbound Platform',
          routes: ['1'],
          direction: null,
        },
        {
          id: 'station',
          stopCode: '9001',
          stopName: 'College Station',
          routes: ['1'],
          direction: null,
        },
      ],
      lookupStop: async (_code, stopName, _agency, route, direction) => {
        if (stopName === 'College' && route === '1' && direction === 'Northbound') {
          return { id: 'north_platform', stopCode: '9001-N', stopName: 'College Station - Northbound Platform', source: 'verified' };
        }
        return null;
      },
    },
  });

  try {
    await handlers.handleTripLog('+14165550015', { userId: 'u15' }, 'College', '1', 'Northbound', 'TTC');
  } finally {
    restore();
  }

  assert.equal(calls.setPendingState.length, 0);
  assert.equal(calls.createTrip.length, 1);
  assert.equal(calls.createTrip[0].startStopCode, '9001-N');
});

test('handleTripLog: opposite-direction platform is removed when a neutral station remains', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      findMatchingStops: async () => [
        {
          id: 'north_platform',
          stopCode: '13837',
          stopName: 'Yorkdale Station - Northbound Platform',
          routes: ['1'],
        },
        {
          id: 'station',
          stopCode: 'station-yorkdale',
          stopName: 'Yorkdale Station',
          routes: ['1'],
          direction: null,
        },
      ],
      lookupStop: async (_code, stopName, _agency, route, direction) => {
        if (stopName === 'Yorkdale' && route === '1' && direction === 'Southbound') {
          return { id: 'station', stopCode: 'station-yorkdale', stopName: 'Yorkdale Station', source: 'manual' };
        }
        return null;
      },
    },
  });

  try {
    await handlers.handleTripLog('+14165550016', { userId: 'u16' }, 'Yorkdale', '1', 'Southbound', 'TTC');
  } finally {
    restore();
  }

  assert.equal(calls.setPendingState.length, 0);
  assert.equal(calls.createTrip.length, 1);
  assert.equal(calls.createTrip[0].startStopCode, 'station-yorkdale');
  assert.equal(calls.createTrip[0].startStopName, 'Yorkdale Station');
});

test('handleTripLog: punctuation-only stop duplicates do not prompt', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      findMatchingStops: async () => [
        { id: 'spaced', stopCode: '1001', stopName: 'St Clair West Station', routes: ['1'], direction: null },
        { id: 'punctuated', stopCode: '1002', stopName: 'St.Clair West Station', routes: ['1'], direction: null },
      ],
      lookupStop: async (_code, stopName, _agency, route, direction) => {
        if (stopName === 'St Clair West' && route === '1' && direction === 'Southbound') {
          return { id: 'spaced', stopCode: '1001', stopName: 'St Clair West Station', source: 'verified' };
        }
        return null;
      },
    },
  });

  try {
    await handlers.handleTripLog('+14165550016', { userId: 'u16' }, 'St Clair West', '1', 'Southbound', 'TTC');
  } finally {
    restore();
  }

  assert.equal(calls.setPendingState.length, 0);
  assert.equal(calls.createTrip.length, 1);
  assert.equal(calls.createTrip[0].startStopCode, '1001');
});

test('handleTripLog: 506 College Station Westbound auto-resolves to westbound surface stop', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      findMatchingStops: async () => [
        { id: 's760', stopCode: '760', stopName: 'College Station', routes: ['506'], direction: 'Westbound' },
        { id: 's761', stopCode: '761', stopName: 'College Station', routes: ['506'], direction: 'Eastbound' },
      ],
      lookupStop: async (_code, stopName, _agency, route, direction) => {
        if (stopName === 'College Station' && route === '506' && direction === 'Westbound') {
          return { id: 's760', stopCode: '760', stopName: 'College Station', source: 'verified' };
        }
        return null;
      },
    },
  });

  try {
    await handlers.handleTripLog('+14165550014', { userId: 'u14' }, 'College Station', '506', 'Westbound', 'TTC');
  } finally {
    restore();
  }

  assert.equal(calls.setPendingState.length, 0);
  assert.equal(calls.createTrip.length, 1);
  assert.equal(calls.createTrip[0].startStopCode, '760');
  assert.equal(calls.createTrip[0].startStopName, 'College Station');
});

test('handleMmsTrip: missing stop sets mms_stop_needed with receivedAt', async () => {
  const { handlers, calls, restore } = loadHandlers({
    gemini: {
      parseStopSignImage: async () => ({
        routes: [{ route: '510', agency: 'TTC' }, { route: '310', agency: 'TTC' }],
        stopCode: null,
        stopName: null,
      }),
    },
  });

  try {
    await handlers.handleMmsTrip('+14165550002', { userId: 'u2' }, 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEtest', 1710000000001);
  } finally {
    restore();
  }

  assert.equal(calls.setPendingState.length, 1);
  assert.equal(calls.setPendingState[0].type, 'mms_stop_needed');
  assert.equal(calls.setPendingState[0].receivedAt, 1710000000001);
  assert.match(calls.sendSmsReply[0].message, /what stop are you at/i);
});

test('handleMmsTrip: single-route snap-to-start preserves startTime/source metadata', async () => {
  const { handlers, calls, restore } = loadHandlers({
    gemini: {
      parseStopSignImage: async () => ({
        routes: [{ route: '510', agency: 'TTC' }],
        stopCode: '11985',
        stopName: null,
      }),
    },
  });

  try {
    await handlers.handleMmsTrip('+14165550003', { userId: 'u3' }, 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEtest', 1710000000002);
  } finally {
    restore();
  }

  assert.equal(calls.createTrip.length, 1);
  assert.equal(calls.createTrip[0].startTime, 1710000000002);
  assert.equal(calls.createTrip[0].source, 'mms');
  assert.equal(calls.createTrip[0].timing_reliability, 'approximate');
  assert.equal(calls.createTrip[0].parsed_by, 'mms');
});

test('handleTripLog: no V4/V5 route guess is stored, even with route artifacts and GTFS routes', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      getRoutesAtStop: async () => ['510'],
    },
    predictV4: {
      PredictionEngineV4: {
        guessTopEndStops: () => [],
      },
    },
    predictV5: {
      PredictionEngineV5: {
        guessTopEndStops: async () => [],
      },
    },
  });

  try {
    await handlers.handleTripLog('+14165550004', { userId: 'u4' }, '11985', '510', null, 'TTC');
  } finally {
    restore();
  }

  assert.equal(calls.createTrip.length, 1);
  assert.ok(!('predictionV4' in calls.createTrip[0]));
  assert.ok(!('predictionV5' in calls.createTrip[0]));
});

test('handleTripLog: experimental models stay off without eligible agency history and artifacts', async () => {
  let endStopContext;
  const networkGraph = { edges: { learned: { tripCount: 3 } } };
  const { handlers, restore } = loadHandlers({
    dbModule: {
      getRecentCompletedTrips: async () => [{
        route: '506',
        endStopName: 'College Station',
        startTime: { toDate: () => new Date(Date.now() - 10 * 60 * 1000) },
      }],
      getRoutesAtStop: async () => ['510'],
    },
    network: {
      NetworkEngine: {
        load: async () => networkGraph,
      },
    },
    predictV4: {
      PredictionEngineV4: {
        guessTopEndStops: context => { endStopContext = context; return []; },
      },
    },
  });

  try {
    await handlers.handleTripLog('+14165550005', { userId: 'u5', email: 'user@example.com' }, '11985', '510', 'Southbound', 'TTC');
  } finally {
    restore();
  }

  assert.equal(endStopContext, undefined);
});

test('fillPredictions: fallback inference stays off without eligible agency artifacts', async () => {
  let endStopContext;
  const networkGraph = { edges: { learned: { tripCount: 3 } } };
  const { handlers, restore } = loadHandlers({
    dbModule: {
      getRecentCompletedTrips: async () => [{
        route: '506',
        endStopName: 'College Station',
        startTime: { toDate: () => new Date(Date.now() - 10 * 60 * 1000) },
      }],
    },
    network: {
      NetworkEngine: {
        load: async () => networkGraph,
      },
    },
    predictV4: {
      PredictionEngineV4: {
        guessTopEndStops: context => { endStopContext = context; return []; },
      },
    },
  });

  try {
    await handlers.fillPredictions(
      { userId: 'u5', email: 'user@example.com' },
      'trip_5',
      'Spadina Station',
      '510',
      'Southbound',
      'TTC',
    );
  } finally {
    restore();
  }

  assert.equal(endStopContext, undefined);
});

test('fillPredictions: stores V4/V5 end-stop guesses only, never a route guess', async () => {
  const { handlers, calls, restore } = loadHandlers({
    eligibility: { isModelReady: () => true },
    predictV4: { PredictionEngineV4: { guessTopEndStops: () => [{ stop: 'Bathurst', confidence: 55 }] } },
    predictV5: { PredictionEngineV5: { guessTopEndStops: async () => [{ stop: 'Strachan', confidence: 50 }] } },
  });
  try {
    await handlers.fillPredictions({ userId: 'u6', email: 'user@example.com' }, 'trip_6', 'Spadina Station', '510', 'Southbound', 'TTC');
  } finally {
    restore();
  }
  assert.equal(calls.docUpdates.length, 1);
  const update = calls.docUpdates[0];
  assert.equal(update.endStopPredictionV4.stop, 'Bathurst');
  assert.equal(update.endStopPredictionV5.stop, 'Strachan');
  assert.ok(!('predictionV4' in update) && !('predictionV5' in update));
});

test('handleTripLog: skips V4/V5 shadow inference when experimental access is disabled', async () => {
  let v4Calls = 0;
  let v5Calls = 0;
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      isExperimentalIntelligenceEnabled: async () => false,
    },
    predictV4: {
      PredictionEngineV4: {
        guessTopEndStops: () => { v4Calls += 1; return []; },
      },
    },
    predictV5: {
      PredictionEngineV5: {
        guessTopEndStops: async () => { v5Calls += 1; return []; },
      },
    },
  });

  try {
    await handlers.handleTripLog('+14165550004', { userId: 'u4', email: 'user@example.com' }, '11985', '510', null, 'TTC');
  } finally {
    restore();
  }

  assert.equal(v4Calls, 0);
  assert.equal(v5Calls, 0);
  assert.ok(!('predictionV4' in calls.createTrip[0]));
  assert.ok(!('predictionV5' in calls.createTrip[0]));
});

test('handleTripLog: end-to-end prediction prompt does not surface illegal 506 destinations', async () => {
  const { PredictionEngine } = require('./lib/predict.js');
  const now = new Date();
  const makeTrip = ({ endStopName, daysAgo }) => {
    const startTime = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    const endTime = new Date(startTime.getTime() + 25 * 60 * 1000);
    return {
      route: '506',
      agency: 'TTC',
      startStopName: 'College Station',
      endStopName,
      direction: 'Westbound',
      startTime,
      endTime,
    };
  };

  const history = [
    ...Array.from({ length: 8 }, (_, i) => makeTrip({ endStopName: 'Spadina Station', daysAgo: i + 1 })),
    // Enough legal history for the top guess to clear the admin display gate (confidence >= 75).
    ...Array.from({ length: 7 }, (_, i) => makeTrip({ endStopName: 'College / Spadina', daysAgo: i + 1 })),
    makeTrip({ endStopName: 'College St at Bathurst St', daysAgo: 2 }),
  ];

  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      getRecentCompletedTrips: async () => history,
      isEmailAdmin: async () => true,
      getUserProfile: async () => ({ defaultAgency: 'TTC', isAdmin: true }),
      lookupStop: async () => ({
        id: 'stop_506',
        stopCode: '14400',
        stopName: 'College Station',
        source: 'verified',
      }),
    },
    predict: { PredictionEngine },
    predictV4: {
      PredictionEngineV4: {
        guessTopEndStops: () => [],
      },
    },
    predictV5: {
      PredictionEngineV5: {
        guessTopEndStops: async () => [],
      },
    },
  });

  try {
    await handlers.handleTripLog('+14165550004', { userId: 'u4' }, '14400', '506', 'Westbound', 'TTC');
  } finally {
    restore();
    PredictionEngine.networkGraph = null;
    PredictionEngine.stopsLibrary = [];
  }

  const reply = calls.sendSmsReply[0]?.message || '';
  assert.doesNotMatch(reply, /Spadina Station/);
  assert.match(reply, /College \/ Spadina|College St at Bathurst St/);
  assert.equal(calls.createTrip[0].endStopConstraintSource, 'topology');
  assert.notEqual(calls.createTrip[0].endStopPrediction?.stop, 'Spadina Station');
  assert.match(calls.createTrip[0].endStopPrediction?.stop || '', /College \/ Spadina|College St at Bathurst St/);
  assert.ok(calls.loggerInfo.some(entry =>
    entry.message === 'Trip-start end-stop constraint' &&
    entry.data?.constraintSource === 'topology'
  ));
});

test('handleTripLog: writes provisional transfer metadata at second-leg start', async () => {
  const { TransferEngine } = require('./lib/transfer.js');
  const now = Date.now();
  const prevTrip = {
    id: 'prev_506',
    route: '506',
    endStopName: 'College Station',
    endTime: new Date(now - 4 * 60000),
    startTime: new Date(now - 14 * 60000),
  };

  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      getRecentCompletedTrips: async () => [prevTrip],
      lookupStop: async () => ({
        id: 'stop_college',
        stopCode: '1234',
        stopName: 'College Station',
        source: 'verified',
      }),
    },
    transfer: { TransferEngine },
  });

  try {
    await handlers.handleTripLog('+14165550009', { userId: 'u9' }, '1234', '1', 'Northbound', 'TTC');
  } finally {
    restore();
  }

  assert.equal(calls.createTrip.length, 1);
  assert.equal(calls.createTrip[0].provisionalTransfer, true);
  assert.equal(calls.createTrip[0].provisionalPrevTripId, 'prev_506');
  assert.ok(calls.createTrip[0].provisionalJourneyConfidence >= 0.55);
  assert.ok(calls.loggerInfo.some(entry =>
    entry.message === 'Trip-start provisional transfer detected' &&
    entry.data?.prevTripId === 'prev_506'
  ));
});

test('handleEndTrip: next-leg suggestion appended when transfer index has known connection', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      getActiveTrip: async () => ({
        id: 'trip_1',
        userId: 'u5',
        route: '510',
        direction: 'Westbound',
        agency: 'TTC',
        startStopName: 'King / Spadina',
        startStopCode: '11985',
        startTime: { toDate: () => new Date(Date.now() - 20 * 60000) },
        prediction: null,
        predictionV4: null,
        predictionV5: null,
        habitPrediction: null,
        endStopPrediction: null,
        endStopPredictionV4: null,
        endStopPredictionV5: null,
        endStopPredictions: null,
        stop_matched: true,
      }),
    },
    network: {
      NetworkEngine: {
        load: async () => null,
        observe: async () => {},
        filterCandidates: () => null,
        getMedianDuration: () => null,
        getConnectionsAtStop: async () => ({ '510_to_2': 4, '510_to_504': 1 }),
        getConnectionLabels: async () => ({ '510_to_2': '2', '510_to_504': '504' }),
        _key: (s) => s.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
      },
    },
  });

  try {
    await handlers.handleEndTrip('+14165550005', { userId: 'u5' }, 'Spadina Station');
  } finally {
    restore();
  }

  const reply = calls.sendSmsReply[0]?.message || '';
  assert.match(reply, /Usually take the 2 from here/);
});

test('handleEndTrip: next-leg suggestion suppressed when connection count below threshold', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      getActiveTrip: async () => ({
        id: 'trip_1',
        userId: 'u6',
        route: '510',
        direction: 'Westbound',
        agency: 'TTC',
        startStopName: 'King / Spadina',
        startStopCode: '11985',
        startTime: { toDate: () => new Date(Date.now() - 20 * 60000) },
        prediction: null, predictionV4: null, predictionV5: null,
        habitPrediction: null, endStopPrediction: null,
        endStopPredictionV4: null, endStopPredictionV5: null,
        endStopPredictions: null, stop_matched: true,
      }),
    },
    network: {
      NetworkEngine: {
        load: async () => null,
        observe: async () => {},
        filterCandidates: () => null,
        getMedianDuration: () => null,
        getConnectionsAtStop: async () => ({ '510_to_2': 1 }), // below threshold
        getConnectionLabels: async () => ({ '510_to_2': '2' }),
        _key: (s) => s.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
      },
    },
  });

  try {
    await handlers.handleEndTrip('+14165550006', { userId: 'u6' }, 'Spadina Station');
  } finally {
    restore();
  }

  const reply = calls.sendSmsReply[0]?.message || '';
  assert.doesNotMatch(reply, /Usually take/);
});

test('handleEndTrip: transfer scoring uses network connections and observe receives prevRoute', async () => {
  const scoreCalls = [];
  const observeCalls = [];
  const prevTrip = {
    id: 'prev_trip',
    route: '2',
    endStopName: 'Bloor-Yonge Station',
    endTime: { toDate: () => new Date(Date.now() - 5 * 60000) },
    startTime: { toDate: () => new Date(Date.now() - 9 * 60000) },
  };

  const { handlers, restore } = loadHandlers({
    dbModule: {
      getActiveTrip: async () => ({
        id: 'trip_1',
        userId: 'u7',
        route: '1',
        direction: 'Northbound',
        agency: 'TTC',
        startStopName: 'Bloor-Yonge Station',
        startStopCode: '',
        startTime: { toDate: () => new Date(Date.now() - 4 * 60000) },
        prediction: null, predictionV4: null, predictionV5: null,
        habitPrediction: null, endStopPrediction: null,
        endStopPredictionV4: null, endStopPredictionV5: null,
        endStopPredictions: null, stop_matched: true,
      }),
      getRecentCompletedTrips: async () => [prevTrip],
      lookupStop: async (_code, name) => ({
        id: 'stop_1',
        stopCode: '',
        stopName: name === 'Davisville' ? 'Davisville' : 'Bloor-Yonge Station',
        source: 'verified',
      }),
    },
    network: {
      NetworkEngine: {
        load: async () => null,
        observe: async (_db, _userId, trip, prevRoute) => { observeCalls.push({ trip, prevRoute }); },
        filterCandidates: () => null,
        getMedianDuration: () => null,
        getConnectionsAtStop: async () => ({ '2_to_1': 3 }),
        getConnectionLabels: async () => ({}),
        _key: (s) => s.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
      },
    },
    transfer: {
      TransferEngine: {
        score: (_prev, _next, _history, connections) => {
          scoreCalls.push(connections);
          return 0.8;
        },
        CONFIDENCE_THRESHOLD: 0.55,
      },
    },
  });

  try {
    await handlers.handleEndTrip('+14165550007', { userId: 'u7' }, 'Davisville');
  } finally {
    restore();
  }

  // Verify TransferEngine.score was called with the correct network connections
  assert.deepEqual(scoreCalls[0], { '2_to_1': 3 });
  // observeCalls removed: NetworkEngine.observe now runs in background finalization, not handleEndTrip
});

test('handleEndTrip: single text-matched end candidate without a stop code still counts as matched', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      getActiveTrip: async () => ({
        id: 'trip_code_less_end',
        userId: 'u11',
        route: '1',
        direction: 'Southbound',
        agency: 'TTC',
        startStopName: 'Davisville',
        startStopCode: null,
        startTime: { toDate: () => new Date(Date.now() - 10 * 60000) },
        prediction: null,
        predictionV4: null,
        predictionV5: null,
        habitPrediction: null,
        endStopPrediction: null,
        endStopPredictionV4: null,
        endStopPredictionV5: null,
        endStopPredictions: null,
        stop_matched: true,
      }),
      findMatchingStops: async (name) => (
        name === 'College Station'
          ? [{ id: 'stop_college', stopCode: null, stopName: 'College Station', routes: ['1'], direction: null, source: 'manual' }]
          : []
      ),
      lookupStop: async (code, name) => {
        if (code === null && name === 'College Station') {
          return { id: 'stop_college', stopCode: null, stopName: 'College Station', source: 'manual' };
        }
        return null;
      },
    },
  });

  try {
    await handlers.handleEndTrip('+14165550011', { userId: 'u11' }, 'College Station');
  } finally {
    restore();
  }

  assert.ok(calls.docUpdates.length > 0);
  assert.equal(calls.docUpdates[0].endStopName, 'College Station');
  assert.equal(calls.docUpdates[0].stop_matched, true);
});

test('handleEndTrip: final journey reconciliation prefers provisional previous trip', async () => {
  const { TransferEngine } = require('./lib/transfer.js');
  const now = Date.now();
  const trip504 = {
    id: 'prev_504',
    route: '504',
    endStopName: 'College Station',
    endTime: { toDate: () => new Date(now - 8 * 60000) },
    startTime: { toDate: () => new Date(now - 23 * 60000) },
  };
  const trip506 = {
    id: 'prev_506',
    route: '506',
    endStopName: 'College Station',
    endTime: { toDate: () => new Date(now - 3 * 60000) },
    startTime: { toDate: () => new Date(now - 14 * 60000) },
  };

  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      getActiveTrip: async () => ({
        id: 'trip_1',
        userId: 'u10',
        route: '1',
        direction: 'Northbound',
        agency: 'TTC',
        startStopName: 'College Station',
        startStopCode: '1234',
        startTime: { toDate: () => new Date(now) },
        prediction: null, predictionV4: null, predictionV5: null,
        habitPrediction: null, endStopPrediction: null,
        endStopPredictionV4: null, endStopPredictionV5: null,
        endStopPredictions: null, stop_matched: true,
        provisionalPrevTripId: 'prev_506',
      }),
      getRecentCompletedTrips: async () => [trip504, trip506],
      lookupStop: async (_code, stopName) => ({
        id: `stop_${String(stopName || 'college').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
        stopCode: '1234',
        stopName: stopName || 'Davisville',
        source: 'verified',
      }),
    },
    network: {
      NetworkEngine: {
        load: async () => null,
        observe: async () => {},
        filterCandidates: () => null,
        getEdgeMedianDuration: () => null,
        getMedianDuration: () => null,
        getConnectionsAtStop: async () => ({}),
        getConnectionLabels: async () => ({}),
        _key: (s) => s.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
      },
    },
    transfer: { TransferEngine },
  });

  try {
    await handlers.handleEndTrip('+14165550010', { userId: 'u10' }, 'Davisville');
  } finally {
    restore();
  }

  const reply = calls.sendSmsReply[0]?.message || '';
  assert.match(reply, /Linked to your 506 trip/);
});

function makeEndTripHandlers(networkOverride) {
  return loadHandlers({
    dbModule: {
      getActiveTrip: async () => ({
        id: 'trip_1',
        userId: 'u7',
        route: '510',
        direction: 'Westbound',
        agency: 'TTC',
        startStopName: 'King / Spadina',
        startStopCode: '11985',
        startTime: { toDate: () => new Date(Date.now() - 40 * 60000) },
        prediction: null, predictionV4: null, predictionV5: null,
        habitPrediction: null, endStopPrediction: null,
        endStopPredictionV4: null, endStopPredictionV5: null,
        endStopPredictions: null, stop_matched: true,
      }),
    },
    network: { NetworkEngine: networkOverride },
    // Personal graph doc for detectAnomaly's direct Firestore read; the
    // content is inert — getEdgeMedianDuration is mocked per test.
    networkGraphDoc: { edges: {} },
  });
}

test('handleEndTrip: anomaly note appended when trip duration >= 2x hour-specific median', async () => {
  const { handlers, calls, restore } = makeEndTripHandlers({
    load: async () => ({
      edges: {
        e1: {
          fromStop: 'King / Spadina',
          toStop: 'Spadina Station',
          direction: 'Westbound',
          durations: [10, 10, 10],
          medianMinutes: 10,
          durationsByHour: { [new Date().getHours().toString()]: [10, 10, 10] },
          tripCount: 3,
        },
      },
    }),
    observe: async () => {},
    filterCandidates: () => null,
    getEdgeMedianDuration: () => 10, // specific edge: King→Spadina Station typical = 10 min
    getMedianDuration: () => 10,
    getConnectionsAtStop: async () => ({}),
    getConnectionLabels: async () => ({}),
    _key: (s) => s.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
  });

  try {
    await handlers.handleEndTrip('+14165550007', { userId: 'u7' }, 'Spadina Station');
  } finally {
    restore();
  }

  const reply = calls.sendSmsReply[0]?.message || '';
  assert.match(reply, /took longer than usual/);
  assert.match(reply, /40 min vs\. typical 10 min/);
});

test('handleEndTrip: anomaly note suppressed when duration is within normal range', async () => {
  const { handlers, calls, restore } = makeEndTripHandlers({
    load: async () => ({
      edges: {
        e1: {
          fromStop: 'King / Spadina',
          toStop: 'Spadina Station',
          direction: 'Westbound',
          durations: [35, 38, 40],
          medianMinutes: 38,
          durationsByHour: { [new Date().getHours().toString()]: [35, 38, 40] },
          tripCount: 3,
        },
      },
    }),
    observe: async () => {},
    filterCandidates: () => null,
    getEdgeMedianDuration: () => 38, // specific edge: typical = 38 min; trip took 40 min (within 2x)
    getMedianDuration: () => 38,
    getConnectionsAtStop: async () => ({}),
    getConnectionLabels: async () => ({}),
    _key: (s) => s.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
  });

  try {
    await handlers.handleEndTrip('+14165550008', { userId: 'u8' }, 'Spadina Station');
  } finally {
    restore();
  }

  const reply = calls.sendSmsReply[0]?.message || '';
  assert.doesNotMatch(reply, /took longer than usual/);
});

test('handleEndTrip: completion reply advertises NOTES follow-up', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      getActiveTrip: async () => ({
        id: 'trip_notes_prompt',
        userId: 'u12',
        route: '510',
        direction: 'Westbound',
        agency: 'TTC',
        startStopName: 'Spadina Station',
        startStopCode: '11985',
        startTime: { toDate: () => new Date(Date.now() - 12 * 60000) },
        prediction: null,
        predictionV4: null,
        predictionV5: null,
        habitPrediction: null,
        endStopPrediction: null,
        endStopPredictionV4: null,
        endStopPredictionV5: null,
        endStopPredictions: null,
        stop_matched: true,
      }),
      lookupStop: async (_code, name) => ({
        id: 'stop_notes',
        stopCode: '844',
        stopName: name || 'College St at Spadina Ave',
        source: 'verified',
      }),
    },
  });

  try {
    await handlers.handleEndTrip('+14165550012', { userId: 'u12' }, 'College St at Spadina Ave');
  } finally {
    restore();
  }

  const reply = calls.sendSmsReply[0]?.message || '';
  assert.match(reply, /Reply NOTES \(your note\) to add a note\./);
});

test('handleAddNotes: updates most recent completed trip notes', async () => {
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      getRecentCompletedTrips: async () => [{
        id: 'recent_trip_1',
        route: '510',
        direction: 'Southbound',
      }],
    },
  });

  try {
    await handlers.handleAddNotes('+14165550013', { userId: 'u13' }, 'crowded but fast');
  } finally {
    restore();
  }

  assert.equal(calls.docUpdates.length, 1);
  assert.deepEqual(calls.docUpdates[0], { notes: 'crowded but fast' });
  assert.equal(calls.sendSmsReply[0]?.message, 'Added notes to 510 Southbound.');
});

// --- Unconfirmed numbers (invite links not yet confirmed by the owner) ---
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
const { phoneTag, tripStartedByPhone } = require('./lib/phone-confirmation');
const LOCKED_USER = { userId: 'u1', email: 'owner@example.com', loginConfirmed: false };
const OWNER_TRIP = {
  id: 'owner-trip', route: '504', direction: 'Eastbound', agency: 'TTC',
  startStopName: 'Broadview', startTime: { toDate: () => new Date(Date.now() - 10 * 60000) },
};

test('unconfirmed number: starting a trip while the owner has one running gets a neutral reply and reveals nothing', async () => {
  const { handlers, calls, restore } = loadHandlers({ dbModule: { getActiveTrip: async () => OWNER_TRIP } });
  try {
    await handlers.handleTripLog('+14165550001', LOCKED_USER, 'Spadina', '510', null, 'TTC', { agencyExplicit: true });
  } finally { restore(); }
  assert.equal(calls.createTrip.length, 0);
  assert.equal(calls.setPendingState.length, 0);
  assert.equal(calls.sendSmsReply.length, 1);
  assert.doesNotMatch(calls.sendSmsReply[0].message, /504|Broadview|Eastbound|started/i);
});

test('unconfirmed number: a new trip uses no history, habits, achievements or last agency, and is tagged with its number', async () => {
  const touched = [];
  const { handlers, calls, restore } = loadHandlers({
    dbModule: {
      getRecentCompletedTrips: async () => { touched.push('history'); return []; },
      getLastTripAgency: async () => { touched.push('lastAgency'); return 'GO Transit'; },
      getUserProfile: async () => { touched.push('profile'); return { defaultAgency: 'GO Transit' }; },
    },
  });
  try {
    await handlers.handleTripLog('+14165550001', LOCKED_USER, 'Spadina', '510', null, 'TTC', {});
  } finally { restore(); }
  assert.deepEqual(touched.filter(t => t !== 'profile'), []);
  assert.equal(calls.createTrip.length, 1);
  assert.equal(calls.createTrip[0].sourcePhone, phoneTag('+14165550001'));
  assert.equal(calls.createTrip[0].habitPrediction, null);
  assert.doesNotMatch(calls.sendSmsReply[0].message, /Usual trip|streak|trips/i);
});

test('confirmed number: new trips are tagged with the number that started them', async () => {
  const { handlers, calls, restore } = loadHandlers();
  try {
    await handlers.handleTripLog('+14165550001', { userId: 'u1', email: 'o@example.com' }, 'Spadina', '510', null, 'TTC', {});
  } finally { restore(); }
  assert.equal(calls.createTrip[0].sourcePhone, phoneTag('+14165550001'));
});

test('unconfirmed number: END cannot touch a trip it did not start, and cannot tell whether one exists', async () => {
  const replies = [];
  for (const active of [OWNER_TRIP, { ...OWNER_TRIP, sourcePhone: phoneTag('+14165559999') }, null]) {
    const { handlers, calls, restore } = loadHandlers({ dbModule: { getActiveTrip: async () => active } });
    try {
      await handlers.handleEndTrip('+14165550001', LOCKED_USER, 'Union', null, null);
    } finally { restore(); }
    assert.equal(calls.docUpdates.length, 0);
    replies.push(calls.sendSmsReply[0].message);
  }
  assert.equal(new Set(replies).size, 1);
  assert.doesNotMatch(replies[0], /504|Broadview|No active trip/i);
});

test('unconfirmed number: END ends its own trip with a plain reply and no history notes', async () => {
  const own = { ...OWNER_TRIP, sourcePhone: phoneTag('+14165550001') };
  const { handlers, calls, restore } = loadHandlers({ dbModule: { getActiveTrip: async () => own } });
  try {
    await handlers.handleEndTrip('+14165550001', LOCKED_USER, 'Union', null, null);
  } finally { restore(); }
  assert.equal(calls.docUpdates.length, 1);
  assert.match(calls.sendSmsReply[0].message, /^Ended 504 Eastbound at \S+ \(\d+ min trip\)\.$/);
});

test('unconfirmed number: confirming a start can never mark the owner\'s trip incomplete', async () => {
  const { handlers, calls, restore } = loadHandlers();
  try {
    await handlers.handleConfirmStart('+14165550001', LOCKED_USER, {
      activeTrip: { ...OWNER_TRIP },
      newTrip: { stopCode: '1', stopName: 'Spadina', route: '510', direction: null, agency: 'TTC' },
    });
  } finally { restore(); }
  assert.equal(calls.createTrip.length, 0);
  assert.equal(calls.docUpdates.length, 0);
  assert.equal(calls.batchUpdates.length, 0);
});

test('source tags: keyed hash, never for the app identity, and none at all without the secret', () => {
  const tag = phoneTag('+14165550001');
  assert.match(tag, /^[0-9a-f]{32}$/);
  assert.equal(phoneTag('+14165550001'), tag);
  assert.notEqual(phoneTag('+14165550002'), tag);
  assert.equal(phoneTag('web:u1'), null);

  const saved = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = 'a-different-secret';
  const other = phoneTag('+14165550001');
  delete process.env.TWILIO_AUTH_TOKEN;
  const none = phoneTag('+14165550001');
  const owns = tripStartedByPhone({ sourcePhone: tag }, '+14165550001');
  process.env.TWILIO_AUTH_TOKEN = saved;
  assert.notEqual(other, tag);
  assert.equal(none, null);
  assert.equal(owns, false); // fails closed: no secret, no ownership
  assert.equal(tripStartedByPhone({ sourcePhone: null }, '+14165550001'), false);
  assert.equal(tripStartedByPhone({}, '+14165550001'), false);
});

test('a trip the owner starts from the app carries no number tag, so no phone can end it', async () => {
  // Owner starts a trip as the app identity.
  const started = loadHandlers();
  try {
    await started.handlers.handleTripLog('web:u1', { userId: 'u1', email: 'o@example.com', loginConfirmed: true }, 'Spadina', '510', null, 'TTC', {});
  } finally { started.restore(); }
  assert.equal(started.calls.createTrip[0].sourcePhone, null);

  // Unconfirmed number X tries to end it.
  const webTrip = { ...OWNER_TRIP, sourcePhone: started.calls.createTrip[0].sourcePhone };
  const attack = loadHandlers({ dbModule: { getActiveTrip: async () => webTrip } });
  try {
    await attack.handlers.handleEndTrip('+14165550001', LOCKED_USER, 'Union', null, null);
  } finally { attack.restore(); }
  assert.equal(attack.calls.docUpdates.length, 0);
});

test('the owner in the app can end any of their trips, including ones a phone started', async () => {
  const { handlers, calls, restore } = loadHandlers({ dbModule: { getActiveTrip: async () => ({ ...OWNER_TRIP, sourcePhone: phoneTag('+14165550001') }) } });
  try {
    await handlers.handleEndTrip('web:u1', { userId: 'u1', email: 'o@example.com', loginConfirmed: true }, 'Union', null, null);
  } finally { restore(); }
  assert.equal(calls.docUpdates.length, 1);
});

test('guessing between the default and last agency uses the read-only library check and skips Atlas', async () => {
  const checks = [];
  const { handlers, restore } = loadHandlers({
    dbModule: {
      getLastTripAgency: async () => 'GO Transit',
      lookupStop: async () => null,
      lookupStopCheck: async (code, name, agency, route, direction, options) => {
        checks.push({ agency, options });
        return { status: 'notFound', stop: null };
      },
    },
  });
  try {
    await handlers.handleTripLog('+14165550001', { userId: 'u1', email: 'o@example.com' }, '88888', '510', null, 'TTC', {});
  } finally { restore(); }
  assert.ok(checks.length >= 2);
  assert.ok(checks.every(c => c.options?.atlas === false), 'agency guessing must skip Atlas');
});

test('getPredictionPrompt: admin end-stop list shows only guesses with confidence >= 75', () => {
  const { getPredictionPrompt, getShownEndStopPredictions } = require('./lib/handlers-utils');
  const plain = getPredictionPrompt(null);
  assert.equal(getPredictionPrompt([{ stop: 'Elm St', confidence: 74 }, { stop: 'Oak St', confidence: 20 }]), plain);
  assert.match(getPredictionPrompt([{ stop: 'Elm St', confidence: 75 }, { stop: 'Oak St', confidence: 20 }]),
    /Heading to Elm St\? END 1 to end\./);
  assert.deepStrictEqual(getShownEndStopPredictions([{ stop: 'A', confidence: 50 }, { stop: 'B', confidence: 90 }]),
    [{ stop: 'B', confidence: 90 }]);
});

function endTripWithStoredGuesses(endStopPredictions) {
  return loadHandlers({
    dbModule: {
      isEmailAdmin: async () => true,
      getActiveTrip: async () => ({
        id: 'trip_end_gate',
        userId: 'u13',
        route: '1',
        direction: 'Southbound',
        agency: 'TTC',
        startStopName: 'Davisville',
        startStopCode: null,
        startTime: { toDate: () => new Date(Date.now() - 10 * 60000) },
        prediction: null,
        predictionV4: null,
        predictionV5: null,
        habitPrediction: null,
        endStopPrediction: endStopPredictions[0],
        endStopPredictionV4: null,
        endStopPredictionV5: null,
        endStopPredictions,
        stop_matched: true,
      }),
      findMatchingStops: async (name) => (
        name === 'College Station'
          ? [{ id: 'stop_college', stopCode: null, stopName: 'College Station', routes: ['1'], direction: null, source: 'manual' }]
          : []
      ),
      lookupStop: async (code, name) => (code === null && name === 'College Station'
        ? { id: 'stop_college', stopCode: null, stopName: 'College Station', source: 'manual' }
        : null),
    },
  });
}

test('handleEndTrip: admin END 1 resolves a shown (confidence >= 75) guess', async () => {
  const { handlers, calls, restore } = endTripWithStoredGuesses([{ stop: 'College Station', confidence: 80, version: '3.5.0' }]);
  try {
    await handlers.handleEndTrip('+14165550013', { userId: 'u13' }, '1');
  } finally {
    restore();
  }
  assert.equal(calls.docUpdates[0]?.endStopName, 'College Station');
});

test('handleEndTrip: admin END 1 does not resolve a stored guess below 75', async () => {
  const { handlers, calls, restore } = endTripWithStoredGuesses([{ stop: 'College Station', confidence: 60, version: '3.5.0' }]);
  try {
    await handlers.handleEndTrip('+14165550014', { userId: 'u13' }, '1');
  } finally {
    restore();
  }
  assert.ok(calls.docUpdates.length > 0, 'trip still ends');
  // Same as a non-admin: "1" is parsed as typed input (a stop code), not the hidden guess.
  assert.equal(calls.docUpdates[0].endStopCode, '1');
  assert.notEqual(calls.docUpdates[0].endStopName, 'College Station');
});
