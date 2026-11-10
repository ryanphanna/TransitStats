import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPrestoTrips } from '../js/shared/presto-trips.js';
import {
    computeSummaryStats,
    countAgencies,
    countedRides,
    countedTrips,
    durationSummary,
    finishedTrips,
    isCountedTrip,
    isHistoryTrip,
    isUnreadableText,
    ridingStreaks,
    totalTripHours,
    tripAgency,
    tripLocalDay,
    tripsBetweenDays,
    tripsByAgency,
    tripsByDate,
    tripsByRoute,
    tripsByStop,
    weekStartKey,
    COUNT_UNREADABLE_TEXTS,
} from '../js/shared/trip-stats.js';
import { Stats } from '../js/stats.js';

// ASK runs the generated CommonJS copies inside the Cloud Functions.
const require = createRequire(import.meta.url);
const claude = require('../functions/lib/claude.js');

const originalTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Toronto'; });
afterAll(() => { process.env.TZ = originalTz; });

const NOW = Date.parse('2026-11-09T17:00:00Z');
const ZONE = { timeZone: 'America/Toronto' };
const trip = (iso, extra = {}) => ({ userId: 'user-1', agency: 'TTC', startTime: new Date(iso), endTime: null, ...extra });
const finished = (iso, minutes, extra = {}) => trip(iso, {
    endTime: new Date(Date.parse(iso) + minutes * 60000), duration: minutes, ...extra,
});
// PRESTO rows carry Toronto wall-clock times read as UTC.
const presto = (wallClock, agency = 'TTC', userId = 'user-1') => ({
    userId, type: 'fare_payment', agency, amountCents: -330, occurredAtSortKey: Date.parse(`${wallClock}Z`),
});

// What the 13 real records look like: a text that could not be read, later discarded.
const unreadableDiscarded = { userId: 'user-1', source: 'sms_fallback', discarded: true, raw_text: 'hello', timestamp: new Date(NOW) };
const unreadablePending = { userId: 'user-1', source: 'sms_fallback', needs_review: true, raw_text: 'what' };

describe('which records count as trips', () => {
    const readable = [
        finished('2026-09-12T09:00:00-04:00', 20),
        trip('2026-09-30T18:17:00-04:00', { incomplete: true }),
        trip('2026-09-13T09:00:00-04:00', { discarded: true }),
    ];
    const inProgress = trip(new Date(NOW - 60 * 60 * 1000).toISOString());
    const all = [...readable, unreadableDiscarded, unreadablePending, inProgress];

    it('recognises an unreadable text and nothing else', () => {
        expect(isUnreadableText(unreadableDiscarded)).toBe(true);
        expect(isUnreadableText(unreadablePending)).toBe(true);
        readable.forEach(record => expect(isUnreadableText(record)).toBe(false));
        // A fallback record that did get a route or an agency is a real trip.
        expect(isUnreadableText({ source: 'sms_fallback', route: '510' })).toBe(false);
        expect(isUnreadableText({ source: 'sms_fallback', agency: 'TTC' })).toBe(false);
        expect(isUnreadableText({ source: 'sms', discarded: true })).toBe(false);
    });

    it('counts discarded unreadable texts today, as the dashboard always has', () => {
        expect(COUNT_UNREADABLE_TEXTS).toBe(true);
        expect(countedTrips(all, NOW)).toEqual([...readable, unreadableDiscarded]);
        expect(countedTrips(all, NOW)).toEqual(all.filter(record => isHistoryTrip(record, NOW)));
    });

    it('leaves them out of every total when the rule is switched off', () => {
        expect(countedTrips(all, NOW, false)).toEqual(readable);
        expect(isCountedTrip(unreadableDiscarded, NOW, false)).toBe(false);
        expect(countedRides(all, [], { now: NOW, countUnreadableTexts: false })).toHaveLength(3);
        expect(countedRides(all, [], { now: NOW, countUnreadableTexts: true })).toHaveLength(4);
    });

    it('never counts a trip in progress or an unreadable text still awaiting review', () => {
        [true, false].forEach(flag => {
            expect(isCountedTrip(inProgress, NOW, flag)).toBe(false);
            expect(isCountedTrip(unreadablePending, NOW, flag)).toBe(false);
        });
    });

    it('treats only trips with a recorded duration as finished', () => {
        expect(finishedTrips(readable)).toEqual([readable[0]]);
        expect(durationSummary(readable)).toEqual({ minutes: [20], count: 1, average: 20, shortest: 20, longest: 20 });
        expect(durationSummary([])).toEqual({ minutes: [], count: 0, average: null, shortest: null, longest: null });
        expect(totalTripHours([finished('2026-09-12T09:00:00-04:00', 45), ...readable])).toBe(1.1);
    });
});

