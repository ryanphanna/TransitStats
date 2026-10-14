import { beforeAll, describe, expect, it } from 'vitest';
import { projectPrestoTripsForStats } from '../js/presto-stop-matcher.js';
import { Stats } from '../js/stats.js';

// A rider in Toronto: PRESTO's wall-clock times are Toronto time, and the
// browser reads them back in Toronto time.
beforeAll(() => { process.env.TZ = 'America/Toronto'; });

const ride = (y, m, d, h, min) => ({
    agency: 'TTC',
    startRecord: { agency: 'TTC', occurredAtSortKey: Date.UTC(y, m - 1, d, h, min) },
});

describe('imported rides keep their local day and month', () => {
    it('a 12:30 AM ride stays on its own day, not the previous one', () => {
        const [projected] = projectPrestoTripsForStats([ride(2026, 11, 1, 0, 30)]);
        expect(projected.startTime.getDate()).toBe(1);
        expect(projected.startTime.getMonth()).toBe(10);
        expect(projected.startTime.getHours()).toBe(0);
    });

    it('late-night rides land in the right month for Wrapped, either side of midnight', () => {
        const trips = projectPrestoTripsForStats([
            ride(2026, 10, 31, 23, 50),   // Oct 31, 11:50 PM
            ride(2026, 11, 1, 0, 10),     // Nov 1, 12:10 AM
            ride(2026, 11, 1, 3, 59),     // Nov 1, 3:59 AM
        ]);
        expect(Stats.filterByCalendarMonth(trips, 2026, 9)).toHaveLength(1);
        expect(Stats.filterByCalendarMonth(trips, 2026, 10)).toHaveLength(2);
    });

    it('day counts treat a post-midnight ride as its own day', () => {
        const trips = projectPrestoTripsForStats([ride(2026, 10, 31, 23, 50), ride(2026, 11, 1, 0, 10)]);
        expect(Stats.computeTripPeriodCounts(trips).daysRidden).toBe(2);
    });
});
