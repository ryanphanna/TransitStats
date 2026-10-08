const AGENCY_COUNTRIES = new Map([
    ...['TTC', 'GO', 'GO Transit', 'MiWay', 'YRT', 'Brampton Transit', 'Durham Transit', 'HSR', 'GRT', 'Grand River Transit', 'OC Transpo', 'STM', 'TransLink', 'Oakville Transit', 'GTAA Terminal Link', 'Flagship Cruises & Events', 'Exo', 'CDPQ Infra', 'Niagara Region Transit'].map(agency => [agency.toLowerCase(), 'Canada']),
    ...['NYC MTA', 'New York City Transit', 'LA Metro', 'LADOT', 'Los Angeles Department of Transportation', 'Big Blue Bus', 'BART', 'Muni', 'Caltrain', 'VTA', 'AC Transit', 'SamTrans', 'MTS', 'Amtrak', 'Golden Gate Transit', 'SMART', 'Santa Rosa CityBus', 'CDTA', 'NFTA Metro', 'TriMet', 'C-Tran', 'Sound Transit', 'King County Metro', 'Utah Transit Authority', 'Sacramento Regional Transit', 'GCRTA'].map(agency => [agency.toLowerCase(), 'United States']),
    ...['RATP', 'SNCF Transilien'].map(agency => [agency.toLowerCase(), 'France']),
    ...['TMB'].map(agency => [agency.toLowerCase(), 'Spain']),
]);

/**
 * TransitStats V2 Stats Module
 * Pure logic for processing trip data into dashboard metrics.
 */
export const Stats = {
    getAgencyCountry(agency) {
        return AGENCY_COUNTRIES.get(String(agency || '').trim().toLowerCase()) || null;
    },

    getCountriesRidden(trips) {
        return new Set((trips || [])
            .map(trip => this.getAgencyCountry(trip.agency))
            .filter(Boolean)).size;
    },

    getTripDate(trip) {
        const date = trip?.startTime?.toDate
            ? trip.startTime.toDate()
            : new Date(trip?.startTime);
        return isNaN(date.getTime()) ? null : date;
    },

    computeTripPeriodCounts(trips, now = new Date()) {
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const thirtyDaysAgo = new Date(now);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        let thisWeek = 0;
        let thisMonth = 0;
        const riddenDays = new Set();
        (trips || []).forEach(trip => {
            const date = this.getTripDate(trip);
            if (!date) return;
            riddenDays.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`);
            if (date >= sevenDaysAgo) thisWeek++;
            if (date >= thirtyDaysAgo) thisMonth++;
        });

        return {
            lifetime: trips?.length || 0,
            thisMonth,
            thisWeek,
            daysRidden: riddenDays.size
        };
    },

    /**
     * Compute all dashboard metrics from a list of trips.
     */
    computeMetrics(trips, filterDays = null) {
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

        const filtered = filterDays 
            ? this.filterRecent(trips, filterDays) 
            : trips;

        const routeCounts = {};
        const stopCounts = {};
        let totalMinutes = 0;

        filtered.forEach(t => {
            // Count Route
            if (t.route) {
                routeCounts[t.route] = (routeCounts[t.route] || 0) + 1;
            }

            // Count Stops — intentionally union of boarding + exiting stops.
            // The "Stops" metric represents every distinct physical stop the user has
            // ever touched, regardless of role. Once all stops are normalized to
            // canonical names via the stop library, duplicate entries within a single
            // trip (e.g. a stop that is both a start and an end across different trips)
            // will be naturally deduplicated by the shared key in stopCounts.
            const start = t.startStopName || t.startStop || t.startStopCode;
            const end = t.endStopName || t.endStop || t.endStopCode;
            if (start) stopCounts[start] = (stopCounts[start] || 0) + 1;
            if (end) stopCounts[end] = (stopCounts[end] || 0) + 1;

            // Compute Duration
            totalMinutes += (t.duration || 0);
        });

        return {
            trips: filtered.length,
            routes: Object.keys(routeCounts).length,
            hours: Math.round((totalMinutes / 60) * 10) / 10,
            stops: Object.keys(stopCounts).length,
            topRoutes: this.getTopItems(routeCounts, 5),
            topStops: this.getTopItems(stopCounts, 5)
        };
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

    listAvailableMonths(trips) {
        const keys = new Set();
        (trips || []).forEach(trip => {
            const date = this.getTripDate(trip);
            if (!date) return;
            keys.add(`${date.getFullYear()}-${date.getMonth()}`);
        });
        return Array.from(keys)
            .map(key => {
                const [year, monthIndex] = key.split('-').map(Number);
                return { year, monthIndex };
            })
            .sort((a, b) => (b.year - a.year) || (b.monthIndex - a.monthIndex));
    },

    formatMonthLabel(year, monthIndex, { style = 'long' } = {}) {
        const date = new Date(year, monthIndex, 1);
        if (isNaN(date.getTime())) return '';
        const month = date.toLocaleString('en-US', { month: style });
        return `${month} ${year}`;
    },

    computeBusiestDay(trips) {
        const dayCounts = {};
        (trips || []).forEach(trip => {
            const date = this.getTripDate(trip);
            if (!date) return;
            const key = [
                date.getFullYear(),
                String(date.getMonth() + 1).padStart(2, '0'),
                String(date.getDate()).padStart(2, '0'),
            ].join('-');
            dayCounts[key] = (dayCounts[key] || 0) + 1;
        });
        const top = Object.entries(dayCounts).sort(([, a], [, b]) => b - a)[0];
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
            topRoute: metrics.topRoutes[0] || null,
            topRoutes: metrics.topRoutes,
            favoriteStop: metrics.topStops[0] || null,
            bestStreak: streaks.best,
            busiestDay,
            peak,
        };
    },

    getTopItems(countsObj, limit) {
        return Object.entries(countsObj)
            .sort(([, a], [, b]) => b - a)
            .slice(0, limit)
            .map(([name, count]) => ({ name, count }));
    },

    calculateStreaks(trips) {
        if (!trips || trips.length === 0) return { current: 0, best: 0 };

        const dayTimestamps = new Set();
        trips.forEach(t => {
            const date = t.startTime?.toDate ? t.startTime.toDate() : new Date(t.startTime);
            if (isNaN(date.getTime())) return;
            const normalized = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
            dayTimestamps.add(normalized);
        });

        const sorted = Array.from(dayTimestamps).sort((a, b) => b - a);
        if (sorted.length === 0) return { current: 0, best: 0 };

        // Best Streak
        let best = 1;
        let temp = 1;
        for (let i = 0; i < sorted.length - 1; i++) {
            const diffDays = Math.round((sorted[i] - sorted[i+1]) / (24 * 60 * 60 * 1000));
            if (diffDays === 1) {
                temp++;
            } else {
                best = Math.max(best, temp);
                temp = 1;
            }
        }
        best = Math.max(best, temp);

        // Current Streak
        const today = new Date();
        today.setHours(0,0,0,0);
        const todayTs = today.getTime();
        const yesterdayTs = todayTs - (24 * 60 * 60 * 1000);
        
        const latest = sorted[0];
        let current = 0;
        if (latest === todayTs || latest === yesterdayTs) {
            current = 1;
            for (let i = 0; i < sorted.length - 1; i++) {
                const diffDays = Math.round((sorted[i] - sorted[i+1]) / (24 * 60 * 60 * 1000));
                if (diffDays === 1) current++;
                else break;
            }
        }

        return { current, best };
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
