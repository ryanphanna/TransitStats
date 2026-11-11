/**
 * Claude AI helper functions: trip text parsing, ASK answers and agency time zones.
 * Stop-sign photo reading stays on Gemini (gemini.js).
 */
const Anthropic = require('@anthropic-ai/sdk');
const { defineSecret } = require('firebase-functions/params');
const { VALID_INTENTS, VALID_SENTIMENTS, timezoneForAgency } = require('./constants');
const logger = require('./logger');
const { ASK_FAILED } = require('./sms-text');
const { buildPrestoTrips } = require('./presto-trips');
const {
  boardingStop,
  countAgencies,
  countRoutes,
  countedRides,
  durationSummary,
  exitStop,
  finishedTrips,
  ridingStreaks,
  sortedCounts,
  tripAgency,
  tripLocalDay,
  tripStartDate,
  tripsBetweenDays,
  tripsByAgency,
  tripsByDate,
  tripsByRoute,
  tripsByStop,
} = require('./trip-stats');

const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const CLAUDE_MODEL = 'claude-haiku-5-5';
// Effort is set on every request: "low" is what the comparison test measured for these short tasks.
const CLAUDE_EFFORT = 'low';
// Output caps include the model's own reasoning, so they sit well above the short replies expected.
const MAX_TOKENS_PARSE = 2000;
const MAX_TOKENS_TIMEZONE = 1000;
const MAX_TOKENS_ASK = 2000;
// Tool rounds allowed per ASK question before the model has to answer with what it has.
const MAX_TOOL_ROUNDS = 3;

// Time limits. The sms and api functions run with the default 60 s limit, and a
// timed-out attempt is retried, so the worst case per call is about
// timeout x (maxRetries + 1) plus a short backoff.
// Trip parsing and time zone lookups: about 17 s at worst, which leaves the
// rule-based fallback time to run and reply.
const SHORT_CALL_OPTIONS = { timeout: 8000, maxRetries: 1 };
// ASK: one deadline across every request in the tool loop. A time zone lookup
// (up to about 17 s) can run first in the same function call, so 35 s keeps the
// total under 60 s with room for the Firestore reads and the reply.
const ASK_DEADLINE_MS = 35000;
const ASK_ATTEMPT_TIMEOUT_MS = 15000;
// Below this much time left, a new request is not worth starting.
const ASK_MIN_REQUEST_MS = 1000;

let cachedClient = null;
let cachedClientKey = null;

/**
 * One client per API key. The SDK retries rate limits, server errors and
 * connection failures itself. Every call passes its own timeout and retry
 * count (see the time limits above); the values here are only a backstop.
 * @param {string} apiKey
 * @returns {Anthropic}
 */
function getClient(apiKey) {
  if (!cachedClient || cachedClientKey !== apiKey) {
    cachedClient = new Anthropic({ apiKey, maxRetries: 2, timeout: 20000 });
    cachedClientKey = apiKey;
  }
  return cachedClient;
}

/**
 * Short label for a failed Claude call, for logs.
 * @param {Error} error
 * @returns {string}
 */
function claudeErrorKind(error) {
  if (error instanceof Anthropic.AuthenticationError) return 'auth';
  if (error instanceof Anthropic.PermissionDeniedError) return 'permission';
  if (error instanceof Anthropic.BadRequestError) return 'bad_request';
  if (error instanceof Anthropic.RateLimitError) return 'rate_limit';
  if (error instanceof Anthropic.APIUserAbortError) return 'deadline';
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (error instanceof Anthropic.APIConnectionError) return 'connection';
  if (error instanceof Anthropic.APIError) return `api_${error.status}`;
  return 'error';
}

/**
 * Text of a finished reply, or null when the model stopped for any other
 * reason (refusal, cut off at max_tokens, etc.).
 * @param {object} message - Claude Messages API response
 * @param {string} feature - Label for logs
 * @returns {string|null}
 */
