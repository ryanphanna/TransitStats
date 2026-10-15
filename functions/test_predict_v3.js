const test = require('node:test');
const assert = require('node:assert');
const { PredictionEngineV3: V3 } = require('./lib/predict_v3');

const NOW = new Date('2026-09-15T13:00:00Z');

function trip(route, startStopName, endStopName, { direction = null, agency = 'TTC', daysAgo = 1 } = {}) {
  const startTime = new Date(NOW.getTime() - daysAgo * 86400000);
  const endTime = new Date(startTime.getTime() + 600000);
  return { route, startStopName, endStopName, direction, agency, startTime, endTime };
}

const at = (route, startStopName, extra = {}) => ({ route, startStopName, time: NOW, agency: 'TTC', ...extra });

function withConfig(overrides, fn) {
  const saved = { ...V3.CONFIG };
  Object.assign(V3.CONFIG, overrides);
  try { return fn(); } finally { V3.CONFIG = saved; }
}

test.beforeEach(() => {
  V3.stopsLibrary = [];
  V3.networkGraph = null;
});

test('library stop names with a direction word are valid history', () => {
  V3.stopsLibrary = [{ name: 'Sample Ave Northbound Platform', aliases: [] }];
  assert.equal(V3._isValidTrip(trip('99', 'Sample Ave Northbound Platform', 'Elm St')), true);
  // A sentence-like parse that is not a library stop is still rejected.
  assert.equal(V3._isValidTrip(trip('99', 'heading northbound on 99', 'Elm St')), false);

  const history = [1, 2, 3].map(d => trip('99', 'Sample Ave Northbound Platform', 'Elm St', { daysAgo: d }));
  const top = V3.guessTopEndStops(history, at('99', 'Sample Ave Northbound Platform'));
  assert.equal(top[0].stop, 'Elm St');
  assert.equal(top[0].tier, 'exact');
});

test('exact-tier predictions are identical with and without backoff', () => {
  const history = [
    trip('99', 'Oak St', 'Elm St', { daysAgo: 1 }),
    trip('99', 'Oak St', 'Elm St', { daysAgo: 2 }),
    trip('99', 'Oak St', 'Pine St', { daysAgo: 3 }),
    trip('99', 'Birch St', 'Cedar St', { daysAgo: 1 }),
  ];
  const ctx = at('99', 'Oak St');
  const withBackoff = V3.guessTopEndStops(history, ctx, 3);
  const without = withConfig({ BACKOFF: false }, () => V3.guessTopEndStops(history, ctx, 3));
  assert.deepStrictEqual(withBackoff, without);
  assert.deepStrictEqual(withBackoff.map(p => p.stop), ['Elm St', 'Pine St']);
  assert.ok(withBackoff.every(p => p.tier === 'exact'));
});

test('route backoff fills in when the boarding stop is new, never predicting the boarding stop', () => {
  const history = [
    trip('99', 'Oak St', 'Elm St', { daysAgo: 1 }),
    trip('99', 'Oak St', 'Elm St', { daysAgo: 2 }),
    trip('99', 'Pine St', 'Maple St', { daysAgo: 3 }),
    trip('99', 'Birch St', 'Willow St', { daysAgo: 1 }),
  ];
  const top = V3.guessTopEndStops(history, at('99', 'Maple St'), 3);
  assert.equal(top[0].stop, 'Elm St');
  assert.equal(top[0].tier, 'route');
  assert.ok(top[0].confidence <= Math.round(100 * V3.CONFIG.BACKOFF_CONFIDENCE.route));
  assert.ok(!top.some(p => p.stop === 'Maple St'));
  assert.deepStrictEqual(withConfig({ BACKOFF: false }, () => V3.guessTopEndStops(history, at('99', 'Maple St'))), []);
});

test('stop backoff uses other routes from the same boarding stop, then the agency', () => {
  const history = [
    trip('77', 'Oak St', 'Elm St', { daysAgo: 1 }),
    trip('55', 'Birch St', 'Cedar St', { daysAgo: 1 }),
    trip('55', 'Birch St', 'Cedar St', { daysAgo: 2 }),
    trip('55', 'Birch St', 'Spruce St', { agency: 'Other', daysAgo: 1 }),
  ];
  const stopTier = V3.guessTopEndStops(history, at('99', 'Oak St'));
  assert.equal(stopTier[0].stop, 'Elm St');
  assert.equal(stopTier[0].tier, 'stop');

  const agencyTier = V3.guessTopEndStops(history, at('99', 'Ash St'), 3);
  assert.equal(agencyTier[0].stop, 'Cedar St');
  assert.equal(agencyTier[0].tier, 'agency');
  assert.ok(!agencyTier.some(p => p.stop === 'Spruce St'), 'other agencies never vote');
});

test('backoff tiers respect subway topology', () => {
  // Line 2 eastbound from Royal York: Islington is behind the rider, High Park is ahead.
  const history = [
    ...[1, 2, 3, 4, 5].map(d => trip('2', 'Kipling', 'Islington', { direction: 'Eastbound', daysAgo: d })),
    trip('2', 'Kipling', 'High Park', { direction: 'Eastbound', daysAgo: 6 }),
  ];
  const top = V3.guessTopEndStops(history, at('2', 'Royal York', { direction: 'Eastbound' }), 3);
  assert.deepStrictEqual(top.map(p => p.stop), ['High Park']);
  assert.equal(top[0].tier, 'route');
});

test('exact candidates emptied by topology fall through to a legal backoff tier', () => {
  const history = [
    ...[1, 2, 3].map(d => trip('2', 'Royal York', 'Islington', { direction: 'Eastbound', daysAgo: d })),
    trip('2', 'Kipling', 'Jane', { direction: 'Eastbound', daysAgo: 4 }),
  ];
  const top = V3.guessTopEndStops(history, at('2', 'Royal York', { direction: 'Eastbound' }), 3);
  assert.deepStrictEqual(top.map(p => p.stop), ['Jane']);
  assert.equal(top[0].tier, 'route');
});

test('stop canonicalization follows the current stops library', () => {
  V3.stopsLibrary = [{ name: 'Union Station', aliases: ['Union Stn'] }, { name: 'Other', aliases: ['Union Stn'] }];
  assert.equal(V3._canonicalizeStop('Union Stn'), 'union station', 'first library entry wins');
  assert.equal(V3._canonicalizeStop('Queen St & Spadina Ave'), 'queen st/spadina ave');
  V3.stopsLibrary = [{ name: 'Union', aliases: ['Union Stn'] }];
  assert.equal(V3._canonicalizeStop('Union Stn'), 'union', 'index rebuilds when the library is replaced');
  V3.stopsLibrary = [];
  assert.equal(V3._canonicalizeStop('Union Stn'), 'union stn');
});
