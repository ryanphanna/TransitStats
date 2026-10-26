const fs = require('node:fs');
const path = require('node:path');
const { onRequest } = require('firebase-functions/v2/https');
const { getPublicProfilePayload } = require('./public-profile');

// Copied from the built dist/public.html by every root build (scripts/sync-public-profile-template.mjs)
// and checked before each functions deploy. Read on first use, so a checkout that was never built
// (tests, the emulator) still loads every other function.
const TEMPLATE_PATH = path.join(__dirname, '..', 'public-profile-template.html');
let template = null;
function getTemplate() {
  if (template === null) template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return template;
}
const PUBLIC_ORIGIN = 'https://transitstats.fyi';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function handlePublicProfilePage(req, res) {
  const username = String(req.path || '').match(/^\/user\/([^/]+)/i)?.[1]
    || String(req.query.user || '').trim();
  const decodedUsername = decodeURIComponent(username).trim().toLowerCase();
  if (!decodedUsername) {
    res.status(404).send('Profile not found');
    return;
  }

  const result = await getPublicProfilePayload(decodedUsername);
  if (result.statusCode !== 200) {
    // Let the existing browser client render its styled private/not-found state.
    // Returning the shell without profile metadata also prevents crawlers from
    // receiving a preview for a profile that is not public.
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.status(200).send(getTemplate());
    return;
  }

  const data = result.body;
  const canonicalUrl = `${PUBLIC_ORIGIN}/user/${encodeURIComponent(data.canonicalUsername || decodedUsername)}`;
  const displayName = data.displayName || 'Traveler';
  const title = `${displayName}’s TransitStats — every ride, mapped`;
  const description = `${data.totalTrips || 0} trips across ${data.routes || 0} routes and ${data.agencies || 0} transit agencies — every ride mapped, from daily commutes to trips across the world.`;
  const imageAlt = `${displayName}’s ride map`;
  // Use a versioned path because X can cache or mishandle query-string image
  // URLs independently from the profile URL.
  const imageUrl = `${PUBLIC_ORIGIN}/public-profile-og-v11?user=${encodeURIComponent(data.canonicalUsername || decodedUsername)}`;
  const metadata = `
    <meta name="description" content="${escapeHtml(description)}">
    <meta property="og:type" content="profile">
    <meta property="og:site_name" content="TransitStats">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
    <meta property="og:image" content="${escapeHtml(imageUrl)}">
    <meta property="og:image:secure_url" content="${escapeHtml(imageUrl)}">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}">
    <meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}">`;

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=300');
  res.status(200).send(getTemplate().replace('</head>', `${metadata}\n</head>`));
}

exports.publicProfilePage = onRequest({ concurrency: 40, maxInstances: 4 }, handlePublicProfilePage);
exports.handlePublicProfilePage = handlePublicProfilePage;
