/**
 * Stop lookup and GTFS route mapping
 */
const { db, FieldValue } = require('./core');
const { AGENCY_CITY } = require('../constants');
const { getConnectionGroup, areConnectedStops, normalizeStopName } = require('../transfer-connections');
const { getStopCandidateDirection, collapseEquivalentStopCandidates, stopNameKey } = require('../utils');
const { findAtlasStopByCode } = require('../atlas-enrich');
const TopologyConstraints = require('../topology-constraints');
let _topology = null;
try { _topology = require('../topology.json'); } catch (_) { /* optional */ }

// Shared lookup. Throws on a database error so callers can tell "no such stop" from "could not
// check". crossAgency=false skips the fallback that scans the whole stops collection and writes
// (auto-expanding a stop's agencies), for read-only checks.
async function _lookupStopCore(stopCode, stopName, agency, route, direction, { crossAgency = true } = {}) {
  {
    if (!stopCode && !stopName) return null;

    // Code lookup — uses composite index (agencies array-contains + code ==)
    if (stopCode) {
      const snap = await db.collection('stops')
        .where('agencies', 'array-contains', agency)
        .where('code', '==', stopCode)
        .limit(1)
        .get();
      if (!snap.empty) {
        const doc = snap.docs[0];
        const data = doc.data();
        return { id: doc.id, ...data, stopCode: data.code, stopName: data.name };
      }
    }

    if (stopName) {
      const agencySnap = await db.collection('stops')
        .where('agencies', 'array-contains', agency)
        .get();
      const candidates = _findStopCandidates(stopName, agencySnap.docs);

      if (candidates.length > 0) {
        const resolved = await _resolveCandidates(candidates, agency, route, direction, stopName);
        if (resolved) return resolved;
        return null;
      }
    }

    // Atlas fallback for a stop code the library does not have: the agency's own Atlas stops-meta
    // (never another agency's). The write path adds the stop to the library; the read-only check
    // just reports it. An Atlas outage skips this step (the other fallbacks still run) and is
    // remembered, so a read-only check never mistakes it for "no such stop".
    let atlasUnavailable = false;
    if (stopCode) {
      const atlas = await findAtlasStopByCode(agency, stopCode);
      if (atlas.status === 'error') atlasUnavailable = true;
      if (atlas.status === 'found') return crossAgency ? _addAtlasStop(agency, atlas.stop) : _atlasStopRecord(agency, atlas.stop);
    }

    // Cross-agency fallback: stop exists in library under a different agency.
    // If found, auto-expand the stop's agencies array so future lookups hit directly.
    const term = stopCode || stopName;
    if (crossAgency && term) {
      const found = await _findAndExpandStop(term, agency);
      if (found) return found;
    }

    // Trusted topology fallback: for routes covered by topology.json, treat a
    // route-specific stop/alias match as verified enough for trip trust even if
    // the normalized stop library is missing the station.
    if (stopName && route) {
      const topologyMatch = _lookupStopInTopology(stopName, agency, route);
      if (topologyMatch) return topologyMatch;
    }

    if (atlasUnavailable && !crossAgency) throw new Error('Atlas stops-meta unavailable');
    return null;
  }
}

function _atlasStopRecord(agency, stop) {
  const data = {
    agency,
    agencies: [agency],
    code: stop.code,
    name: stop.name || `Stop ${stop.code}`,
    aliases: stop.aliases || [],
    routes: stop.routes || [],
    direction: stop.direction || null,
    lat: stop.lat ?? null,
    lng: stop.lng ?? null,
    source: 'atlas',
  };
  return { id: `atlas_${stop.slug}_${stop.code}`.replace(/[^a-zA-Z0-9_-]/g, '_'), ...data, stopCode: data.code, stopName: data.name };
}

