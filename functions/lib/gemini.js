/**
 * Gemini AI helper functions for SMS parsing and querying
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { defineSecret } = require('firebase-functions/params');
const { VALID_INTENTS, VALID_SENTIMENTS } = require('./constants');
const logger = require('./logger');
const { ASK_FAILED } = require('./sms-text');

const geminiApiKey = defineSecret('GEMINI_API_KEY');
const GEMINI_MODEL = 'gemini-2.5-flash';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getTimezoneDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'long',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function getWeekStartDateKeyInTimezone(date, timezone) {
  const parts = getTimezoneDateParts(date, timezone);
  const weekdayIndex = DAY_NAMES.indexOf(parts.weekday);
  const utcMidday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
  utcMidday.setUTCDate(utcMidday.getUTCDate() - ((weekdayIndex + 6) % 7));
  return getTimezoneDateParts(utcMidday, timezone).dateKey;
}

/**
 * Retry helper with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Initial delay in milliseconds
 * @returns {Promise<any>} Result of function
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000, traceId = null) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries - 1;

      // Don't retry on permanent errors
      if (error.message && (
        error.message.includes('API key') ||
        error.message.includes('unauthorized') ||
        error.message.includes('no longer available') ||
        error.message.includes('404') ||
        (error.message.includes('invalid') && !error.message.includes('invalid response'))
      )) {
        throw error;
      }

      if (isLastAttempt) {
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = baseDelay * Math.pow(2, attempt);
      logger.info('Gemini retrying', { attempt: attempt + 1, maxRetries, delayMs: delay }, traceId);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Aggregate trip data into summary stats for AI context
 * @param {Array} trips - List of trip objects
 * @returns {object} Aggregated stats
 */
