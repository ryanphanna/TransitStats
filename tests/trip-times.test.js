import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    buildTripPairs,
    durationStats,
    isTimedTrip,
    median,
    percentile,
    routeFamily,
    stopGroupKey,
    summarizePair,
    timeOfDayBucket,
    timeOfDayMedians,
    tripMinutes,
} from '../js/trip-times.js';
import { isPlatformRecord, stationBaseName, stopNameKey } from '../js/shared/station-names.js';
import { PredictionEngine } from '../js/predict.js';
import { initHeader } from '../js/shared/header.js';

const require = createRequire(import.meta.url);
const serverUtils = require('../functions/lib/utils.js');

// Toronto in October 2026 is UTC-4.
const at = (h, min = 0, day = 5) => new Date(Date.UTC(2026, 9, day, h + 4, min));
const trip = (h, minutes, extra = {}) => ({
    route: '510',
    agency: 'TTC',
    startStopName: 'Spadina Station',
    endStopName: 'Union Station',
    timezone: 'America/Toronto',
    startTime: at(h),
    endTime: new Date(at(h).getTime() + minutes * 60000),
    ...extra,
});
const canonicalizeStop = (name, agency) => PredictionEngine._canonicalizeStop(name, agency);

beforeEach(() => {
    PredictionEngine.stopsLibrary = [
        { name: "Queen's Park Station", agency: 'TTC', aliases: ['QUEENS PARK'] },
        { name: "Queen's Park Station - Northbound Platform", agency: 'TTC' },
        { name: 'Union Station', agency: 'TTC', aliases: ['Union'] },
        { name: 'Spadina Station', agency: 'TTC' },
    ];
});

describe('percentiles', () => {
    it('median of odd and even lists', () => {
        expect(median([1, 2, 3])).toBe(2);
        expect(median([1, 2, 3, 4])).toBe(2.5);
        expect(median([])).toBeNull();
    });

    it('interpolates between neighbours', () => {
        const sorted = [10, 20, 30, 40, 50];
        expect(percentile(sorted, 25)).toBe(20);
        expect(percentile(sorted, 75)).toBe(40);
        expect(percentile([10, 20, 30, 40], 25)).toBe(17.5);
        expect(percentile([7], 25)).toBe(7);
    });

    it('summarizes durations in any order', () => {
        expect(durationStats([30, 10, 20, 50, 40])).toEqual({ count: 5, median: 30, p25: 20, p75: 40, fastest: 10, slowest: 50 });
        expect(durationStats([])).toEqual({ count: 0, median: null, p25: null, p75: null, fastest: null, slowest: null });
    });
});

describe('which trips count', () => {
    it('needs both times, more than zero minutes and at most three hours', () => {
        expect(tripMinutes(trip(8, 25))).toBe(25);
        expect(isTimedTrip(trip(8, 25))).toBe(true);
        expect(isTimedTrip(trip(8, 180))).toBe(true);
        expect(isTimedTrip(trip(8, 181))).toBe(false);
        expect(isTimedTrip(trip(8, 0))).toBe(false);
        expect(isTimedTrip(trip(8, -5))).toBe(false);
        expect(isTimedTrip(trip(8, 25, { endTime: null }))).toBe(false);
        expect(isTimedTrip(trip(8, 25, { startTime: null }))).toBe(false);
    });

    it('skips discarded and ended-early trips', () => {
        expect(isTimedTrip(trip(8, 25, { discarded: true }))).toBe(false);
        expect(isTimedTrip(trip(8, 25, { incomplete: true }))).toBe(false);
    });

    it('reads Firestore timestamps', () => {
        const t = trip(8, 25);
        const ts = d => ({ toDate: () => d });
        expect(tripMinutes({ startTime: ts(t.startTime), endTime: ts(t.endTime) })).toBe(25);
    });
});

describe('time of day', () => {
    it('buckets by local start hour', () => {
        expect(timeOfDayBucket(5)).toBe('evening');
        expect(timeOfDayBucket(6)).toBe('morning');
        expect(timeOfDayBucket(9)).toBe('morning');
        expect(timeOfDayBucket(10)).toBe('midday');
        expect(timeOfDayBucket(14)).toBe('midday');
        expect(timeOfDayBucket(15)).toBe('afternoon');
        expect(timeOfDayBucket(18)).toBe('afternoon');
        expect(timeOfDayBucket(19)).toBe('evening');
        expect(timeOfDayBucket(0)).toBe('evening');
        expect(timeOfDayBucket(null)).toBeNull();
    });

    it('uses the trip time zone and hides rows under 3 trips', () => {
        const trips = [trip(7, 20), trip(8, 30), trip(9, 40), trip(12, 15), trip(12, 25), trip(22, 10), trip(23, 12), trip(1, 14)];
        const rows = timeOfDayMedians(trips);
        expect(rows.map(r => [r.key, r.count, r.median])).toEqual([['morning', 3, 30], ['evening', 3, 12]]);
    });
});

