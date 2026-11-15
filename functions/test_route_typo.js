/**
 * Route typo check (RYN-42): when "did you mean 510?" is asked, and when it isn't.
 * Run with: node --test test_route_typo.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PredictionEngineV3 } = require('./lib/predict_v3');
const { suggestRouteCorrection, isOneEditApart } = require('./lib/route-typo');
const text = require('./lib/sms-text');

function engine() {
  const e = Object.create(PredictionEngineV3);
  e.stopsLibrary = [];
  e.networkGraph = null;
  return e;
}

// Weekday 8am Toronto (12:00 UTC in November).
const NOW = new Date('2026-11-16T13:00:00Z');

function trips(route, n, { stop = 'Spadina Station', agency = 'TTC', start = '2026-11-09T13:05:00Z' } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    route,
    startStopName: stop,
    agency,
    startTime: new Date(new Date(start).getTime() - i * 86400000),
  }));
}

function suggest(history, route, extra = {}) {
  return suggestRouteCorrection({
    engine: engine(), history, startStopName: 'Spadina Station', agency: 'TTC', route, now: NOW, ...extra,
  });
}

test('isOneEditApart: dropped, added, changed and swapped digits', () => {
  assert.equal(isOneEditApart('51', '510'), true);
  assert.equal(isOneEditApart('5100', '510'), true);
  assert.equal(isOneEditApart('511', '510'), true);
  assert.equal(isOneEditApart('501', '510'), true);
  assert.equal(isOneEditApart('29', '510'), false);
  assert.equal(isOneEditApart('105', '510'), false);
  assert.equal(isOneEditApart('510', '510'), false);
});

test('suggests the usual route for a one-keystroke typo never ridden from this stop', () => {
  const result = suggest(trips('510', 8), '51');
  assert.equal(result.route, '510');
  assert.equal(result.rides, 8);
  assert.equal(result.share, 1);
});

test('no suggestion when the texted route has been ridden from this stop before', () => {
  assert.equal(suggest([...trips('510', 8), ...trips('51', 1)], '51'), null);
});

test('no suggestion for a genuinely different route (not a typo of the usual one)', () => {
  assert.equal(suggest(trips('510', 8), '29'), null);
});

test('no suggestion when GTFS lists the texted route at this stop', () => {
  assert.equal(suggest(trips('510', 8), '511', { routesAtStop: ['510', '511'] }), null);
  assert.equal(suggest(trips('510', 8), '511', { routesAtStop: ['510'] }).route, '510');
});

test('no suggestion with too few rides from this stop', () => {
  assert.equal(suggest(trips('510', 4), '51'), null);
});

test('no suggestion when no route clearly leads at this stop', () => {
  const history = [...trips('510', 5), ...trips('505', 5, { start: '2026-11-09T13:10:00Z' })];
  assert.equal(suggest(history, '51'), null);
});

test('rides from other stops or agencies never count', () => {
  const history = [
    ...trips('510', 8, { stop: 'Union Station' }),
    ...trips('510', 8, { agency: 'GO Transit' }),
  ];
  assert.equal(suggest(history, '51'), null);
});

test('suffixes are the same route: 510A is not a typo of 510', () => {
  assert.equal(suggest(trips('510', 8), '510A'), null);
});

test('named routes are never questioned', () => {
  assert.equal(suggest(trips('Lakeshore West', 8), 'Lakeshore Wes'), null);
});

test('uses the time-of-day bucket at the stop when it has rides', () => {
  // Mornings: 510. Evenings: 511. A morning "51" points at 510 even though 511 is busier overall.
  const morning = trips('510', 5);
  const evening = trips('511', 8, { start: '2026-11-09T23:05:00Z' });
  assert.equal(suggest([...morning, ...evening], '51').route, '510');
});

test('the typo prompt copies the stop-choice layout, with no blank line before the reply line', () => {
  const msg = text.routeTypoPrompt('51', 'Spadina Station', '', ['510', '51']);
  assert.equal(msg, 'Started 51 from Spadina Station.\n\nDid you mean 510?\n' +
    '1. Route 510\n2. Route 51\nReply with a number to set the route, or ignore to keep 51.');
  assert.doesNotMatch(msg, /\bI\b/);
});