describe('imported PRESTO rides', () => {
    const logged = [finished('2026-09-12T09:00:00-04:00', 20, { route: '510' })];

    it('skips a ride that was also logged and adds the rest', () => {
        const rides = countedRides(logged, buildPrestoTrips([
            presto('2026-09-12T09:03:00'),                 // the logged ride, recorded again
            presto('2026-09-12T10:30:00'),
            presto('2026-09-13T08:00:00', 'Mississauga Transit'),
            { ...presto('2026-09-14T08:00:00'), type: 'load' }, // not a ride
        ]), { now: NOW });
        expect(rides).toHaveLength(3);
        expect(rides.filter(ride => ride.imported).map(ride => [tripAgency(ride), tripLocalDay(ride, ZONE).dayKey]))
            .toEqual([['TTC', '2026-09-12'], ['MiWay', '2026-09-13']]);
        // Imported rides add trips, agencies and days, but no routes, stops or durations.
        expect(computeSummaryStats(rides, { now: new Date(NOW) })).toMatchObject({
            totalTrips: 3, daysRidden: 2, agencies: 2, routes: 1, totalHours: 0.3,
        });
    });

    it('matches across spelling variants of one agency, never across agencies', () => {
        const toronto = [finished('2026-09-12T09:00:00-04:00', 20, { agency: 'Toronto Transit Commission' })];
        expect(countedRides(toronto, buildPrestoTrips([presto('2026-09-12T09:03:00', 'ttc')]), { now: NOW })).toHaveLength(1);
        expect(countedRides(toronto, buildPrestoTrips([presto('2026-09-12T09:03:00', 'MiWay')]), { now: NOW })).toHaveLength(2);
    });

    it('does not let an uncounted record cancel an imported ride', () => {
        const inProgress = trip(new Date(NOW - 10 * 60 * 1000).toISOString());
        const wallClockNow = new Date(NOW - 5 * 60 * 60 * 1000 - 8 * 60 * 1000).toISOString().slice(0, 19); // EST
        expect(countedRides([inProgress], buildPrestoTrips([presto(wallClockNow)]), { now: NOW })).toHaveLength(1);
    });
});

describe('canonical agency names', () => {
    const trips = ['TTC', ' ttc ', 'Toronto Transit Commission', 'NFTA', 'MFTA', 'NFTA Metro', 'GO', 'GO Transit', 'Some Shuttle', '', null, 42]
        .map(agency => ({ agency }));

    it('merges spelling variants and reports trips with no agency', () => {
        expect(tripsByAgency(trips)).toEqual({
            counts: [['TTC', 3], ['NFTA Metro', 3], ['GO Transit', 2], ['Some Shuttle', 1]],
            withoutAgency: 3,
        });
        expect(countAgencies(trips)).toBe(4);
        expect(computeSummaryStats(trips).agencies).toBe(4);
        expect(computeSummaryStats(trips).countries).toBe(2);
    });
});