function finishedText(message, feature, traceId = null) {
  if (message.stop_reason !== 'end_turn') {
    logger.error('Claude reply not usable', {
      feature,
      stopReason: message.stop_reason,
      category: message.stop_details ? message.stop_details.category : undefined,
    }, traceId);
    return null;
  }
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Sanitize AI output to prevent prompt injection attacks and invalid data.
 * @param {object} parsed - AI result object
 * @returns {object|null} Sanitized result
 */
function sanitizeParsedOutput(parsed) {
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
    vehicle: sanitizeField(parsed.vehicle, 30),
    sentiment,
    tags,
    question: sanitizeField(parsed.question, 300),
    notes: sanitizeField(parsed.notes, 300),
  };
}

const NULLABLE_STRING = { type: ['string', 'null'] };
const TRIP_TEXT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: VALID_INTENTS },
    route: NULLABLE_STRING,
    stop_name: NULLABLE_STRING,
    stop_id: NULLABLE_STRING,
    direction: NULLABLE_STRING,
    agency: NULLABLE_STRING,
    vehicle: NULLABLE_STRING,
    sentiment: { type: 'string', enum: VALID_SENTIMENTS },
    tags: { type: 'array', items: { type: 'string' } },
    question: NULLABLE_STRING,
  },
  required: [
    'intent', 'route', 'stop_name', 'stop_id', 'direction', 'agency', 'vehicle', 'sentiment', 'tags', 'question',
  ],
  additionalProperties: false,
};

/**
 * Parse natural language trip text using Claude
 * @param {string} text - Raw SMS text
 * @returns {Promise<object|null>} Parsed and sanitized data or null if failed
 */
async function parseWithClaude(text, traceId = null) {
  if (process.env.TS_TEST_MODE) return null; // Use heuristic parser in tests
  const apiKey = anthropicApiKey.value();
  if (!apiKey) {
    logger.error('Anthropic API key not configured', {}, traceId);
    return null;
  }

  // Truncate input to prevent prompt injection via very long messages
  const truncatedText = text.length > 500 ? text.slice(0, 500) : text;

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

  try {
    const message = await getClient(apiKey).messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS_PARSE,
      output_config: {
        effort: CLAUDE_EFFORT,
        format: { type: 'json_schema', schema: TRIP_TEXT_SCHEMA },
      },
      messages: [{ role: 'user', content: prompt }],
    }, SHORT_CALL_OPTIONS);

    const raw = finishedText(message, 'parse', traceId);
    if (!raw) return null;

    // Sanitize output to prevent prompt injection
    const sanitized = sanitizeParsedOutput(JSON.parse(raw));

    // Log successful API call for monitoring
    logger.info('Claude API call successful', {
      intent: sanitized?.intent,
      hasRoute: !!sanitized?.route,
      hasStop: !!(sanitized?.stop_name || sanitized?.stop_id),
    }, traceId);

    return sanitized;
  } catch (error) {
    logger.error('Claude parsing error', {
      kind: claudeErrorKind(error), error: error.message, stack: error.stack,
    }, traceId);
    // Return null to fall back to heuristic parsing
    return null;
  }
}

// Tools the ASK feature can call. Every one reads only the asking user's own trips.
// Counts cover every counted ride (countedRides in trip-stats, the same list the
// dashboard counts); durations cover finished trips only (finishedTrips), and
// each duration result says how many.
// Strict mode: the API only produces inputs that match these schemas. Every
// property is required; optional filters are sent as null.
const toolInput = (properties = {}) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const DATE_ERROR = 'Dates must be in YYYY-MM-DD format.';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const dateInput = (description) => ({ type: 'string', format: 'date', description });
// No "format" here: with strict tools a date format on a nullable field stops the model sending null.
const optionalDateInput = (description) => ({ type: ['string', 'null'], description });

/**
 * Reject a date the tools cannot use, so the model is told and can correct it.
 * @param {*} value
 * @returns {string}
 */
function requireDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) {
    throw new Error(DATE_ERROR);
  }
  return value;
}

const QUERY_TOOLS = [
  {
    name: 'get_all_time_stats',
    description: 'Get all-time totals: trips, different routes, stops and agencies, plus timedTrips, ' +
      'the number of trips that have a recorded duration. ' +
      'Call this for "total ever", "all time", or "since I started" questions.',
  },
  {
    name: 'get_all_time_stop_stats',
    description: 'Get the top boarding and exit stops (up to 20 each) across all time. ' +
      'Call this for all-time stop frequency questions.',
  },
  {
    name: 'get_all_time_route_stats',
    description: 'Get the number of different routes and the most-ridden routes (up to 50) with their ' +
      'trip counts across all time. Call this for all-time route frequency questions.',
  },
  {
    name: 'get_monthly_trip_counts',
    description: 'Get trip counts for every month (by_month) and every year (by_year) across all time, ' +
      'with the all-time total. Call this for questions about a specific month or year, such as ' +
      '"how many trips this year?", and for per-month averages. Read a year from by_year instead of ' +
      'adding months up.',
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
    input_schema: toolInput({
      year: { type: 'integer', description: 'The year to filter by (e.g. 2026)' },
    }),
  },
  {
    name: 'get_trips_for_date',
    description: 'Get the COUNT of trips taken on a specific calendar date. ' +
      'Call this ONLY for questions like "how many trips on March 1?", "did I ride on Jan 1?". ' +
      'Do NOT call this when the user asks which trips, what routes, or trip details — use get_trip_details_for_date instead.',
    input_schema: toolInput({
      date: dateInput('The date in YYYY-MM-DD format (e.g. "2026-03-01")'),
    }),
  },
  {
    name: 'get_trip_details_for_date',
    description: 'Get the full details of each trip taken on a specific date — agency, route, direction, ' +
      'boarding stop, exit stop, and time. ' +
      'Call this when the user asks "which trips", "what routes", "where did I go", "what did I ride", ' +
      'or any question about the specific trips taken on a day (not just the count).',
    input_schema: toolInput({
      date: dateInput('The date in YYYY-MM-DD format (e.g. "2026-03-01")'),
    }),
  },
  {
    name: 'get_trips_for_date_range',
    description: 'Get the number of trips taken between two dates (inclusive). ' +
      'Call this for questions like "how many trips between March 1 and March 15?" or ' +
      '"how many trips in the first two weeks of February?".',
    input_schema: toolInput({
      start_date: dateInput('Start date in YYYY-MM-DD format (inclusive)'),
      end_date: dateInput('End date in YYYY-MM-DD format (inclusive)'),
    }),
  },
  {
    name: 'get_route_stats_for_period',
    description: 'Get trip counts per route between two dates. ' +
      'Call this for questions like "how often did I take the 505 this month?" or ' +
      '"what routes did I use in February?".',
    input_schema: toolInput({
      start_date: dateInput('Start date in YYYY-MM-DD format (inclusive)'),
      end_date: dateInput('End date in YYYY-MM-DD format (inclusive)'),
    }),
  },
  {
    name: 'get_agency_stats',
    description: 'Get trip counts per transit agency (e.g. TTC, GO Transit), the number of different agencies, ' +
      'and how many trips have no agency recorded. For an all-time answer set both dates to null; do not ' +
      'pass an early start date instead. Set both dates only when the question names a period. ' +
      'Call this for questions like "how many different agencies have I ridden?", ' +
      '"which agency do I ride most?" or "how many GO Transit trips this year?".',
    input_schema: toolInput({
      start_date: optionalDateInput('Start date in YYYY-MM-DD format (inclusive), or null for all time'),
      end_date: optionalDateInput('End date in YYYY-MM-DD format (inclusive), or null for all time'),
    }),
  },
  {
    name: 'get_riding_streak',
    description: 'Get the longest streak of consecutive days with at least one trip, ' +
      'the current streak and the number of different days ridden. Call this for questions like "what\'s my longest streak?" ' +
      'or "how many days in a row have I ridden?".',
  },
  {
    name: 'get_average_trip_duration',
    description: 'Get the average and longest trip duration in minutes, optionally filtered by route. ' +
      'Durations exist only for trips with a recorded end time: timed_trips is how many the figures ' +
      'cover and total_trips is every trip counted. ' +
      'Call this for questions like "what is my average commute time?", "what was my longest trip?" or ' +
      '"how long is a typical 505 trip?".',
    input_schema: toolInput({
      route: {
        type: ['string', 'null'],
        description: 'Route number to filter by (e.g. "505"), or null for all routes',
      },
    }),
  },
  {
    name: 'get_weekday_vs_weekend_stats',
    description: 'Get all-time trip counts split between weekdays (Mon–Fri) and weekends (Sat–Sun). ' +
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
    description: 'Get trip counts AND run times for a specific origin and/or destination stop, with ' +
      'counts by day of week. Run times cover only the timed_trips that have a recorded end time; ' +
      'individual run times are listed when there are 100 or fewer. Call this for questions like ' +
      '"how many times have I gone from Spadina to York University?", ' +
      '"what days do I travel to York U?", "how often do I board at Bloor?", ' +
      '"what are all the run times between Queens Park and York U?", or ' +
      '"what is the fastest/slowest/average trip between two stops?".',
    input_schema: toolInput({
      start_stop: {
        type: ['string', 'null'],
        description: 'Partial or full name of the boarding stop, or null for any',
      },
      end_stop: { type: ['string', 'null'], description: 'Partial or full name of the exit stop, or null for any' },
    }),
  },
].map((tool) => ({ input_schema: toolInput(), ...tool, strict: true }));

