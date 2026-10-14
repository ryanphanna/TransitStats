/**
 * Tests for SMS parsing logic
 * Run with: node test_parsing.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMultiLineTripFormat,
  parseSingleLineTripFormat,
  parseCasualTripFormat,
  parseEndTripFormat,
  isHeuristicLogValid,
} = require('./lib/parsing');

const DEFAULT_AGENCY = 'TTC';

// ─── parseMultiLineTripFormat ────────────────────────────────────────────────

test('multi-line: route + stop', () => {
  const result = parseMultiLineTripFormat('510\nSpadina / College', DEFAULT_AGENCY);
  assert.equal(result.route, '510');
  assert.equal(result.stop, 'Spadina / College');
  assert.equal(result.direction, null);
});

test('multi-line: route + stop + direction', () => {
  const result = parseMultiLineTripFormat('47\nLansdowne / Dupont\nNorth', DEFAULT_AGENCY);
  assert.equal(result.route, '47');
  assert.equal(result.stop, 'Lansdowne / Dupont');
  assert.equal(result.direction, 'Northbound');
});

test('multi-line: direction abbreviations', () => {
  assert.equal(parseMultiLineTripFormat('506\nCollege / Spadina\nEB', DEFAULT_AGENCY).direction, 'Eastbound');
  assert.equal(parseMultiLineTripFormat('506\nCollege / Spadina\nS', DEFAULT_AGENCY).direction, 'Southbound');
  assert.equal(parseMultiLineTripFormat('506\nCollege / Spadina\nWB', DEFAULT_AGENCY).direction, 'Westbound');
});

test('multi-line: single line returns null', () => {
  assert.equal(parseMultiLineTripFormat('510', DEFAULT_AGENCY), null);
});

test('multi-line: command on first line returns null', () => {
  assert.equal(parseMultiLineTripFormat('END\nSpadina', DEFAULT_AGENCY), null);
  assert.equal(parseMultiLineTripFormat('STATUS\nSpadina', DEFAULT_AGENCY), null);
});

test('multi-line: explicit START prefix is accepted', () => {
  const result = parseMultiLineTripFormat('Start\n2\nKipling\nWest', DEFAULT_AGENCY);
  assert.equal(result.route, '2');
  assert.equal(result.stop, 'Kipling');
  assert.equal(result.direction, 'Westbound');
});

test('multi-line: slash in stop name normalizes correctly', () => {
  const result = parseMultiLineTripFormat('506\nCollege/Spadina\nEast', DEFAULT_AGENCY);
  assert.equal(result.stop, 'College / Spadina'); // toTitleCase adds spaces around slashes
  assert.equal(result.direction, 'Eastbound');
});

test('multi-line: agency on line 3 is accepted if not a direction', () => {
  const result = parseMultiLineTripFormat('47\nLansdowne / Dupont\nGO Transit', DEFAULT_AGENCY);
  // GO Transit is not a direction, so it should be treated as an agency (v1.26.0 logic).
  assert.equal(result.agency, 'GO Transit');
  assert.equal(result.agencyExplicit, true);
});

test('multi-line: extracts vehicle from separate line', () => {
  const result = parseMultiLineTripFormat('506\nCollege\nWest\nVehicle 4412', DEFAULT_AGENCY);
  assert.equal(result.route, '506');
  assert.equal(result.stop, 'College');
  assert.equal(result.direction, 'Westbound');
  assert.equal(result.vehicle, '4412');
});

test('multi-line: extracts vehicle from stop name', () => {
  const result = parseMultiLineTripFormat('506\nCollege (v: 4412)\nWest', DEFAULT_AGENCY);
  assert.equal(result.route, '506');
  assert.equal(result.stop, 'College');
  assert.equal(result.direction, 'Westbound');
  assert.equal(result.vehicle, '4412');
});

// ─── parseSingleLineTripFormat ───────────────────────────────────────────────

test('single-line: route + stop + direction', () => {
  const result = parseSingleLineTripFormat('510 Spadina/College North', DEFAULT_AGENCY);
  assert.equal(result.route, '510');
  assert.equal(result.stop, 'Spadina / College'); // toTitleCase adds spaces around slashes
  assert.equal(result.direction, 'Northbound');
});

test('single-line: extracts vehicle from stop name', () => {
  const result = parseSingleLineTripFormat('506 College (Vehicle 4412) West', DEFAULT_AGENCY);
  assert.equal(result.route, '506');
  assert.equal(result.stop, 'College');
  assert.equal(result.direction, 'Westbound');
  assert.equal(result.vehicle, '4412');
});

test('single-line: stop with spaces and slash', () => {
  const result = parseSingleLineTripFormat('47 Lansdowne / Dupont South', DEFAULT_AGENCY);
  assert.equal(result.route, '47');
  assert.equal(result.stop, 'Lansdowne / Dupont');
  assert.equal(result.direction, 'Southbound');
});

test('single-line: direction abbreviation', () => {
  const result = parseSingleLineTripFormat('506 College / Spadina EB', DEFAULT_AGENCY);
  assert.equal(result.route, '506');
  assert.equal(result.direction, 'Eastbound');
});

test('single-line: no direction returns null', () => {
  // Without direction we can\'t reliably distinguish from other message types
  assert.equal(parseSingleLineTripFormat('510 Spadina/College', DEFAULT_AGENCY), null);
});

test('single-line: only route + direction (no stop) returns null', () => {
  assert.equal(parseSingleLineTripFormat('510 North', DEFAULT_AGENCY), null);
});

test('single-line: multi-line input returns null', () => {
  assert.equal(parseSingleLineTripFormat('510\nSpadina\nNorth', DEFAULT_AGENCY), null);
});

test('single-line: sentence with motion phrase rejected by heuristic', () => {
  // "going to" in the stop triggers the sentence pattern
  assert.equal(parseSingleLineTripFormat('Hey going to Spadina North', DEFAULT_AGENCY), null);
});

test('single-line: tonight\'s failing case', () => {
  const result = parseSingleLineTripFormat('510 Spadina/College North', DEFAULT_AGENCY);
  assert.ok(result !== null, 'Should have parsed');
  assert.equal(result.route, '510');
  assert.equal(result.direction, 'Northbound');
});

// ─── parseCasualTripFormat ───────────────────────────────────────────────────

test('casual: "I\'m on the [route] from [stop]"', () => {
  const result = parseCasualTripFormat('I\'m on the 510 from Spadina and Nassau', DEFAULT_AGENCY);
  assert.ok(result !== null);
  assert.equal(result.route, '510');
  assert.equal(result.stop, 'Spadina & Nassau');
  assert.equal(result.direction, null);
});

// ─── parseEndTripFormat ──────────────────────────────────────────────────────

test('end: multi-line END + stop', () => {
  const result = parseEndTripFormat('End\nCollege / Spadina');
  assert.ok(result !== null);
  assert.equal(result.stop, 'College / Spadina');
  assert.equal(result.isEnd, true);
});

test('end: bare END', () => {
  const result = parseEndTripFormat('End');
  assert.ok(result !== null);
  assert.equal(result.stop, null);
});

test('end: STOP keyword works', () => {
  const result = parseEndTripFormat('STOP\nBathurst Station');
  assert.ok(result !== null);
  assert.equal(result.stop, 'Bathurst Station');
});

test('end: non-end message returns null', () => {
  assert.equal(parseEndTripFormat('510\nSpadina'), null);
  assert.equal(parseEndTripFormat('STATUS'), null);
});

test('end: END with notes', () => {
  const result = parseEndTripFormat('End\nCollege / Spadina\nCrowded');
  assert.equal(result.stop, 'College / Spadina');
  assert.equal(result.notes, 'Crowded');
});

test('end: single-line END [stop] returns null from parseEndTripFormat', () => {
  // Single-line end is handled by singleLineEndMatch in dispatcher, not this parser
  assert.equal(parseEndTripFormat('End College / Spadina'), null);
});

// ─── isHeuristicLogValid ─────────────────────────────────────────────────────

test('heuristic: valid stop and route', () => {
  assert.equal(isHeuristicLogValid('Spadina / College', '510'), true);
});

test('heuristic: sentence starter rejected', () => {
  assert.equal(isHeuristicLogValid('I am at Spadina', '510'), false);
  assert.equal(isHeuristicLogValid('Hey there', '510'), false);
});

test('heuristic: bad stop name rejected', () => {
  assert.equal(isHeuristicLogValid('BUS stop', '510'), false);
});

test('heuristic: empty inputs rejected', () => {
  assert.equal(isHeuristicLogValid('', '510'), false);
  assert.equal(isHeuristicLogValid('Spadina', ''), false);
  assert.equal(isHeuristicLogValid(null, '510'), false);
});

test('heuristic: motion sentence rejected', () => {
  assert.equal(isHeuristicLogValid('headed to spadina', '510'), false);
});

test('heuristic: stop too long rejected', () => {
  assert.equal(isHeuristicLogValid('A'.repeat(61), '510'), false);
});

test('multi-line: a third line that is not a known agency is never stored as the agency', () => {
  for (const junk of ['Downtown', 'Union Station', 'Somewhere']) {
    const result = parseMultiLineTripFormat(`506\nCollege\n${junk}`, DEFAULT_AGENCY);
    assert.equal(result.agency, DEFAULT_AGENCY, junk);
    assert.equal(result.agencyExplicit, false, junk);
    assert.equal(result.direction, null, junk);
  }
});

test('multi-line: typos and cut-off words on line 3 are read as the direction', () => {
  const cases = { Northa: 'Northbound', Sout: 'Southbound', Nort: 'Northbound', Sotuh: 'Southbound', Eastb: 'Eastbound', Wset: 'Westbound' };
  for (const [typed, expected] of Object.entries(cases)) {
    const result = parseMultiLineTripFormat(`506\nCollege\n${typed}`, DEFAULT_AGENCY);
    assert.equal(result.direction, expected, typed);
    assert.equal(result.agencyExplicit, false, typed);
  }
});

test('multi-line: agency aliases on line 3 or 4 resolve to the canonical agency', () => {
  assert.equal(parseMultiLineTripFormat('47\nLansdowne\nGO', DEFAULT_AGENCY).agency, 'GO Transit');
  const four = parseMultiLineTripFormat('47\nLansdowne\nNorth\nMFTA', DEFAULT_AGENCY);
  assert.equal(four.agency, 'NFTA Metro');
  assert.equal(four.direction, 'Northbound');
  const junkFour = parseMultiLineTripFormat('47\nLansdowne\nNorth\nDowntown', DEFAULT_AGENCY);
  assert.equal(junkFour.agency, DEFAULT_AGENCY);
});