describe('calendar days across a clock change', () => {
    // Toronto, 8 March 2026: 02:00 EST jumps to 03:00 EDT (a 23-hour day).
    // Toronto, 1 November 2026: 02:00 EDT falls back to 01:00 EST (a 25-hour day).
    const trips = [
        trip('2026-03-07T23:59:30-05:00'),
        trip('2026-03-08T00:00:30-05:00'),
        trip('2026-03-08T01:59:30-05:00'),
        trip('2026-03-08T03:00:30-04:00'),
        trip('2026-03-08T23:59:30-04:00'),
        trip('2026-03-09T00:00:30-04:00'),
        trip('2026-10-31T23:59:30-04:00'),
        trip('2026-11-01T01:30:00-04:00'),
        trip('2026-11-01T01:30:00-05:00'), // the hour that repeats
        trip('2026-11-01T23:59:30-05:00'),
        trip('2026-11-02T00:00:30-05:00'),
        { userId: 'user-1', discarded: true }, // no start time: counted, on no day
    ];
    const expected = {
        '2026-03-07': 1, '2026-03-08': 4, '2026-03-09': 1, '2026-10-31': 1, '2026-11-01': 3, '2026-11-02': 1,
    };

    it('puts each trip on its local day, in a named zone or the local one', () => {
        [ZONE, {}, { timeZoneFor: () => 'America/Toronto' }].forEach(options => {
            const dates = tripsByDate(trips, options);
            expect(dates.byDay).toEqual(expected);
            expect(dates.withoutDate).toBe(1);
            expect(dates.daysRidden).toBe(6);
            expect(dates.byMonth).toEqual({ '2026-03': 6, '2026-10': 1, '2026-11': 4 });
            expect(dates.byYear).toEqual({ 2026: 11 });
            expect(dates.byWeekday).toEqual({ Saturday: 2, Sunday: 7, Monday: 2 });
            expect(dates.byWeek).toEqual({ '2026-03-02': 5, '2026-03-09': 1, '2026-10-26': 4, '2026-11-02': 1 });
        });
        expect(tripsBetweenDays(trips, '2026-03-08', '2026-03-08', ZONE)).toHaveLength(4);
        expect(tripsBetweenDays(trips, '2026-10-31', '2026-11-01', ZONE)).toHaveLength(4);
        expect(weekStartKey('2026-11-01')).toBe('2026-10-26');
        expect(weekStartKey('2026-11-02')).toBe('2026-11-02');
    });

    it('counts streaks in whole days even when a day is 23 or 25 hours long', () => {
        expect(ridingStreaks(trips, { ...ZONE, now: new Date('2026-11-03T12:00:00-05:00') }))
            .toEqual({ longest: 3, current: 3, daysRidden: 6 });
        expect(ridingStreaks(trips, { ...ZONE, now: new Date('2026-11-04T00:30:00-05:00') }).current).toBe(0);
        expect(ridingStreaks([], ZONE)).toEqual({ longest: 0, current: 0, daysRidden: 0 });
    });
});

