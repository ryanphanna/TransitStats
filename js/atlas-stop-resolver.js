/**
 * Read-only stop resolution shared by the Atlas beta surfaces.
 * GTFS stop data from Atlas is the only geographic source used by map views.
 */

export function normalizeStopLabel(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeMatchLabel(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\b(st|street)\b/g, 'street')
        .replace(/\b(rd|road)\b/g, 'road')
        .replace(/\b(ave|avenue)\b/g, 'avenue')
        .replace(/\b(blvd|boulevard)\b/g, 'boulevard')
        .replace(/\b(dr|drive)\b/g, 'drive')
        .replace(/\b(hwy|highway)\b/g, 'highway')
        .replace(/\b(centre|ctr)\b/g, 'center')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function matchTokens(value) {
    return new Set(normalizeMatchLabel(value).split(' ').filter(token => token.length > 1));
}

export function validLocation(location) {
    const lat = Number(location?.lat);
    const lng = Number(location?.lng ?? location?.lon);
    // Missing GTFS coordinates are sometimes serialized as 0,0. Treat them
    // as unresolved so they cannot pull a city map out to the whole world.
    return Number.isFinite(lat) && Number.isFinite(lng)
        && lat !== 0 && lng !== 0
        ? { lat, lng }
        : null;
}

function agencyKey(value) {
    return String(value || '').trim().toLowerCase();
}

function indexKey(agency, label) {
    const normalized = normalizeStopLabel(label);
    if (!normalized) return null;
    return `${agency ? agencyKey(agency) : '*'}:${normalized}`;
}

function stopLabels(stop) {
    return [stop.code, stop.name, ...(stop.aliases || [])].filter(Boolean);
}

function addStops(index, stops, source) {
    const stopsByAgency = index.stopsByAgency || new Map();
    (stops || []).forEach(stop => {
        const location = validLocation(stop);
        if (!location) return;
        const displayName = stop.name || stop.stopName || stop.code || null;
        const key = agencyKey(stop.agency);
        if (!stopsByAgency.has(key)) stopsByAgency.set(key, []);
        stopsByAgency.get(key).push({ stop, location, source, label: displayName });

        stopLabels(stop).forEach(label => {
            const labelKey = indexKey(stop.agency, label);
            if (labelKey && !index.has(labelKey)) {
                index.set(labelKey, { location, source, label: displayName, match: 'exact' });
            }
        });
    });
    index.stopsByAgency = stopsByAgency;
}

export function buildStopIndex({ atlasStops = [], normalizedStops = [] } = {}) {
    const index = new Map();

    addStops(index, atlasStops, 'atlas');
    addStops(index, normalizedStops, 'firestore');
    addNormalizedAliases(index, normalizedStops);
    return index;
}

function lookup(index, agency, label) {
    const normalized = normalizeStopLabel(label);
    if (!normalized) return null;

    return index.get(`${agencyKey(agency)}:${normalized}`)
        || index.get(`*:${normalized}`)
        || null;
}

function fuzzyLookup(index, agency, label) {
    const query = normalizeMatchLabel(label);
    const queryTokens = matchTokens(label);
    if (!query || queryTokens.size === 0) return null;

    const candidates = index.stopsByAgency?.get(agencyKey(agency)) || [];
    const ranked = candidates.map(candidate => {
        const name = normalizeMatchLabel(candidate.label);
        const tokens = matchTokens(candidate.label);
        const allQueryTokensMatch = [...queryTokens].every(token => tokens.has(token));
        const commonTokens = [...queryTokens].filter(token => tokens.has(token)).length;
        let score = 0;
        if (name === query) score = 100;
        else if (name.startsWith(query) || query.startsWith(name)) score = 94;
        else if (allQueryTokensMatch) score = 88;
        else if (commonTokens > 0) score = (commonTokens / queryTokens.size) * 70;
        score -= Math.max(0, tokens.size - queryTokens.size) * 0.25;
        return { ...candidate, score };
    }).sort((a, b) => b.score - a.score || a.label.length - b.label.length);

    const best = ranked[0];
    if (!best || best.score < 82) return null;
    return { location: best.location, source: best.source, label: best.label, match: 'fuzzy' };
}

function addNormalizedAliases(index, stops) {
    (stops || []).forEach(stop => {
        const agencies = stop.agencies || (stop.agency ? [stop.agency] : []);
        const labels = stopLabels(stop);
        if (agencies.length === 0 || labels.length === 0) return;

        agencies.forEach(agency => {
            const canonical = labels
                .map(label => lookup(index, agency, label) || fuzzyLookup(index, agency, label))
                .find(Boolean);
            if (!canonical) return;

            labels.forEach(label => {
                const key = indexKey(agency, label);
                if (key && !index.has(key)) {
                    index.set(key, {
                        location: canonical.location,
                        source: 'atlas',
                        label: canonical.label,
                        match: 'normalized-alias',
                    });
                }
            });
        });
    });
}

function predictedExitLabels(trip) {
    const predictions = [];
    if (trip.endStopPrediction?.stop && Number(trip.endStopPrediction.confidence) >= 90) {
        predictions.push(trip.endStopPrediction);
    }

    const versioned = [trip.endStopPredictionV4, trip.endStopPredictionV5];
    if (versioned.every(prediction => prediction?.stop && Number(prediction.confidence) >= 90)
        && normalizeStopLabel(versioned[0].stop) === normalizeStopLabel(versioned[1].stop)) {
        predictions.push(versioned[0]);
    }

    for (const prediction of trip.endStopPredictions || []) {
        if (prediction?.stop && Number(prediction.confidence) >= 90) predictions.push(prediction);
    }

    return predictions
        .filter(prediction => prediction?.stop && Number(prediction.confidence) >= 90)
        .map(prediction => ({
            label: prediction.stop,
            confidence: Number(prediction.confidence),
        }))
        .filter((prediction, index, all) => all.findIndex(item => normalizeStopLabel(item.label) === normalizeStopLabel(prediction.label)) === index);
}

/**
 * Resolve a trip endpoint to GTFS coordinates.
 *
 * `allowPredicted` opts in to drawing a high-confidence exit GUESS for trips
 * that have no exit recorded at all. Guesses are an admin-only suggestion, so
 * the default is off; when on, the result is flagged `estimated: true` so it
 * can never be drawn or counted like a real exit.
 */
export function resolveStopLocation(trip, side, index, { allowPredicted = false } = {}) {
    const stopCode = side === 'boarding' ? trip.startStopCode : trip.endStopCode;
    const stopName = side === 'boarding'
        ? (trip.startStopName || trip.startStop)
        : (trip.endStopName || trip.endStop);
    const agency = trip.agency || null;

    for (const label of [stopCode, stopName]) {
        const match = lookup(index, agency, label);
        if (match) return match;
    }

    const fuzzyMatch = fuzzyLookup(index, agency, stopName);
    if (fuzzyMatch) return fuzzyMatch;

    // A high-confidence prediction is only an input label. Coordinates still
    // come exclusively from the agency's GTFS stop index, and raw stop data
    // wins whenever it is present.
    if (allowPredicted && side === 'exiting' && !stopCode && !stopName) {
        for (const prediction of predictedExitLabels(trip)) {
            const match = lookup(index, agency, prediction.label) || fuzzyLookup(index, agency, prediction.label);
            if (match) {
                return {
                    ...match,
                    match: 'prediction-gtfs',
                    estimated: true,
                    predictionConfidence: prediction.confidence,
                };
            }
        }
    }

    return { location: null, source: 'unresolved' };
}