// Adds the Atlas stop to the library under a deterministic id (idempotent). The Atlas name is the
// only label a code-only stop has; onStopCreated then fills in anything else that is missing.
async function _addAtlasStop(agency, stop) {
  const record = _atlasStopRecord(agency, stop);
  const { id, stopCode, stopName, ...data } = record;
  try {
    await db.collection('stops').doc(id).set({ ...data, createdAt: new Date(), updatedAt: new Date() }, { merge: true });
  } catch (error) {
    console.warn('Could not add Atlas stop to the library:', error.message);
  }
  return record;
}

async function lookupStop(stopCode, stopName, agency, route = null, direction = null) {
  try {
    return await _lookupStopCore(stopCode, stopName, agency, route, direction);
  } catch (error) {
    console.error('Error looking up stop:', error);
    return null;
  }
}

/**
 * Read-only stop check: never writes and never scans the whole collection. Resolves to
 * { status: 'found' | 'notFound' | 'error', stop } so a database error is never mistaken for a
 * stop that does not exist.
 */
async function lookupStopCheck(stopCode, stopName, agency, route = null, direction = null) {
  try {
    const stop = await _lookupStopCore(stopCode, stopName, agency, route, direction, { crossAgency: false });
    return stop ? { status: 'found', stop } : { status: 'notFound', stop: null };
  } catch (error) {
    console.error('Error checking stop:', error);
    return { status: 'error', stop: null };
  }
}

function _lookupStopInTopology(stopName, agency, route) {
  const line = _topologyLine(route, agency);
  if (!line || !stopName) return null;

  const lower = TopologyConstraints.normalizeStopLabel(stopName);
  for (const canon of line.stops || []) {
    if (TopologyConstraints.normalizeStopLabel(canon) === lower) {
      return _topologyStop(canon, agency, route, line);
    }
    const variants = (line.directional_stops && line.directional_stops[canon]) || [];
    for (const variant of variants) {
      if (TopologyConstraints.normalizeStopLabel(variant.name) === lower) {
        return _topologyStop(variant.name, agency, route, line, variant.aliases || []);
      }
      if ((variant.aliases || []).some(alias => TopologyConstraints.normalizeStopLabel(alias) === lower)) {
        return _topologyStop(variant.name, agency, route, line, variant.aliases || []);
      }
    }
    const aliases = (line.aliases && line.aliases[canon]) || [];
    if (aliases.some(alias => TopologyConstraints.normalizeStopLabel(alias) === lower)) {
      return _topologyStop(canon, agency, route, line);
    }
  }
  return null;
}

function _topologyLine(route, agency) {
  return TopologyConstraints.getLine(_topology, route, { agency, baseRoute: routeStr => routeStr.toString().trim() });
}

function _topologyStop(canon, agency, route, line, aliases = null) {
  return {
    id: null,
    agency,
    code: '',
    stopCode: '',
    name: canon,
    stopName: canon,
    aliases: aliases || (line.aliases && line.aliases[canon]) || [],
    routes: [route.toString()],
    source: 'topology',
    topologyMatched: true,
  };
}

// Search all stops by name, alias, or code. Scoped to the same city as the
// requesting agency to prevent wrong-city matches (e.g. Toronto Union Station
// matching a Muni trip). When a match is found, auto-expands the agencies array.
async function _findAndExpandStop(term, agency) {
  const lowerTerm = term.toLowerCase();
  const tripCity = AGENCY_CITY[agency] || null;

  // Build the set of agencies in the same city. If the trip agency isn't in
  // AGENCY_CITY (unknown city), skip the fallback entirely — safer than guessing.
  if (!tripCity) return null;

  const cityAgencies = new Set(
    Object.entries(AGENCY_CITY)
      .filter(([, city]) => city === tripCity)
      .map(([a]) => a)
  );

  const allStops = await db.collection('stops').get();

  for (const doc of allStops.docs) {
    const data = doc.data();

    // Skip stops whose home agency is in a different city
    if (data.agency && !cityAgencies.has(data.agency)) continue;

    const match =
      data.name?.toLowerCase() === lowerTerm ||
      data.code === term ||
      data.aliases?.some(a => a.toLowerCase() === lowerTerm);

    if (match) {
      if (!data.agencies?.includes(agency)) {
        doc.ref.update({
          agencies: FieldValue.arrayUnion(agency),
          updatedAt: new Date(),
        }).catch(err => console.error('agencies auto-expand failed:', err.message));
      }
      return { id: doc.id, ...data, stopCode: data.code, stopName: data.name };
    }
  }
  return null;
}

