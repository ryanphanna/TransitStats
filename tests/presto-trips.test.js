import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrestoTrips, GO_MAX_TRIP_GAP_MS } from '../js/shared/presto-trips.js';
import { SHARED_MODULES, generated } from '../scripts/sync-shared.mjs';

const H = 60 * 60 * 1000;
const go = (hours, amountCents, label = 'x') => ({
    type: 'fare_payment', agency: 'GO', occurredAtSortKey: hours * H, amountCents, location: label,
});
const tapOn = (hours, label) => go(hours, -552, label);
const tapOff = (hours, label) => go(hours, 264, label);

describe('buildPrestoTrips GO pairing', () => {
    it('pairs a tap-on with its tap-off', () => {
        const [trip, ...rest] = buildPrestoTrips([tapOn(1, 'A'), tapOff(2, 'B')]);
        expect(rest).toHaveLength(0);
        expect(trip.startRecord.location).toBe('A');
        expect(trip.endRecord.location).toBe('B');
    });

    it('one missed tap-off does not shift every later pair', () => {
        const trips = buildPrestoTrips([
            tapOn(1, 'A'), tapOff(2, 'B'),
            tapOn(10, 'C'),                 // tap-off never recorded
            tapOn(20, 'D'), tapOff(21, 'E'),
            tapOn(30, 'F'), tapOff(31, 'G'),
        ]);
        expect(trips.map(t => [t.startRecord.location, t.endRecord?.location ?? null])).toEqual([
            ['A', 'B'], ['C', null], ['D', 'E'], ['F', 'G'],
        ]);
    });

    it('does not pair across a gap longer than the maximum trip time', () => {
        const trips = buildPrestoTrips([tapOn(1, 'A'), tapOff(1 + GO_MAX_TRIP_GAP_MS / H + 1, 'B')]);
        expect(trips).toHaveLength(2);
        expect(trips[0].endRecord).toBeNull();
        // The stray exit still counts as a trip rather than vanishing.
        expect(trips[1].startRecord.location).toBe('B');
    });

    it('keeps two back-to-back charges as two boarding-only trips', () => {
        const trips = buildPrestoTrips([tapOn(1, 'A'), tapOn(1.5, 'B')]);
        expect(trips).toHaveLength(2);
        expect(trips.every(t => t.endRecord === null)).toBe(true);
    });

    it('keeps a lone exit adjustment as its own trip', () => {
        const trips = buildPrestoTrips([tapOff(1, 'A')]);
        expect(trips).toHaveLength(1);
        expect(trips[0].startRecord.location).toBe('A');
    });

    it('pairs rows that have no amounts (older fixtures)', () => {
        const noAmount = hours => ({ type: 'fare_payment', agency: 'GO', occurredAtSortKey: hours * H });
        expect(buildPrestoTrips([noAmount(1), noAmount(2)])).toHaveLength(1);
    });

    it('sorts unordered input and leaves other agencies as single-tap trips', () => {
        const trips = buildPrestoTrips([
            tapOff(2, 'B'),
            { type: 'fare_payment', agency: 'TTC', occurredAtSortKey: 5 * H, amountCents: -330 },
            tapOn(1, 'A'),
        ]);
        expect(trips).toHaveLength(2);
        expect(trips.find(t => t.agency === 'TTC').endRecord).toBeNull();
        expect(trips.find(t => t.agency === 'GO').endRecord.location).toBe('B');
    });

    it('ignores card loads and handles empty input', () => {
        expect(buildPrestoTrips([{ type: 'epurse_load', agency: 'GO', occurredAtSortKey: 1 }])).toHaveLength(0);
        expect(buildPrestoTrips()).toEqual([]);
    });
});

describe('generated CommonJS copies for functions', () => {
    it.each(SHARED_MODULES)('functions/lib/%s.js is in sync (run `npm run sync:shared`)', (name) => {
        const copy = readFileSync(resolve(process.cwd(), `functions/lib/${name}.js`), 'utf8');
        expect(copy).toBe(generated(name));
    });
});
