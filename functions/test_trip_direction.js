/**
 * New trips store the app's direction words (db/trips.js createTrip), CIV-1458.
 * Run with: node --test test_trip_direction.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadTripsModule() {
  const tripsPath = require.resolve('./lib/db/trips');
  delete require.cache[tripsPath];
  const adds = [];
  const core = {
    db: {
      collection: (name) => ({
        add: async (data) => { adds.push({ collection: name, data }); return { id: `trip_${adds.length}` }; },
      }),
    },
    FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
    Timestamp: { fromDate: (date) => date },
  };
  const users = { getUserProfile: async () => ({ isPublic: false }) };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.id === tripsPath) {
      if (request === './core') return core;
      if (request === './users') return users;
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return { trips: require('./lib/db/trips'), adds };
  } finally {
    Module._load = originalLoad;
  }
}

async function savedDirection(direction) {
  const { trips, adds } = loadTripsModule();
  const data = { userId: 'u1', route: '510', startStopName: 'Spadina Station', agency: 'TTC' };
  if (direction !== undefined) data.direction = direction;
  await trips.createTrip(data);
  return adds[0].data;
}

test('compass words in any case are saved as the app\'s direction values', async () => {
  const cases = {
    SOUTH: 'Southbound',
    South: 'Southbound',
    NORTH: 'Northbound',
    WESTBOUND: 'Westbound',
    'EAST ': 'Eastbound',
    WB: 'Westbound',
    Eastward: 'Eastbound',
    Northbound: 'Northbound',
    counterclockwise: 'Counterclockwise',
  };
  for (const [typed, expected] of Object.entries(cases)) {
    assert.equal((await savedDirection(typed)).direction, expected, typed);
  }
});

test('text that is not a known direction is kept as typed', async () => {
  assert.equal((await savedDirection('Downtown')).direction, 'Downtown');
  assert.equal((await savedDirection('To SJ')).direction, 'To SJ');
});

test('missing or blank direction is stored as null or left out', async () => {
  assert.equal((await savedDirection(null)).direction, null);
  assert.equal((await savedDirection('   ')).direction, null);
  assert.equal('direction' in (await savedDirection(undefined)), false);
});
