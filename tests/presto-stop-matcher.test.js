import { describe, expect, it } from 'vitest';
import {
    buildPrestoTrips,
    matchPrestoRecord,
    matchPrestoRecords,
    projectPrestoTripsForStats,
    resolvePrestoStopLocation,
} from '../js/presto-stop-matcher.js';

const baseRecord = {
    agency: 'TTC',
    location: 'Bloor St East at Parliament St',
    locationLabel: 'Bloor St East at Parliament St',
};

describe('PRESTO stop matcher', () => {
    it('matches a unique canonical name or alias', () => {
        const result = matchPrestoRecord({
            ...baseRecord,
            location: 'Toronto- New USBT',
            locationLabel: 'Union Station Bus Terminal',
            agency: 'GO',
        }, [{
            id: 'bus-terminal',
            agency: 'GO Transit',
            name: 'Union Station Bus Terminal',
            code: '102300',
            lat: 43.644,
            lng: -79.377,
        }]);

        expect(result.status).toBe('matched');
        expect(result.candidate.code).toBe('102300');
    });

    it('preserves opposite-direction candidates as ambiguous', () => {
        const stops = [
            { id: 'east', agency: 'TTC', name: baseRecord.location, code: '482', direction: 'Eastbound', lat: 43.6717, lng: -79.3715 },
            { id: 'west', agency: 'TTC', name: baseRecord.location, code: '483', direction: 'Westbound', lat: 43.6722, lng: -79.3707 },
        ];
        const result = matchPrestoRecord(baseRecord, stops);

        expect(result.status).toBe('ambiguous');
        expect(result.candidates.map(candidate => candidate.direction)).toEqual(['Eastbound', 'Westbound']);
        expect(resolvePrestoStopLocation(baseRecord, stops)).toEqual({
            source: 'unresolved',
            location: null,
            matchStatus: 'ambiguous',
            candidates: result.candidates,
        });
    });

    it('does not match a label from another agency', () => {
        const result = matchPrestoRecord({ ...baseRecord, agency: 'GO' }, [{
            agency: 'TTC',
            name: baseRecord.location,
            lat: 43.67,
            lng: -79.37,
        }]);

        expect(result).toEqual({ status: 'unmatched', candidates: [] });
    });

    it('summarizes matched, ambiguous, and unmatched records', () => {
        const result = matchPrestoRecords([
            baseRecord,
            { ...baseRecord, location: 'Unknown', locationLabel: 'Unknown' },
        ], [{ agency: 'TTC', name: baseRecord.location, code: '482', lat: 43.67, lng: -79.37 }]);

        expect(result.counts).toEqual({ matched: 1, ambiguous: 0, unmatched: 1 });
        expect(result.results).toHaveLength(2);
    });
});

describe('buildPrestoTrips', () => {
    it('pairs consecutive GO fare payments into one trip, boarding then exit', () => {
        const boarding = { type: 'fare_payment', agency: 'GO', occurredAtSortKey: 100, location: 'Union Station Rail' };
        const exit = { type: 'fare_payment', agency: 'GO', occurredAtSortKey: 200, location: 'Oakville GO Station Rail' };
        const trips = buildPrestoTrips([exit, boarding]);

        expect(trips).toHaveLength(1);
        expect(trips[0].startRecord).toBe(boarding);
        expect(trips[0].endRecord).toBe(exit);
    });

    it('keeps a trailing unpaired GO tap as a boarding-only trip', () => {
        const first = { type: 'fare_payment', agency: 'GO', occurredAtSortKey: 100 };
        const second = { type: 'fare_payment', agency: 'GO', occurredAtSortKey: 200 };
        const missedTapOut = { type: 'fare_payment', agency: 'GO', occurredAtSortKey: 300 };
        const trips = buildPrestoTrips([first, second, missedTapOut]);

        expect(trips).toHaveLength(2);
        expect(trips[1].startRecord).toBe(missedTapOut);
        expect(trips[1].endRecord).toBeNull();
    });

    it('treats every tap-in-only agency fare payment as its own trip', () => {
        const trips = buildPrestoTrips([
            { type: 'fare_payment', agency: 'TTC', occurredAtSortKey: 100 },
            { type: 'fare_payment', agency: 'TTC', occurredAtSortKey: 200 },
        ]);

        expect(trips).toHaveLength(2);
        expect(trips.every(trip => trip.endRecord === null)).toBe(true);
    });

    it('excludes card loads from trips entirely', () => {
        const trips = buildPrestoTrips([
            { type: 'period_pass_load', agency: 'TTC', occurredAtSortKey: 100 },
            { type: 'epurse_load', agency: 'GO', occurredAtSortKey: 200 },
        ]);

        expect(trips).toHaveLength(0);
    });
});

describe('projectPrestoTripsForStats', () => {
    it('projects a presto trip to the { agency, startTime } shape Stats expects', () => {
        const sortKey = Date.UTC(2026, 0, 2, 8, 0);
        const [projected] = projectPrestoTripsForStats([
            { agency: 'TTC', startRecord: { occurredAtSortKey: sortKey } },
        ]);

        expect(projected.agency).toBe('TTC');
        // 8:00 Toronto wall clock (EST, UTC-5) is 13:00 UTC.
        expect(projected.startTime).toEqual(new Date(Date.UTC(2026, 0, 2, 13, 0)));
    });

    it('drops trips with no resolvable date instead of defaulting to epoch', () => {
        const projected = projectPrestoTripsForStats([
            { agency: 'TTC', startRecord: { occurredAtSortKey: null } },
        ]);

        expect(projected).toHaveLength(0);
    });
});
