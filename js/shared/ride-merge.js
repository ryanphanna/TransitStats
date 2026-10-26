// Combines logged trips with imported PRESTO rides without double counting.
//
// This file is the single source of truth. The Cloud Functions can't import
// from js/, so functions/lib/ride-merge.js is generated from it by
// `npm run sync:shared` (a test fails if the copy drifts). Keep this file
// dependency-free, with plain `export function` declarations only.

const RIDE_MATCH_WINDOW_MS = 30 * 60 * 1000;
const PRESTO_TIME_ZONE = 'America/Toronto';

const AGENCY_ALIASES = {
    'toronto transit commission': 'ttc',
    'go transit': 'go',
    'mississauga transit': 'miway',
    'hamilton street railway': 'hsr',
    'york region transit': 'yrt',
};

export function normalizeRideAgency(value) {
    const key = String(value || '').trim().toLowerCase();
    return AGENCY_ALIASES[key] || key;
}

// PRESTO exports carry wall-clock times with no zone. occurredAtSortKey is that
// wall clock read as UTC, so convert it to the real instant (the rider is in
// the Toronto area) before comparing against logged trips, which are true
// instants.
export function prestoWallClockToInstant(sortKey, timeZone = PRESTO_TIME_ZONE) {
    if (sortKey === null || sortKey === undefined || sortKey === '') return null;
    const wall = Number(sortKey);
    if (!Number.isFinite(wall)) return null;
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
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

function rideAgency(ride) {
    return normalizeRideAgency(ride?.agency || ride?.startRecord?.agency || ride?.startRecord?.agencySource);
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
    const pairs = [];

    logged.forEach((trip, loggedIndex) => {
        const loggedTime = loggedTripTime(trip);
        if (loggedTime === null) return;
        const loggedAgency = rideAgency(trip);
        imported.forEach((ride, importedIndex) => {
            const importedTime = importedRideTime(ride);
            if (importedTime === null) return;
            const importedAgency = rideAgency(ride);
            if (loggedAgency && importedAgency && loggedAgency !== importedAgency) return;
            const gap = Math.abs(importedTime - loggedTime);
            if (gap <= windowMs) pairs.push({ gap, loggedIndex, importedIndex });
        });
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
 * A lightweight `{ agency, startTime }` projection of PRESTO trips, shaped to
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
        }));
}

/**
 * The trips behind the summary tiles: logged history trips plus the imported
 * PRESTO rides that weren't also logged. The dashboard and the public profile
 * both use this, so they count the same rides.
 */
export function summaryTrips(loggedTrips, prestoTrips) {
    return [
        ...(loggedTrips || []),
        ...projectPrestoTripsForStats(unmatchedImportedRides(loggedTrips, prestoTrips)),
    ];
}
