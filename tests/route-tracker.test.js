import { describe, expect, it } from 'vitest';
import {
    buildAgencyCoverage,
    buildObservedAgencies,
    isEligibleRouteTrip,
} from '../js/route-tracker.js';

describe('route tracker coverage', () => {
    const inventory = [
        { routeShortName: '510', routeLongName: 'Spadina' },
        { routeShortName: '510-N', routeLongName: 'Spadina Northbound' },
        { routeShortName: '29', routeLongName: 'Dufferin' },
        { routeShortName: '501', routeLongName: 'Queen' },
    ];

    it('counts a branch as the base route and deduplicates inventory variants', () => {
        const coverage = buildAgencyCoverage('TTC', inventory, [
            { agency: 'TTC', route: '510A' },
            { agency: 'TTC', route: 'Route 29' },
        ]);

        expect(coverage.total).toBe(3);
        expect(coverage.riddenCount).toBe(2);
        expect(coverage.percentage).toBe(67);
        expect(coverage.riddenRoutes.map(route => route.routeShortName)).toEqual(['29', '510']);
    });

    it('excludes discarded, review-flagged, and unknown-route trips', () => {
        expect(isEligibleRouteTrip({ agency: 'TTC', route: '510', discarded: true })).toBe(false);
        expect(isEligibleRouteTrip({ agency: 'TTC', route: '510', needs_review: true })).toBe(false);
        expect(isEligibleRouteTrip({ agency: 'TTC', route: 'incomplete trip' })).toBe(false);
        expect(isEligibleRouteTrip({ agency: 'TTC', route: '510', incomplete: true })).toBe(true);
    });

    it('groups only eligible trips into observed agencies', () => {
        expect(buildObservedAgencies([
            { agency: 'TTC', route: '510' },
            { agency: 'GO Transit', route: '01' },
            { agency: 'TTC', route: '510', discarded: true },
        ])).toEqual(['GO Transit', 'TTC']);
    });
});