describe('route families', () => {
    it('matches the prediction engine rule', () => {
        expect(routeFamily('510A')).toBe('510');
        expect(routeFamily('510 Shuttle')).toBe('510');
        expect(routeFamily('Line 1')).toBe('Line 1');
        expect(readFileSync('functions/lib/predict_v3.js', 'utf8')).toMatch(/_baseRoute: function \(route\)/);
    });
});

describe('station names', () => {
    it('platform records belong to their station', () => {
        expect(stationBaseName("Queen's Park Station - Northbound Platform")).toBe("Queen's Park Station");
        expect(stationBaseName('Union Station (Platform 3)')).toBe('Union Station');
        expect(stationBaseName('Platform Road')).toBe('Platform Road');
        expect(isPlatformRecord('College Station - Southbound Platform')).toBe(true);
        expect(stopNameKey("Queen's Park Station")).toBe('queensparkstation');
    });

    it('the Cloud Functions use the same helpers', () => {
        for (const label of ["Queen's Park Station - Northbound Platform", 'Union Station (Platform 3)', 'King St / Spadina']) {
            expect(serverUtils.stationBaseName(label)).toBe(stationBaseName(label));
            expect(serverUtils.stopNameKey(label)).toBe(stopNameKey(label));
        }
    });

    it('resolves aliases first, then groups platforms under the station', () => {
        const key = stopGroupKey("Queen's Park Station", 'TTC', canonicalizeStop);
        expect(stopGroupKey('QUEENS PARK', 'TTC', canonicalizeStop)).toBe(key);
        expect(stopGroupKey("Queen's Park Station - Northbound Platform", 'TTC', canonicalizeStop)).toBe(key);
    });
});

describe('trip pairs', () => {
    it('groups by route family and resolved stations, busiest first, with direction kept', () => {
        const trips = [
            trip(8, 20, { startStopName: 'QUEENS PARK', endStopName: 'Union' }),
            trip(9, 22, { startStopName: "Queen's Park Station - Northbound Platform", endStopName: 'Union Station', route: '510A' }),
            trip(10, 24, { startStopName: "Queen's Park Station", endStopName: 'Union Station' }),
            trip(17, 30, { startStopName: 'Union Station', endStopName: "Queen's Park Station" }),
            trip(8, 25, { discarded: true }),
            trip(8, 250),
            trip(8, 20, { endStopName: 'Unknown exit stop' }),
            trip(8, 20, { route: '' }),
        ];
        const pairs = buildTripPairs(trips, { canonicalizeStop });
        expect(pairs.map(p => [p.route, p.startLabel, p.endLabel, p.trips.length])).toEqual([
            ['510', "Queen's Park Station", 'Union Station', 3],
            ['510', 'Union Station', "Queen's Park Station", 1],
        ]);
        expect(pairs[0].variants).toEqual(['510', '510A']);
        const summary = summarizePair(pairs[0]);
        expect([summary.count, summary.median, summary.fastest, summary.slowest]).toEqual([3, 22, 20, 24]);
    });

    it('keeps the same station name at different agencies apart', () => {
        const pairs = buildTripPairs([
            trip(8, 20),
            trip(8, 30, { agency: 'GO Transit' }),
        ], { canonicalizeStop });
        expect(pairs).toHaveLength(2);
    });

    it('skips trips that start and end at the same station', () => {
        expect(buildTripPairs([trip(8, 20, { endStopName: 'Spadina Station' })], { canonicalizeStop })).toEqual([]);
    });
});

describe('page wiring', () => {
    it('is served at /trip-times', () => {
        const hosting = JSON.parse(readFileSync('firebase.json', 'utf8')).hosting[0];
        expect(hosting.rewrites).toContainEqual({ source: '/trip-times', destination: '/trip-times.html' });
        const vite = readFileSync('vite.config.js', 'utf8');
        expect(vite).toContain("'trip-times': './trip-times.html'");
        expect(vite).toMatch(/const targets = \[[^\]]*'\/trip-times'/);
    });

    it('reads trips only through the signed-in trip stream', () => {
        const js = readFileSync('js/pages/trip-times.js', 'utf8');
        expect(js).toMatch(/requireAuth/);
        expect(js).toMatch(/TripController\.listen\(user\.uid/);
        expect(js).not.toMatch(/innerHTML|db\.collection/);
    });

    it('header shows a Trip times link on signed-in pages', () => {
        document.body.innerHTML = '<div id="app-root"></div>';
        initHeader({ currentPage: 'trip-times', showRecap: true, showTripTimes: true });
        const link = document.querySelector('.header-actions a[href="/trip-times"]');
        expect(link.textContent.trim()).toBe('Trip times');
        expect(link.classList.contains('active')).toBe(true);
        document.body.innerHTML = '<div id="app-root"></div>';
        initHeader({ currentPage: 'dashboard' });
        expect(document.querySelector('a[href="/trip-times"]')).toBeNull();
        for (const file of ['js/pages/dashboard.js', 'js/pages/route-heatmap.js', 'js/pages/recap.js', 'js/public.js']) {
            expect(readFileSync(file, 'utf8')).toMatch(/showTripTimes: true/);
        }
    });
});
