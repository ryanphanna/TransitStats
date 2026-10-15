const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  artifactSupportsAgency,
  cleanTripsForAgency,
  getEligibility,
  isModelReady,
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
  assert.deepEqual(getEligibility(history, 'TTC', { endStopTrips: 1 }), {
    agency: 'TTC',
    cleanTripCount: 1,
    endStopEligible: true,
    thresholds: { endStopTrips: 1 },
  });
});

test('legacy or incomplete artifacts are never treated as agency-safe', () => {
  assert.equal(artifactSupportsAgency({ agencies: ['TTC'] }, 'TTC'), false);
  assert.equal(artifactSupportsAgency({ feature_schema_version: 2, agencies: ['TTC'] }, 'ttc'), true);
  assert.equal(artifactSupportsAgency({ feature_schema_version: 2, agencies: ['TTC'] }, 'PRT'), false);
});

test('eligibility accepts a valid stop code without a display name', () => {
  const history = [trip({ startStopName: null, startStopCode: '5394' })];
  assert.equal(cleanTripsForAgency(history, 'TTC').length, 1);
});

test('isModelReady checks end-stop artifacts only', () => {
  const history = Array.from({ length: 15 }, () => trip());
  const endMeta = { feature_schema_version: 2, agencies: ['TTC'], label_schema: 'agency::end_stop' };
  const routeMeta = { feature_schema_version: 2, agencies: ['TTC'], label_schema: 'agency::route' };
  assert.equal(isModelReady(history, 'TTC', endMeta, endMeta), true);
  assert.equal(isModelReady(history, 'TTC', routeMeta, routeMeta), false);
  assert.equal(isModelReady(history.slice(0, 14), 'TTC', endMeta, endMeta), false);
});
