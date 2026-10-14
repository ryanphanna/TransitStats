/**
 * Serving half of the V4/V5 end-stop feature-parity check. ml/test_feature_parity.py checks that training
 * builds the fixture's expected features; this checks serving builds the same ones from the same
 * synthetic trips, with the context derived the way handlers-trip.js derives it from history[0].
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fx = require(path.join(__dirname, '..', 'ml', 'feature_parity_fixture.json'));
const {
  buildEndStopFeatures, getHourAndDay, toFeatureVector,
  configureFromDict, resetPolicies, loadPolicies,
} = require('./lib/ml_utils');

const HIGH_IMPACT = new Set(['route', 'direction', 'agency', 'startStop', 'startStopCode', 'startStopName',
  'endStop', 'endStopCode', 'endStopName']);

// db/trips.js getRecentCompletedTrips() filter
function servesAsHistory(t) {
  if (t.incomplete || t.discarded || t.needs_review) return false;
  if (t.exclude_from_training || t.exclude_from_accuracy || t.needs_reprocess) return false;
  if ((t.correctedFields || []).some(f => HIGH_IMPACT.has(f))) return false;
  return t.stop_matched != null ? !!t.stop_matched : !!t.verified;
}

// handlers-trip.js: history = newest 100 completed trips by endTime, then filtered; context from history[0]
function servingContext(trip) {
  const now = new Date(trip.startTime);
  const history = fx.trips
    .filter(t => t.userId === trip.userId && t.endTime && new Date(t.endTime) < now)
    .sort((a, b) => new Date(b.endTime) - new Date(a.endTime))
    .slice(0, 100)
    .filter(servesAsHistory);
  const lastTrip = history[0] || null;
  const common = {
    time: now,
    lastEndStopName: lastTrip?.endStopName || lastTrip?.endStop || null,
    lastRoute: lastTrip?.route || null,
    agency: trip.agency,
    stopsLibrary: fx.stops,
    primaryAgency: fx.primaryAgency,
  };
  return {
    ...common,
    route: trip.route,
    startStopName: trip.startStopName,
    direction: trip.direction,
    minutesSinceLastTrip: lastTrip
      ? Math.max(0, Math.round((now.getTime() - new Date(lastTrip.startTime).getTime()) / 60000))
      : null,
  };
}

function nonZero(features) {
  return Object.fromEntries(Object.entries(features).filter(([, v]) => Math.abs(v) > 1e-6));
}

function assertSameFeatures(actual, expected, label) {
  const a = nonZero(actual);
  const e = nonZero(expected);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(e).sort(), `${label}: feature names differ`);
  for (const k of Object.keys(e)) {
    assert.ok(Math.abs(a[k] - e[k]) < 1e-5, `${label}: ${k} = ${a[k]}, training has ${e[k]}`);
  }
}

test('serving builds the same V4/V5 end-stop features as training (local time artifacts)', () => {
  resetPolicies();
  configureFromDict(fx.policies);
  try {
    const ids = Object.keys(fx.expected);
    assert.ok(ids.length >= 8);
    for (const id of ids) {
      const trip = fx.trips.find(t => t._id === id);
      assertSameFeatures(buildEndStopFeatures(servingContext(trip), 'local'), fx.expected[id], `${id} end stop`);
    }
  } finally {
    resetPolicies();
    loadPolicies();
  }
});

test('local time follows the agency timezone across DST; old artifacts keep UTC', () => {
  // 2026-11-01 06:30Z is 01:30 EST on Sunday (after the fall-back), 02:30 EDT would be wrong.
  assert.deepEqual(getHourAndDay(new Date('2026-11-01T06:30:00Z'), 'TTC', 'local'), { hour: 1, pyDay: 6 });
  // 2026-07-01 03:00Z is still Tuesday 23:00 in Toronto, Tuesday 20:00 in LA.
  assert.deepEqual(getHourAndDay(new Date('2026-07-01T03:00:00Z'), 'TTC', 'local'), { hour: 23, pyDay: 1 });
  assert.deepEqual(getHourAndDay(new Date('2026-07-01T03:00:00Z'), 'LA Metro', 'local'), { hour: 20, pyDay: 1 });
  // Unmapped agencies fall back to Toronto, like trips stored with timezone 'UTC'.
  assert.deepEqual(getHourAndDay(new Date('2026-07-01T04:00:00Z'), 'Nowhere Transit', 'local'), { hour: 0, pyDay: 2 });
  // Midnight is hour 0, never 24.
  assert.equal(getHourAndDay(new Date('2026-07-01T04:00:00Z'), 'TTC', 'local').hour, 0);
  // Artifacts without time_basis were trained on UTC hours.
  assert.deepEqual(getHourAndDay(new Date('2026-07-01T03:00:00Z'), 'TTC', undefined), { hour: 3, pyDay: 2 });
});

test('toFeatureVector places named features in artifact order', () => {
  const x = toFeatureVector({ b: 2, a: 1, zz: 9 }, ['a', 'b', 'c'], Float32Array);
  assert.ok(x instanceof Float32Array);
  assert.deepEqual(Array.from(x), [1, 2, 0]);
});
