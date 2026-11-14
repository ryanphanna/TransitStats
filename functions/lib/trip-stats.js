// GENERATED from js/shared/trip-stats.js by scripts/sync-shared.mjs. Do not edit.
// How trips are counted, for the website (dashboard, public profile, recap)
// and for ASK. Every total both sides show comes from the functions here, so
// the same trips give the same numbers everywhere: which records count, which
// are finished, how imported PRESTO rides join in, canonical agency names, and
// the tallies by agency, route, stop, day, month, year and weekday.
//
// Single source of truth: functions/lib/trip-stats.js is generated from this
// file by `npm run sync:shared` (a test fails if the copy drifts). Keep it to
// plain `export const` / `export function`, importing only from other shared
// modules.
const { canonicalAgency } = require('./agency-aliases');
const { summaryTrips } = require('./ride-merge');

// A trip with no end time stays "active" (off the history) for this long.
const ACTIVE_TRIP_WINDOW_MS = 6 * 60 * 60 * 1000;

// Riders without a stored trip timezone are assumed to be in the Toronto area.
const DEFAULT_TRIP_TIME_ZONE = 'America/Toronto';

const AGENCY_COUNTRIES = new Map([
    ...['TTC', 'GO', 'GO Transit', 'MiWay', 'YRT', 'Brampton Transit', 'Durham Transit', 'HSR', 'GRT', 'Grand River Transit', 'OC Transpo', 'STM', 'TransLink', 'Oakville Transit', 'GTAA Terminal Link', 'Flagship Cruises & Events', 'Exo', 'CDPQ Infra', 'Niagara Region Transit'].map(agency => [agency.toLowerCase(), 'Canada']),
    ...['NYC MTA', 'New York City Transit', 'LA Metro', 'LADOT', 'Los Angeles Department of Transportation', 'Big Blue Bus', 'BART', 'Muni', 'Caltrain', 'VTA', 'AC Transit', 'SamTrans', 'MTS', 'Amtrak', 'Golden Gate Transit', 'SMART', 'Santa Rosa CityBus', 'CDTA', 'NFTA Metro', 'TriMet', 'C-Tran', 'Sound Transit', 'King County Metro', 'Utah Transit Authority', 'Sacramento Regional Transit', 'GCRTA'].map(agency => [agency.toLowerCase(), 'United States']),
    ...['RATP', 'SNCF Transilien'].map(agency => [agency.toLowerCase(), 'France']),
    ...['TMB'].map(agency => [agency.toLowerCase(), 'Spain']),
]);

function agencyCountry(agency) {
    const name = typeof agency === 'string' ? canonicalAgency(agency) : '';
    return AGENCY_COUNTRIES.get(String(name || '').toLowerCase()) || null;
}

