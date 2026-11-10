// Combines logged trips with imported PRESTO rides without double counting.
//
// This file is the single source of truth. The Cloud Functions can't import
// from js/, so functions/lib/ride-merge.js is generated from it by
// `npm run sync:shared` (a test fails if the copy drifts). Keep it to plain
// `export function` declarations, importing only from other shared modules.
import { canonicalAgency } from './agency-aliases.js';

const RIDE_MATCH_WINDOW_MS = 30 * 60 * 1000;
const PRESTO_TIME_ZONE = 'America/Toronto';

/** Agency key for matching rides: the canonical name, lowercased. */
export function normalizeRideAgency(value) {
    return String(canonicalAgency(String(value || '')) || '').toLowerCase();
}

// Building a formatter is slow, so each time zone gets one, made on first use.
const WALL_CLOCK_FORMATTERS = new Map();

function wallClockFormatter(timeZone) {
    let formatter = WALL_CLOCK_FORMATTERS.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric',
        });
        WALL_CLOCK_FORMATTERS.set(timeZone, formatter);
    }
    return formatter;
}

// PRESTO exports carry wall-clock times with no zone. occurredAtSortKey is that
// wall clock read as UTC, so convert it to the real instant (the rider is in
// the Toronto area) before comparing against logged trips, which are true
// instants.
export function prestoWallClockToInstant(sortKey, timeZone = PRESTO_TIME_ZONE) {
    if (sortKey === null || sortKey === undefined || sortKey === '') return null;
    const wall = Number(sortKey);
    if (!Number.isFinite(wall)) return null;
    const formatter = wallClockFormatter(timeZone);
    const offsetAt = (instant) => {
        const parts = {};
        formatter.formatToParts(new Date(instant)).forEach(part => { parts[part.type] = Number(part.value); });
        const asWall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
        return asWall - Math.floor(instant / 1000) * 1000;
    };
    let instant = wall - offsetAt(wall);
    instant = wall - offsetAt(instant);
    return instant;
}

function loggedTripTime(trip) {
    const value = trip?.startTime;
    if (value === null || value === undefined) return null;
    const date = value?.toDate ? value.toDate() : new Date(value);
    const time = date.getTime();
    return Number.isFinite(time) ? time : null;
}

// Works for both a PRESTO trip ({ startRecord }) and a bare PRESTO record.
export function importedRideTime(ride) {
    const record = ride?.startRecord || ride;
    if (record?.occurredAtSortKey != null) return prestoWallClockToInstant(record.occurredAtSortKey);
    return loggedTripTime(ride);
}

/**
 * One-to-one matching, closest first. Each logged trip cancels at most one
 * imported ride (the same ride recorded twice) within windowMs, and only when
 * their agencies agree (or either side has none). Returns the set of imported
 * indexes that matched a logged trip.
 */
export function matchImportedRides(loggedTrips, importedRides, windowMs = RIDE_MATCH_WINDOW_MS) {
    const logged = loggedTrips || [];
    const imported = importedRides || [];

    // Each ride's time and agency are worked out once, and the imported rides
    // are put in time order, so a logged trip is compared only with the
    // imported rides inside its window instead of with every one of them.
    const agencyKeys = new Map();
    const agencyOf = (ride) => {
        const raw = ride?.agency || ride?.startRecord?.agency || ride?.startRecord?.agencySource;
        if (!agencyKeys.has(raw)) agencyKeys.set(raw, normalizeRideAgency(raw));
        return agencyKeys.get(raw);
    };
    const timed = [];
    imported.forEach((ride, importedIndex) => {
        const time = importedRideTime(ride);
        if (time === null) return;
        timed.push({ time, agency: agencyOf(ride), importedIndex });
    });
    timed.sort((a, b) => a.time - b.time || a.importedIndex - b.importedIndex);

    const pairs = [];
    logged.forEach((trip, loggedIndex) => {
        const loggedTime = loggedTripTime(trip);
        if (loggedTime === null) return;
        const loggedAgency = agencyOf(trip);
        // First imported ride at or after the start of this trip's window.
        const earliest = loggedTime - windowMs;
        let low = 0;
        let high = timed.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (timed[middle].time < earliest) low = middle + 1;
            else high = middle;
        }
        for (let i = low; i < timed.length; i++) {
            const { time, agency, importedIndex } = timed[i];
            const gap = Math.abs(time - loggedTime);
            if (!(gap <= windowMs)) break;
            if (loggedAgency && agency && loggedAgency !== agency) continue;
            pairs.push({ gap, loggedIndex, importedIndex });
        }
    });
    pairs.sort((a, b) => a.gap - b.gap || a.loggedIndex - b.loggedIndex || a.importedIndex - b.importedIndex);

    const usedLogged = new Set();
    const matchedImported = new Set();
    pairs.forEach(({ loggedIndex, importedIndex }) => {
        if (usedLogged.has(loggedIndex) || matchedImported.has(importedIndex)) return;
        usedLogged.add(loggedIndex);
        matchedImported.add(importedIndex);
    });
    return matchedImported;
}

/** Imported rides that are NOT already represented by a logged trip. */
export function unmatchedImportedRides(loggedTrips, importedRides, windowMs = RIDE_MATCH_WINDOW_MS) {
    const matched = matchImportedRides(loggedTrips, importedRides, windowMs);
    return (importedRides || []).filter((_, index) => !matched.has(index));
}

/** Logged trips plus the imported rides they don't already cover. */
export function mergeImportedRides(loggedTrips, importedRides, windowMs = RIDE_MATCH_WINDOW_MS) {
    return [...(loggedTrips || []), ...unmatchedImportedRides(loggedTrips, importedRides, windowMs)];
}

/**
 * A lightweight `{ agency, startTime, imported }` projection of PRESTO trips, shaped to
 * match what the summary stats (js/shared/trip-stats.js) expect from logged
 * trips. This only covers the summary counts (trip counts, agencies, days
 * ridden, countries) that don't depend on duration, route, or stop names —
 * PRESTO trips have none of those, so they stay out of the richer metrics
 * (top routes/stops, peak times, streaks, highlights).
 */
export function projectPrestoTripsForStats(prestoTrips = []) {
    return prestoTrips
        .map(trip => ({ trip, time: importedRideTime(trip) }))
        .filter(({ time }) => Number.isFinite(time))
        .map(({ trip, time }) => ({
            agency: trip.agency,
            startTime: new Date(time),
            imported: true,
        }));
}

/**
 * Logged trips plus the imported PRESTO rides that weren't also logged. Call
 * it through countedRides (trip-stats.js), which first keeps only the logged
 * trips that count.
 */
export function summaryTrips(loggedTrips, prestoTrips) {
    return [
        ...(loggedTrips || []),
        ...projectPrestoTripsForStats(unmatchedImportedRides(loggedTrips, prestoTrips)),
    ];
}
