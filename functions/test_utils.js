const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isValidRoute } = require('./lib/utils');

test('isValidRoute accepts compact TTC-style identifiers', () => {
  assert.equal(isValidRoute('510A'), true);
  assert.equal(isValidRoute('GO1'), true);
  assert.equal(isValidRoute('Line 1'), true);
});

test('isValidRoute accepts legitimate named multi-agency routes', () => {
  assert.equal(isValidRoute('Orange'), true);
  assert.equal(isValidRoute('Green Line'), true);
  assert.equal(isValidRoute('Pacific Surfliner'), true);
  assert.equal(isValidRoute('Flagship Cruises & Events'), true);
  assert.equal(isValidRoute('Red Oakland-bound'), true);
  assert.equal(isValidRoute('506 Bus B'), true);
});

test('isValidRoute rejects obvious garbage', () => {
  assert.equal(isValidRoute(''), false);
  assert.equal(isValidRoute(null), false);
  assert.equal(isValidRoute('NB'), false);
  assert.equal(isValidRoute('BUS'), false);
  assert.equal(isValidRoute('TRAIN'), false);
  assert.equal(isValidRoute('Need To Correct Origin To Keelesdale'), false);
  assert.equal(isValidRoute('This is definitely not a route name at all'), false);
});

test('normalizeAgency uses the shared alias list (GO, NFTA/MFTA)', () => {
  const { normalizeAgency } = require('./lib/utils');
  assert.equal(normalizeAgency('GO'), 'GO Transit');
  assert.equal(normalizeAgency('MFTA'), 'NFTA Metro');
  assert.equal(normalizeAgency('Unknown Agency'), 'Unknown Agency');
});

test('collapseEquivalentStopCandidates folds a platform record into its parent station', () => {
  const { collapseEquivalentStopCandidates } = require('./lib/utils');
  const parent = { stopCode: '9001', stopName: 'College Station', routes: [] };
  const child = { stopCode: '9001-N', stopName: 'College Station - Northbound Platform', routes: ['1'] };
  const out = collapseEquivalentStopCandidates([child, parent], { strict: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].stopCode, '9001');
  assert.deepEqual(out[0].routes, ['1']); // route evidence from the folded platform is kept
});

test('collapseEquivalentStopCandidates keeps the platform that matches the requested direction', () => {
  const { collapseEquivalentStopCandidates } = require('./lib/utils');
  const parent = { stopCode: '9001', stopName: 'College Station', routes: [] };
  const child = { stopCode: '9001-N', stopName: 'College Station - Northbound Platform', routes: [] };
  const out = collapseEquivalentStopCandidates([child, parent], { strict: true, direction: 'Northbound' });
  assert.equal(out.length, 2);
});

test('collapseEquivalentStopCandidates never merges different stops', () => {
  const { collapseEquivalentStopCandidates } = require('./lib/utils');
  // Same name, different stop codes: two real stops.
  const sameName = [{ stopCode: '8121', stopName: 'Spadina / Dundas' }, { stopCode: '7349', stopName: 'Spadina / Dundas' }];
  assert.equal(collapseEquivalentStopCandidates(sameName, { strict: true }).length, 2);
  // Different stations that merely share a prefix.
  const different = [{ stopName: 'College Station' }, { stopName: 'College Park Station' }];
  assert.equal(collapseEquivalentStopCandidates(different, { strict: true }).length, 2);
  // Two directional platforms with no parent present stay distinct.
  const platforms = [
    { stopCode: 'a', stopName: 'X Station - Northbound Platform' },
    { stopCode: 'b', stopName: 'X Station - Southbound Platform' },
  ];
  assert.equal(collapseEquivalentStopCandidates(platforms, { strict: true }).length, 2);
});

test('collapseEquivalentStopCandidates merges punctuation twins', () => {
  const { collapseEquivalentStopCandidates } = require('./lib/utils');
  const twins = [{ stopName: 'St. George Station', routes: [] }, { stopCode: '77', stopName: 'St George Station', routes: ['1'] }];
  const out = collapseEquivalentStopCandidates(twins, { strict: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].stopCode, '77');
});

test('collapseEquivalentStopCandidates does not merge records from different home agencies', () => {
  const { collapseEquivalentStopCandidates } = require('./lib/utils');
  const ttc = { agency: 'TTC', stopName: 'Union Station', routes: ['1'] };
  const go = { agency: 'GO Transit', stopCode: 'UN', stopName: 'Union Station', routes: ['LW'] };
  const out = collapseEquivalentStopCandidates([ttc, go], { strict: true });
  assert.equal(out.length, 2);
  assert.deepEqual(out.find(c => c.agency === 'TTC').routes, ['1']); // no GO route attached to the TTC record
});