async function getRoutesAtStop(stopCode, agency) {
  if (!stopCode || !agency) return null;
  try {
    const docId = `${agency}_${stopCode}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const doc = await db.collection('stopRoutes').doc(docId).get();
    if (!doc.exists) return null;
    return doc.data().routes || null;
  } catch (err) {
    console.error('Error fetching stopRoutes:', err);
    return null;
  }
}

async function getStopsLibrary() {
  const snapshot = await db.collection('stops').get();
  return snapshot.docs.map(doc => {
    const data = doc.data();
    return {
      name: data.name,
      aliases: data.aliases || [],
      code: data.code || null,
      agency: data.agency || null,
      agencies: data.agencies || [],
      lat: data.lat ?? data.location?.lat ?? null,
      lng: data.lng ?? data.lon ?? data.location?.lng ?? data.location?.lon ?? null,
    };
  });
}

/**
 * Find all stops within an agency matching a name or alias (case-insensitive).
 * Returns up to 5 candidates. Used for stop disambiguation before trip start.
 */
async function findMatchingStops(stopName, agency) {
  if (!stopName || !agency) return [];

  const snap = await db.collection('stops')
    .where('agencies', 'array-contains', agency)
    .get();

  return _findStopCandidates(stopName, snap.docs).slice(0, 5);
}

function _findStopCandidates(stopName, docs) {
  const lowerName = stopName.toLowerCase();
  const inputKey = stopNameKey(stopName);
  const inputGroup = getConnectionGroup(stopName);
  const normalizedInput = normalizeStopName(stopName);
  const literalMatches = [];
  const keyedMatches = [];
  const connectedMatches = [];
  const seen = new Set();

  for (const doc of docs) {
    const data = doc.data();
    const candidate = {
      id: doc.id,
      ...data,
      stopCode: data.code,
      stopName: data.name,
      routes: data.routes || [],
      direction: data.direction || null,
    };
    const names = [data.name, ...(data.aliases || [])].filter(Boolean);
    // Literal name match first; the station-key match (punctuation twins, platform records of the
    // same station) is only a fallback, so a directional platform asked for by its full name never
    // resolves to its opposite-direction twin.
    const literal = names.some(name => name.toLowerCase() === lowerName);
    const keyed = !literal && inputKey && names.some(name => stopNameKey(name) === inputKey);
    if (literal || keyed) {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        (literal ? literalMatches : keyedMatches).push(candidate);
      }
      continue;
    }
    if (!inputGroup) continue;
    const connected = names.some(name =>
      getConnectionGroup(name) === inputGroup ||
      areConnectedStops(name, stopName) ||
      normalizeStopName(name) === normalizedInput
    );
    if (connected && !seen.has(doc.id)) {
      seen.add(doc.id);
      connectedMatches.push(candidate);
    }
  }

  return [...(literalMatches.length ? literalMatches : keyedMatches), ...connectedMatches];
}

async function _resolveCandidates(candidates, agency, route, direction, rawStopName) {
  // Fold duplicate records of one station (platform children, punctuation twins) before the
  // route check, so a duplicate can't make a single station look ambiguous or unconfirmed.
  candidates = collapseEquivalentStopCandidates(candidates, { strict: true, direction });
  if (!route || candidates.length === 1) return candidates[0];

  const routeResult = await _filterCandidatesByRoute(candidates, agency, route);
  let narrowed = routeResult.candidates;
  if (routeResult.confirmed) narrowed = collapseEquivalentStopCandidates(narrowed, { direction });
  if (narrowed.length === 0) {
    if (candidates.length === 1) return candidates[0];
    console.warn(`lookupStop: ${candidates.length} stops named "${rawStopName}" but none confirmed for route ${route} via stopRoutes`);
    return null;
  }

  if (narrowed.length === 1) return narrowed[0];

  if (direction) {
    const dirFiltered = narrowed.filter(c => _directionMatches(getStopCandidateDirection(c), direction));
    if (dirFiltered.length === 1) return dirFiltered[0];
    if (dirFiltered.length > 1) narrowed = dirFiltered;
  }

  const modePreferred = _preferCandidatesByRouteMode(narrowed, agency, route);
  if (modePreferred.length === 1) return modePreferred[0];
  if (modePreferred.length > 1 && modePreferred.length < narrowed.length) narrowed = modePreferred;

  // Keep ambiguity explicit unless route+direction leave only one valid stop.
  return narrowed.length === 1 ? narrowed[0] : null;
}

async function _filterCandidatesByRoute(candidates, agency, route) {
  const normRoute = _normalizeRouteKey(route);
  const confirmed = [];
  const fallback = [];

  for (const candidate of candidates) {
    const localRoutes = Array.isArray(candidate.routes) ? candidate.routes : [];
    if (localRoutes.some(r => _normalizeRouteKey(r) === normRoute)) {
      confirmed.push(candidate);
      continue;
    }
    if (candidate.stopCode) {
      const docId = `${agency}_${candidate.stopCode}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      try {
        const srDoc = await db.collection('stopRoutes').doc(docId).get();
        if (srDoc.exists) {
          const routes = srDoc.data().routes || [];
          if (routes.some(r => _normalizeRouteKey(r) === normRoute)) {
            confirmed.push(candidate);
            continue;
          }
        }
      } catch (_) { /* non-fatal */ }
    }
    if (localRoutes.length === 0) fallback.push(candidate);
  }

  return confirmed.length > 0
    ? { candidates: confirmed, confirmed: true }
    : { candidates: fallback, confirmed: false };
}

