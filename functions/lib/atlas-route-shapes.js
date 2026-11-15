// Atlas route files carry every stop point and per-stop headway table for each
// route variant (about 25 MB for TTC). The web map only needs each route's line,
// so trim to line geometry, the fields the map reads, and one copy of each
// identical shape (Weekday/Saturday/Sunday variants usually repeat the same line).

const KEPT_PROPERTIES = ['routeShortName', 'routeId', 'directionId', 'routeColor'];

function leanRouteShapes(features = [], routeSet = new Set()) {
  const seen = new Set();
  const lean = [];
  for (const feature of features) {
    const geometry = feature?.geometry;
    if (!geometry || (geometry.type !== 'LineString' && geometry.type !== 'MultiLineString')) continue;

    const properties = feature.properties || {};
    const shortName = String(properties.routeShortName || '').trim();
    const routeId = String(properties.routeId || '').trim();
    if (!routeSet.has(shortName) && !routeSet.has(routeId)) continue;

    const coordinates = JSON.stringify(geometry.coordinates);
    const key = `${shortName}|${routeId}|${properties.directionId ?? ''}|${coordinates}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const keptProperties = {};
    for (const name of KEPT_PROPERTIES) {
      if (properties[name] !== undefined) keptProperties[name] = properties[name];
    }
    lean.push({ type: 'Feature', properties: keptProperties, geometry });
  }
  return lean;
}

module.exports = { leanRouteShapes };
