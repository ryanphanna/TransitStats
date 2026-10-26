import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    importedRideTime,
    matchImportedRides,
    mergeImportedRides,
    normalizeRideAgency,
    prestoWallClockToInstant,
    unmatchedImportedRides,
} from '../js/shared/ride-merge.js';
import { generated } from '../scripts/sync-shared.mjs';

const MIN = 60 * 1000;
const base = Date.UTC(2026, 0, 2, 13, 0); // 8:00 Toronto in January (EST)

const logged = (offsetMin, agency = 'TTC') => ({ agency, startTime: new Date(base + offsetMin * MIN), tag: `l${offsetMin}` });
// PRESTO wall clock for 8:00 + offsetMin Toronto time.
const presto = (offsetMin, agency = 'TTC') => ({
    agency,
    startRecord: { agency, occurredAtSortKey: Date.UTC(2026, 0, 2, 8, 0) + offsetMin * MIN },
    tag: `p${offsetMin}`,
});

describe('prestoWallClockToInstant', () => {
    it('converts Toronto wall clock to the real instant across DST', () => {
        expect(new Date(prestoWallClockToInstant(Date.UTC(2026, 0, 1, 8, 0))).toISOString()).toBe('2026-01-01T13:00:00.000Z');
        expect(new Date(prestoWallClockToInstant(Date.UTC(2026, 6, 1, 8, 0))).toISOString()).toBe('2026-07-01T12:00:00.000Z');
    });

    it('returns null for a missing or invalid key', () => {
        expect(prestoWallClockToInstant(null)).toBeNull();
        expect(prestoWallClockToInstant('nope')).toBeNull();
    });

    it('reads time from a trip or a bare record', () => {
        expect(importedRideTime(presto(0))).toBe(base);
        expect(importedRideTime(presto(0).startRecord)).toBe(base);
    });
});

describe('mergeImportedRides', () => {
    it('drops an imported ride that matches a logged trip', () => {
        const merged = mergeImportedRides([logged(0)], [presto(3)]);
        expect(merged.map(ride => ride.tag)).toEqual(['l0']);
    });

    it('keeps imported rides outside the window', () => {
        const merged = mergeImportedRides([logged(0)], [presto(45)]);
        expect(merged.map(ride => ride.tag)).toEqual(['l0', 'p45']);
    });

    it('is one-to-one: a logged trip cancels only the closest imported ride', () => {
        const merged = mergeImportedRides([logged(0)], [presto(10), presto(2)]);
        expect(merged.map(ride => ride.tag)).toEqual(['l0', 'p10']);
    });

    it('is one-to-one the other way: two logged trips need two imported rides', () => {
        const merged = mergeImportedRides([logged(0), logged(4)], [presto(2)]);
        expect(merged.map(ride => ride.tag)).toEqual(['l0', 'l4']);
    });

    it('does not match across different agencies', () => {
        const merged = mergeImportedRides([logged(0, 'TTC')], [presto(1, 'GO Transit')]);
        expect(merged.map(ride => ride.tag)).toEqual(['l0', 'p1']);
    });

    it('matches when an agency is missing or spelled out in full', () => {
        expect(mergeImportedRides([logged(0, '')], [presto(1, 'TTC')]).map(r => r.tag)).toEqual(['l0']);
        expect(mergeImportedRides([logged(0, 'TTC')], [presto(1, 'Toronto Transit Commission')]).map(r => r.tag)).toEqual(['l0']);
        expect(normalizeRideAgency(' GO Transit ')).toBe('go transit');
    });

    it('ignores logged trips and imported rides with no usable time', () => {
        const noTime = { agency: 'TTC', startTime: null, tag: 'bad' };
        const merged = mergeImportedRides([noTime], [{ agency: 'TTC', startRecord: {}, tag: 'pbad' }]);
        // Nothing can be compared, so nothing is cancelled.
        expect(merged.map(ride => ride.tag)).toEqual(['bad', 'pbad']);
    });

    it('handles empty and missing inputs', () => {
        expect(mergeImportedRides(undefined, undefined)).toEqual([]);
        expect(unmatchedImportedRides([], [presto(0)])).toHaveLength(1);
    });

    it('accepts Firestore-style timestamps on logged trips', () => {
        const trip = { agency: 'TTC', startTime: { toDate: () => new Date(base) } };
        expect(matchImportedRides([trip], [presto(1)]).size).toBe(1);
    });

    it('re-importing the same rides never changes the merged count', () => {
        const imported = [presto(0), presto(60)];
        const once = mergeImportedRides([logged(1)], imported).length;
        expect(once).toBe(2);
    });
});

describe('functions/lib/ride-merge.js', () => {
    it('is in sync with js/shared/ride-merge.js (run `npm run sync:shared`)', () => {
        const copy = readFileSync(resolve(process.cwd(), 'functions/lib/ride-merge.js'), 'utf8');
        expect(copy).toBe(generated('ride-merge'));
    });
});
