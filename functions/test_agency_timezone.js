/**
 * Tests for the shared agency timezone table (constants.js AGENCY_TIMEZONE) and the timezone
 * stored on new trips (db/trips.js createTrip).
 * Run with: node test_agency_timezone.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { AGENCY_TIMEZONE, timezoneForAgency } = require('./lib/constants');
const { AGENCY_ALIASES } = require('./lib/agency-aliases');

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

// Agencies that were only in gemini.js KNOWN_AGENCY_TIMEZONES (or in neither table) before #375,
// so their trips were stored with timezone 'UTC'.
const PREVIOUSLY_MISSING = {
  'Brampton Transit': 'America/Toronto',
  'Durham Transit': 'America/Toronto',
  'HSR': 'America/Toronto',
  'GRT': 'America/Toronto',
  'OC Transpo': 'America/Toronto',
  'STM': 'America/Toronto',
  'TransLink': 'America/Vancouver',
  'NYC MTA': 'America/New_York',
  'Caltrain': 'America/Los_Angeles',
  'NFTA Metro': 'America/New_York',
  'PRT': 'America/New_York',
};

test('every canonical agency name in the alias list has a timezone', () => {
  const missing = [...new Set(Object.values(AGENCY_ALIASES))].filter(agency => !AGENCY_TIMEZONE[agency]);
  assert.deepEqual(missing, []);
});

test('every zone in the table is a valid IANA timezone', () => {
  for (const [agency, zone] of Object.entries(AGENCY_TIMEZONE)) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: zone }), agency);
  }
});

test('timezoneForAgency resolves aliases and returns null for unknown agencies', () => {
  assert.equal(timezoneForAgency('Hamilton Street Railway'), 'America/Toronto');
  assert.equal(timezoneForAgency(' caltrain '), 'America/Los_Angeles');
  assert.equal(timezoneForAgency('translink'), 'America/Vancouver');
  assert.equal(timezoneForAgency('Mystery Transit'), null);
  assert.equal(timezoneForAgency(null), null);
  assert.equal(timezoneForAgency(''), null);
});

test('a new trip for each previously missing agency stores that agency\'s zone', async () => {
  const { trips, adds } = loadTripsModule();
  for (const agency of Object.keys(PREVIOUSLY_MISSING)) {
    await trips.createTrip({ userId: 'u1', agency, route: '1', startStopName: 'Main St' });
  }
  assert.deepEqual(
    Object.fromEntries(adds.map(({ data }) => [data.agency, data.timezone])),
    PREVIOUSLY_MISSING,
  );
});

test('a new trip for an unknown agency stores no timezone (not UTC)', async () => {
  const { trips, adds } = loadTripsModule();
  await trips.createTrip({ userId: 'u1', agency: 'Mystery Transit', route: '1', startStopName: 'Main St' });
  await trips.createTrip({ userId: 'u1', agency: null, route: '1', startStopName: 'Main St' });
  for (const { data } of adds) {
    assert.equal('timezone' in data, false);
  }
});

test('lookupAgencyTimezone answers previously missing agencies from the shared table', async () => {
  const { lookupAgencyTimezone } = require('./lib/gemini');
  for (const [agency, zone] of Object.entries(PREVIOUSLY_MISSING)) {
    assert.equal(await lookupAgencyTimezone(agency), zone, agency);
  }
});
