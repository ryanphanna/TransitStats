const { onRequest } = require('firebase-functions/v2/https');
const sharp = require('sharp');
const { getPublicProfilePayload } = require('./public-profile');

const WIDTH = 1200;
const HEIGHT = 630;
const MAP_AREA = { left: 50, top: 55, width: 1100, height: 520 };
const TILE_SIZE = 256;
const MAX_TILE_ZOOM = 14;
const MIN_TILE_ZOOM = 3;
const MERCATOR_LAT_LIMIT = 85.05112878;
const TILE_USER_AGENT = 'TransitStats/1.0 (+https://transitstats.fyi; social preview image)';
const TILE_FETCH_TIMEOUT_MS = 1500;
const BASEMAP_BUDGET_MS = 2000;

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clampLat(lat) {
  return Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat));
}

// Standard Web Mercator projection (matches the OpenStreetMap raster tile grid),
// so dots/paths land on the exact same pixels as the basemap tiles beneath them.
function lngLatToWorldPixel(lng, lat, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const x = ((lng + 180) / 360) * scale;
  const sinLat = Math.sin((clampLat(lat) * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function boundsFromCoords(coords) {
  if (coords.length === 0) return null;
  const lats = coords.map(([lat]) => lat);
  const lngs = coords.map(([, lng]) => lng);
  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
  };
}

// Picks the highest zoom whose bounding box still fits inside the map viewport,
// so the basemap and the projected geometry share one zoom/origin pair.
function chooseZoom(bounds, viewportWidth, viewportHeight) {
  for (let zoom = MAX_TILE_ZOOM; zoom >= MIN_TILE_ZOOM; zoom -= 1) {
    const topLeft = lngLatToWorldPixel(bounds.minLng, bounds.maxLat, zoom);
    const bottomRight = lngLatToWorldPixel(bounds.maxLng, bounds.minLat, zoom);
    if (bottomRight.x - topLeft.x <= viewportWidth && bottomRight.y - topLeft.y <= viewportHeight) {
      return zoom;
    }
  }
  return MIN_TILE_ZOOM;
}

function buildProjection(bounds) {
  const zoom = chooseZoom(bounds, MAP_AREA.width, MAP_AREA.height);
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const centerLng = (bounds.minLng + bounds.maxLng) / 2;
  const center = lngLatToWorldPixel(centerLng, centerLat, zoom);
  const originX = center.x - MAP_AREA.width / 2;
  const originY = center.y - MAP_AREA.height / 2;
  const project = (lng, lat) => {
    const pixel = lngLatToWorldPixel(lng, lat, zoom);
    return { x: MAP_AREA.left + (pixel.x - originX), y: MAP_AREA.top + (pixel.y - originY) };
  };
  return { zoom, originX, originY, project };
}

async function defaultFetchTile(zoom, x, y) {
  const size = 2 ** zoom;
  if (y < 0 || y >= size) return null;
  const wrappedX = ((x % size) + size) % size;
  const server = ['a', 'b', 'c'][Math.abs(x + y) % 3];
  const url = `https://${server}.tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TILE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': TILE_USER_AGENT }, signal: controller.signal });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null; // Slow/unreachable tile server: skip it, the caller falls back gracefully.
  } finally {
    clearTimeout(timer);
  }
}

// Waits for `promise` but never longer than `ms` — a slow or hanging fetchTile
// must not be able to stall the whole social-card response past this budget.
function withBudget(promise, ms) {
  return Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);
}

// Stitches the OSM tiles under the map viewport into one faded, grayscale basemap
// image, positioned so it lines up pixel-for-pixel with points/paths from `project`.
async function buildBasemapImage(projection, fetchTile) {
  const { zoom, originX, originY } = projection;
  const firstTileX = Math.floor(originX / TILE_SIZE);
  const firstTileY = Math.floor(originY / TILE_SIZE);
  const lastTileX = Math.floor((originX + MAP_AREA.width) / TILE_SIZE);
  const lastTileY = Math.floor((originY + MAP_AREA.height) / TILE_SIZE);

  const composites = [];
  const tasks = [];
  for (let tx = firstTileX; tx <= lastTileX; tx += 1) {
    for (let ty = firstTileY; ty <= lastTileY; ty += 1) {
      tasks.push(
        fetchTile(zoom, tx, ty).then(buffer => {
          if (!buffer) return;
          composites.push({
            input: buffer,
            left: Math.round(tx * TILE_SIZE - firstTileX * TILE_SIZE),
            top: Math.round(ty * TILE_SIZE - firstTileY * TILE_SIZE),
          });
        }).catch(() => {}),
      );
    }
  }
  // Tiles that land within the budget get used; anything still outstanding
  // after that is abandoned in place (fire-and-forget) rather than awaited.
  await withBudget(Promise.all(tasks), BASEMAP_BUDGET_MS);
  if (composites.length === 0) return null;

  const canvasWidth = (lastTileX - firstTileX + 1) * TILE_SIZE;
  const canvasHeight = (lastTileY - firstTileY + 1) * TILE_SIZE;
  const stitched = await sharp({
    create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { r: 238, g: 244, b: 241, alpha: 1 } },
  }).composite(composites).png().toBuffer();

  const cropLeft = Math.min(Math.max(0, Math.round(originX - firstTileX * TILE_SIZE)), Math.max(0, canvasWidth - 1));
  const cropTop = Math.min(Math.max(0, Math.round(originY - firstTileY * TILE_SIZE)), Math.max(0, canvasHeight - 1));
  const cropWidth = Math.min(MAP_AREA.width, canvasWidth - cropLeft);
  const cropHeight = Math.min(MAP_AREA.height, canvasHeight - cropTop);

  const faded = await sharp(stitched)
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .resize(MAP_AREA.width, MAP_AREA.height, { fit: 'fill' })
    .grayscale()
    .modulate({ brightness: 1.12, saturation: 0 })
    .png()
    .toBuffer();

  return faded.toString('base64');
}

function isValidLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function projectPoints(points, project) {
  const valid = points.filter(point => isValidLatLng(Number(point.lat), Number(point.lng)));
  const svg = valid.map(point => {
    const { x, y } = project(Number(point.lng), Number(point.lat));
    const radius = Math.min(13, 5 + Math.sqrt(Number(point.usage) || 1));
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(1)}" fill="#39d39f" fill-opacity="0.72" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1.5"/>`;
  });
  const coords = valid.map(point => [Number(point.lat), Number(point.lng)]);
  return { svg, coords };
}