function aggregateTripStats(trips, defaultTimezone = 'America/Toronto') {
  const routeMap = {};
  const pairMap = {};
  const boardingStopMap = {};
  const exitStopMap = {};
  const hourMap = {};
  const dayOfWeekMap = {};
  let windowStart = null;
  let windowEnd = null;

  trips.forEach((trip) => {
    const route = trip.route || 'Unknown';
    const dur = trip.duration || 0;
    const startStop = trip.startStopName || trip.startStop || trip.startStopCode || 'Unknown';
    const endStop = trip.endStopName || trip.endStop || trip.endStopCode || 'Unknown';
    const pairKey = `${startStop} → ${endStop}`;

    // Respect per-trip timezone, fallback to provided default
    const tripTimezone = trip.timezone || defaultTimezone;

    if (!routeMap[route]) routeMap[route] = { count: 0, durations: [] };
    routeMap[route].count++;
    if (dur > 0) routeMap[route].durations.push(dur);

    if (!pairMap[pairKey]) pairMap[pairKey] = { route, count: 0, durations: [] };
    pairMap[pairKey].count++;
    if (dur > 0) pairMap[pairKey].durations.push(dur);

    if (startStop !== 'Unknown') {
      boardingStopMap[startStop] = (boardingStopMap[startStop] || 0) + 1;
    }
    if (endStop !== 'Unknown') {
      exitStopMap[endStop] = (exitStopMap[endStop] || 0) + 1;
    }

    if (trip.startTime) {
      const date = trip.startTime.toDate ? trip.startTime.toDate() : new Date(trip.startTime);
      const parts = getTimezoneDateParts(date, tripTimezone);
      hourMap[parts.hour] = (hourMap[parts.hour] || 0) + 1;
      dayOfWeekMap[parts.weekday] = (dayOfWeekMap[parts.weekday] || 0) + 1;
      if (!windowStart || date < windowStart) windowStart = date;
      if (!windowEnd || date > windowEnd) windowEnd = date;
    }
  });

  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

  const routeStats = Object.entries(routeMap).map(([route, data]) => ({
    route,
    count: data.count,
    avgDuration: avg(data.durations),
    minDuration: data.durations.length ? Math.min(...data.durations) : null,
    maxDuration: data.durations.length ? Math.max(...data.durations) : null,
  })).sort((a, b) => b.count - a.count).slice(0, 10);

  const pairStats = Object.entries(pairMap).map(([pair, data]) => ({
    pair,
    route: data.route,
    count: data.count,
    avgDuration: avg(data.durations),
    minDuration: data.durations.length ? Math.min(...data.durations) : null,
    maxDuration: data.durations.length ? Math.max(...data.durations) : null,
  })).sort((a, b) => b.count - a.count).slice(0, 20);

  const boardingStops = Object.entries(boardingStopMap)
    .map(([stop, count]) => ({ stop, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const exitStops = Object.entries(exitStopMap)
    .map(([stop, count]) => ({ stop, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const timeOfDay = { morning: 0, midday: 0, afternoon: 0, evening: 0, night: 0 };
  Object.entries(hourMap).forEach(([hour, count]) => {
    const h = parseInt(hour);
    if (h >= 6 && h <= 9) timeOfDay.morning += count;
    else if (h >= 10 && h <= 14) timeOfDay.midday += count;
    else if (h >= 15 && h <= 18) timeOfDay.afternoon += count;
    else if (h >= 19 && h <= 22) timeOfDay.evening += count;
    else timeOfDay.night += count;
  });

  // Daily trip counts (YYYY-MM-DD → count) for specific date queries
  const dailyCounts = {};
  trips.forEach((trip) => {
    if (!trip.startTime) return;
    const tripTimezone = trip.timezone || defaultTimezone;
    const date = trip.startTime.toDate ? trip.startTime.toDate() : new Date(trip.startTime);
    const key = getTimezoneDateParts(date, tripTimezone).dateKey;
    dailyCounts[key] = (dailyCounts[key] || 0) + 1;
  });

  const allStops = Array.from(new Set([
    ...Object.keys(boardingStopMap),
    ...Object.keys(exitStopMap),
  ])).sort();

  return {
    total: trips.length,
    routeStats, pairStats, boardingStops, exitStops, timeOfDay, dailyCounts, allStops,
    dayOfWeek: dayOfWeekMap,
    windowStart: windowStart ? windowStart.toLocaleDateString('en-CA', { timeZone: defaultTimezone }) : null,
    windowEnd: windowEnd ? windowEnd.toLocaleDateString('en-CA', { timeZone: defaultTimezone }) : null,
  };
}

/**
 * Sanitize Gemini output to prevent prompt injection attacks and invalid data.
 * @param {object} parsed - Gemini result object
 * @returns {object|null} Sanitized result
 */
function sanitizeGeminiOutput(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const MAX_FIELD_LENGTH = 100;

  // Strip HTML tags from a string (recursive to prevent bypass)
  const stripHtml = (str) => {
    if (typeof str !== 'string') return str;
    let oldStr;
    do {
      oldStr = str;
      str = str.replace(/<[^>]*>/g, '');
    } while (str !== oldStr);
    return str.trim();
  };

  // Sanitize and cap a string field
  const sanitizeField = (val, maxLen = MAX_FIELD_LENGTH) => {
    if (val == null) return null;
    if (typeof val !== 'string') return null;
    return stripHtml(val).slice(0, maxLen) || null;
  };

  // Validate intent
  const intent = VALID_INTENTS.includes(parsed.intent) ? parsed.intent : 'OTHER';

  // Validate sentiment
  const sentiment = VALID_SENTIMENTS.includes(parsed.sentiment) ? parsed.sentiment : 'NEUTRAL';

  // Sanitize tags array
  const tags = Array.isArray(parsed.tags) ?
    parsed.tags.filter((t) => typeof t === 'string').map((t) => stripHtml(t).slice(0, 30)).slice(0, 5) :
    [];

  return {
    intent,
    route: sanitizeField(parsed.route, 50),
    stop_name: sanitizeField(parsed.stop_name),
    stop_id: sanitizeField(parsed.stop_id, 20),
    direction: sanitizeField(parsed.direction, 30),
    agency: sanitizeField(parsed.agency, 50),
    sentiment,
    tags,
    question: sanitizeField(parsed.question, 300),
    notes: sanitizeField(parsed.notes, 300),
  };
}

/**
 * Use Gemini to answer a natural-language question given aggregated trip stats,
 * using function calling (tools) to search the database if needed.
 * @param {string} userId - User identifier
 * @param {string} question - User question
 * @param {Array} recentTrips - Most recent 200 trips (raw)
 * @param {object} stats - Aggregated stats for the recent 200 trips
 * @param {Array} conversationHistory - Recent Q&A turns [{ role, text }]
 * @returns {Promise<string>} AI answer
 */
/**
 * Returns UTC Date objects for the start and end of a calendar day in the given timezone.
 * Uses noon as a DST-safe reference point to calculate the UTC offset.
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} timezone - IANA timezone string
 * @returns {{ start: Date, end: Date }}
 */
function dayBoundsInTimezone(dateStr, timezone) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const refUTC = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(refUTC).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  const localNoonMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = refUTC.getTime() - localNoonMs;
  return {
    start: new Date(Date.UTC(year, month - 1, day, 0, 0, 0) + offsetMs),
    end: new Date(Date.UTC(year, month - 1, day, 23, 59, 59) + offsetMs),
  };
}

async function answerQueryWithGemini(
  userId,
  question,
  recentTrips,
  stats,
  conversationHistory = [],
  timezone = 'America/Toronto',
  traceId = null
) {
  const apiKey = geminiApiKey.value();
  if (!apiKey) return 'AI unavailable right now.';

  const { getFirestore } = require('firebase-admin/firestore');
  const db = getFirestore();

  // Define tools available to the AI
  const tools = [
    {
      functionDeclarations: [
        {
          name: 'get_all_time_stats',
          description: 'Get total trip, route, and stop counts across all time. ' +
            'Call this for "total ever", "all time", or "since I started" questions.',
        },
        {
          name: 'get_all_time_stop_stats',
          description: 'Get the top boarding and exit stops (up to 20 each) across all time. ' +
            'Call this for all-time stop frequency questions.',
        },
        {
          name: 'get_all_time_route_stats',
          description: 'Get all routes and their frequency across all time. ' +
            'Call this for all-time route frequency questions.',
        },
        {
          name: 'get_monthly_trip_counts',
          description: 'Get trip counts grouped by year-month across all time. ' +
            'Call this for questions about a specific month, year, or date range ' +
            'that may fall outside the recent window.',
        },
        {
          name: 'get_day_of_week_stats',
          description: 'Get trip counts by day of week (Monday, Tuesday, etc.) across all time. ' +
            'Call this for questions about busiest days, Fridays, weekdays vs weekends, etc. ' +
            'Does NOT filter by year — use get_day_of_week_stats_for_year for year-specific questions.',
        },
        {
          name: 'get_day_of_week_stats_for_year',
          description: 'Get trip counts by day of week filtered to a specific year. ' +
            'Call this for questions like "how many Tuesdays in 2026" or "busiest day this year". ' +
            'Requires a year parameter (e.g. 2026).',
          parameters: {
            type: 'object',
            properties: {
              year: { type: 'number', description: 'The year to filter by (e.g. 2026)' },
            },
            required: ['year'],
          },
        },
        {
          name: 'get_trips_for_date',
          description: 'Get the COUNT of trips taken on a specific calendar date. ' +
            'Call this ONLY for questions like "how many trips on March 1?", "did I ride on Jan 1?". ' +
            'Do NOT call this when the user asks which trips, what routes, or trip details — use get_trip_details_for_date instead.',
          parameters: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'The date in YYYY-MM-DD format (e.g. "2026-03-01")' },
            },
            required: ['date'],
          },
        },
        {
          name: 'get_trip_details_for_date',
          description: 'Get the full details of each trip taken on a specific date — route, direction, boarding stop, exit stop, and time. ' +
            'Call this when the user asks "which trips", "what routes", "where did I go", "what did I ride", ' +
            'or any question about the specific trips taken on a day (not just the count).',
          parameters: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'The date in YYYY-MM-DD format (e.g. "2026-03-01")' },
            },
            required: ['date'],
          },
        },
        {
          name: 'get_trips_for_date_range',
          description: 'Get the number of trips taken between two dates (inclusive). ' +
            'Call this for questions like "how many trips between March 1 and March 15?" or ' +
            '"how many trips in the first two weeks of February?".',
          parameters: {
            type: 'object',
            properties: {
              start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format (inclusive)' },
              end_date: { type: 'string', description: 'End date in YYYY-MM-DD format (inclusive)' },
            },
            required: ['start_date', 'end_date'],
          },
        },
        {
          name: 'get_route_stats_for_period',
          description: 'Get trip counts per route between two dates. ' +
            'Call this for questions like "how often did I take the 505 this month?" or ' +
            '"what routes did I use in February?".',
          parameters: {
            type: 'object',
            properties: {
              start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format (inclusive)' },
              end_date: { type: 'string', description: 'End date in YYYY-MM-DD format (inclusive)' },
            },
            required: ['start_date', 'end_date'],
          },
        },
        {
          name: 'get_riding_streak',
          description: 'Get the longest streak of consecutive days with at least one trip, ' +
            'and the current streak. Call this for questions like "what\'s my longest streak?" ' +
            'or "how many days in a row have I ridden?".',
        },
        {
          name: 'get_average_trip_duration',
          description: 'Get the average trip duration in minutes, optionally filtered by route. ' +
            'Call this for questions like "what is my average commute time?" or ' +
            '"how long is a typical 505 trip?".',
          parameters: {
            type: 'object',
            properties: {
              route: { type: 'string', description: 'Route number to filter by (optional, e.g. "505")' },
            },
          },
        },
        {
          name: 'get_weekday_vs_weekend_stats',
          description: 'Get trip counts split between weekdays (Mon–Fri) and weekends (Sat–Sun). ' +
            'Call this for questions like "do I ride more on weekdays or weekends?".',
        },
        {
          name: 'get_busiest_weeks',
          description: 'Get the top weeks by trip count across all time. ' +
            'Call this for questions like "what was my busiest week?" or "when do I ride the most?".',
        },
        {
          name: 'get_unique_stops',
          description: 'Get the total number of unique stops visited and a full list. ' +
            'Call this for questions like "how many unique stops have I visited?" or "what stops have I used?".',
        },
        {
          name: 'get_stop_pair_stats',
          description: 'Get trip counts AND individual run times for a specific origin and/or ' +
            'destination stop, optionally filtered by day of week. Call this for questions like ' +
            '"how many times have I gone from Spadina to York University?", ' +
            '"what days do I travel to York U?", "how often do I board at Bloor?", ' +
            '"what are all the run times between Queens Park and York U?", or ' +
            '"what is the fastest/slowest/average trip between two stops?".',
          parameters: {
            type: 'object',
            properties: {
              start_stop: { type: 'string', description: 'Partial or full name of the boarding stop (optional)' },
              end_stop: { type: 'string', description: 'Partial or full name of the exit stop (optional)' },
            },
          },
        },
      ]
    }
  ];

  // Tool implementations
  const toolExecutors = {
    get_all_time_stats: async () => {
      const tripsCol = db.collection('trips').where('userId', '==', userId).where('endTime', '!=', null);
      const snapshot = await tripsCol.count().get();
      const count = snapshot.data().count;

      const trips = await tripsCol.select('route', 'startStopName', 'endStopName').get();
      const routes = new Set(trips.docs.map((t) => t.data().route).filter(Boolean)).size;
      const boarding = new Set(trips.docs.map((t) => t.data().startStopName).filter(Boolean));
      const exit = new Set(trips.docs.map((t) => t.data().endStopName).filter(Boolean));
      const stops = new Set([...boarding, ...exit]).size;

      return { totalTrips: count, uniqueRoutes: routes, uniqueStops: stops };
    },
    get_all_time_stop_stats: async () => {
      const trips = await db.collection('trips')
        .where('userId', '==', userId)
        .where('endTime', '!=', null)
        .select('startStopName', 'endStopName')
        .get();

      const boarding = {};
      const exit = {};
      trips.docs.forEach((d) => {
        const t = d.data();
        if (t.startStopName) boarding[t.startStopName] = (boarding[t.startStopName] || 0) + 1;
        if (t.endStopName) exit[t.endStopName] = (exit[t.endStopName] || 0) + 1;
      });

      const topBoarding = Object.entries(boarding).sort((a, b) => b[1] - a[1]).slice(0, 20);
      const topExit = Object.entries(exit).sort((a, b) => b[1] - a[1]).slice(0, 20);
      return { topBoardingStops: topBoarding, topExitStops: topExit };
    },
    get_all_time_route_stats: async () => {
      const trips = await db.collection('trips')
        .where('userId', '==', userId)
        .where('endTime', '!=', null)
        .select('route')
        .get();

      const routes = {};
      trips.docs.forEach((d) => {
        const r = d.data().route;
        if (r) routes[r] = (routes[r] || 0) + 1;
      });
      return Object.entries(routes).sort((a, b) => b[1] - a[1]);
    },
    get_monthly_trip_counts: async () => {
      const trips = await db.collection('trips')
        .where('userId', '==', userId)
        .where('endTime', '!=', null)
        .select('endTime')
        .get();

      const months = {};
      trips.docs.forEach((d) => {
        const ts = d.data().endTime;
        const date = ts.toDate ? ts.toDate() : new Date(ts);
        const parts = getTimezoneDateParts(date, timezone);
        const key = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
        months[key] = (months[key] || 0) + 1;
      });
      return months;
    },
    get_day_of_week_stats: async () => {
      const trips = await db.collection('trips')
        .where('userId', '==', userId)
        .where('endTime', '!=', null)
        .select('startTime')
        .get();

      const days = {};
      trips.docs.forEach((d) => {
        const ts = d.data().startTime;
        if (!ts) return;
        const date = ts.toDate ? ts.toDate() : new Date(ts);
        const day = getTimezoneDateParts(date, timezone).weekday;
        days[day] = (days[day] || 0) + 1;
      });
      return days;
    },
    get_unique_stops: async () => {
      const snap = await db.collection('trips')
        .where('userId', '==', userId)
        .select('startStopName', 'endStopName')
        .get();

      const stops = new Set();
      snap.docs.forEach((d) => {
        const t = d.data();
        if (t.startStopName) stops.add(t.startStopName);
        if (t.endStopName) stops.add(t.endStopName);
      });
      return { unique_stop_count: stops.size, stops: [...stops].sort() };
    },
    get_busiest_weeks: async () => {
      const snap = await db.collection('trips')
        .where('userId', '==', userId)
        .select('startTime')
        .get();

      const weeks = {};
      snap.docs.forEach((d) => {
        const ts = d.data().startTime;
        if (!ts) return;
        const date = ts.toDate ? ts.toDate() : new Date(ts);
        const key = getWeekStartDateKeyInTimezone(date, timezone);
        weeks[key] = (weeks[key] || 0) + 1;
      });

      return Object.entries(weeks)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([week, count]) => ({ week_starting: week, trips: count }));
    },
    get_weekday_vs_weekend_stats: async () => {
      const snap = await db.collection('trips')
        .where('userId', '==', userId)
        .select('startTime')
        .get();

      let weekdays = 0;
      let weekends = 0;
      snap.docs.forEach((d) => {
        const ts = d.data().startTime;
        if (!ts) return;
        const date = ts.toDate ? ts.toDate() : new Date(ts);
        const day = DAY_NAMES.indexOf(getTimezoneDateParts(date, timezone).weekday);
        if (day === 0 || day === 6) weekends++;
        else weekdays++;
      });
      return { weekdays, weekends, total: weekdays + weekends };
    },
    get_average_trip_duration: async ({ route }) => {
      const snap = await db.collection('trips')
        .where('userId', '==', userId)
        .where('endTime', '!=', null)
        .select('duration', 'route')
        .get();

      const durations = [];
      snap.docs.forEach((d) => {
        const t = d.data();
        if (route && t.route?.toString() !== route.toString()) return;
        if (t.duration > 0) durations.push(t.duration);
      });

      if (durations.length === 0) return { average_minutes: null, trip_count: 0 };
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      return { average_minutes: Math.round(avg), trip_count: durations.length };
    },
    get_stop_pair_stats: async ({ start_stop, end_stop }) => {
      const snap = await db.collection('trips')
        .where('userId', '==', userId)
        .where('endTime', '!=', null)
        .select('startStopName', 'endStopName', 'startTime', 'duration')
        .get();

      const byDay = {};
      const durations = [];

      snap.docs.forEach((d) => {
        const t = d.data();
        const start = (t.startStopName || '').toLowerCase();
        const end = (t.endStopName || '').toLowerCase();
        const startMatch = !start_stop || start.includes(start_stop.toLowerCase());
        const endMatch = !end_stop || end.includes(end_stop.toLowerCase());
        if (!startMatch || !endMatch) return;

        const ts = t.startTime;
        if (!ts) return;
        const date = ts.toDate ? ts.toDate() : new Date(ts);
        const day = getTimezoneDateParts(date, timezone).weekday;
        byDay[day] = (byDay[day] || 0) + 1;

        if (t.duration > 0) durations.push(t.duration);
      });

      const total = Object.values(byDay).reduce((a, b) => a + b, 0);
      const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
      const min = durations.length ? Math.min(...durations) : null;
      const max = durations.length ? Math.max(...durations) : null;

      return {
        total,
        by_day_of_week: byDay,
        run_times_minutes: durations,
        avg_duration_minutes: avg,
        min_duration_minutes: min,
        max_duration_minutes: max,
      };
    },
    get_riding_streak: async () => {
      const snap = await db.collection('trips')
        .where('userId', '==', userId)
        .select('startTime')
        .get();

      const days = new Set();
      snap.docs.forEach((d) => {
        const ts = d.data().startTime;
        if (!ts) return;
        const date = ts.toDate ? ts.toDate() : new Date(ts);
        days.add(getTimezoneDateParts(date, timezone).dateKey);
      });

      const sorted = [...days].sort();
      let longest = 0;
      let current = 0;
      let prev = null;
      for (const day of sorted) {
        if (prev) {
          const diff = (new Date(day) - new Date(prev)) / 86400000;
          current = diff === 1 ? current + 1 : 1;
        } else {
          current = 1;
        }
        longest = Math.max(longest, current);
        prev = day;
      }

      const today = getTimezoneDateParts(new Date(), timezone).dateKey;
      const yesterday = getTimezoneDateParts(new Date(Date.now() - 86400000), timezone).dateKey;
      const currentStreak = days.has(today) || days.has(yesterday) ? current : 0;

      return { longest_streak_days: longest, current_streak_days: currentStreak };
    },
    get_route_stats_for_period: async ({ start_date, end_date }) => {
      const { start } = dayBoundsInTimezone(start_date, timezone);
      const { end } = dayBoundsInTimezone(end_date, timezone);
      const snap = await db.collection('trips')
        .where('userId', '==', userId)
        .where('startTime', '>=', start)
        .where('startTime', '<=', end)
        .select('route')
        .get();

      const routes = {};
      snap.docs.forEach((d) => {
        const route = d.data().route;
        if (!route) return;
        routes[route] = (routes[route] || 0) + 1;
      });
      return routes;
    },
    get_trips_for_date_range: async ({ start_date, end_date }) => {
      const { start } = dayBoundsInTimezone(start_date, timezone);
      const { end } = dayBoundsInTimezone(end_date, timezone);
      const snap = await db.collection('trips')
        .where('userId', '==', userId)
        .where('startTime', '>=', start)
        .where('startTime', '<=', end)
        .get();
      return { start_date, end_date, count: snap.size };
    },
    get_trips_for_date: async ({ date }) => {
      const { start, end } = dayBoundsInTimezone(date, timezone);
      const snap = await db.collection('trips')
        .where('userId', '==', userId)
        .where('startTime', '>=', start)
        .where('startTime', '<=', end)
        .get();
      return { date, count: snap.size };
    },
    get_trip_details_for_date: async ({ date }) => {
      const { start, end } = dayBoundsInTimezone(date, timezone);
      const snap = await db.collection('trips')
        .where('userId', '==', userId)
        .where('startTime', '>=', start)
        .where('startTime', '<=', end)
        .orderBy('startTime', 'asc')
        .get();
      const trips = snap.docs.map((d) => {
        const t = d.data();
        const startTime = t.startTime?.toDate ? t.startTime.toDate() : new Date(t.startTime);
        const timeStr = startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone });
        return {
          time: timeStr,
          route: t.route || 'Unknown',
          direction: t.direction || null,
          from: t.startStopName || t.startStop || t.startStopCode || 'Unknown',
          to: t.endStopName || t.endStop || t.endStopCode || null,
          duration_min: t.duration || null,
        };
      });
      return { date, trips };
    },
    get_day_of_week_stats_for_year: async ({ year: rawYear }) => {
      const year = parseInt(rawYear, 10);
      const trips = await db.collection('trips')
        .where('userId', '==', userId)
        .where('endTime', '!=', null)
        .select('startTime')
        .get();

      const days = {};
      trips.docs.forEach((d) => {
        const ts = d.data().startTime;
        if (!ts) return;
        const date = ts.toDate ? ts.toDate() : new Date(ts);
        const parts = getTimezoneDateParts(date, timezone);
        if (parts.year !== year) return;
        const day = parts.weekday;
        days[day] = (days[day] || 0) + 1;
      });
      return days;
    },
  };

  return await retryWithBackoff(async () => {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      tools: tools,
    });

    const chatHistory = conversationHistory.map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    }));

    const chat = model.startChat({
      history: chatHistory,
    });

    const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
    const introPrompt = `You are a transit stats assistant for TransitStats.
Answer the user's question using their personal transit data below.
Be concise and friendly. Keep the response under 300 characters for SMS.

You have access to the most recent 200 trips spanning ${stats.windowStart || '?'} to ${stats.windowEnd || today}:
- Window size (NOT a date-filtered count): ${stats.total} trips
- Top 5 routes in window: ${JSON.stringify(stats.routeStats.slice(0, 5))}
- Top stop pairs: ${JSON.stringify(stats.pairStats.slice(0, 5))}
- Trips by day of week in window: ${JSON.stringify(stats.dayOfWeek || {})}
- Daily trip counts (YYYY-MM-DD): ${JSON.stringify(stats.dailyCounts || {})}
- Stops visited recently: ${stats.allStops?.join(', ')}

IMPORTANT:
- "Window size" is NOT the answer to any date-scoped question. For "last month", "this year", or any specific period, sum the relevant entries from dailyCounts, or call get_monthly_trip_counts.
- If the question asks about dates outside ${stats.windowStart || '?'}–${stats.windowEnd || today}, or asks for all-time stats, CALL the appropriate tool. NEVER guess!

Today's date: ${today}
Question: "${question}"`;

    let result = await chat.sendMessage(introPrompt);
    let response = result.response;

    // Handle tool calls in a loop (up to 3 levels deep)
    for (let i = 0; i < 3; i++) {
      const calls = response.functionCalls();
      if (!calls || calls.length === 0) break;

      const results = await Promise.all(calls.map(async (call) => {
        const executor = toolExecutors[call.name];
        if (!executor) return { name: call.name, response: { error: 'Tool not found' } };
        const data = await executor(call.args);
        return { name: call.name, response: { content: data } };
      }));

      result = await chat.sendMessage(results.map((r) => ({ functionResponse: r })));
      response = result.response;
    }

    return response.text().trim();
  }, 3, 1000, traceId).catch((err) => {
    logger.error('Gemini Tooling Error', { error: err.message, stack: err.stack }, traceId);
    return ASK_FAILED;
  });
}