// Fields the ASK tools read. One projection for every read keeps reads small.
const ASK_TRIP_FIELDS = [
  'startTime', 'endTime', 'discarded', 'duration', 'route', 'direction', 'agency', 'source',
  'startStopName', 'startStop', 'startStopCode', 'endStopName', 'endStop', 'endStopCode',
];
// Fields of an imported PRESTO row that decide whether and when it counts as a ride.
const ASK_PRESTO_FIELDS = ['type', 'agency', 'agencySource', 'amountCents', 'occurredAtSortKey'];
// Most run times or routes one tool result may list.
const MAX_LISTED_RUN_TIMES = 100;
const MAX_LISTED_ROUTES = 50;

/**
 * Build the ASK tool implementations for one user. Every figure comes from the
 * shared counting module (trip-stats), the same one the dashboard uses.
 * @param {object} db - Firestore instance
 * @param {string} userId - The asking user; every read is filtered to this id
 * @param {string} timezone - IANA timezone used for date bucketing
 * @param {object} [options] - countUnreadableTexts overrides the shared setting (tests only)
 * @returns {object} Map of tool name to async function
 */
function buildQueryToolExecutors(db, userId, timezone, { countUnreadableTexts } = {}) {
  const zone = { timeZone: timezone };
  // The only place trips are read: the asking user's logged trips and imported
  // PRESTO rows, both filtered by the handler's user id, combined into the one
  // list every tool counts. Read once per question (this memo lives inside one
  // call to buildQueryToolExecutors and is never shared between questions).
  const userDocs = (collection, fields) =>
    db.collection(collection).where('userId', '==', userId).select(...fields).get()
      .then((snapshot) => snapshot.docs.map((doc) => doc.data()));
  let ridesRead = null;
  const allRides = () => {
    if (!ridesRead) {
      const read = Promise.all([
        userDocs('trips', ASK_TRIP_FIELDS),
        userDocs('prestoTransactions', ASK_PRESTO_FIELDS),
      ]).then(([trips, prestoRows]) => countedRides(trips, buildPrestoTrips(prestoRows), { countUnreadableTexts }));
      ridesRead = read;
      // A failed read is not remembered, so the next tool call reads again.
      read.catch(() => { if (ridesRead === read) ridesRead = null; });
    }
    return ridesRead;
  };
  /** Counted rides on the local calendar days start to end, inclusive. */
  const ridesBetween = async (startDate, endDate) => {
    const from = requireDate(startDate);
    const to = requireDate(endDate);
    return tripsBetweenDays(await allRides(), from, to, zone);
  };
  // Totals shared by the tools that group trips by date.
  const dateTotals = (trips, dates) => ({ total_trips: trips.length, trips_without_date: dates.withoutDate });

  const toolExecutors = {
    get_all_time_stats: async () => {
      const trips = await allRides();
      return {
        totalTrips: trips.length,
        uniqueRoutes: countRoutes(trips),
        uniqueStops: tripsByStop(trips).all.length,
        uniqueAgencies: countAgencies(trips),
        timedTrips: finishedTrips(trips).length,
      };
    },
    get_all_time_stop_stats: async () => {
      const stops = tripsByStop(await allRides());
      return { topBoardingStops: stops.boarding.slice(0, 20), topExitStops: stops.exit.slice(0, 20) };
    },
    get_all_time_route_stats: async () => {
      const trips = await allRides();
      const routes = tripsByRoute(trips);
      return {
        total_trips: trips.length,
        route_count: routes.counts.length,
        trips_without_route: routes.withoutRoute,
        top_routes: routes.counts.slice(0, MAX_LISTED_ROUTES),
      };
    },
    get_monthly_trip_counts: async () => {
      const trips = await allRides();
      const dates = tripsByDate(trips, zone);
      return { by_month: dates.byMonth, by_year: dates.byYear, ...dateTotals(trips, dates) };
    },
    get_day_of_week_stats: async () => {
      const trips = await allRides();
      const dates = tripsByDate(trips, zone);
      return { by_day_of_week: dates.byWeekday, ...dateTotals(trips, dates) };
    },
    get_unique_stops: async () => {
      const stops = tripsByStop(await allRides()).all.map(([stop]) => stop);
      return { unique_stop_count: stops.length, stops: stops.sort() };
    },
    get_busiest_weeks: async () => {
      const weeks = tripsByDate(await allRides(), zone).byWeek;
      return sortedCounts(weeks).slice(0, 5).map(([week, count]) => ({ week_starting: week, trips: count }));
    },
    get_weekday_vs_weekend_stats: async () => {
      const trips = await allRides();
      const dates = tripsByDate(trips, zone);
      const weekends = (dates.byWeekday.Saturday || 0) + (dates.byWeekday.Sunday || 0);
      const dated = trips.length - dates.withoutDate;
      return { weekdays: dated - weekends, weekends, ...dateTotals(trips, dates) };
    },
    get_average_trip_duration: async ({ route }) => {
      const trips = (await allRides())
        .filter((trip) => !route || trip.route?.toString() === route.toString());
      const timed = durationSummary(trips);
      return {
        average_minutes: timed.average,
        longest_minutes: timed.longest,
        timed_trips: timed.count,
        total_trips: trips.length,
      };
    },
    get_stop_pair_stats: async ({ start_stop, end_stop }) => {
      const matches = (await allRides()).filter((trip) => {
        const start = String(boardingStop(trip) || '').toLowerCase();
        const end = String(exitStop(trip) || '').toLowerCase();
        return (!start_stop || start.includes(start_stop.toLowerCase())) &&
          (!end_stop || end.includes(end_stop.toLowerCase()));
      });
      const timed = durationSummary(matches);

      return {
        total: matches.length,
        by_day_of_week: tripsByDate(matches, zone).byWeekday,
        timed_trips: timed.count,
        // Individual run times only while the list is short.
        run_times_minutes: timed.count <= MAX_LISTED_RUN_TIMES ? timed.minutes : null,
        avg_duration_minutes: timed.average,
        min_duration_minutes: timed.shortest,
        max_duration_minutes: timed.longest,
      };
    },
    get_riding_streak: async () => {
      const streaks = ridingStreaks(await allRides(), zone);
      return {
        longest_streak_days: streaks.longest,
        current_streak_days: streaks.current,
        days_ridden: streaks.daysRidden,
      };
    },
    get_route_stats_for_period: async ({ start_date, end_date }) => {
      return Object.fromEntries(tripsByRoute(await ridesBetween(start_date, end_date)).counts);
    },
    get_agency_stats: async ({ start_date, end_date }) => {
      // A period needs both dates; a half-given one is refused before any read.
      const allTime = start_date == null && end_date == null;
      const trips = allTime ? await allRides() : await ridesBetween(start_date, end_date);
      const agencies = tripsByAgency(trips);
      return {
        period: allTime ? 'all time' : { start_date, end_date },
        total_trips: trips.length,
        agency_count: agencies.counts.length,
        trips_by_agency: agencies.counts,
        trips_without_agency: agencies.withoutAgency,
      };
    },
    get_trips_for_date_range: async ({ start_date, end_date }) => {
      const trips = await ridesBetween(start_date, end_date);
      return { start_date, end_date, count: trips.length };
    },
    get_trips_for_date: async ({ date }) => {
      const trips = await ridesBetween(date, date);
      return { date, count: trips.length };
    },
    get_trip_details_for_date: async ({ date }) => {
      const trips = (await ridesBetween(date, date))
        .map((trip) => ({ trip, startTime: tripStartDate(trip) }))
        .sort((a, b) => a.startTime - b.startTime)
        .map(({ trip, startTime }) => ({
          time: startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }),
          agency: tripAgency(trip),
          route: trip.route || 'Unknown',
          direction: trip.direction || null,
          from: boardingStop(trip) || 'Unknown',
          to: exitStop(trip),
          duration_min: trip.duration || null,
          // An imported PRESTO ride has only a time and an agency.
          ...(trip.imported ? { source: 'PRESTO import' } : {}),
        }));
      return { date, trips };
    },
    get_day_of_week_stats_for_year: async ({ year: rawYear }) => {
      const year = parseInt(rawYear, 10);
      const trips = (await allRides()).filter((trip) => tripLocalDay(trip, zone)?.year === year);
      return { year, by_day_of_week: tripsByDate(trips, zone).byWeekday, total_trips: trips.length };
    },
  };

  return toolExecutors;
}

