/**
 * STATS reply figures: counted with the shared trip rule.
 * Run with: node --test test_stats_summary.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recentRideStats } = require('./lib/stats-summary');

const NOW = new Date('2026-11-10T18:00:00Z');
const daysAgo = (days) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const trip = (days, extra = {}) => ({
  startTime: daysAgo(days), endTime: daysAgo(days), route: '510', agency: 'TTC', ...extra,
});

test('counts trips without an exit stop, like the dashboard and ASK', () => {
  const stats = recentRideStats([
    trip(1, { endStopName: 'Union', duration: 20 }),
    trip(2), // finished, no exit stop recorded
    trip(3, { endTime: null }), // never ended, started over 6 hours ago
  ], [], NOW);
  assert.equal(stats.weekCount, 3);
  assert.equal(stats.monthCount, 3);
  assert.equal(stats.totalMinutes, 20);
});

test('leaves out a trip still in progress and unreadable texts', () => {
  const stats = recentRideStats([
    trip(0.1, { endTime: null }), // started under 6 hours ago
    { source: 'sms_fallback', discarded: true, startTime: null },
    trip(1),
  ], [], NOW);
  assert.equal(stats.total, 1);
  assert.equal(stats.weekCount, 1);
});

test('splits rides into this and the prior week and month', () => {
  const stats = recentRideStats([trip(1), trip(6), trip(8), trip(13), trip(20), trip(40), trip(59), trip(61)], [], NOW);
  assert.equal(stats.weekCount, 2);
  assert.equal(stats.prevWeekCount, 2);
  assert.equal(stats.monthCount, 5);
  assert.equal(stats.prevMonthCount, 2);
  assert.equal(stats.total, 7);
});

test('counts imported PRESTO rides that were not also logged', () => {
  const presto = (days, agency) => ({
    source: 'presto', agency, endRecord: null,
    startRecord: { type: 'fare_payment', agency, occurredAtSortKey: daysAgo(days).getTime() },
  });
  const withImport = recentRideStats([trip(2)], [presto(3, 'TTC'), presto(100, 'TTC')], NOW);
  const without = recentRideStats([trip(2)], [], NOW);
  assert.equal(without.monthCount, 1);
  assert.equal(withImport.monthCount, 2); // the 100-day-old ride is outside the window
  assert.equal(withImport.routeCount, 1); // imported rides have no route
});

test('top route and route count come from the last 30 days', () => {
  const stats = recentRideStats([
    trip(1, { route: '510' }), trip(2, { route: '510' }), trip(3, { route: '1' }), trip(45, { route: '29' }),
  ], [], NOW);
  assert.equal(stats.routeCount, 2);
  assert.deepEqual(stats.topRoute, ['510', 2]);
});

test('ignores negative durations', () => {
  const stats = recentRideStats([trip(1, { duration: -5 }), trip(2, { duration: 12 })], [], NOW);
  assert.equal(stats.totalMinutes, 12);
});