/**
 * Construct stop input from Gemini result
 * Prefer stop_id (code) if available, otherwise stop_name
 * @param {object} result - Gemini result object
 * @returns {string|null} Stop input string or null
 */
function constructStopInput(result) {
  if (!result) return null;
  return result.stop_id || result.stop_name || null;
}

/**
 * Parse natural language trip text using Gemini Flash
 * @param {string} text - Raw SMS text
 * @returns {Promise<object|null>} Parsed and sanitized data or null if failed
 */
async function parseWithGemini(text, traceId = null) {
  if (process.env.TS_TEST_MODE) return null; // Use heuristic parser in tests
  const apiKey = geminiApiKey.value();
  if (!apiKey) {
    logger.error('Gemini API key not configured', {}, traceId);
    return null;
  }

  // Truncate input to prevent prompt injection via very long messages
  const truncatedText = text.length > 500 ? text.slice(0, 500) : text;

  return await retryWithBackoff(async () => {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

    const prompt = `Analyze this SMS from a transit tracker user. Determine the intent and extract data.
    Text: "${truncatedText}"
    
    Possible Intents:
    - START_TRIP: User is starting a new trip (requires route and stop).
    - END_TRIP: User is ending the current trip (extract stop if present).
    - DISCARD_TRIP: User wants to cancel/delete the active trip.
    - INCOMPLETE_TRIP: User forgot to end the trip earlier.
    - QUERY: User is asking a question about their history.
    - OTHER: Not a transit command.

    Extraction Rules:
    - Direction: Normalize: "Northbound", "Southbound", "Eastbound", "Westbound", "Inbound", "Outbound", "Clockwise", "Counterclockwise", "Up Valley", "Down Valley".
    - Route: Extract ONLY the route identifier explicitly mentioned (e.g., "504", "Line 1", "510a").
      Routes are typically 1-3 digits or "Line X". Never infer or guess a route —
      if none is clearly stated, return null.
    - Stop ID: A number explicitly labeled as a stop ("stop 815", "from stop 11986") in the message.
      If ambiguous, prefer stop_name over stop_id. Never put a route number in stop_id.
    - Stop Name: Extract the full location name.
    - Ignore conversational text: "Just boarded", "I'm on", "taking", etc.
    - Agency: Extract the transit agency name if explicitly mentioned (e.g., "LA Metro", "BART", "TTC").
      If not mentioned, return null — do not guess.
    - Sentiment: Determine if POSITIVE, NEGATIVE, or NEUTRAL.
    - Tags: Extract 1-3 keyword tags (e.g., "crowded", "delayed", "clean").
    - Vehicle: Extract the vehicle number or identifier if explicitly mentioned (e.g. "bus 7109", "car 123", "vehicle 456").

    Examples:
    - "Just boarded Route 1 NB" -> intent: "START_TRIP", route: "1", direction: "Northbound"
    - "B Line Wilshire/Vermont LA Metro" -> intent: "START_TRIP", route: "B", stop_name: "Wilshire/Vermont", agency: "LA Metro"
    - "Packed 504 from King" -> intent: "START_TRIP", route: "504", tags: ["crowded"]
    - "Boarded 510 from Spadina (Vehicle 4412)" -> intent: "START_TRIP", route: "510", stop_name: "Spadina", vehicle: "4412"
    - "How many trips have I taken in total ever?" -> intent: "QUERY", question: "How many trips have I taken in total ever?"
    - "How many trips have I taken in 2026 so far?" -> intent: "QUERY", question: "How many trips have I taken in 2026 so far?"
    - "How many trips have I made between Queens Park and York University?" -> intent: "QUERY", question: "How many trips have I made between Queens Park and York University?"
    - "How often do I take the 505?" -> intent: "QUERY", question: "How often do I take the 505?"
    - "LMK the number of trips I've taken in the last month" -> intent: "QUERY", question: "LMK the number of trips I've taken in the last month"
    - "What's my most used route?" -> intent: "QUERY", question: "What's my most used route?"
    - "Tell me my stats" -> intent: "QUERY", question: "Tell me my stats"
    - Any message starting with "How many", "How often", "What", "When", "Which", "Tell me", "Show me", or containing a "?" is QUERY, not START_TRIP.

    Return ONLY JSON:
    {
      "intent": "START_TRIP" | "END_TRIP" | "DISCARD_TRIP" | "INCOMPLETE_TRIP" | "QUERY" | "OTHER",
      "route": "string" | null,
      "stop_name": "string" | null,
      "stop_id": "string" | null,
      "direction": "string" | null,
      "agency": "string" | null,
      "vehicle": "string" | null,
      "sentiment": "POSITIVE" | "NEGATIVE" | "NEUTRAL",
      "tags": ["string"],
      "question": "string" | null
    }`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const textResponse = response.text();

    // Clean up markdown code blocks if present
    const jsonStr = textResponse.replace(/^```json\n|\n```$/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    // Sanitize output to prevent prompt injection
    const sanitized = sanitizeGeminiOutput(parsed);

    // Log successful API call for monitoring
    logger.info('Gemini API call successful', {
      intent: sanitized?.intent,
      hasRoute: !!sanitized?.route,
      hasStop: !!(sanitized?.stop_name || sanitized?.stop_id),
    }, traceId);

    return sanitized;
  }, 3, 1000, traceId).catch((error) => {
    logger.error('Gemini parsing error after retries', { error: error.message, stack: error.stack }, traceId);
    // Return null to fall back to heuristic parsing
    return null;
  });
}

// Ambiguous agency names that should never be cached — Gemini looks them up fresh each time
const AMBIGUOUS_AGENCIES = new Set(['MTA', 'Metro', 'Transit']);

// Known agency → IANA timezone mappings (checked before Firestore/Gemini)
// Canonical agency names only — aliases are handled by normalizeAgency() before lookup
const KNOWN_AGENCY_TIMEZONES = {
  // Ontario
  'TTC': 'America/Toronto',
  'MiWay': 'America/Toronto',
  'GO Transit': 'America/Toronto',
  'YRT': 'America/Toronto',
  'Brampton Transit': 'America/Toronto',
  'Durham Transit': 'America/Toronto',
  'HSR': 'America/Toronto',
  'GRT': 'America/Toronto',
  'OC Transpo': 'America/Toronto',
  // Quebec
  'STM': 'America/Toronto',
  // BC
  'TransLink': 'America/Vancouver',
  // NYC
  'NYC MTA': 'America/New_York',
  // LA
  'LA Metro': 'America/Los_Angeles',
  'LADOT': 'America/Los_Angeles',
  'Big Blue Bus': 'America/Los_Angeles',
  // SF Bay Area
  'BART': 'America/Los_Angeles',
  'Muni': 'America/Los_Angeles',
  'Caltrain': 'America/Los_Angeles',
  'VTA': 'America/Los_Angeles',
  'AC Transit': 'America/Los_Angeles',
  'SamTrans': 'America/Los_Angeles',
};

/**
 * Look up the IANA timezone for a transit agency.
 * Checks hardcoded map first, then Firestore cache, then asks Gemini.
 * Caches Gemini results to Firestore so each agency is only looked up once.
 * @param {string} agency
 * @returns {Promise<string>} IANA timezone string (e.g. 'America/Los_Angeles')
 */
async function lookupAgencyTimezone(agency, traceId = null) {
  if (!agency) return 'America/Toronto';

  // Normalize first so aliases always resolve to canonical names
  const { normalizeAgency } = require('./utils');
  const canonical = normalizeAgency(agency);

  // 1. Hardcoded map
  if (KNOWN_AGENCY_TIMEZONES[canonical]) return KNOWN_AGENCY_TIMEZONES[canonical];

  // 2. Firestore cache (skip for ambiguous names — they can't be cached safely)
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const db = getFirestore();
  const isAmbiguous = AMBIGUOUS_AGENCIES.has(canonical);
  if (!isAmbiguous) {
    try {
      const doc = await db.collection('agencyTimezones').doc(canonical).get();
      if (doc.exists && doc.data().timezone) return doc.data().timezone;
    } catch (e) {
      logger.error('agencyTimezones cache read error', { error: e.message }, traceId);
    }
  }

  // 3. Ask Gemini
  const apiKey = geminiApiKey.value();
  if (!apiKey) return 'America/Toronto';

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(
      `What is the IANA timezone for the public transit agency "${canonical}"? ` +
      `Reply with only the IANA timezone string (e.g. America/Los_Angeles), nothing else.`
    );
    const tz = result.response.text().trim().replace(/['"]/g, '');

    // Basic sanity check — IANA timezones contain a /
    if (tz && tz.includes('/')) {
      if (!isAmbiguous) {
        await db.collection('agencyTimezones').doc(canonical).set({
          timezone: tz,
          discoveredAt: FieldValue.serverTimestamp(),
        });
        logger.info('Agency timezone discovered and cached', { agency: canonical, timezone: tz }, traceId);
      } else {
        logger.info('Agency timezone resolved (not cached, ambiguous)', { agency: canonical, timezone: tz }, traceId);
      }
      return tz;
    }
  } catch (e) {
    logger.error('Agency timezone Gemini lookup error', { error: e.message }, traceId);
  }

  return 'America/Toronto';
}

/**
 * Parse a transit stop sign photo and extract stop/route information.
 * @param {string} imageBase64 - Base64-encoded image data
 * @param {string} mimeType - Image MIME type (e.g. 'image/jpeg')
 * @returns {Promise<{stopCode: string|null, stopName: string|null, routes: Array<{route: string, agency: string|null}>}|null>}
 */
async function parseStopSignImage(imageBase64, mimeType, traceId = null) {
  const genAI = new GoogleGenerativeAI(geminiApiKey.value());
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const prompt = `Analyze this photo of a transit stop sign, pole, or shelter. Extract stop information and return ONLY valid JSON with no other text:
{
  "stopCode": "numeric stop ID or code if visible (often on 'Next Vehicle' or 'SMS' stickers, e.g. 'Text 12345'), otherwise null",
  "stopName": "intersection, station name, or landmark if visible, otherwise null",
  "routes": [
    { "route": "route identifier as a string (e.g. '510', 'Line 1', 'Blue')", "agency": "transit agency name if determinable, otherwise null" }
  ]
}

Rules:
1. Only include routes clearly visible on the signage.
2. If multiple route numbers are shown, list all of them.
3. For stop codes, look for numeric IDs of any length (typically 3-6 digits, e.g. '110', '8128', '11985'), especially near 'Next Vehicle' or text-messaging instructions.
4. If no transit stop information is found, return null.`;

  const result = await retryWithBackoff(async () => {
    return model.generateContent([
      { inlineData: { data: imageBase64, mimeType } },
      { text: prompt },
    ]);
  }, 3, 1000, traceId);

  const text = result.response.text().trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || !Array.isArray(parsed.routes)) return null;
    parsed.routes = parsed.routes.filter(r => r.route && typeof r.route === 'string');
    if (parsed.routes.length === 0) return null;
  } catch {
    return null;
  }

  // If routes were found but stop code is missing, do a focused second pass
  // specifically looking for the small "Next Vehicle" SMS sticker text.
  if (!parsed.stopCode) {
    try {
      const focusedPrompt = `Look carefully at this transit stop pole photo. Find any small sticker or label with the words "Next Vehicle", "Text stop", or "SMS". These stickers contain a short numeric stop code (usually 4-6 digits) and a phone number (e.g. "Text 11985 to 898882" — the stop code would be 11985). Return ONLY the numeric stop code as plain text, or the word null if you cannot find one.`;
      const focusedResult = await retryWithBackoff(async () => {
        return model.generateContent([
          { inlineData: { data: imageBase64, mimeType } },
          { text: focusedPrompt },
        ]);
      }, 3, 1000, traceId);
      const focusedText = focusedResult.response.text().trim();
      const codeMatch = focusedText.match(/\b\d{4,6}\b/);
      if (codeMatch) parsed.stopCode = codeMatch[0];
    } catch {
      // Non-fatal — proceed without stop code
    }
  }

  return parsed;
}

module.exports = {
  retryWithBackoff,
  aggregateTripStats,
  answerQueryWithGemini,
  constructStopInput,
  parseWithGemini,
  lookupAgencyTimezone,
  parseStopSignImage,
};
