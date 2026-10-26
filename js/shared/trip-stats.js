// Summary stats shared by the dashboard and the public profile, so the same
// trips give the same numbers on both. Single source of truth:
// functions/lib/trip-stats.js is generated from this file by
// `npm run sync:shared` (a test fails if the copy drifts). Keep this file
// dependency-free, with plain `export const` / `export function` only.

// A trip with no end time stays "active" (off the history) for this long.
export const ACTIVE_TRIP_WINDOW_MS = 6 * 60 * 60 * 1000;

// Riders without a stored trip timezone are assumed to be in the Toronto area.
export const DEFAULT_TRIP_TIME_ZONE = 'America/Toronto';

export const AGENCY_COUNTRIES = new Map([
    ...['TTC', 'GO', 'GO Transit', 'MiWay', 'YRT', 'Brampton Transit', 'Durham Transit', 'HSR', 'GRT', 'Grand River Transit', 'OC Transpo', 'STM', 'TransLink', 'Oakville Transit', 'GTAA Terminal Link', 'Flagship Cruises & Events', 'Exo', 'CDPQ Infra', 'Niagara Region Transit'].map(agency => [agency.toLowerCase(), 'Canada']),
    ...['NYC MTA', 'New York City Transit', 'LA Metro', 'LADOT', 'Los Angeles Department of Transportation', 'Big Blue Bus', 'BART', 'Muni', 'Caltrain', 'VTA', 'AC Transit', 'SamTrans', 'MTS', 'Amtrak', 'Golden Gate Transit', 'SMART', 'Santa Rosa CityBus', 'CDTA', 'NFTA Metro', 'TriMet', 'C-Tran', 'Sound Transit', 'King County Metro', 'Utah Transit Authority', 'Sacramento Regional Transit', 'GCRTA'].map(agency => [agency.toLowerCase(), 'United States']),
    ...['RATP', 'SNCF Transilien'].map(agency => [agency.toLowerCase(), 'France']),
    ...['TMB'].map(agency => [agency.toLowerCase(), 'Spain']),
]);

export function agencyCountry(agency) {
    return AGENCY_COUNTRIES.get(String(agency || '').trim().toLowerCase()) || null;
}

export function tripStartDate(trip) {
    const date = trip?.startTime?.toDate
        ? trip.startTime.toDate()
        : new Date(trip?.startTime);
    return Number.isNaN(date.getTime()) ? null : date;
}

function tripStartMs(trip) {
    const date = tripStartDate(trip);
    return date ? date.getTime() : NaN;
}

/** Still in progress: no end time, not discarded, and started under 6 hours ago. */
export function isActiveTrip(trip, now = Date.now()) {
    if (trip?.endTime || trip?.discarded) return false;
    return now - tripStartMs(trip) < ACTIVE_TRIP_WINDOW_MS;
}

/** Belongs in history: finished, discarded, or started 6+ hours ago. */
export function isHistoryTrip(trip, now = Date.now()) {
    if (trip?.endTime || trip?.discarded) return true;
    return now - tripStartMs(trip) >= ACTIVE_TRIP_WINDOW_MS;
}

/** The public profile reads each trip's stored timezone, never the server clock. */
export function storedTripTimeZone(trip) {
    return trip?.timezone || DEFAULT_TRIP_TIME_ZONE;
}

const DAY_FORMATTERS = new Map();

function dayFormatter(timeZone) {
    if (!DAY_FORMATTERS.has(timeZone)) {
        let formatter;
        try {
            formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
        } catch {
            formatter = timeZone === DEFAULT_TRIP_TIME_ZONE ? null : dayFormatter(DEFAULT_TRIP_TIME_ZONE);
        }
        DAY_FORMATTERS.set(timeZone, formatter);
    }
    return DAY_FORMATTERS.get(timeZone);
}

/**
 * The calendar day a date falls on. With no timeZone it uses the runtime's
 * local time (the viewer's browser on the dashboard).
 */
export function tripDayKey(date, timeZone = null) {
    if (!timeZone) return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    return dayFormatter(timeZone).format(date);
}

/** Trip counts for lifetime, the last 30 and 7 days, and distinct days ridden. */
export function computePeriodCounts(trips, { now = new Date(), timeZoneFor = null } = {}) {
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    let thisWeek = 0;
    let thisMonth = 0;
    const riddenDays = new Set();
    (trips || []).forEach(trip => {
        const date = tripStartDate(trip);
        if (!date) return;
        riddenDays.add(tripDayKey(date, timeZoneFor ? timeZoneFor(trip) : null));
        if (date >= sevenDaysAgo) thisWeek++;
        if (date >= thirtyDaysAgo) thisMonth++;
    });

    return {
        lifetime: trips?.length || 0,
        thisMonth,
        thisWeek,
        daysRidden: riddenDays.size,
    };
}

export function countAgencies(trips) {
    return new Set((trips || [])
        .map(trip => String(trip.agency || '').trim())
        .filter(Boolean)).size;
}

export function countCountries(trips) {
    return new Set((trips || [])
        .map(trip => agencyCountry(trip.agency))
        .filter(Boolean)).size;
}

export function countRoutes(trips) {
    return new Set((trips || [])
        .filter(trip => trip.route)
        .map(trip => String(trip.route))).size;
}

export function totalTripHours(trips) {
    const minutes = (trips || []).reduce((sum, trip) => sum + (trip.duration || 0), 0);
    return Math.round((minutes / 60) * 10) / 10;
}

/**
 * Every summary tile, from logged trips plus imported rides already projected
 * to `{ agency, startTime }` (see projectPrestoTripsForStats).
 */
export function computeSummaryStats(trips, options = {}) {
    const period = computePeriodCounts(trips, options);
    return {
        totalTrips: period.lifetime,
        thisMonth: period.thisMonth,
        thisWeek: period.thisWeek,
        daysRidden: period.daysRidden,
        totalHours: totalTripHours(trips),
        agencies: countAgencies(trips),
        routes: countRoutes(trips),
        countries: countCountries(trips),
    };
}
