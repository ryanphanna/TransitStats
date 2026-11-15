const test = require('node:test');
const assert = require('node:assert/strict');
const { leanRouteShapes } = require('./lib/atlas-route-shapes');

const line = (props, coords = [[-79.4, 43.6], [-79.3, 43.7]]) => ({
  type: 'Feature',
  properties: { headwayByHour: [1, 2, 3], stopHeadways: { a: 1 }, ...props },
  geometry: { type: 'LineString', coordinates: coords },
});

test('keeps only requested route lines with the fields the map reads', () => {
  const features = [
    line({ routeShortName: '510', routeId: 'r510', directionId: 0, routeColor: 'ff0000' }),
    line({ routeShortName: '505', routeId: 'r505', directionId: 0 }),
    { type: 'Feature', properties: { routeShortName: '510' }, geometry: { type: 'Point', coordinates: [-79.4, 43.6] } },
  ];
  const result = leanRouteShapes(features, new Set(['510']));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].properties, {
    routeShortName: '510', routeId: 'r510', directionId: 0, routeColor: 'ff0000',
  });
});

test('matches by routeId too', () => {
  const result = leanRouteShapes([line({ routeShortName: '1', routeId: 'line1' })], new Set(['line1']));
  assert.equal(result.length, 1);
});

test('drops repeated identical shapes across service days, keeps different ones', () => {
  const features = [
    line({ routeShortName: '510', directionId: 0, day: 'Weekday' }),
    line({ routeShortName: '510', directionId: 0, day: 'Saturday' }),
    line({ routeShortName: '510', directionId: 1, day: 'Weekday' }),
    line({ routeShortName: '510', directionId: 0, day: 'Sunday' }, [[-79.5, 43.6], [-79.3, 43.7]]),
  ];
  assert.equal(leanRouteShapes(features, new Set(['510'])).length, 3);
});
