const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  artifactSupportsAgency,
  cleanTripsForAgency,
  getEligibility,
} = require('./lib/intelligence-eligibility');

function trip(overrides = {}) {
  return {
    agency: 'TTC',
    route: '510',
    startStopName: 'Spadina Station',
    endStopName: 'College Station',
    stop_matched: true,
    ...overrides,
  };
}

test('eligibility counts only clean trips from the requested agency', () => {
  const history = [
    trip(),
    trip({ agency: 'PRT' }),
    trip({ needs_reprocess: true }),
    trip({ correctedFields: ['agency'] }),
    trip({ stop_matched: false }),
  ];
  assert.equal(cleanTripsForAgency(history, 'ttc').length, 1);
  assert.deepEqual(getEligibility(history, 'TTC', { routeTrips: 1, endStopTrips: 1 }), {
    agency: 'TTC',
    cleanTripCount: 1,
    routeEligible: true,
    endStopEligible: true,
    thresholds: { routeTrips: 1, endStopTrips: 1 },
  });
});

test('legacy or incomplete artifacts are never treated as agency-safe', () => {
  assert.equal(artifactSupportsAgency({ agencies: ['TTC'] }, 'TTC'), false);
  assert.equal(artifactSupportsAgency({ feature_schema_version: 2, agencies: ['TTC'] }, 'ttc'), true);
  assert.equal(artifactSupportsAgency({ feature_schema_version: 2, agencies: ['TTC'] }, 'PRT'), false);
});
