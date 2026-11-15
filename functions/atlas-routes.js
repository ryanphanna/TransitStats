const { onRequest } = require('firebase-functions/v2/https');
const { resolveAtlasAgency } = require('./atlas-agency');
const { leanRouteShapes } = require('./lib/atlas-route-shapes');

const ATLAS_R2_BASE = process.env.ATLAS_R2_BASE || 'https://data.transitatlas.fyi';
const cache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function getAgencyRoutes(slug) {
  const cached = cache.get(slug);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  const response = await fetch(`${ATLAS_R2_BASE}/atlas/${slug}.json`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Atlas route data unavailable for ${slug}`);

  const data = await response.json();
  cache.set(slug, { fetchedAt: Date.now(), data });
  return data;
}

exports.atlasRoutes = onRequest({
  cors: true,
  maxInstances: 4,
}, async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const requestedAgency = String(req.query.agency || '').trim();
  const routeSet = new Set(String(req.query.routes || '')
    .split(',')
    .map(route => route.trim())
    .filter(Boolean));
  const metadataOnly = String(req.query.all || '').toLowerCase() === 'true';

  if (!requestedAgency || (!metadataOnly && routeSet.size === 0)) {
    res.status(400).json({ error: 'Missing agency or routes' });
    return;
  }

  let slug = null;
  try {
    slug = await resolveAtlasAgency(requestedAgency);
    if (!slug) {
      res.status(404).json({ error: 'Agency inventory unavailable' });
      return;
    }
    const data = await getAgencyRoutes(slug);
    if (metadataOnly) {
      const routes = new Map();
      for (const feature of data.features || []) {
        const properties = feature.properties || {};
        const routeShortName = String(properties.routeShortName || '').trim();
        if (!routeShortName || routes.has(routeShortName)) continue;
        routes.set(routeShortName, {
          routeShortName,
          routeLongName: String(properties.routeLongName || '').trim(),
        });
      }

      res.set('Cache-Control', 'public, max-age=3600');
      res.status(200).json({ routes: [...routes.values()] });
      return;
    }

    const features = leanRouteShapes(data.features, routeSet);

    res.set('Cache-Control', 'public, max-age=3600');
    res.status(200).json({ type: 'FeatureCollection', features });
  } catch (error) {
    console.error(`Atlas route proxy failed for ${slug}:`, error.message);
    res.status(502).json({ error: 'Atlas route data unavailable' });
  }
});