function tripStartDate(trip) {
    const value = trip?.startTime;
    // No start time means no date. `new Date(null)` would be 1 January 1970.
    if (value === null || value === undefined) return null;
    const date = value.toDate ? value.toDate() : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function tripStartMs(trip) {
    const date = tripStartDate(trip);
    return date ? date.getTime() : NaN;
}

/** Still in progress: no end time, not discarded, and started under 6 hours ago. */
function isActiveTrip(trip, now = Date.now()) {
    if (trip?.endTime || trip?.discarded) return false;
    return now - tripStartMs(trip) < ACTIVE_TRIP_WINDOW_MS;
}

/** Belongs in history: finished, discarded, or started 6+ hours ago. */
function isHistoryTrip(trip, now = Date.now()) {
    if (trip?.endTime || trip?.discarded) return true;
    return now - tripStartMs(trip) >= ACTIVE_TRIP_WINDOW_MS;
}

/**
 * A text that could not be read as a trip: saved from the fallback path with
 * no start time, route or agency.
 */
function isUnreadableText(trip) {
    return trip?.source === 'sms_fallback' && tripStartDate(trip) === null && !trip.route && !tripAgency(trip);
}

// Whether unreadable texts that reach history (the discarded ones) count as
// trips. They do not (CIV-1378): they have no route, stop or time, so they
// are left out of every total on the website and in ASK.
const COUNT_UNREADABLE_TEXTS = false;

/** A counted trip: in history and, unless unreadable texts count, not one of those. */
function isCountedTrip(trip, now = Date.now(), countUnreadableTexts = COUNT_UNREADABLE_TEXTS) {
    if (!isHistoryTrip(trip, now)) return false;
    return countUnreadableTexts || !isUnreadableText(trip);
}

/** The logged trips every total is based on. */
function countedTrips(trips, now = Date.now(), countUnreadableTexts = COUNT_UNREADABLE_TEXTS) {
    return (trips || []).filter(trip => isCountedTrip(trip, now, countUnreadableTexts));
}

/**
 * Everything that counts as a trip: counted logged trips plus the imported
 * PRESTO rides (from buildPrestoTrips) that were not also logged. Imported
 * rides carry only an agency and a start time.
 */
function countedRides(loggedTrips, prestoTrips = [], { now = Date.now(), countUnreadableTexts = COUNT_UNREADABLE_TEXTS } = {}) {
    return summaryTrips(countedTrips(loggedTrips, now, countUnreadableTexts), prestoTrips);
}

/** Finished trips: those with a recorded duration. Used for durations only, never for a trip count. */
function finishedTrips(trips) {
    return (trips || []).filter(trip => trip.duration > 0);
}

/** The public profile reads each trip's stored timezone, never the server clock. */
function storedTripTimeZone(trip) {
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

const pad = value => String(value).padStart(2, '0');

/**
 * The calendar day a date falls on, as YYYY-MM-DD. With no timeZone it uses
 * the runtime's local time (the viewer's browser on the dashboard).
 */
function tripDayKey(date, timeZone = null) {
    if (!timeZone) return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return dayFormatter(timeZone).format(date);
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Whole days since 1970 for a YYYY-MM-DD key, so days can be compared and stepped.
function dayNumber(dayKey) {
    const [year, month, day] = dayKey.split('-').map(Number);
    return Date.UTC(year, month - 1, day) / 86400000;
}

/** The Monday that starts a day's week, as YYYY-MM-DD. */
function weekStartKey(dayKey) {
    const number = dayNumber(dayKey);
    const weekday = new Date(number * 86400000).getUTCDay();
    return new Date((number - ((weekday + 6) % 7)) * 86400000).toISOString().slice(0, 10);
}

/**
 * Every trip is placed on the calendar day it happened in its own stored time
 * zone (Toronto when it has none, which covers imported PRESTO rides), the
 * same on the dashboard, public profile and in ASK (CIV-1394). `timeZoneFor`
 * overrides that per trip (tests). `timeZone` is only the zone "today" is
 * read in; with none, "today" is the runtime's local day.
 */
function zoneOf(trip, { timeZoneFor = null } = {}) {
    return timeZoneFor ? timeZoneFor(trip) : storedTripTimeZone(trip);
}

const HOUR_FORMATTERS = new Map();

function hourFormatter(timeZone) {
    if (!HOUR_FORMATTERS.has(timeZone)) {
        let formatter;
        try {
            formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });
        } catch {
            formatter = timeZone === DEFAULT_TRIP_TIME_ZONE ? null : hourFormatter(DEFAULT_TRIP_TIME_ZONE);
        }
        HOUR_FORMATTERS.set(timeZone, formatter);
    }
    return HOUR_FORMATTERS.get(timeZone);
}

/**
 * The local calendar day a trip started on, or null when it has no start time:
 * `{ dayKey, month, year, weekday }` (YYYY-MM-DD, YYYY-MM, number, day name).
 */
function tripLocalDay(trip, options = {}) {
    const date = tripStartDate(trip);
    if (!date) return null;
    const dayKey = tripDayKey(date, zoneOf(trip, options));
    return {
        dayKey,
        month: dayKey.slice(0, 7),
        year: Number(dayKey.slice(0, 4)),
        weekday: DAY_NAMES[new Date(dayNumber(dayKey) * 86400000).getUTCDay()],
    };
}

/** The local hour (0-23) a trip started at in its own time zone, or null when it has no start time. */
function tripLocalHour(trip, options = {}) {
    const date = tripStartDate(trip);
    if (!date) return null;
    return Number(hourFormatter(zoneOf(trip, options)).format(date)) % 24;
}

/** Trips that started on the local days `fromDay` to `toDay` (YYYY-MM-DD), inclusive. */
function tripsBetweenDays(trips, fromDay, toDay, options = {}) {
    return (trips || []).filter(trip => {
        const local = tripLocalDay(trip, options);
        return local && local.dayKey >= fromDay && local.dayKey <= toDay;
    });
}

const tally = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };

