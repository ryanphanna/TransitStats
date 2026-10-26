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

/**
 * Match one imported PRESTO location without inventing a direction.
 *
 * This is intentionally exact-name/alias matching. Multiple directional
 * records remain ambiguous candidates; pairing them is a separate map concern.
 */
export function matchPrestoRecord(record, stops = []) {
    const agency = record?.agency || record?.agencySource || null;
    const target = normalizeStopLibraryLabel(record?.locationLabel || record?.location);
    if (!target) return { status: 'unmatched', candidates: [] };

    const candidates = [];
    const seen = new Map();
    for (const stop of stops) {
        if (!stopBelongsToAgency(stop, agency)) continue;
        if (!stopLabels(stop).includes(target)) continue;

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

    if (candidates.length === 0) return { status: 'unmatched', candidates: [] };
    if (candidates.length > 1) return { status: 'ambiguous', candidates };
    return { status: 'matched', candidate: candidates[0], candidates };
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
export function resolvePrestoStopLocation(record, stops = []) {
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
