/**
 * Tests for route-aware stop lookup in db/stops.
 * Run with: node test_stops.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadStopsModule({ stops = [], stopRoutes = {}, failQueries = false, scans = [], writes = [], createError = null } = {}) {
  const stopsPath = require.resolve('./lib/db/stops');
  delete require.cache[stopsPath];

  const wrapDoc = (id, data) => ({
    id,
    data: () => data,
    ref: { update: async () => {} },
  });

  const fakeDb = {
    collection(name) {
      if (name === 'stops') {
        return {
          doc(id) {
            return {
              set: async (data, opts) => { writes.push({ op: 'set', id, data, opts }); },
              create: async (data) => { if (createError) throw createError; writes.push({ op: 'create', id, data }); },
              update: async (data) => { writes.push({ op: 'update', id, data }); },
            };
          },
          where(field, op, value) {
            if (field === 'agencies' && op === 'array-contains') {
              const docs = stops
                .filter(s => Array.isArray(s.data.agencies) && s.data.agencies.includes(value))
                .map(s => wrapDoc(s.id, s.data));
              return {
                // code lookup: .where('agencies', ...).where('code', '==', x).limit(1).get()
                where(field2, op2, value2) {
                  const byCode = docs.filter(d => d.data()[field2] === value2);
                  return { limit: () => ({ get: async () => ({ docs: byCode, empty: byCode.length === 0 }) }) };
                },
                get: async () => { if (failQueries) throw new Error('unavailable'); return { docs, empty: docs.length === 0 }; },
              };
            }
            throw new Error(`Unexpected stops.where: ${field} ${op}`);
          },
          get: async () => { scans.push('stops'); return { docs: stops.map(s => wrapDoc(s.id, s.data)) }; },
        };
      }

      if (name === 'stopRoutes') {
        return {
          doc(docId) {
            const routes = stopRoutes[docId];
            return {
              get: async () => ({
                exists: Array.isArray(routes),
                data: () => ({ routes: routes || [] }),
              }),
            };
          },
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.id === stopsPath) {
      if (request === './core') return { db: fakeDb, FieldValue: { arrayUnion: (...v) => ({ _op: 'arrayUnion', values: v }) } };
      if (request === '../constants') return { AGENCY_CITY: { TTC: 'Toronto' } };
      if (request === 'firebase-admin') {
        return {
          firestore: {
            FieldValue: { arrayUnion: (...v) => ({ _op: 'arrayUnion', values: v }) },
          },
        };
      }
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    return require('./lib/db/stops');
  } finally {
    Module._load = originalLoad;
  }
}

test('lookupStop: prefers candidate whose stopRoutes serves the requested route', async () => {
  const { lookupStop } = loadStopsModule({
    stops: [
      {
        id: 's_2070',
        data: { agencies: ['TTC'], code: '2070', name: 'Grove / Juniper', aliases: [] },
      },
      {
        id: 's_5360',
        data: { agencies: ['TTC'], code: '5360', name: 'Grove / Juniper', aliases: [] },
      },
    ],
    stopRoutes: {
      TTC_2070: ['929'],
      TTC_5360: ['52', '52B'],
    },
  });

  const result = await lookupStop(null, 'Grove / Juniper', 'TTC', '52B');
  assert.ok(result);
  assert.equal(result.stopCode, '5360');
});

test('lookupStop: uses transfer complex plus direction to resolve a generic stop name', async () => {
  const { lookupStop } = loadStopsModule({
    stops: [
      {
        id: 'line1_college',
        data: { agencies: ['TTC'], code: '9001', name: 'College', aliases: ['College Station'] },
      },
      {
        id: 'ttc_760',
        data: { agencies: ['TTC'], code: '760', name: 'College Station', aliases: ['College / Yonge'], direction: 'Westbound' },
      },
      {
        id: 'ttc_761',
        data: { agencies: ['TTC'], code: '761', name: 'College Station', aliases: ['College / Yonge'], direction: 'Eastbound' },
      },
    ],
    stopRoutes: {
      TTC_9001: ['1'],
      TTC_760: ['506'],
      TTC_761: ['506'],
    },
  });

  const result = await lookupStop(null, 'College', 'TTC', '506', 'Westbound');
  assert.ok(result);
  assert.equal(result.stopCode, '760');
});

test('lookupStop: generic subway stop still resolves to the line stop', async () => {
  const { lookupStop } = loadStopsModule({
    stops: [
      {
        id: 'line1_college',
        data: { agencies: ['TTC'], code: '9001', name: 'College', aliases: ['College Station'] },
      },
      {
        id: 'ttc_760',
        data: { agencies: ['TTC'], code: '760', name: 'College Station', aliases: ['College / Yonge'], direction: 'Westbound' },
      },
    ],
    stopRoutes: {
      TTC_9001: ['1'],
      TTC_760: ['506'],
    },
  });

  const result = await lookupStop(null, 'College', 'TTC', '1', 'Northbound');
  assert.ok(result);
  assert.equal(result.stopCode, '9001');
});

test('lookupStop: direction in a platform name resolves over a generic station', async () => {
  const { lookupStop } = loadStopsModule({
    stops: [
      {
        id: 'ttc_college_nb_platform',
        data: {
          agencies: ['TTC'],
          code: '9001-N',
          name: 'College Station - Northbound Platform',
          aliases: ['College'],
        },
      },
      {
        id: 'ttc_college_station',
        data: {
          agencies: ['TTC'],
          code: '9001',
          name: 'College Station',
          aliases: ['College'],
        },
      },
    ],
    stopRoutes: {
      'TTC_9001-N': ['1'],
      TTC_9001: ['1'],
    },
  });

  const result = await lookupStop(null, 'College', 'TTC', '1', 'Northbound');
  assert.ok(result);
  assert.equal(result.stopCode, '9001-N');
});

test('lookupStop: punctuation-only duplicate names resolve to one stop', async () => {
  const { lookupStop } = loadStopsModule({
    stops: [
      {
        id: 'ttc_st_clair_spaced',
        data: { agencies: ['TTC'], code: '1001', name: 'St Clair West Station', aliases: ['St Clair West'] },
      },
      {
        id: 'ttc_st_clair_punctuated',
        data: { agencies: ['TTC'], code: '1002', name: 'St.Clair West Station', aliases: ['St Clair West'] },
      },
    ],
    stopRoutes: {
      TTC_1001: ['1'],
      TTC_1002: ['1'],
    },
  });

  const result = await lookupStop(null, 'St Clair West', 'TTC', '1', 'Southbound');
  assert.ok(result);
  assert.ok(['1001', '1002'].includes(result.stopCode));
});

test('lookupStop: returns null when multiple same-name candidates are unconfirmed for route', async () => {
  const { lookupStop } = loadStopsModule({
    stops: [
      {
        id: 's_a',
        data: { agencies: ['TTC'], code: '1000', name: 'Main / King', aliases: [] },
      },
      {
        id: 's_b',
        data: { agencies: ['TTC'], code: '1001', name: 'Main / King', aliases: [] },
      },
    ],
    stopRoutes: {
      TTC_1000: ['1'],
      TTC_1001: ['2'],
    },
  });

  const result = await lookupStop(null, 'Main / King', 'TTC', '999');
  assert.equal(result, null);
});

test('lookupStop: transfer-complex ambiguity stays unresolved without direction', async () => {
  const { lookupStop } = loadStopsModule({
    stops: [
      {
        id: 'ttc_760',
        data: { agencies: ['TTC'], code: '760', name: 'College Station', aliases: ['College / Yonge'], direction: 'Westbound' },
      },
      {
        id: 'ttc_761',
        data: { agencies: ['TTC'], code: '761', name: 'College Station', aliases: ['College / Yonge'], direction: 'Eastbound' },
      },
    ],
    stopRoutes: {
      TTC_760: ['506'],
      TTC_761: ['506'],
    },
  });

  const result = await lookupStop(null, 'College', 'TTC', '506');
  assert.equal(result, null);
});

test('lookupStop: a station name finds its platform record and its parent as one stop', async () => {
  const { lookupStop } = loadStopsModule({
    stops: [
      { id: 'ttc_main_nb', data: { agencies: ['TTC'], code: '5001-N', name: 'Main Street Station - Northbound Platform', aliases: [] } },
      { id: 'ttc_main', data: { agencies: ['TTC'], code: '5001', name: 'Main Street Station', aliases: [] } },
    ],
    stopRoutes: { TTC_5001: ['2'], 'TTC_5001-N': ['2'] },
  });

  const result = await lookupStop(null, 'Main Street Station', 'TTC', '2');
  assert.ok(result, 'platform + parent should resolve to one stop, not stay ambiguous');
  assert.equal(result.stopCode, '5001');
});

test('lookupStop: a station typed with different punctuation still matches', async () => {
  const { lookupStop } = loadStopsModule({
    stops: [{ id: 'ttc_stg', data: { agencies: ['TTC'], code: '88', name: 'St. George Station', aliases: [] } }],
    stopRoutes: { TTC_88: ['1'] },
  });
  const result = await lookupStop(null, 'St George Station', 'TTC', '1');
  assert.equal(result?.stopCode, '88');
});

test('lookupStop: genuinely different stops that share a prefix are not matched', async () => {
  const { lookupStop } = loadStopsModule({
    stops: [{ id: 'ttc_cp', data: { agencies: ['TTC'], code: '12', name: 'College Park Station', aliases: [] } }],
    stopRoutes: { TTC_12: ['1'] },
  });
  assert.equal(await lookupStop(null, 'College Station', 'TTC', '1'), null);
});

test('lookupStopCheck: reports found / notFound / error and never mistakes an error for a missing stop', async () => {
  const stops = [{ id: 'ttc_88', data: { agencies: ['TTC'], code: '88', name: 'Main Station', aliases: [] } }];
  const ok = loadStopsModule({ stops, stopRoutes: { TTC_88: ['1'] } });
  assert.equal((await ok.lookupStopCheck(null, 'Main Station', 'TTC', '1')).status, 'found');
  assert.equal((await ok.lookupStopCheck(null, 'Nowhere Station', 'TTC', '1')).status, 'notFound');
  const broken = loadStopsModule({ stops, failQueries: true });
  assert.equal((await broken.lookupStopCheck(null, 'Main Station', 'TTC', '1')).status, 'error');
});

test('lookupStopCheck: no whole-collection scan (lookupStop still does one for other-agency stops)', async () => {
  const scans = [];
  const stops = [{ id: 'go_1', data: { agencies: ['GO Transit'], agency: 'GO Transit', code: '1', name: 'Zzyzx Terminal', aliases: [] } }];
  const m = loadStopsModule({ stops, scans });
  assert.equal((await m.lookupStopCheck(null, 'Zzyzx Terminal', 'TTC', '1')).status, 'notFound');
  assert.equal(scans.length, 0);
});

test('lookupStop: a platform asked for by its full name never resolves to its opposite-direction twin', async () => {
  const m = loadStopsModule({
    stops: [
      { id: 'sb', data: { agencies: ['TTC'], code: '9001-S', name: 'College Station - Southbound Platform', aliases: [] } },
      { id: 'nb', data: { agencies: ['TTC'], code: '9001-N', name: 'College Station - Northbound Platform', aliases: [] } },
    ],
    stopRoutes: { 'TTC_9001-N': ['1'], 'TTC_9001-S': ['1'] },
  });
  const result = await m.lookupStop(null, 'College Station - Northbound Platform', 'TTC', '1', 'Northbound');
  assert.equal(result?.stopCode, '9001-N');
  const southbound = await m.lookupStop(null, 'College Station - Southbound Platform', 'TTC', '1');
  assert.equal(southbound?.stopCode, '9001-S');
});

// --- Atlas fallback for stop codes missing from the library ---

function stubAtlas({ directory, metas, metaStatus = 200 } = {}) {
  const original = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/atlas/agencies.json')) return { ok: true, status: 200, json: async () => ({ agencies: directory }) };
    const slug = String(url).match(/atlas\/([^/]+)-stops-meta\.json/)?.[1];
    if (metaStatus !== 200) return { ok: false, status: metaStatus, json: async () => ({}) };
    if (metas[slug]) return { ok: true, status: 200, json: async () => ({ stops: metas[slug] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return () => { global.fetch = original; };
}

const ATLAS_DIRECTORY = [
  { slug: 'ttc', name: 'Toronto Transit Commission' },
  { slug: 'port-authority-pa', name: 'Pittsburgh Regional Transit' },
  { slug: 'bart', name: 'Bay Area Rapid Transit (BART)' },
];

test('lookupStop: an unknown stop code is found in the agency\'s Atlas stops-meta and added to the library', async () => {
  const restore = stubAtlas({
    directory: ATLAS_DIRECTORY,
    metas: { ttc: [{ code: '14444', name: 'Spadina Station', routes: ['1'], direction: 'Northbound', lat: 43.667, lon: -79.404 }] },
  });
  try {
    const writes = [];
    const m = loadStopsModule({ stops: [], writes });
    const result = await m.lookupStop('14444', null, 'TTC', '1');
    assert.equal(result?.stopCode, '14444');
    assert.equal(result.stopName, 'Spadina Station');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].op, 'create'); // never set/merge: an existing doc can't be overwritten
    assert.deepEqual(writes[0].data.agencies, ['TTC']);
    assert.equal(writes[0].data.source, 'atlas');
  } finally { restore(); }
});

test('lookupStop: Atlas lookup stays inside the trip\'s agency (a TTC code is not matched against PRT)', async () => {
  const restore = stubAtlas({
    directory: ATLAS_DIRECTORY,
    metas: { 'port-authority-pa': [{ code: '55555', name: 'STEEL PLAZA STATION', routes: ['RED'] }], ttc: [] },
  });
  try {
    const m = loadStopsModule({ stops: [] });
    assert.equal(await m.lookupStop('55555', null, 'TTC', '1'), null);
    const pitt = await m.lookupStop('55555', null, 'PRT', 'RED');
    assert.equal(pitt?.stopCode, '55555');
  } finally { restore(); }
});

test('lookupStopCheck: finds the Atlas stop without writing, and an Atlas outage is an error, not "not found"', async () => {
  let restore = stubAtlas({ directory: ATLAS_DIRECTORY, metas: { ttc: [{ code: '14444', name: 'Spadina Station', routes: ['1'] }] } });
  try {
    const writes = [];
    const m = loadStopsModule({ stops: [], writes });
    assert.equal((await m.lookupStopCheck('14444', null, 'TTC', '1')).status, 'found');
    assert.equal(writes.length, 0);
    assert.equal((await m.lookupStopCheck('99999', null, 'TTC', '1')).status, 'notFound');
  } finally { restore(); }
  restore = stubAtlas({ directory: ATLAS_DIRECTORY, metas: {}, metaStatus: 500 });
  try {
    const m = loadStopsModule({ stops: [] });
    assert.equal((await m.lookupStopCheck('31313', null, 'BART', 'RED')).status, 'error');
  } finally { restore(); }
});

test('lookupStop: a code the library already has never calls Atlas', async () => {
  let calls = 0;
  const original = global.fetch;
  global.fetch = async () => { calls += 1; return { ok: false, status: 500 }; };
  try {
    const m = loadStopsModule({ stops: [{ id: 'ttc_1', data: { agencies: ['TTC'], code: '1', name: 'Known', aliases: [] } }] });
    assert.equal((await m.lookupStop('1', null, 'TTC', '1')).stopCode, '1');
    assert.equal(calls, 0);
  } finally { global.fetch = original; }
});

test('lookupStop: if the Atlas stop doc already exists, only this agency label is unioned in', async () => {
  const restore = stubAtlas({ directory: ATLAS_DIRECTORY, metas: { ttc: [{ code: '14444', name: 'Renamed By Atlas', routes: ['9'] }] } });
  try {
    const writes = [];
    const m = loadStopsModule({ stops: [], writes, createError: Object.assign(new Error('6 ALREADY_EXISTS'), { code: 6 }) });
    const result = await m.lookupStop('14444', null, 'TTC', '1');
    assert.equal(result?.stopCode, '14444');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].op, 'update');
    assert.deepEqual(Object.keys(writes[0].data).sort(), ['agencies', 'updatedAt']); // name, routes, aliases, createdAt untouched
  } finally { restore(); }
});

test('lookupStop: a code the library has under another label of the agency is found there, not re-created from Atlas', async () => {
  let fetches = 0;
  const original = global.fetch;
  global.fetch = async () => { fetches += 1; return { ok: false, status: 500 }; };
  try {
    const writes = [];
    const m = loadStopsModule({
      stops: [{ id: 'go_un', data: { agencies: ['GO'], code: 'UN', name: 'Union Station GO', aliases: [] } }],
      writes,
    });
    const result = await m.lookupStop('UN', null, 'GO Transit', 'LW');
    assert.equal(result?.stopCode, 'UN');
    assert.equal(fetches, 0);
    assert.equal(writes.filter(w => w.op === 'create').length, 0);
  } finally { global.fetch = original; }
});

test('lookupStopCheck: { atlas: false } never consults Atlas', async () => {
  let fetches = 0;
  const original = global.fetch;
  global.fetch = async () => { fetches += 1; return { ok: false, status: 500 }; };
  try {
    const m = loadStopsModule({ stops: [] });
    assert.equal((await m.lookupStopCheck('777777', null, 'TTC', '1', null, { atlas: false })).status, 'notFound');
    assert.equal(fetches, 0);
  } finally { global.fetch = original; }
});
