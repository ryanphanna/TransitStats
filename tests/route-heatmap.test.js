// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
    aggregateTripCorridors,
    buildCorridorPopup,
    clipRouteGeometry,
    countRiddenRoutes,
    formatRiddenHeadline,
    getCorridorStyle,
    getDensestCorridorViewport,
    pickRiddenAgency,
    routeMatches,
} from '../js/route-heatmap.js';

const endpoint = (agency, start, end) => ({
    trip: { agency, startStopName: 'Start', endStopName: 'End' },
    boarding: { location: start },
    exiting: { location: end },
});

describe('aggregateTripCorridors', () => {
    it('groups repeated trips while keeping agencies separate', () => {
        const corridors = aggregateTripCorridors([
            endpoint('TTC', { lat: 43.65, lng: -79.38 }, { lat: 43.66, lng: -79.39 }),
            endpoint('TTC', { lat: 43.65, lng: -79.38 }, { lat: 43.66, lng: -79.39 }),
            endpoint('York Region Transit', { lat: 43.65, lng: -79.38 }, { lat: 43.66, lng: -79.39 }),
        ]);

        expect(corridors).toHaveLength(2);
        expect(corridors[0].count).toBe(2);
        expect(corridors[0].agency).toBe('TTC');
    });

    it('leaves incomplete or invalid trips out of the lines', () => {
        expect(aggregateTripCorridors([
            endpoint('TTC', { lat: 43.65, lng: -79.38 }, null),
            endpoint('TTC', { lat: 0, lng: 0 }, { lat: 43.66, lng: -79.39 }),
            endpoint('TTC', { lat: 43.65, lng: -79.38 }, { lat: 43.65, lng: -79.38 }),
        ])).toEqual([]);
    });
});

it('makes busier corridors stronger', () => {
    const quiet = getCorridorStyle(1, 4);
    const busy = getCorridorStyle(4, 4);
    expect(busy.weight).toBe(quiet.weight);
    expect(busy.color).not.toBe(quiet.color);
});

it('builds a useful and escaped corridor popup', () => {
    const popup = buildCorridorPopup({
        agency: '<TTC>',
        route: '510 & 511',
        count: 2,
        startLabel: 'Union <Station>',
        endLabel: 'Spadina & Bloor',
    });

    expect(popup).toContain('&lt;TTC&gt; · Route 510 &amp; 511');
    expect(popup).toContain('2 trips');
    expect(popup).toContain('From Union &lt;Station&gt;');
    expect(popup).not.toContain('<TTC>');
});

it('matches route branches without drawing a straight line between stops', () => {
    expect(routeMatches('510A', '510')).toBe(true);
    expect(clipRouteGeometry([[0, 0], [10, 0], [10, 10]], 0.25, 0.75)).toEqual([
        [0, 5],
        [0, 10],
        [5, 10],
    ]);
});

it('selects the busiest half-degree area for the initial view', () => {
    expect(getDensestCorridorViewport([
        { lat: 43.65, lng: -79.38, usage: 10 },
        { lat: 43.70, lng: -79.40, usage: 10 },
        { lat: 45.42, lng: -75.70, usage: 30 },
    ])).toEqual([{ lat: 45.42, lng: -75.70 }]);
});

it('draws an estimated-exit corridor dashed and labels it', () => {
    expect(getCorridorStyle(3, 4, { estimated: true }).dashArray).toBeTruthy();
    expect(getCorridorStyle(3, 4).dashArray).toBeUndefined();

    const popup = buildCorridorPopup({ count: 1, endLabel: 'Spadina & Bloor', estimated: true });
    expect(popup).toContain('To Spadina &amp; Bloor (estimated, no exit recorded)');
    expect(buildCorridorPopup({ count: 1, endLabel: 'Bloor' })).not.toContain('estimated');
});

describe('ridden routes', () => {
    const trip = (agency, route, extra = {}) => ({ agency, route, startTime: new Date('2026-01-01T12:00:00Z'), endTime: new Date('2026-01-01T12:30:00Z'), ...extra });
    const ttcRoutes = [{ routeShortName: '1' }, { routeShortName: '29' }, { routeShortName: '501' }, { routeShortName: '510' }];

    it('picks the agency with the most trips, merging aliases', () => {
        expect(pickRiddenAgency([
            trip('ttc', '29'),
            trip('TTC', '510'),
            trip('GO Transit', 'LW'),
            trip('go', 'LE'),
            trip('Toronto Transit Commission', '1'),
        ])).toBe('TTC');
        expect(pickRiddenAgency([trip('YRT', '1'), trip('MiWay', '1')])).toBe('MiWay');
        expect(pickRiddenAgency([])).toBeNull();
    });

    it('counts each listed route once, with branches counting toward the base route', () => {
        const result = countRiddenRoutes(ttcRoutes, [
            trip('TTC', '510'),
            trip('TTC', '510A'),
            trip('ttc', '29'),
            trip('TTC', '29'),
        ], 'TTC');
        expect(result.ridden).toBe(2);
        expect(result.total).toBe(4);
        expect([...result.riddenRoutes].sort()).toEqual(['29', '510']);
    });

    it('ignores other agencies and routes Atlas does not list', () => {
        const result = countRiddenRoutes(ttcRoutes, [
            trip('YRT', '1'),
            trip('TTC', '999'),
            trip('TTC', ''),
        ], 'TTC');
        expect(result).toMatchObject({ ridden: 0, total: 4 });
    });

    it('leaves unreadable texts out, like every other total', () => {
        const result = countRiddenRoutes(ttcRoutes, [
            { source: 'sms_fallback', discarded: true, agency: 'TTC', route: '' },
            trip('TTC', '501', { endTime: null, startTime: new Date() }),
        ], 'TTC');
        expect(result.ridden).toBe(0);
    });

    it('marks both a route and its listed branch from one trip, through routeMatches', () => {
        const result = countRiddenRoutes([{ routeShortName: '510' }, { routeShortName: '510A' }], [trip('TTC', '510')], 'TTC');
        expect(result).toMatchObject({ ridden: 2, total: 2 });
    });

    it('dedupes repeated route names in the Atlas list', () => {
        expect(countRiddenRoutes(['501', '501', ' 501 '], [trip('TTC', '501')], 'TTC')).toMatchObject({ ridden: 1, total: 1 });
    });

    it('writes the headline in plain words', () => {
        expect(formatRiddenHeadline({ ridden: 41, total: 160, agency: 'TTC' })).toBe('41 of 160 TTC routes ridden');
        expect(formatRiddenHeadline({ ridden: 1, total: 1, agency: 'GO Transit' })).toBe('1 of 1 GO Transit route ridden');
    });
});
