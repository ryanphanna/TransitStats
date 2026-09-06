const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalizeStop,
  getStopFeature,
  normalizeRouteForMl,
  scopedRouteKey,
  displayScopedRouteLabel,
  displayScopedStopLabel,
  normalizeDirectionForMl,
  getGapFeatures,
  configureFromDict,
} = require('./lib/ml_utils');

// Establish the same policy configuration the training pipeline uses
configureFromDict({
  TTC: 'collapse',
  DEFAULT: 'preserve_variant',
});

test('normalizeRouteForMl collapses TTC branch and shuttle variants', () => {
  assert.equal(normalizeRouteForMl('510A', 'TTC'), '510');
  assert.equal(normalizeRouteForMl('510 Shuttle', 'TTC'), '510');
  assert.equal(normalizeRouteForMl('510 Short Turn (to Queen)', 'TTC'), '510');
  assert.equal(normalizeRouteForMl('52G', 'TTC'), '52');
});

test('normalizeRouteForMl preserves distinct non-TTC route identities', () => {
  assert.equal(normalizeRouteForMl('Red', 'BART'), 'Red');
  assert.equal(normalizeRouteForMl('n', 'Muni'), 'N');
  assert.equal(normalizeRouteForMl('18c', 'GO Transit'), '18C');
  assert.equal(normalizeRouteForMl('1t', 'AC Transit'), '1T');
});

test('scoped model labels cannot collide across agencies', () => {
  assert.equal(scopedRouteKey('1', 'TTC'), 'ttc::1');
  assert.equal(scopedRouteKey('1', 'PRT'), 'prt::1');
  assert.equal(displayScopedRouteLabel('prt::1'), '1');
  assert.equal(displayScopedStopLabel('prt::Downtown Station'), 'Downtown Station');
});

test('semantic directions remain available to ML features', () => {
  assert.equal(normalizeDirectionForMl('Downtown'), 'downtown');
  assert.equal(normalizeDirectionForMl('Northbound'), 'northbound');
});

test('canonicalizeStop and getStopFeature normalize aliases consistently', () => {
  const lib = [
    { name: 'Spadina Ave at Nassau St South Side', aliases: ['Spadina / Nassau', 'SPADINA & NASSAU'] },
  ];
  assert.equal(
    canonicalizeStop('SPADINA & NASSAU', lib),
    'spadina ave/nassau st south side',
  );
  assert.equal(
    getStopFeature('Spadina / Nassau', lib),
    'stop_spadina_ave_nassau_st_south_side',
  );
});

test('getGapFeatures encodes missing and present gaps predictably', () => {
  assert.deepEqual(getGapFeatures(null), { gapLog: 0, gapMissing: 1 });
  assert.deepEqual(getGapFeatures(-5), { gapLog: 0, gapMissing: 1 });

  const zero = getGapFeatures(0);
  assert.equal(zero.gapMissing, 0);
  assert.equal(zero.gapLog, 0);

  const sixty = getGapFeatures(60);
  assert.equal(sixty.gapMissing, 0);
  assert.ok(sixty.gapLog > 0);

  const capped = getGapFeatures(5000);
  const maxed = getGapFeatures(720);
  assert.equal(capped.gapMissing, 0);
  assert.equal(capped.gapLog, maxed.gapLog);
});

test('normalizeRouteForMl is neutral for unknown agencies until configured', () => {
  const { resetPolicies, configureFromDict, normalizeRouteForMl } = require('./lib/ml_utils');
  resetPolicies();

  // No config → any agency (even TTC) gets preserve_variant
  assert.equal(normalizeRouteForMl('510A', 'TTC'), '510A');
  assert.equal(normalizeRouteForMl('Red', 'NewCityTransit'), 'Red');

  configureFromDict({ TTC: 'collapse', DEFAULT: 'preserve_variant' });
  assert.equal(normalizeRouteForMl('510A', 'TTC'), '510');
  assert.equal(normalizeRouteForMl('Red', 'NewCityTransit'), 'Red'); // still neutral default
});

test('loadPolicies and configuration APIs are exported and functional', () => {
  const api = require('./lib/ml_utils');
  assert.equal(typeof api.loadPolicies, 'function');
  assert.equal(typeof api.configureFromDict, 'function');
  assert.equal(typeof api.registerPolicy, 'function');
  assert.equal(typeof api.resetPolicies, 'function');
  assert.equal(typeof api.getDefaultConfig, 'function');
  assert.deepEqual(api.getDefaultConfig(), { DEFAULT: 'preserve_variant' });
});

test('PRIMARY policy is applied when primaryAgency matches the trip agency', () => {
  const { resetPolicies, configureFromDict, normalizeRouteForMl } = require('./lib/ml_utils');
  resetPolicies();

  configureFromDict({ PRIMARY: 'collapse', DEFAULT: 'preserve_variant' });

  // When the agency matches the provided primaryAgency, PRIMARY policy wins
  assert.equal(normalizeRouteForMl('510A', 'TTC', 'TTC'), '510');
  assert.equal(normalizeRouteForMl('42 Shuttle', 'MiWay', 'MiWay'), '42');

  // When it does not match the primary, normal/DEFAULT behavior applies
  assert.equal(normalizeRouteForMl('510A', 'TTC', 'MiWay'), '510A');
  assert.equal(normalizeRouteForMl('Red', 'BART', 'TTC'), 'Red');
});
