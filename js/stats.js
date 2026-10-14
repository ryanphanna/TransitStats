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

    init() {
        console.log("Stats module initialized.");
    }
};