const ASK_SYSTEM_PROMPT = `You answer questions for TransitStats, a personal transit trip tracker.
Each reply is sent to the rider as a single SMS text message.

These rules apply to every reply, including when the message is a greeting, a test, a trip log,
or anything else that is not a real question:
- Keep the whole reply under 300 characters.
- Plain text only. No markdown or formatting characters: no asterisks, underscores for emphasis,
  backticks, headings, bullet points or numbered lists.
- Never write in the first person. The reply must not contain "I", "I'm", "I've", "I'll", "me",
  "we" or "us". Do not introduce yourself or describe what you can do. Address the rider as "you"
  and state the answer directly, e.g. "12 trips on Fridays."
- When something can't be answered, say so without first person, e.g. "That isn't in your trip
  data." or "No trips found for that date." Never "I can't" or "I couldn't".
- When the tools and the data provided do not hold what the question needs, say that it is not
  available in one short sentence. Do not estimate, guess or infer an answer from other fields
  such as stop names or route numbers.
- When the message is not a question about the rider's trips, reply briefly that questions about
  your trips can be answered, and suggest topics rather than quoting a sample question,
  e.g. "Try asking about trips last week or your top route."
- Trip counts cover every logged trip. Durations come only from trips with a recorded duration,
  so a duration answer names how many trips it covers, e.g. "Average 18 min across 1,116 timed
  trips." Never present the timed-trip number as the total number of trips.
- Be concise and friendly.`;

