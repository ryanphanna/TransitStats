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
