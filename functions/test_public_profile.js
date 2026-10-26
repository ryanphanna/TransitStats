/**
 * Unit tests for the public profile HTTP endpoint (functions/lib/public-profile.js).
 * Run with: node test_public_profile.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadPublicProfile(overrides = {}) {
  const modulePath = require.resolve('./lib/public-profile');
  delete require.cache[modulePath];

  const dbModule = {
    db: {
      collection: (name) => ({
        doc: (id) => ({
          get: async () => (overrides.docs?.[name]?.[id] ?? { exists: false }),
        }),
        where: () => {
          const query = {
            where: () => query,
            limit: () => query,
            get: async () => {
              if (overrides[`${name}Snap`]) return overrides[`${name}Snap`];
              if (name === 'trips') return overrides.tripsSnap ?? { size: 0, forEach: () => {}, docs: [] };
              return { size: 0, docs: [] };
            },
          };
          return query;
        },
        get: async () => (overrides.stopsSnap ?? { size: 0, docs: [] }),
      }),
    },
    getUserProfile: async () => overrides.profile ?? null,
    getStopsLibrary: async () => (overrides.stopsSnap ?? { docs: [] }).docs.map(doc => doc.data()),
    ...overrides.dbModule,
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.id === modulePath) {
      if (request === './db') return dbModule;
      if (request === './logger') return { error: () => {}, info: () => {}, warn: () => {} };
      if (request === 'firebase-functions/v2/https') {
        return { onRequest: (_opts, handler) => handler };
      }
    }
    return originalLoad(request, parent, isMain);
  };

  let mod;
  try {
    mod = require('./lib/public-profile');
  } finally {
    Module._load = originalLoad;
  }
  return mod.publicProfile; // the raw handler, thanks to the onRequest stub
}

function mockRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.send = (body) => { res.body = body; return res; };
  return res;
}

test('publicProfile handles OPTIONS preflight with 204', async () => {
  const handler = loadPublicProfile();
  const res = mockRes();
  await handler({ method: 'OPTIONS', query: {} }, res);
  assert.equal(res.statusCode, 204);
});

test('publicProfile returns 400 when user query param is missing', async () => {
  const handler = loadPublicProfile();
  const res = mockRes();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 400);
});

test('publicProfile returns 404 when username is not found', async () => {
  const handler = loadPublicProfile({ docs: { usernames: {} } });
  const res = mockRes();
  await handler({ method: 'GET', query: { user: 'nobody' } }, res);
  assert.equal(res.statusCode, 404);
});

test('publicProfile returns 403 when profile is not public', async () => {
  const handler = loadPublicProfile({
    docs: { usernames: { 'subway-subway-subway': { exists: true, data: () => ({ uid: 'u1' }) } } },
    profile: { isPublic: false },
  });
  const res = mockRes();
  await handler({ method: 'GET', query: { user: 'subway-subway-subway' } }, res);
  assert.equal(res.statusCode, 403);
});

test('publicProfile returns 200 for any public profile, not just the beta account', async () => {
  const handler = loadPublicProfile({
    docs: { usernames: { r: { exists: true, data: () => ({ uid: 'u1' }) } } },
    profile: { isPublic: true, username: 'r' },
  });
  const res = mockRes();
  await handler({ method: 'GET', query: { user: 'r' } }, res);
  assert.equal(res.statusCode, 200);
});

test('publicProfile returns 200 with aggregated stats for a public profile', async () => {
  const tripDocs = [
    { data: () => ({ duration: 10, startTime: new Date(Date.now() - 7 * 60 * 60 * 1000), startStopName: 'Start', endStopName: 'End', boardingLocation: { lat: 1, lng: 2 }, exitLocation: { lat: 3, lng: 4 } }) },
  ];
  const handler = loadPublicProfile({
    docs: { usernames: { 'subway-subway-subway': { exists: true, data: () => ({ uid: 'u1' }) }, r: { exists: true, data: () => ({ uid: 'u1' }) } } },
    profile: {
      isPublic: true,
      displayName: 'Alice',
      username: 'r',
      emojiUsername: 'subway-subway-subway',
      usernameAliases: ['subway-subway-subway'],
      defaultAgency: 'TTC',
      mapStopMode: 'exiting',
    },
    tripsSnap: { size: 1, forEach: (fn) => tripDocs.forEach(fn) },
  });
  const res = mockRes();
  await handler({ method: 'GET', query: { user: 'subway-subway-subway' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totalTrips, 1);
  assert.equal(res.body.routes, 0);
  assert.equal(res.body.totalHours, Math.round((10 / 60) * 10) / 10);
  assert.equal(res.body.thisMonth, 1);
  assert.equal(res.body.thisWeek, 1);
  assert.equal(res.body.points.length, 2);
  assert.equal('names' in res.body.points[0], false);
  assert.equal(res.body.displayName, 'Alice');
  assert.equal(res.body.canonicalUsername, 'r');
  assert.equal(res.body.mapStopMode, 'exiting');
});

test('publicProfile resolves missing trip coordinates from the stop library', async () => {
  const handler = loadPublicProfile({
    docs: { usernames: { r: { exists: true, data: () => ({ uid: 'u1' }) } } },
    profile: { isPublic: true, username: 'r', emojiUsername: 'subway-subway-subway' },
    tripsSnap: {
      size: 1,
      forEach: (fn) => fn({ data: () => ({ agency: 'STM', startTime: new Date(Date.now() - 7 * 60 * 60 * 1000), startStopName: 'Berri-UQAM', endStopName: 'Lionel-Groulx' }) }),
    },
    stopsSnap: {
      docs: [
        { data: () => ({ name: 'Berri-UQAM', agencies: ['STM'], lat: 45.5152, lng: -73.5618 }) },
        { data: () => ({ name: 'Lionel-Groulx', agencies: ['STM'], lat: 45.4827, lng: -73.5802 }) },
      ],
    },
  });
  const res = mockRes();
  await handler({ method: 'GET', query: { user: 'r' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.points.map(point => [point.lat, point.lng]), [
    [45.5152, -73.5618],
    [45.4827, -73.5802],
  ]);
});

test('publicProfile includes uniquely matched PRESTO activity for beta pilots', async () => {
  const handler = loadPublicProfile({
    docs: { usernames: { 'train-taco-panda': { exists: true, data: () => ({ uid: 'u1' }) } } },
    profile: {
      isPublic: true,
      displayName: 'Test',
      username: 'train-taco-panda',
      emojiUsername: 'subway-subway-subway',
    },
    tripsSnap: { size: 0, forEach: () => {} },
    prestoTransactionsSnap: {
      size: 1,
      docs: [{ data: () => ({
        type: 'fare_payment',
        agency: 'GO Transit',
        locationLabel: 'Union Station Bus Terminal',
        occurredAtSortKey: Date.UTC(2026, 0, 2),
      }) }],
    },
    stopsSnap: {
      size: 1,
      docs: [{ data: () => ({
        agency: 'GO Transit',
        name: 'Union Station Bus Terminal',
        code: '102300',
        lat: 43.644,
        lng: -79.377,
      }) }],
    },
  });
  const res = mockRes();
  await handler({ method: 'GET', query: { user: 'train-taco-panda' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.displayName, 'Test');
  assert.equal(res.body.totalTrips, 1);
  assert.equal(res.body.points.length, 1);
  assert.deepEqual(res.body.points[0].names, ['Union Station Bus Terminal']);
});

test('publicProfile pairs GO tap-in/tap-out rows into one trip with boarding and exit points', async () => {
  const handler = loadPublicProfile({
    docs: { usernames: { 'train-taco-panda': { exists: true, data: () => ({ uid: 'u1' }) } } },
    profile: {
      isPublic: true,
      displayName: 'Test',
      username: 'train-taco-panda',
      emojiUsername: 'subway-subway-subway',
    },
    tripsSnap: { size: 0, forEach: () => {} },
    prestoTransactionsSnap: {
      size: 2,
      docs: [
        { data: () => ({
          type: 'fare_payment',
          agency: 'GO Transit',
          locationLabel: 'Union Station Bus Terminal',
          occurredAtSortKey: Date.now() - 7 * 60 * 60 * 1000,
        }) },
        { data: () => ({
          type: 'fare_payment',
          agency: 'GO Transit',
          locationLabel: 'Oakville GO Station Rail',
          occurredAtSortKey: Date.now() - 6 * 60 * 60 * 1000,
        }) },
      ],
    },
    stopsSnap: {
      size: 2,
      docs: [
        { data: () => ({ agency: 'GO Transit', name: 'Union Station Bus Terminal', code: '102300', lat: 43.644, lng: -79.377 }) },
        { data: () => ({ agency: 'GO Transit', name: 'Oakville GO Station Rail', code: '102400', lat: 43.451, lng: -79.688 }) },
      ],
    },
  });
  const res = mockRes();
  await handler({ method: 'GET', query: { user: 'train-taco-panda' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totalTrips, 1);
  assert.equal(res.body.thisMonth, 1);
  assert.equal(res.body.points.length, 2);
  assert.deepEqual(res.body.points.map(point => point.type).sort(), ['end', 'start']);
});

test('publicProfile does not double count a PRESTO ride the user also logged as a trip', async () => {
  const loggedStart = new Date('2026-01-02T13:05:00Z'); // 8:05 Toronto
  const handler = loadPublicProfile({
    docs: { usernames: { 'train-taco-panda': { exists: true, data: () => ({ uid: 'u1' }) } } },
    profile: { isPublic: true, displayName: 'Test', username: 'train-taco-panda', emojiUsername: 'subway-subway-subway' },
    tripsSnap: {
      size: 1,
      forEach: (fn) => fn({ data: () => ({
        userId: 'u1',
        agency: 'TTC',
        startTime: { toDate: () => loggedStart },
        endTime: { toDate: () => new Date('2026-01-02T13:25:00Z') },
        duration: 20,
      }) }),
    },
    prestoTransactionsSnap: {
      size: 2,
      docs: [
        // Same ride as the logged trip (8:00 Toronto wall clock, same agency).
        { data: () => ({ type: 'fare_payment', agency: 'TTC', locationLabel: 'A', occurredAtSortKey: Date.UTC(2026, 0, 2, 8, 0) }) },
        // A different ride that only PRESTO knows about.
        { data: () => ({ type: 'fare_payment', agency: 'TTC', locationLabel: 'B', occurredAtSortKey: Date.UTC(2026, 0, 2, 18, 0) }) },
      ],
    },
    stopsSnap: { size: 0, docs: [] },
  });
  const res = mockRes();
  await handler({ method: 'GET', query: { user: 'train-taco-panda' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totalTrips, 2);
});

test('publicProfile returns 500 and does not leak internal error detail on unexpected failure', async () => {
  const handler = loadPublicProfile({
    dbModule: { db: { collection: () => { throw new Error('db down'); } } },
  });
  const res = mockRes();
  await handler({ method: 'GET', query: { user: 'alice' } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Internal error');
});

test('publicProfile never reports a username another account owns', async () => {
  const handler = loadPublicProfile({
    docs: { usernames: {
      mine: { exists: true, data: () => ({ uid: 'u1' }) },
      victim: { exists: true, data: () => ({ uid: 'u2' }) },
    } },
    profile: { isPublic: true, username: 'victim' },
  });
  const res = mockRes();
  await handler({ method: 'GET', query: { user: 'mine' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.canonicalUsername, 'mine');
  assert.equal(res.body.username, 'mine');
});

test('publicProfile ignores a claimed username that is not registered', async () => {
  const handler = loadPublicProfile({
    docs: { usernames: { mine: { exists: true, data: () => ({ uid: 'u1' }) } } },
    profile: { isPublic: true, username: 'nobody-owns-this' },
  });
  const res = mockRes();
  await handler({ method: 'GET', query: { user: 'mine' } }, res);
  assert.equal(res.body.canonicalUsername, 'mine');
});

test('publicProfile counts days in the trip timezone and agencies/routes like the dashboard', async () => {
  // 9:00 PM Toronto on Oct 20 is 1:00 AM UTC on Oct 21; the 8:00 AM ride is Oct 21.
  const tripDocs = [
    { agency: 'TTC', route: '501', duration: 30, startTime: new Date('2026-10-21T01:00:00Z'), endTime: new Date('2026-10-21T01:30:00Z'), timezone: 'America/Toronto' },
    { agency: 'ttc', route: '501', duration: 30, startTime: new Date('2026-10-21T12:00:00Z'), endTime: new Date('2026-10-21T12:30:00Z') },
    { agency: 'TTC', route: '504a', duration: 30, startTime: new Date('2026-10-21T13:00:00Z'), endTime: new Date('2026-10-21T13:30:00Z'), timezone: 'America/Toronto' },
  ].map(trip => ({ data: () => trip }));
  const handler = loadPublicProfile({
    docs: { usernames: { r: { exists: true, data: () => ({ uid: 'u1' }) } } },
    profile: { isPublic: true, username: 'r' },
    tripsSnap: { size: tripDocs.length, forEach: (fn) => tripDocs.forEach(fn) },
  });
  const res = mockRes();
  await handler({ method: 'GET', query: { user: 'r', includePoints: '0' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totalTrips, 3);
  assert.equal(res.body.daysRidden, 2);
  assert.equal(res.body.agencies, 2);
  assert.equal(res.body.routes, 2);
  assert.equal(res.body.countries, 1);
  assert.equal(res.body.totalHours, 1.5);
});
