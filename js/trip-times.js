/**
 * TransitStats - trip times between two stops on one route.
 * Pure computation (no DOM): which trips count, how they group into
 * route + start stop + end stop pairs, and the duration stats for a pair.
 */
import { boardingStop, exitStop, tripAgency, tripLocalHour, tripStartDate } from './shared/trip-stats.js';
import { usableStopLabel } from './trip-display.js';
import { stationBaseName, stopNameKey } from './shared/station-names.js';

/** Trips longer than this are treated as a forgotten end, not a real ride. */
export const MAX_TRIP_MINUTES = 180;

/** A time-of-day row needs at least this many trips to be shown. */
export const MIN_BUCKET_TRIPS = 3;

/** Time-of-day rows, by the local start hour in each trip's own time zone. */
export const TIME_OF_DAY_BUCKETS = [
    { key: 'morning', label: 'Morning peak', hours: '6 to 10 am', from: 6, to: 10 },
    { key: 'midday', label: 'Midday', hours: '10 am to 3 pm', from: 10, to: 15 },
    { key: 'afternoon', label: 'Afternoon peak', hours: '3 to 7 pm', from: 15, to: 19 },
    { key: 'evening', label: 'Evening and night', hours: '7 pm to 6 am', from: 19, to: 6 },
];

/**
 * Route family: "510A", "510B" and "510 Shuttle" all ride as "510". Same rule
 * as the prediction engine's _baseRoute (functions/lib/predict_v3.js): only
 * routes that start with a digit are trimmed, so "Line 1" stays as it is.
 */
export function routeFamily(route) {
    const s = String(route ?? '').trim();
    if (!/^\d/.test(s)) return s;
    return s.match(/^\d+/)[0];
}

function toDate(value) {
    if (value === null || value === undefined) return null;
    const date = value.toDate ? value.toDate() : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Minutes from start to end, or null when either time is missing. */
export function tripMinutes(trip) {
    const start = tripStartDate(trip);
    const end = toDate(trip?.endTime);
    if (!start || !end) return null;
    return (end.getTime() - start.getTime()) / 60000;
}

/**
 * A trip whose time can be measured: both times recorded, not discarded or
 * ended early, longer than zero and no longer than three hours.
 */
export function isTimedTrip(trip) {
    if (!trip || trip.discarded || trip.incomplete) return false;
    const minutes = tripMinutes(trip);
    return minutes !== null && minutes > 0 && minutes <= MAX_TRIP_MINUTES;
}

/** The p-th percentile (0 to 100) of an ascending list, interpolating between neighbours. */
export function percentile(sorted, p) {
    if (!sorted.length) return null;
    const rank = (p / 100) * (sorted.length - 1);
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export function median(sorted) {
    return percentile(sorted, 50);
}

/** Trip count, median, middle half (25th to 75th percentile), fastest and slowest, in minutes. */
export function durationStats(minutes) {
    const sorted = [...minutes].sort((a, b) => a - b);
    return {
        count: sorted.length,
        median: median(sorted),
        p25: percentile(sorted, 25),
        p75: percentile(sorted, 75),
        fastest: sorted.length ? sorted[0] : null,
        slowest: sorted.length ? sorted[sorted.length - 1] : null,
    };
}

/** The time-of-day bucket key for a local hour (0 to 23). */
export function timeOfDayBucket(hour) {
    if (hour === null || hour === undefined) return null;
    const bucket = TIME_OF_DAY_BUCKETS.find(b => (b.from < b.to
        ? hour >= b.from && hour < b.to
        : hour >= b.from || hour < b.to));
    return bucket ? bucket.key : null;
}

/**
 * Median per time of day for a pair's trips. Rows with fewer than
 * `minTrips` trips are left out.
 */
export function timeOfDayMedians(trips, { minTrips = MIN_BUCKET_TRIPS, hourOf = tripLocalHour } = {}) {
    const groups = new Map(TIME_OF_DAY_BUCKETS.map(b => [b.key, []]));
    (trips || []).forEach(trip => {
        const key = timeOfDayBucket(hourOf(trip));
        const minutes = tripMinutes(trip);
        if (key && minutes !== null) groups.get(key).push(minutes);
    });
    return TIME_OF_DAY_BUCKETS
        .map(b => ({ ...b, count: groups.get(b.key).length, median: median([...groups.get(b.key)].sort((x, y) => x - y)) }))
        .filter(row => row.count >= minTrips);
}

function mostCommon(labels) {
    const counts = new Map();
    labels.forEach(label => counts.set(label, (counts.get(label) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/**
 * The grouping key for a stop: resolve the typed name to its library record
 * with the app's alias lookup (`canonicalizeStop`), then use that record's
 * station name, so platform records ("Queen's Park Station - Northbound
 * Platform") group under their station. Same rule as the backend's stopNameKey.
 */
export function stopGroupKey(label, agency, canonicalizeStop) {
    const resolved = canonicalizeStop(label, agency) || label;
    return stopNameKey(resolved) || null;
}

/**
 * Timed trips grouped by agency, route family, start stop and end stop, most
 * trips first. Direction is part of the pair (A to B is not B to A). Each
 * pair shows the station name of the spelling used most often.
 */
export function buildTripPairs(trips, { canonicalizeStop }) {
    const pairs = new Map();
    (trips || []).filter(isTimedTrip).forEach(trip => {
        const route = trip.route ? String(trip.route).trim() : '';
        const startLabel = usableStopLabel(boardingStop(trip));
        const endLabel = usableStopLabel(exitStop(trip));
        if (!route || !startLabel || !endLabel) return;
        const agency = tripAgency(trip);
        const startKey = stopGroupKey(startLabel, agency, canonicalizeStop);
        const endKey = stopGroupKey(endLabel, agency, canonicalizeStop);
        if (!startKey || !endKey || startKey === endKey) return;
        const family = routeFamily(route);
        const routeKey = `${(agency || '').toLowerCase()}\u0000${family.toLowerCase()}`;
        const key = `${routeKey}\u0000${startKey}\u0000${endKey}`;
        if (!pairs.has(key)) {
            pairs.set(key, { key, routeKey, agency, route: family, startKey, endKey, trips: [], routes: [], starts: [], ends: [] });
        }
        const pair = pairs.get(key);
        pair.trips.push(trip);
        pair.routes.push(route);
        pair.starts.push(startLabel);
        pair.ends.push(endLabel);
    });
    return [...pairs.values()]
        .map(({ routes, starts, ends, ...pair }) => ({
            ...pair,
            variants: [...new Set(routes)].sort(),
            startLabel: mostCommon(starts.map(stationBaseName)),
            endLabel: mostCommon(ends.map(stationBaseName)),
        }))
        .sort((a, b) => b.trips.length - a.trips.length || a.key.localeCompare(b.key));
}

/** Everything the page shows for one pair. */
export function summarizePair(pair, options = {}) {
    return {
        ...durationStats(pair.trips.map(tripMinutes)),
        timeOfDay: timeOfDayMedians(pair.trips, options),
    };
}