/**
 * Use Claude to answer a natural-language question given aggregated trip stats,
 * using tools to search the user's own trips if needed.
 * @param {string} userId - User identifier
 * @param {string} question - User question
 * @param {Array} recentTrips - Most recent 200 trips (raw)
 * @param {object} stats - Aggregated stats for the recent 200 trips
 * @param {Array} conversationHistory - Recent Q&A turns [{ role, text }]
 * @returns {Promise<string>} AI answer
 */
async function answerQueryWithClaude(
  userId,
  question,
  recentTrips,
  stats,
  conversationHistory = [],
  timezone = 'America/Toronto',
  traceId = null
) {
  const apiKey = anthropicApiKey.value();
  if (!apiKey) return 'AI unavailable right now.';

  const { getFirestore } = require('firebase-admin/firestore');
  const db = getFirestore();
  const toolExecutors = buildQueryToolExecutors(db, userId, timezone);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  const introPrompt = `Answer the question below using the rider's personal transit data.

You have access to the most recent 200 trips spanning ${stats.windowStart || '?'} to ${stats.windowEnd || today}:
- Window size (NOT a date-filtered count): ${stats.total} trips
- Top 5 routes in window: ${JSON.stringify(stats.routeStats.slice(0, 5))}
- Top stop pairs: ${JSON.stringify(stats.pairStats.slice(0, 5))}
- Trips by day of week in window: ${JSON.stringify(stats.dayOfWeek || {})}
- Stops visited recently: ${stats.allStops?.join(', ')}
${stats.total ? '' : `- This window holds no logged trips, but the rider may have imported rides, which the tools count. CALL a tool for every count instead of answering that there are no trips.
`}
IMPORTANT:
- "Window size" is NOT the answer to any date-scoped question. For a specific date, "yesterday", "this week", "last month", "this year", or any other period, CALL a tool (get_trips_for_date, get_trips_for_date_range or get_monthly_trip_counts). Never count trips for a date or period from the figures above.
- If the question asks about dates outside ${stats.windowStart || '?'}–${stats.windowEnd || today}, or asks for all-time stats, CALL the appropriate tool. NEVER guess!

Today's date: ${today}
Question: "${question}"`;

  // Earlier turns are stored as { role: 'user' | 'model', text }. Claude calls the
  // second role "assistant" and needs the conversation to open with a user turn.
  const history = conversationHistory
    .filter((turn) => turn && typeof turn.text === 'string' && turn.text.trim())
    .map((turn) => ({ role: turn.role === 'user' ? 'user' : 'assistant', content: turn.text }));
  while (history.length && history[0].role !== 'user') history.shift();

  const messages = [...history, { role: 'user', content: introPrompt }];

  // One deadline for the whole question: each request gets at most the time
  // left, and anything still running when it passes is cancelled.
  const deadline = Date.now() + ASK_DEADLINE_MS;
  const deadlineAbort = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineAbort.abort(), ASK_DEADLINE_MS);

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const lastRound = round === MAX_TOOL_ROUNDS;
      const remainingMs = deadline - Date.now();
      if (remainingMs < ASK_MIN_REQUEST_MS) {
        logger.error('Claude ASK ran out of time', { rounds: round }, traceId);
        return ASK_FAILED;
      }
      const message = await getClient(apiKey).messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS_ASK,
        output_config: { effort: CLAUDE_EFFORT },
        system: ASK_SYSTEM_PROMPT,
        tools: QUERY_TOOLS,
        // After the last allowed tool round the model must answer with what it has.
        ...(lastRound ? { tool_choice: { type: 'none' } } : {}),
        messages,
      }, {
        timeout: Math.min(ASK_ATTEMPT_TIMEOUT_MS, remainingMs),
        maxRetries: 1,
        signal: deadlineAbort.signal,
      });

      if (message.stop_reason !== 'tool_use') {
        return finishedText(message, 'ask', traceId) || ASK_FAILED;
      }

      const calls = message.content.filter((block) => block.type === 'tool_use');
      if (lastRound || calls.length === 0) {
        logger.error('Claude ASK tool loop did not finish', { rounds: round }, traceId);
        return ASK_FAILED;
      }

      // Echo the assistant turn back unchanged, then answer every tool call from
      // this turn in a single user message.
      messages.push({ role: 'assistant', content: message.content });
      const results = await Promise.all(calls.map(async (call) => {
        const executor = Object.hasOwn(toolExecutors, call.name) ? toolExecutors[call.name] : null;
        if (!executor) {
          return { type: 'tool_result', tool_use_id: call.id, content: 'Tool not found', is_error: true };
        }
        // One bad argument fails only that call: the model sees the error and can retry.
        try {
          const data = await executor(call.input || {});
          return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(data) };
        } catch (toolError) {
          logger.error('Claude ASK tool failed', { tool: call.name, error: toolError.message }, traceId);
          const hint = toolError.message === DATE_ERROR ? ` ${DATE_ERROR}` : '';
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: `Tool call failed. Check the arguments and try again.${hint}`,
            is_error: true,
          };
        }
      }));
      messages.push({ role: 'user', content: results });
    }
    return ASK_FAILED;
  } catch (err) {
    logger.error('Claude Tooling Error', {
      kind: claudeErrorKind(err), error: err.message, stack: err.stack,
    }, traceId);
    return ASK_FAILED;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

// Ambiguous agency names that should never be cached — Claude looks them up fresh each time
const AMBIGUOUS_AGENCIES = new Set(['MTA', 'Metro', 'Transit']);

const TIMEZONE_SCHEMA = {
  type: 'object',
  properties: { timezone: { type: 'string' } },
  required: ['timezone'],
  additionalProperties: false,
};

/**
 * True when the runtime recognises the string as an IANA time zone.
 * @param {string} timeZone
 * @returns {boolean}
 */
function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Look up the IANA timezone for a transit agency.
 * Checks the shared agency table (constants.js) first, then Firestore cache, then asks Claude.
 * Caches Claude results to Firestore so each agency is only looked up once.
 * @param {string} agency
 * @returns {Promise<string>} IANA timezone string (e.g. 'America/Los_Angeles')
 */
async function lookupAgencyTimezone(agency, traceId = null) {
  if (!agency) return 'America/Toronto';

  // Normalize first so aliases always resolve to canonical names
  const { normalizeAgency } = require('./utils');
  const canonical = normalizeAgency(agency);

  // 1. Shared agency table (constants.js AGENCY_TIMEZONE)
  const known = timezoneForAgency(canonical);
  if (known) return known;

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

  // 3. Ask Claude
  const apiKey = anthropicApiKey.value();
  if (!apiKey) return 'America/Toronto';

  try {
    const message = await getClient(apiKey).messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS_TIMEZONE,
      output_config: {
        effort: CLAUDE_EFFORT,
        format: { type: 'json_schema', schema: TIMEZONE_SCHEMA },
      },
      messages: [{
        role: 'user',
        content: `What is the IANA timezone for the public transit agency "${canonical}"? ` +
          `Reply with only the IANA timezone string (e.g. America/Los_Angeles), nothing else.`,
      }],
    }, SHORT_CALL_OPTIONS);
    const raw = finishedText(message, 'timezone', traceId);
    const parsed = raw ? JSON.parse(raw) : null;
    const tz = parsed && typeof parsed.timezone === 'string' ?
      parsed.timezone.trim().replace(/['"]/g, '') :
      '';

    // Only a real IANA zone is used or cached; anything else falls back below.
    if (tz && tz.includes('/') && isValidTimeZone(tz)) {
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
    logger.error('Agency timezone Claude lookup error', { kind: claudeErrorKind(e), error: e.message }, traceId);
  }

  return 'America/Toronto';
}

module.exports = {
  answerQueryWithClaude,
  buildQueryToolExecutors,
  ASK_PRESTO_FIELDS,
  parseWithClaude,
  lookupAgencyTimezone,
};