describe('the website and ASK give the same totals from the same records', () => {
    const tripDocs = [
        finished('2026-09-12T09:00:00-04:00', 20, { route: '510', startStopName: 'Spadina', endStopName: 'Union' }),
        finished('2026-09-13T18:00:00-04:00', 10, { agency: 'GO', route: 'LW', startStopName: 'Union', endStopName: 'Exhibition' }),
        finished('2026-09-30T23:59:59.500-04:00', 12, { agency: ' ttc ', route: '506', startStopName: 'Main', endStopName: 'Coxwell' }),
        trip('2026-09-30T18:17:00-04:00', { route: '506', startStopName: 'Spadina', incomplete: true }),
        trip('2026-10-01T00:00:30-04:00', { agency: 'MFTA', route: '1', startStopCode: '1234' }),
        trip('2026-11-01T01:30:00-05:00', { agency: 'NFTA', route: '1', startStop: 'Dundas' }),
        trip('2024-03-18T18:14:00-04:00', { agency: 'MiWay', source: 'legacy-notion', startStopName: 'Sherbourne' }),
        unreadableDiscarded,
        unreadablePending,
        trip(new Date(NOW - 60 * 60 * 1000).toISOString(), { route: '510' }), // in progress
        finished('2026-09-15T08:00:00-04:00', 30, { userId: 'user-2', agency: 'STM', route: '24' }),
    ];
    const prestoDocs = [
        presto('2026-09-12T09:03:00'),                 // also logged
        presto('2026-09-14T08:00:00'),
        presto('2026-11-08T08:00:00', 'Mississauga Transit'),
        presto('2026-09-16T08:00:00', 'TTC', 'user-2'),
    ];
    // Firestore stand-in: serves each collection's documents for the asked user only.
    const db = {
        collection: name => {
            const filters = [];
            const chain = {
                where: (field, op, value) => { filters.push([field, op, value]); return chain; },
                select: () => chain,
                get: async () => {
                    expect(filters).toEqual([['userId', '==', 'user-1']]);
                    const docs = (name === 'trips' ? tripDocs : prestoDocs).filter(doc => doc.userId === 'user-1');
                    return { docs: docs.map(data => ({ data: () => data })) };
                },
            };
            return chain;
        },
    };
    const sum = counts => Object.values(counts).reduce((a, b) => a + b, 0);
    afterEach(() => { vi.useRealTimers(); });

    it('agrees on every shared figure', async () => {
        // ASK reads the clock itself to tell a trip in progress from a finished one.
        vi.useFakeTimers({ toFake: ['Date'], now: NOW });
        // Website: the dashboard keeps history trips, then counts them with imported rides.
        const mine = tripDocs.filter(doc => doc.userId === 'user-1');
        const history = mine.filter(doc => isHistoryTrip(doc, NOW));
        const prestoTrips = buildPrestoTrips(prestoDocs.filter(doc => doc.userId === 'user-1'));
        const rides = countedRides(history, prestoTrips, { now: NOW });
        const tiles = computeSummaryStats(rides, { now: new Date(NOW) });
        const metrics = Stats.computeMetrics(rides);
        const streaks = Stats.calculateStreaks(rides);

        // ASK: the tools, reading the same records through their own loader.
        const tools = claude.buildQueryToolExecutors(db, 'user-1', 'America/Toronto');
        const all = await tools.get_all_time_stats();
        const agencies = await tools.get_agency_stats({ start_date: null, end_date: null });
        const routes = await tools.get_all_time_route_stats();
        const stops = await tools.get_unique_stops();
        const monthly = await tools.get_monthly_trip_counts();
        const streak = await tools.get_riding_streak();
        const durations = await tools.get_average_trip_duration({ route: null });

        expect(tiles.totalTrips).toBe(10);
        expect(all.totalTrips).toBe(tiles.totalTrips);
        expect(metrics.trips).toBe(tiles.totalTrips);
        expect(monthly.total_trips).toBe(tiles.totalTrips);

        expect(tiles.agencies).toBe(4);
        expect(all.uniqueAgencies).toBe(tiles.agencies);
        expect(agencies.agency_count).toBe(tiles.agencies);
        expect(agencies.trips_by_agency).toEqual(tripsByAgency(rides).counts);
        expect(agencies.trips_by_agency[0]).toEqual(['TTC', 4]);

        expect(all.uniqueRoutes).toBe(tiles.routes);
        expect(routes.route_count).toBe(metrics.routes);
        expect(routes.top_routes).toEqual(tripsByRoute(rides).counts);
        expect(routes.top_routes.slice(0, 5).map(([name, count]) => ({ name, count }))).toEqual(metrics.topRoutes);

        expect(all.uniqueStops).toBe(metrics.stops);
        expect(stops.unique_stop_count).toBe(tripsByStop(rides).all.length);

        expect(streak.days_ridden).toBe(tiles.daysRidden);
        expect(streak.longest_streak_days).toBe(streaks.best);
        expect(sum(monthly.by_month)).toBe(tiles.totalTrips - 1);
        expect(monthly.by_month).toEqual(tripsByDate(rides).byMonth);
        expect(monthly.by_month['2026-09']).toBe(Stats.filterByCalendarMonth(rides, 2026, 8).length);

        expect(all.timedTrips).toBe(finishedTrips(rides).length);
        expect(durations.timed_trips * durations.average_minutes / 60).toBeCloseTo(tiles.totalHours, 1);
    });
});
