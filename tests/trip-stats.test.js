import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { summaryTrips } from '../js/shared/ride-merge.js';
import {
    computeSummaryStats,
    isActiveTrip,
    isHistoryTrip,
    storedTripTimeZone,
    tripDayKey,
} from '../js/shared/trip-stats.js';
import { generated } from '../scripts/sync-shared.mjs';

// The public profile runs the generated CommonJS copies in Cloud Functions.
const require = createRequire(import.meta.url);
const serverStats = require('../functions/lib/trip-stats.js');
const serverRideMerge = require('../functions/lib/ride-merge.js');
const serverPrestoTrips = require('../functions/lib/presto-trips.js');

const originalTz = process.env.TZ;
afterAll(() => { process.env.TZ = originalTz; });

const HOUR = 60 * 60 * 1000;
// October 2026 is EDT (UTC-4).
const toronto = (m, d, h, min = 0) => new Date(Date.UTC(2026, m - 1, d, h + 4, min));
const prestoFare = (m, d, h, min, agency = 'TTC') => ({
    type: 'fare_payment',
    agency,
    amountCents: -330,
    occurredAtSortKey: Date.UTC(2026, m - 1, d, h, min), // PRESTO wall clock
});

const loggedTrips = [
    // 9:00 PM Toronto on Oct 20 is 1:00 AM UTC on Oct 21.
    { agency: 'TTC', route: '501', duration: 25, startTime: toronto(10, 20, 21), endTime: toronto(10, 20, 21, 25), timezone: 'America/Toronto' },
    { agency: 'TTC', route: '501', duration: 30, startTime: toronto(10, 21, 8), endTime: toronto(10, 21, 8, 30), timezone: 'America/Toronto' },
    // No stored timezone: the public profile falls back to Toronto.
    { agency: 'ttc', route: '504A', duration: 12, startTime: toronto(10, 22, 23, 30), endTime: toronto(10, 22, 23, 42) },
    { agency: 'GO', route: 'LW', duration: 45, startTime: toronto(9, 1, 7), endTime: toronto(9, 1, 7, 45), timezone: 'America/Toronto' },
    { agency: ' TTC ', route: '501 ', duration: 7, startTime: { toDate: () => toronto(10, 23, 12) }, discarded: true },
];
const prestoRecords = [
    prestoFare(10, 21, 8, 2),          // the logged 8:00 AM ride, recorded again
    prestoFare(10, 24, 22, 15),        // 10:15 PM Toronto, 2:15 AM UTC the next day
    prestoFare(10, 25, 9, 0, 'MiWay'),
];
const now = toronto(10, 26, 12);

describe('dashboard and public profile give the same totals', () => {
    it('matches on every tile, including a 9pm trip that crosses midnight UTC', () => {
        // Dashboard: a viewer in Toronto, days in the browser's local time.
        process.env.TZ = 'America/Toronto';
        const dashboard = computeSummaryStats(
            summaryTrips(loggedTrips, serverPrestoTrips.buildPrestoTrips(prestoRecords)),
            { now },
        );

        // Public profile: a server on UTC, days in each trip's stored timezone.
        process.env.TZ = 'UTC';
        const prestoTrips = serverRideMerge.unmatchedImportedRides(loggedTrips, serverPrestoTrips.buildPrestoTrips(prestoRecords));
        const publicStats = serverStats.computeSummaryStats(
            [...loggedTrips, ...serverRideMerge.projectPrestoTripsForStats(prestoTrips)],
            { now, timeZoneFor: serverStats.storedTripTimeZone },
        );

        expect(publicStats).toEqual(dashboard);
        expect(dashboard).toEqual({
            totalTrips: 7,
            thisMonth: 6,
            thisWeek: 6,
            daysRidden: 7,
            totalHours: 2,
            agencies: 4,
            routes: 4,
            countries: 1,
        });
    });

    it('would have split the 9pm trip onto the next day on a UTC clock', () => {
        process.env.TZ = 'UTC';
        const nine = loggedTrips[0].startTime;
        expect(tripDayKey(nine)).toBe('2026-10-21');
        expect(tripDayKey(nine, storedTripTimeZone(loggedTrips[0]))).toBe('2026-10-20');
    });
});

describe('trip-stats helpers', () => {
    it('falls back to Toronto for a missing or unknown timezone', () => {
        const nine = toronto(10, 20, 21);
        expect(storedTripTimeZone({})).toBe('America/Toronto');
        expect(tripDayKey(nine, 'Not/AZone')).toBe('2026-10-20');
        expect(tripDayKey(nine, 'America/Vancouver')).toBe('2026-10-20');
        expect(tripDayKey(nine, 'Europe/Paris')).toBe('2026-10-21');
    });

    it('keeps a trip active for 6 hours unless it ended or was discarded', () => {
        const start = toronto(10, 26, 6);
        const at = (hours) => start.getTime() + hours * HOUR;
        const open = { startTime: start };
        expect(isActiveTrip(open, at(5.9))).toBe(true);
        expect(isHistoryTrip(open, at(5.9))).toBe(false);
        expect(isActiveTrip(open, at(6))).toBe(false);
        expect(isHistoryTrip(open, at(6))).toBe(true);
        expect(isHistoryTrip({ ...open, endTime: start }, at(1))).toBe(true);
        expect(isHistoryTrip({ ...open, discarded: true }, at(1))).toBe(true);
        expect(isActiveTrip({ startTime: 'bad' }, at(1))).toBe(false);
        expect(isHistoryTrip({ startTime: 'bad' }, at(1))).toBe(false);
    });
});

describe('functions/lib/trip-stats.js', () => {
    it('is in sync with js/shared/trip-stats.js (run `npm run sync:shared`)', () => {
        const copy = readFileSync(resolve(process.cwd(), 'functions/lib/trip-stats.js'), 'utf8');
        expect(copy).toBe(generated('trip-stats'));
    });
});
