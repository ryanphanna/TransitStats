import {
    agencyCountry,
    computePeriodCounts,
    countCountries,
    countedRides,
    ridingStreaks,
    totalTripHours,
    tripsByDate,
    tripsByRoute,
    tripsByStop,
    tripStartDate,
} from './shared/trip-stats.js';

/**
 * TransitStats V2 Stats Module
 * Pure logic for processing trip data into dashboard metrics.
 */
export const Stats = {
    getAgencyCountry(agency) {
        return agencyCountry(agency);
    },

    getCountriesRidden(trips) {
        return countCountries(trips);
    },

    getTripDate(trip) {
        return tripStartDate(trip);
    },

    computeTripPeriodCounts(trips, now = new Date()) {
        return computePeriodCounts(trips, { now });
    },

    /**
     * Compute all dashboard metrics from a list of trips.
     */
    computeMetrics(trips) {
        if (!trips || trips.length === 0) {
            return {
                trips: 0,
                routes: 0,
                hours: 0,
                stops: 0,
                topRoutes: [],
                topStops: []
            };
        }

        // Routes and stops are tallied by the shared counting module. "Stops"
        // is every distinct stop the rider has touched, boarding or exiting.
        const routes = tripsByRoute(trips).counts;
        const stops = tripsByStop(trips).all;
        const top = counts => counts.slice(0, 5).map(([name, count]) => ({ name, count }));

        return {
            trips: trips.length,
            routes: routes.length,
            hours: totalTripHours(trips),
            stops: stops.length,
            topRoutes: top(routes),
            topStops: top(stops)
        };
    },

    /**
     * The trips a recap counts: counted logged trips plus the imported PRESTO
     * rides that were not also logged. Imported rides carry only a start time
     * and agency, so they add trips/days/streaks but no hours, routes, or stops.
     */
    countedRides(loggedTrips, importedRides) {
        return countedRides(loggedTrips, importedRides);
    },

    /**
     * Keep trips whose local start date falls in a calendar month.
     * monthIndex is 0–11 (JavaScript Date month).
     */
    filterByCalendarMonth(trips, year, monthIndex) {
        const y = Number(year);
        const m = Number(monthIndex);
        if (!Number.isInteger(y) || !Number.isInteger(m) || m < 0 || m > 11) return [];
        return (trips || []).filter(trip => {
            const date = this.getTripDate(trip);
            return date && date.getFullYear() === y && date.getMonth() === m;
        });
    },

    /** The calendar month before `now`, as { year, monthIndex } (January rolls back to December). */
    previousMonth(now = new Date()) {
        const date = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        return { year: date.getFullYear(), monthIndex: date.getMonth() };
    },

    formatMonthLabel(year, monthIndex, { style = 'long' } = {}) {
        const date = new Date(year, monthIndex, 1);
        if (isNaN(date.getTime())) return '';
        const month = date.toLocaleString('en-US', { month: style });
        return `${month} ${year}`;
    },

    computeBusiestDay(trips) {
        const top = Object.entries(tripsByDate(trips).byDay).sort(([, a], [, b]) => b - a)[0];
        if (!top) return null;
        const [iso, count] = top;
        const [y, m, d] = iso.split('-').map(Number);
        const label = new Date(y, m - 1, d).toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
        });
        return { date: iso, count, label };
    },

    computePeakBucket(trips) {
        const buckets = this.computePeakTimes(trips || []);
        const top = Object.entries(buckets).sort(([, a], [, b]) => b - a)[0];
        if (!top || top[1] === 0) return null;
        return { name: top[0], count: top[1] };
    },

    /**
     * Calendar-month Wrapped summary for shareable cards.
     */
    computeWrapped(trips, year, monthIndex) {
        const monthTrips = this.filterByCalendarMonth(trips, year, monthIndex);
        const metrics = this.computeMetrics(monthTrips);
        const streaks = this.calculateStreaks(monthTrips);
        const busiestDay = this.computeBusiestDay(monthTrips);
        const peak = this.computePeakBucket(monthTrips);
        const period = this.computeTripPeriodCounts(monthTrips);
        const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
        const dayCounts = Array(daysInMonth).fill(0);
        monthTrips.forEach(trip => {
            const date = this.getTripDate(trip);
            if (date) dayCounts[date.getDate() - 1]++;
        });

        return {
            year,
            monthIndex,
            label: this.formatMonthLabel(year, monthIndex),
            shortLabel: this.formatMonthLabel(year, monthIndex, { style: 'short' }),
            trips: metrics.trips,
            hours: metrics.hours,
            routes: metrics.routes,
            stops: metrics.stops,
            daysRidden: period.daysRidden,
            daysInMonth,
            dayCounts,
            topRoute: metrics.topRoutes[0] || null,
            topRoutes: metrics.topRoutes,
            favoriteStop: metrics.topStops[0] || null,
            bestStreak: streaks.best,
            busiestDay,
            peak,
        };
    },

    calculateStreaks(trips) {
        const streaks = ridingStreaks(trips);
        return { current: streaks.current, best: streaks.longest };
    },

    /**
     * Group trips by time of day buckets.
     */
    computePeakTimes(trips) {
        const buckets = { 'Morning': 0, 'Day': 0, 'Evening': 0, 'Night': 0 };
        trips.forEach(t => {
            const date = t.startTime?.toDate ? t.startTime.toDate() : new Date(t.startTime);
            const hour = date.getHours();
            if (hour >= 5 && hour < 11) buckets['Morning']++;
            else if (hour >= 11 && hour < 17) buckets['Day']++;
            else if (hour >= 17 && hour < 21) buckets['Evening']++;
            else buckets['Night']++;
        });
        return buckets;
    },

/**
     * Compute trips per day for the last N weeks to fit a GitHub-style grid.
     */
/**
     * Compute trips per day for the last N days.
     */
init() {
        console.log("Stats module initialized.");
    }
};
