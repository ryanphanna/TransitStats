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

// The matcher as it was before it was made fast: every logged trip against
// every imported ride. Kept here only to prove the fast one matches the same rides.
function matchImportedRidesAllPairs(loggedTrips, importedRides, windowMs = 30 * MIN) {
    const loggedTime = (trip) => {
        const value = trip?.startTime;
        if (value === null || value === undefined) return null;
        const time = (value?.toDate ? value.toDate() : new Date(value)).getTime();
        return Number.isFinite(time) ? time : null;
    };
    const agencyOf = ride => normalizeRideAgency(ride?.agency || ride?.startRecord?.agency || ride?.startRecord?.agencySource);
    const pairs = [];
    (loggedTrips || []).forEach((trip, loggedIndex) => {
        const time = loggedTime(trip);
        if (time === null) return;
        const loggedAgency = agencyOf(trip);
        (importedRides || []).forEach((ride, importedIndex) => {
            const importedTime = importedRideTime(ride);
            if (importedTime === null) return;
            const importedAgency = agencyOf(ride);
            if (loggedAgency && importedAgency && loggedAgency !== importedAgency) return;
            const gap = Math.abs(importedTime - time);
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

// Small seeded generator, so a failure can be reproduced.
function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('matchImportedRides, fast version', () => {
    const AGENCIES = ['TTC', 'ttc', 'Toronto Transit Commission', 'MiWay', 'Mississauga Transit', 'GO Transit', '', null, undefined];

    function randomFixture(random, loggedCount, importedCount, spanMin) {
        const pick = list => list[Math.floor(random() * list.length)];
        // Whole minutes over a short span, so equal gaps and crowded windows are common.
        const minute = () => Math.floor(random() * spanMin);
        const loggedTrips = Array.from({ length: loggedCount }, () => {
            const roll = random();
            const time = base + minute() * MIN;
            if (roll < 0.05) return { agency: pick(AGENCIES), startTime: null };
            if (roll < 0.08) return { agency: pick(AGENCIES), startTime: 'not a date' };
            if (roll < 0.2) return { agency: pick(AGENCIES), startTime: { toDate: () => new Date(time) } };
            if (roll < 0.3) return { agency: pick(AGENCIES), startTime: time };
            return { agency: pick(AGENCIES), startTime: new Date(time) };
        });
        const importedRides = Array.from({ length: importedCount }, () => {
            const roll = random();
            const agency = pick(AGENCIES);
            const sortKey = Date.UTC(2026, 0, 2, 8, 0) + minute() * MIN;
            if (roll < 0.05) return { agency, startRecord: { agency, occurredAtSortKey: 'nope' } };
            if (roll < 0.15) return { agencySource: agency, occurredAtSortKey: sortKey };          // a bare record
            if (roll < 0.25) return { agency, startTime: new Date(base + minute() * MIN) };         // no PRESTO record
            if (roll < 0.35) return { startRecord: { agencySource: agency, occurredAtSortKey: sortKey } };
            return { agency, startRecord: { agency, occurredAtSortKey: sortKey } };
        });
        return { loggedTrips, importedRides };
    }

    it('matches exactly the rides the all-pairs version matched, on random data', () => {
        const random = seededRandom(20261109);
        const windows = [30 * MIN, 30 * MIN, 30 * MIN, 0, MIN, 5 * MIN, 120 * MIN, Infinity, -1, NaN];
        let matchedSomewhere = 0;
        for (let round = 0; round < 400; round++) {
            const { loggedTrips, importedRides } = randomFixture(
                random,
                Math.floor(random() * 60),
                Math.floor(random() * 60),
                [20, 90, 600, 5000][round % 4],
            );
            const windowMs = windows[round % windows.length];
            const fast = [...matchImportedRides(loggedTrips, importedRides, windowMs)];
            const slow = [...matchImportedRidesAllPairs(loggedTrips, importedRides, windowMs)];
            // Same rides, picked in the same order.
            expect(fast, `round ${round}`).toEqual(slow);
            matchedSomewhere += fast.length;
        }
        expect(matchedSomewhere).toBeGreaterThan(1000);
        expect([...matchImportedRides(null, null)]).toEqual([]);
        expect([...matchImportedRides([logged(0)], undefined)]).toEqual([]);
    }, 30000); // the all-pairs reference is slow; under a full parallel run it can pass 5 s

    it('agrees with the all-pairs version across a clock change', () => {
        const random = seededRandom(7);
        // 1 November 2026, when 01:00 to 02:00 happens twice in Toronto.
        const fallBack = Date.UTC(2026, 10, 1, 4, 0);
        const loggedTrips = Array.from({ length: 80 }, () => ({ agency: 'TTC', startTime: new Date(fallBack + Math.floor(random() * 300) * MIN) }));
        const importedRides = Array.from({ length: 80 }, () => ({
            agency: 'TTC', startRecord: { occurredAtSortKey: Date.UTC(2026, 10, 1, 0, 0) + Math.floor(random() * 300) * MIN },
        }));
        expect([...matchImportedRides(loggedTrips, importedRides)]).toEqual([...matchImportedRidesAllPairs(loggedTrips, importedRides)]);
    });

    it('merges 10,000 logged trips with 2,000 imported rides quickly', () => {
        const random = seededRandom(42);
        const threeYears = 3 * 365 * 24 * 60;
        const loggedTrips = Array.from({ length: 10000 }, () => ({ agency: 'TTC', startTime: new Date(base + Math.floor(random() * threeYears) * MIN) }));
        const importedRides = Array.from({ length: 2000 }, (_, index) => {
            // Half sit a few minutes from a logged trip (in winter time; the
            // summer ones land an hour off and stay unmatched); the rest fall anywhere.
            const near = index % 2 === 0 ? loggedTrips[index].startTime.getTime() - base + 3 * MIN : Math.floor(random() * threeYears) * MIN;
            return { agency: 'TTC', startRecord: { agency: 'TTC', occurredAtSortKey: Date.UTC(2026, 0, 2, 8, 0) + near } };
        });
        const started = performance.now();
        const matched = matchImportedRides(loggedTrips, importedRides);
        const elapsed = performance.now() - started;
        expect(matched.size).toBeGreaterThan(500);
        // Well under a second in practice; the limit is loose so a busy machine does not fail it.
        expect(elapsed).toBeLessThan(2000);
    });
});
