const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { buildSvg } = require('./lib/public-profile-og');

const noopFetchTile = { fetchTile: async () => null };

test('buildSvg includes map geometry without duplicating profile stats', async () => {
  const svg = await buildSvg({
    displayName: 'Test Rider & Friend',
    totalTrips: 12,
    routes: 3,
    agencies: 2,
    points: [{ lat: 43.7, lng: -79.4, usage: 4 }, { lat: 43.65, lng: -79.38, usage: 1 }],
  }, noopFetchTile);
  assert.match(svg, /<circle /);
  assert.doesNotMatch(svg, />12<\/tspan>/);
  assert.doesNotMatch(svg, /TRIPS|ROUTES|AGENCIES/);
  assert.doesNotMatch(svg, /TRANSITSTATS|transitstats\.fyi/);

  const image = await sharp(Buffer.from(svg)).png().toBuffer();
  assert.equal(image.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('buildSvg renders a useful empty state without route geometry', async () => {
  const svg = await buildSvg({ displayName: 'Traveler', totalTrips: 0, routes: 0, agencies: 0, points: [] }, noopFetchTile);
  assert.match(svg, /No matched route segments yet/);
});