const FALLBACK_BACKDROP = `
    <path d="M 0 510 C 190 450 310 570 510 500 S 890 430 1200 505 L 1200 630 L 0 630 Z" fill="#dcebe5"/>
    <path d="M 0 180 C 230 240 320 120 540 190 S 900 260 1200 150" fill="none" stroke="#d5e4df" stroke-width="3"/>
    <path d="M 80 0 C 190 130 170 270 280 360 S 390 520 430 630" fill="none" stroke="#d5e4df" stroke-width="3"/>`;

async function buildSvg(data, { fetchTile = defaultFetchTile } = {}) {
  const bounds = boundsFromCoords((data.points || [])
    .filter(point => isValidLatLng(Number(point.lat), Number(point.lng)))
    .map(point => [Number(point.lat), Number(point.lng)]));
  const projection = bounds ? buildProjection(bounds) : null;
  const project = projection ? projection.project : () => ({ x: 0, y: 0 });

  const { svg: pointDots } = projectPoints(data.points || [], project);
  const mapContent = pointDots.length
    ? pointDots.join('')
    : '<text x="455" y="310" text-anchor="middle" fill="#aaa6c4" font-family="Arial, sans-serif" font-size="20">No matched route segments yet</text>';

  const basemap = projection ? await buildBasemapImage(projection, fetchTile) : null;
  const backdrop = basemap
    ? `<image x="${MAP_AREA.left}" y="${MAP_AREA.top}" width="${MAP_AREA.width}" height="${MAP_AREA.height}" href="data:image/png;base64,${basemap}" opacity="0.6"/>`
    : FALLBACK_BACKDROP;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="1200" height="630" fill="#eef4f1"/>
    ${backdrop}
    <g>${mapContent}</g>
  </svg>`;
}

async function handlePublicProfileOg(req, res) {
  const username = String(req.query.user || '').trim().toLowerCase();
  if (!username) {
    res.status(400).send('Missing user parameter');
    return;
  }
  // Match the interactive profile's coordinate resolution so the share image
  // contains all known stops, while caching the rendered PNG for crawlers.
  const result = await getPublicProfilePayload(username, {
    includePoints: true,
    resolveStops: true,
  });
  if (result.statusCode !== 200) {
    res.status(result.statusCode).send(result.body?.error || 'Profile unavailable');
    return;
  }
  try {
    const image = await sharp(Buffer.from(await buildSvg(result.body))).png().toBuffer();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=300');
    res.status(200).send(image);
  } catch (error) {
    console.error('Public profile OG image failed:', error.message);
    res.status(500).send('Image unavailable');
  }
}

exports.publicProfileOg = onRequest({ memory: '512MiB', concurrency: 8, maxInstances: 4 }, handlePublicProfileOg);
exports.buildSvg = buildSvg;
