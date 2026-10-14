/**
 * atlas-enrich.js — Layer-2 facts for new stop docs, sourced from Atlas R2.
 *
 * Atlas publishes atlas/{slug}-stops-meta.json weekly (official name, routes
 * served, direction of travel per stop) — Civic-Minds/Atlas#161, shipped in
 * Atlas commit 0276e20. When a stop doc is created here with a code but
 * missing facts, we fill the blanks from that file.
 *
 * Layering rules (TransitStats#152):
 *  - `name` is the user's label — NEVER set or changed by this module.
 *  - Official names land in `aliases` verbatim, for matching only.
 *  - Only missing fields are filled; curated values are never overwritten.
 *  - Atlas/R2 is read-only; if the file doesn't exist yet (404), do nothing.
 */

const { FieldValue } = require('firebase-admin/firestore');

const { resolveAtlasAgency } = require('../atlas-agency');

const ATLAS_R2_BASE = process.env.ATLAS_R2_BASE || 'https://data.transitatlas.fyi';

// Per-instance cache: the meta file is ~1 MB and refreshed weekly upstream.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const metaCache = new Map(); // slug -> { fetchedAt, data | null }

async function fetchStopsMeta(slug) {
  const cached = metaCache.get(slug);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
  let data = null;
  try {
    const res = await fetch(`${ATLAS_R2_BASE}/atlas/${slug}-stops-meta.json`, {
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) data = await res.json();
  } catch (_) {
    // network error — treat as unavailable, retry after TTL
  }
  metaCache.set(slug, { fetchedAt: Date.now(), data });
  return data;
}

/**
 * Pure: compute the update for a stop doc from the agency's stops-meta file.
 * Returns { stopUpdate, stopRoutes } or null when there is nothing to add.
 * When several meta entries share the stop code (paired platforms), only
 * facts every entry agrees on are used.
 */
function buildStopEnrichment(stop, metaFile) {
  if (!stop?.code || !metaFile?.stops) return null;
  const code = String(stop.code).trim();
  const entries = metaFile.stops.filter(e => e.code && String(e.code).trim() === code);
  if (entries.length === 0) return null;

  const update = {};

  const directions = new Set(entries.map(e => e.direction).filter(Boolean));
  if (!stop.direction && directions.size === 1 && entries.every(e => e.direction)) {
    update.direction = [...directions][0];
  }

  const existingRoutes = (stop.routes || []).map(r => String(r).toLowerCase());
  const metaRoutes = [...new Set(entries.flatMap(e => e.routes || []))];
  const newRoutes = metaRoutes.filter(r => !existingRoutes.includes(String(r).toLowerCase()));
  if (newRoutes.length) update.newRoutes = newRoutes;

  const knownNames = [stop.name, ...(stop.aliases || [])].filter(Boolean).map(n => n.toLowerCase());
  const officialNames = [...new Set(entries.map(e => e.name).filter(Boolean))];
  const newAliases = officialNames.filter(n => !knownNames.includes(n.toLowerCase()));
  if (newAliases.length) update.newAliases = newAliases;

  if (Object.keys(update).length === 0) return null;

  return {
    stopUpdate: update,
    stopRoutes: metaRoutes.length || existingRoutes.length
      ? [...new Set([...(stop.routes || []).map(String), ...metaRoutes])]
      : null,
  };
}

/**
 * Trigger body: enrich a newly created stop doc in place.
 * Returns a short outcome string for logging.
 */
async function enrichStopDoc(db, stopId, stop) {
  const agency = stop.agency || (stop.agencies || [])[0];
  // Slugs come from Atlas's live agency directory, the same lookup the other
  // Atlas functions use, so new agencies need no edit here.
  let slug = null;
  try {
    slug = agency ? await resolveAtlasAgency(agency) : null;
  } catch (_) {
    return 'meta-unavailable';
  }
  if (!slug) return 'no-slug';
  if (!stop.code) return 'no-code';

  const metaFile = await fetchStopsMeta(slug);
  if (!metaFile) return 'meta-unavailable';

  const enrichment = buildStopEnrichment(stop, metaFile);
  if (!enrichment) return 'nothing-to-add';

  const { stopUpdate, stopRoutes } = enrichment;
  const now = FieldValue.serverTimestamp();
  const update = { atlasEnrichedAt: now, updatedAt: now };
  if (stopUpdate.direction) update.direction = stopUpdate.direction;
  if (stopUpdate.newRoutes) update.routes = FieldValue.arrayUnion(...stopUpdate.newRoutes);
  if (stopUpdate.newAliases) update.aliases = FieldValue.arrayUnion(...stopUpdate.newAliases);
  await db.collection('stops').doc(stopId).update(update);

  if (stopRoutes) {
    const docId = `${agency}_${String(stop.code).trim()}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    await db.collection('stopRoutes').doc(docId).set({
      agency,
      stopCode: String(stop.code).trim(),
      routes: stopRoutes,
      source: 'atlas_enrich',
      updatedAt: now,
    }, { merge: true });
  }
  return 'enriched';
}

module.exports = { buildStopEnrichment, enrichStopDoc, fetchStopsMeta };
