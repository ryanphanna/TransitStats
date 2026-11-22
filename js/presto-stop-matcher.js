import { normalizeStopLibraryLabel, stopBelongsToAgency } from './stop-library-match.js';
import { projectPrestoTripsForStats } from './shared/ride-merge.js';
import { buildPrestoTrips } from './shared/presto-trips.js';

function validLocation(stop) {
    const lat = Number(stop?.lat);
    const lng = Number(stop?.lng ?? stop?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) return null;
    return { lat, lng };
}

function stopLabels(stop) {
    return [stop?.code, stop?.name, ...(stop?.aliases || [])]
        .filter(Boolean)
        .map(normalizeStopLibraryLabel)
        .filter(Boolean);
}

function candidateKey(stop) {
    const agency = String(stop?.agency || (stop?.agencies || [])[0] || '').toLowerCase();
    const code = normalizeStopLibraryLabel(stop?.code);
    if (code) return `${agency}:code:${code}`;

    const location = validLocation(stop);
    return `${agency}:label:${normalizeStopLibraryLabel(stop?.name)}:${location?.lat?.toFixed(5) || ''}:${location?.lng?.toFixed(5) || ''}`;
}

function serializeCandidate(stop, source) {
    return {
        id: stop.id || null,
        name: stop.name || stop.stopName || stop.code || null,
        code: stop.code || null,
        direction: stop.direction || null,
        routes: Array.isArray(stop.routes) ? stop.routes : [],
        location: validLocation(stop),
        source,
    };
}

function sourceForStop(stop, fallback) {
    return stop?.__prestoSource === 'atlas' ? 'atlas' : (fallback || 'firestore');
}

// PRESTO cuts location names off at 39 characters ("... South Si").
const PRESTO_LABEL_LIMIT = 39;

/** One physical place: a station and its platform records, or one stop name. */
function placeKey(label) {
    return normalizeStopLibraryLabel(label)
        .replace(/(north|south|east|west)?(bound)?(subway|bus)?platform\d*$/, '')
        .replace(/station$/, '');
}

/** A place's name without a platform suffix: "Museum Station - Northbound Platform" -> "Museum Station". */
function placeName(name) {
    return String(name || '').replace(/\s*-\s*((north|south|east|west)bound|subway|bus)\s+platform.*$/i, '').trim();
}

function collectCandidates(stops, agency, test) {
    const candidates = [];
    const seen = new Map();
    for (const stop of stops) {
        if (!stopBelongsToAgency(stop, agency)) continue;
        if (!test(stop)) continue;
        const key = candidateKey(stop);
        const candidate = serializeCandidate(stop, sourceForStop(stop, stop.__prestoSource));
        const existingIndex = seen.get(key);
        if (existingIndex !== undefined) {
            // Prefer the copy with coordinates when the same stop exists in
            // both the normalized library and the Atlas feed.
            if (!candidates[existingIndex].location && candidate.location) {
                candidates[existingIndex] = candidate;
            }
            continue;
        }
        seen.set(key, candidates.length);
        candidates.push(candidate);
    }
    return candidates;
}

/**
 * Several records for one place (a station's platforms, or both directions
 * of a stop) count as that one place: the stop library's record wins, then
 * any record with coordinates. Records for different places stay ambiguous.
 */
function onePlace(candidates) {
    const keys = new Set(candidates.map(candidate => placeKey(candidate.name)));
    if (keys.size !== 1) return null;
    const ranked = [...candidates].sort((a, b) =>
        (b.source === 'firestore') - (a.source === 'firestore') || (!!b.location) - (!!a.location));
    const best = ranked[0];
    const location = best.location || ranked.find(candidate => candidate.location)?.location || null;
    const named = ranked.find(candidate => candidate.source === 'firestore') || best;
    // The place is known; which direction or platform is not, so none is claimed.
    return { ...best, name: placeName(named.name), code: null, direction: null, location };
}

/**
 * Match one imported PRESTO location without inventing a direction.
 *
 * Exact name, alias or code first (names the rider's own stop library uses
 * win over Atlas-only names). If nothing matches exactly, a name PRESTO cut
 * short matches the full name it starts, and a station matches its platform
 * records. Matches that are all one place resolve to that place.
 */
