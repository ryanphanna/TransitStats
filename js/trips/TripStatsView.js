import { Stats } from '../stats.js';
import { formatAtlasNumber } from '../shared/atlas-card.js';
import { projectPrestoTripsForStats } from '../presto-stop-matcher.js';

/**
 * TripStatsView - Manages the visualization of transit metrics and analytics.
 */
export const TripStatsView = {
    render(trips, prestoTrips = []) {
        // Trip counts, agencies, days ridden, and countries also count
        // imported PRESTO activity.
        const summaryTrips = [...trips, ...projectPrestoTripsForStats(prestoTrips)];
        const periodCounts = Stats.computeTripPeriodCounts(summaryTrips);
        this._updateBox('stat-trips-lifetime', periodCounts.lifetime);
        this._updateBox('stat-trips-month', periodCounts.thisMonth);
        this._updateBox('stat-trips-week', periodCounts.thisWeek);
        this._updateBox('stat-days-ridden', periodCounts.daysRidden);
        this._updateBox('stat-agencies-ridden', new Set(
            summaryTrips.map(trip => String(trip.agency || '').trim()).filter(Boolean)
        ).size);
        this._updateBox('stat-countries-ridden', Stats.getCountriesRidden(summaryTrips));
    },

    _updateBox(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = formatAtlasNumber(val);
    }
};