/** `[name, count]` pairs, most trips first. */
function sortedCounts(counts) {
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

/** Trip counts per day, week (by its Monday), month, year and weekday, and how many trips have no date. */
function tripsByDate(trips, options = {}) {
    const byDay = {};
    const byWeek = {};
    const byMonth = {};
    const byYear = {};
    const byWeekday = {};
    let withoutDate = 0;
    (trips || []).forEach(trip => {
        const local = tripLocalDay(trip, options);
        if (!local) { withoutDate++; return; }
        tally(byDay, local.dayKey);
        tally(byWeek, weekStartKey(local.dayKey));
        tally(byMonth, local.month);
        tally(byYear, local.year);
        tally(byWeekday, local.weekday);
    });
    return { byDay, byWeek, byMonth, byYear, byWeekday, withoutDate, daysRidden: Object.keys(byDay).length };
}

/**
 * Longest run of consecutive days ridden, and the current run (0 unless the
 * rider rode today or yesterday).
 */
function ridingStreaks(trips, options = {}) {
    const days = Object.keys(tripsByDate(trips, options).byDay).map(dayNumber).sort((a, b) => a - b);
    let longest = 0;
    let run = 0;
    days.forEach((day, index) => {
        run = index > 0 && day - days[index - 1] === 1 ? run + 1 : 1;
        longest = Math.max(longest, run);
    });
    const today = dayNumber(tripDayKey(options.now ? new Date(options.now) : new Date(), options.timeZone || null));
    const last = days[days.length - 1];
    const current = last === today || last === today - 1 ? run : 0;
    return { longest, current, daysRidden: days.length };
}

/** Trip counts for lifetime, the last 30 and 7 days, and distinct days ridden. */
function computePeriodCounts(trips, { now = new Date(), timeZoneFor = null } = {}) {
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
        riddenDays.add(tripLocalDay(trip, { timeZoneFor }).dayKey);
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

/** A trip's agency under its canonical name (spelling variants merge), or null when it has none. */
function tripAgency(trip) {
    const name = typeof trip?.agency === 'string' ? canonicalAgency(trip.agency) : '';
    return name || null;
}

/** Trips per canonical agency, most first, and how many trips have no agency. */
function tripsByAgency(trips) {
    const counts = {};
    let withoutAgency = 0;
    (trips || []).forEach(trip => {
        const agency = tripAgency(trip);
        if (agency) tally(counts, agency);
        else withoutAgency++;
    });
    return { counts: sortedCounts(counts), withoutAgency };
}

function countAgencies(trips) {
    return tripsByAgency(trips).counts.length;
}

function countCountries(trips) {
    return new Set((trips || [])
        .map(trip => agencyCountry(trip.agency))
        .filter(Boolean)).size;
}

/**
 * Route counts keyed by label, where labels that differ only by letter case are one route
 * ("510a" counts with "510A"). Branches and wording stay apart: 510A and 510B are two routes,
 * and "510 Shuttle" is not 510. A number with a letter suffix is shown with the letter
 * uppercased (510A); any other label is shown the way it was most often typed.
 */
function routeCounts(routes) {
    const groups = new Map();
    (routes || []).forEach(route => {
        const typed = String(route).trim();
        if (!typed) return;
        const key = typed.toLowerCase();
        if (!groups.has(key)) groups.set(key, { count: 0, spellings: new Map() });
        const group = groups.get(key);
        group.count++;
        group.spellings.set(typed, (group.spellings.get(typed) || 0) + 1);
    });
    const counts = {};
    groups.forEach(({ count, spellings }) => {
        let label = [...spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const branch = label.match(/^(\d+)([a-z]+)$/i);
        if (branch) label = branch[1] + branch[2].toUpperCase();
        counts[label] = count;
    });
    return counts;
}

/** Trips per route, most first, and how many trips have no route. */
function tripsByRoute(trips) {
    const routes = [];
    let withoutRoute = 0;
    (trips || []).forEach(trip => {
        if (trip.route && String(trip.route).trim()) routes.push(trip.route);
        else withoutRoute++;
    });
    return { counts: sortedCounts(routeCounts(routes)), withoutRoute };
}

function countRoutes(trips) {
    return tripsByRoute(trips).counts.length;
}

function boardingStop(trip) {
    return trip?.startStopName || trip?.startStop || trip?.startStopCode || null;
}

function exitStop(trip) {
    return trip?.endStopName || trip?.endStop || trip?.endStopCode || null;
}

/**
 * Uses per stop, most first: as a boarding stop, as an exit stop, and either
 * way (`all`, one entry per distinct stop the rider has touched).
 */
function tripsByStop(trips) {
    const boarding = {};
    const exit = {};
    const all = {};
    (trips || []).forEach(trip => {
        const start = boardingStop(trip);
        const end = exitStop(trip);
        if (start) { tally(boarding, start); tally(all, start); }
        if (end) { tally(exit, end); tally(all, end); }
    });
    return { boarding: sortedCounts(boarding), exit: sortedCounts(exit), all: sortedCounts(all) };
}

/** Durations of the finished trips, in minutes: the list, how many, average, shortest and longest. */
function durationSummary(trips) {
    const minutes = finishedTrips(trips).map(trip => trip.duration);
    return {
        minutes,
        count: minutes.length,
        average: minutes.length ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null,
        shortest: minutes.length ? Math.min(...minutes) : null,
        longest: minutes.length ? Math.max(...minutes) : null,
    };
}

function totalTripHours(trips) {
    const minutes = durationSummary(trips).minutes.reduce((sum, duration) => sum + duration, 0);
    return Math.round((minutes / 60) * 10) / 10;
}

/** Every summary tile, from the output of countedRides. */
function computeSummaryStats(trips, options = {}) {
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

module.exports = { ACTIVE_TRIP_WINDOW_MS, DEFAULT_TRIP_TIME_ZONE, AGENCY_COUNTRIES, agencyCountry, tripStartDate, isActiveTrip, isHistoryTrip, isUnreadableText, COUNT_UNREADABLE_TEXTS, isCountedTrip, countedTrips, countedRides, finishedTrips, storedTripTimeZone, tripDayKey, DAY_NAMES, weekStartKey, tripLocalDay, tripLocalHour, tripsBetweenDays, sortedCounts, tripsByDate, ridingStreaks, computePeriodCounts, tripAgency, tripsByAgency, countAgencies, countCountries, routeCounts, tripsByRoute, countRoutes, boardingStop, exitStop, tripsByStop, durationSummary, totalTripHours, computeSummaryStats };