export function matchPrestoRecord(record, stops = []) {
    const agency = record?.agency || record?.agencySource || null;
    const raw = String(record?.locationLabel || record?.location || '').trim();
    const target = normalizeStopLibraryLabel(raw);
    if (!target || /^\d+$/.test(target) && Number(target) === 0) return { status: 'unmatched', candidates: [] };

    let candidates = collectCandidates(stops, agency, stop => stopLabels(stop).includes(target));
    if (candidates.length > 1) {
        // A record named exactly this beats one that only lists it as an alias.
        const named = candidates.filter(candidate => normalizeStopLibraryLabel(candidate.name) === target);
        if (named.length) candidates = named;
        const library = candidates.filter(candidate => candidate.source === 'firestore');
        if (library.length && library.length < candidates.length && onePlace(library)) candidates = library;
    }
    if (candidates.length === 0 && raw.length >= PRESTO_LABEL_LIMIT - 1) {
        candidates = collectCandidates(stops, agency, stop => normalizeStopLibraryLabel(stop.name).startsWith(target));
    }
    if (candidates.length === 0) {
        const place = placeKey(raw);
        if (place) candidates = collectCandidates(stops, agency, stop => placeKey(stop.name) === place);
    }

    if (candidates.length === 0) return { status: 'unmatched', candidates: [] };
    if (candidates.length === 1) {
        const [only] = candidates;
        if (only.location) return { status: 'matched', candidate: only, candidates };
        // A library record without coordinates borrows them from another record for the same place.
        const place = placeKey(only.name);
        const located = collectCandidates(stops, agency, stop => placeKey(stop.name) === place).find(candidate => candidate.location);
        return { status: 'matched', candidate: { ...only, location: located?.location || null }, candidates };
    }
    const place = onePlace(candidates);
    if (place) return { status: 'matched', candidate: place, candidates };
    return { status: 'ambiguous', candidates };
}

export function matchPrestoRecords(records = [], stops = []) {
    const counts = { matched: 0, ambiguous: 0, unmatched: 0 };
    const results = records.map(record => {
        const match = matchPrestoRecord(record, stops);
        counts[match.status] += 1;
        return { record, match };
    });
    return { counts, results };
}

/**
 * Adapter for the existing map resolver. Ambiguous or coordinate-less matches
 * stay unresolved rather than selecting one directional stop arbitrarily.
 */
/**
 * The match fields saved on an imported PRESTO row: its status and, when
 * exactly one stop matched, that stop. Stored at import (and by the backfill
 * tool) so the stop is known without re-matching on every map load.
 */
export function prestoMatchFields(record, stops = []) {
    const match = matchPrestoRecord(record, stops);
    if (match.status !== 'matched') return { stopMatchStatus: match.status, matchedStop: null };
    const { id, name, code, location } = match.candidate;
    return { stopMatchStatus: 'matched', matchedStop: { id: id || null, name: name || null, code: code || null, location: location || null } };
}

export function resolvePrestoStopLocation(record, stops = []) {
    // A stop saved at import is used as is; anything else is matched now, so a
    // stop alias added later still fixes rows that didn't match at import.
    if (record?.stopMatchStatus === 'matched' && record.matchedStop?.location) {
        return {
            source: 'saved',
            location: record.matchedStop.location,
            label: record.matchedStop.name,
            match: 'exact',
            matchStatus: 'matched',
            candidates: [],
        };
    }
    const match = matchPrestoRecord(record, stops);
    if (match.status !== 'matched' || !match.candidate.location) {
        return {
            source: 'unresolved',
            location: null,
            matchStatus: match.status,
            candidates: match.candidates,
        };
    }

    return {
        source: match.candidate.source,
        location: match.candidate.location,
        label: match.candidate.name,
        match: 'exact',
        matchStatus: 'matched',
        candidates: match.candidates,
    };
}

export function preparePrestoStops({ atlasStops = [], firestoreStops = [] } = {}) {
    return [
        ...firestoreStops.map(stop => ({ ...stop, __prestoSource: 'firestore' })),
        ...atlasStops.map(stop => ({ ...stop, __prestoSource: 'atlas' })),
    ];
}

// The projection lives in js/shared/ride-merge.js so the public profile
// function uses the same one.
export { buildPrestoTrips, projectPrestoTripsForStats };