function _normalizeRouteKey(route) {
  return route?.toString().replace(/\s+/g, '').toLowerCase() || '';
}

function _directionMatches(candidateDirection, requestedDirection) {
  if (!candidateDirection || !requestedDirection) return false;
  const normalize = value => value.toString().trim().toLowerCase().replace(/bound$/, '');
  return normalize(candidateDirection) === normalize(requestedDirection);
}

function _preferCandidatesByRouteMode(candidates, agency, route) {
  if (!Array.isArray(candidates) || candidates.length <= 1) return candidates;

  const routeMode = _inferRouteMode(route, agency);
  if (routeMode === 'unknown') return candidates;

  const preferred = candidates.filter(candidate => _candidateMatchesRouteMode(candidate, routeMode));
  return preferred.length > 0 ? preferred : candidates;
}

function _inferRouteMode(route, agency) {
  const routeStr = route?.toString().trim();
  if (!routeStr) return 'unknown';

  if (agency === 'TTC') {
    if (/^[1-6]$/.test(routeStr)) return 'rapid';
    if (/^5\d\d/.test(routeStr)) return 'surface';
    if (/^\d+/.test(routeStr)) return 'surface';
  }

  return 'unknown';
}

function _candidateMatchesRouteMode(candidate, routeMode) {
  const stopName = candidate?.stopName?.toString() || '';
  const hasDirection = !!candidate?.direction;
  const isStationLike = /\bstation\b/i.test(stopName);
  const isSurfaceNamed = /\/| at |&/i.test(stopName);

  if (routeMode === 'rapid') {
    return isStationLike || !hasDirection;
  }

  if (routeMode === 'surface') {
    if (hasDirection) return true;
    if (isSurfaceNamed) return true;
    return !isStationLike;
  }

  return true;
}

module.exports = {
  lookupStop,
  lookupStopCheck,
  findMatchingStops,
  getRoutesAtStop,
  getStopsLibrary,
  _lookupStopInTopology,
  _findStopCandidates,
  _preferCandidatesByRouteMode,
};
