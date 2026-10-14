import { describe, expect, it } from 'vitest';
import { Stats } from '../js/stats.js';

describe('Stats.computeTripPeriodCounts', () => {
    it('counts lifetime, last 30 days, and last 7 days', () => {
        const now = new Date(2026, 7, 13, 12); // Thursday, August 13, 2026
        const trips = [
            { startTime: new Date(2026, 7, 13, 8) },
            { startTime: new Date(2026, 7, 10, 8) },
            { startTime: new Date(2026, 7, 1, 8) },
            { startTime: new Date(2026, 6, 13, 8) },
            { startTime: new Date(2026, 7, 9, 8) },
            { startTime: new Date(2026, 7, 6, 11) }
        ];

        expect(Stats.computeTripPeriodCounts(trips, now)).toEqual({
            lifetime: 6,
            thisMonth: 5,
            thisWeek: 3,
            daysRidden: 6
        });
    });

    it('supports Firestore timestamps and ignores invalid dates for period counts', () => {
        const now = new Date(2026, 7, 13, 12);
        const trips = [
            { startTime: { toDate: () => new Date(2026, 7, 12, 8) } },
            { startTime: 'not a date' }
        ];

        expect(Stats.computeTripPeriodCounts(trips, now)).toEqual({
            lifetime: 2,
            thisMonth: 1,
            thisWeek: 1,
            daysRidden: 1
        });
    });

    it('counts multiple trips on the same day once', () => {
        const trips = [
            { startTime: new Date(2026, 7, 13, 8) },
            { startTime: new Date(2026, 7, 13, 17) },
            { startTime: new Date(2026, 7, 14, 8) }
        ];

        expect(Stats.computeTripPeriodCounts(trips, new Date(2026, 7, 14, 12)).daysRidden).toBe(2);
    });
});

describe('Stats calendar-month Wrapped helpers', () => {
    const trips = [
        { startTime: new Date(2026, 8, 2, 8), route: '501', startStopName: 'Spadina', endStopName: 'Bathurst', duration: 20 },
        { startTime: new Date(2026, 8, 2, 18), route: '501', startStopName: 'Bathurst', endStopName: 'Spadina', duration: 22 },
        { startTime: new Date(2026, 8, 3, 9), route: '2', startStopName: 'Spadina', endStopName: 'St George', duration: 8 },
        { startTime: new Date(2026, 7, 20, 9), route: '504', startStopName: 'King', endStopName: 'Queen', duration: 15 },
    ];

    it('filters trips to a calendar month', () => {
        expect(Stats.filterByCalendarMonth(trips, 2026, 8)).toHaveLength(3);
        expect(Stats.filterByCalendarMonth(trips, 2026, 7)).toHaveLength(1);
    });

    it('lists available months newest first', () => {
        expect(Stats.listAvailableMonths(trips)).toEqual([
            { year: 2026, monthIndex: 8 },
            { year: 2026, monthIndex: 7 },
        ]);
    });

    it('computes Wrapped highlights for a month', () => {
        const wrapped = Stats.computeWrapped(trips, 2026, 8);
        expect(wrapped.label).toBe('September 2026');
        expect(wrapped.trips).toBe(3);
        expect(wrapped.topRoute).toEqual({ name: '501', count: 2 });
        expect(wrapped.favoriteStop.name).toBe('Spadina');
        expect(wrapped.busiestDay).toEqual({
            date: '2026-09-02',
            count: 2,
            label: expect.stringContaining('Sep'),
        });
        expect(wrapped.bestStreak).toBeGreaterThanOrEqual(2);
    });

    it('assigns a trip that crosses midnight to the month it started in', () => {
        const crossing = [{
            startTime: new Date(2026, 7, 31, 23, 50),
            endTime: new Date(2026, 8, 1, 0, 10),
            route: '501',
            duration: 20,
        }];
        expect(Stats.computeWrapped(crossing, 2026, 7).trips).toBe(1);
        expect(Stats.computeWrapped(crossing, 2026, 8).trips).toBe(0);
    });

    it('returns an empty summary for a month with no trips', () => {
        const wrapped = Stats.computeWrapped(trips, 2026, 0);
        expect(wrapped).toMatchObject({
            trips: 0, hours: 0, routes: 0, stops: 0, daysRidden: 0, bestStreak: 0,
            topRoute: null, favoriteStop: null, busiestDay: null, peak: null,
        });
    });

    it('sums hours from trip durations in minutes', () => {
        expect(Stats.computeWrapped(trips, 2026, 8).hours).toBe(0.8);
    });
});
