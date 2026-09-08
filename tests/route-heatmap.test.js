// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
    aggregateTripCorridors,
    buildCorridorPopup,
    clipRouteGeometry,
    getCorridorStyle,
    getDensestCorridorViewport,
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
