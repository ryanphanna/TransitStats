import { formatAtlasNumber } from '../shared/atlas-card.js';
import { summaryTrips } from '../shared/ride-merge.js';
import { computeSummaryStats } from '../shared/trip-stats.js';

/**
 * TripStatsView - Manages the visualization of transit metrics and analytics.
 */
export const TripStatsView = {
    render(trips, prestoTrips = []) {
        // Trip counts, agencies, days ridden, and countries also count
        // imported PRESTO activity, except rides already logged as trips.
        // Same calculation as the public profile; days use the viewer's local time.
        const stats = computeSummaryStats(summaryTrips(trips, prestoTrips));
        this._updateBox('stat-trips-lifetime', stats.totalTrips);
        this._updateBox('stat-trips-month', stats.thisMonth);
        this._updateBox('stat-trips-week', stats.thisWeek);
        this._updateBox('stat-days-ridden', stats.daysRidden);
        this._updateBox('stat-agencies-ridden', stats.agencies);
        this._updateBox('stat-countries-ridden', stats.countries);
    },

    _updateBox(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = formatAtlasNumber(val);
    }
};
