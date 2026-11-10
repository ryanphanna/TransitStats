const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const RealAnthropic = require('@anthropic-ai/sdk');

// Loads lib/claude.js with the Anthropic SDK, secrets and Firestore replaced by fakes.
// No network: every "API reply" comes from the `replies` queue.
function loadClaude({ apiKey = 'test-key', replies = [], tripDocs = [], cachedTimezone = null } = {}) {
  const requests = [];
  const requestOptions = [];
  const clientOptions = [];
  const queries = [];
  const timezoneWrites = [];
  const logs = { info: [], error: [] };

  class FakeAnthropic {
    constructor(options) {
      clientOptions.push(options);
      this.messages = {
        create: async (params, requestOpts = {}) => {
          // Snapshot: the module keeps appending to the same messages array.
          requests.push(JSON.parse(JSON.stringify(params)));
          requestOptions.push(requestOpts);
          const next = replies.shift();
          if (!next) throw new Error('test: no reply queued');
          if (next instanceof Error) throw next;
          if (next.hang || next.delayMs) {
            // Behaves like the SDK: a hung call fails after every attempt has
            // timed out, or as soon as the caller's signal is aborted.
            const timeout = requestOpts.timeout ?? options.timeout;
            const attempts = (requestOpts.maxRetries ?? options.maxRetries) + 1;
            return new Promise((resolve, reject) => {
              if (next.hang) {
                setTimeout(() => reject(new RealAnthropic.APIConnectionTimeoutError({ message: 'timed out' })),
                  timeout * attempts);
              } else {
                setTimeout(() => resolve(next.reply), next.delayMs);
              }
              requestOpts.signal?.addEventListener('abort', () => reject(new RealAnthropic.APIUserAbortError()));
            });
          }
          return next;
        },
      };
    }
  }
  // The module checks failures against the SDK's typed error classes.
  for (const name of Object.getOwnPropertyNames(RealAnthropic)) {
    if (/Error$/.test(name)) FakeAnthropic[name] = RealAnthropic[name];
  }

  const makeQuery = (collection) => {
    const query = { collection, wheres: [] };
    queries.push(query);
    const chain = {
      where: (field, op, value) => { query.wheres.push([field, op, value]); return chain; },
      select: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      count: () => ({ get: async () => ({ data: () => ({ count: tripDocs.length }) }) }),
      get: async () => ({ size: tripDocs.length, docs: tripDocs.map((data) => ({ data: () => data })) }),
      doc: (id) => ({
        get: async () => ({
          exists: !!cachedTimezone,
          data: () => ({ timezone: cachedTimezone }),
        }),
        set: async (data) => { timezoneWrites.push({ id, data }); },
      }),
    };
    return chain;
  };
  const db = { collection: (name) => makeQuery(name) };

  const claudePath = require.resolve('./lib/claude');
  delete require.cache[claudePath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.id === claudePath) {
      if (request === '@anthropic-ai/sdk') return FakeAnthropic;
      if (request === 'firebase-functions/params') return { defineSecret: () => ({ value: () => apiKey }) };
      if (request === 'firebase-admin/firestore') {
        return { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'server-timestamp' } };
      }
      if (request === './logger') {
        return {
          info: (message, data) => logs.info.push({ message, data }),
          error: (message, data) => logs.error.push({ message, data }),
        };
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const savedTestMode = process.env.TS_TEST_MODE;
  delete process.env.TS_TEST_MODE;

  const claude = require('./lib/claude');
  const restore = () => {
    Module._load = originalLoad;
    delete require.cache[claudePath];
    if (savedTestMode === undefined) delete process.env.TS_TEST_MODE;
    else process.env.TS_TEST_MODE = savedTestMode;
  };

  return { claude, requests, requestOptions, clientOptions, queries, timezoneWrites, logs, restore };
}

// Fake clock: move time forward in steps, letting pending promises run between steps.
function useFakeClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  return async (ms, step = 500) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(step);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

// Resolves to the promise's value, or 'pending' when it has not settled yet.
const settledOr = (promise) => Promise.race([
  promise,
  new Promise((resolve) => setImmediate(() => resolve('pending'))),
]);

// The sms and api functions run with the default 60 s limit.
const FUNCTION_LIMIT_MS = 60000;

const textReply = (text, extra = {}) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  ...extra,
});

const toolReply = (...calls) => ({
  stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    ...calls.map(([id, name, input]) => ({ type: 'tool_use', id, name, input: input || {} })),
  ],
});

const STATS = {
  total: 2,
  windowStart: '2026-10-01',
  windowEnd: '2026-11-01',
  routeStats: [],
  pairStats: [],
  dayOfWeek: {},
  dailyCounts: {},
  allStops: ['Spadina'],
};

// A finished trip on 1 March 2026, Toronto time.
const MARCH_1_TIMES = {
  startTime: new Date('2026-03-01T15:00:00Z'),
  endTime: new Date('2026-03-01T15:12:00Z'),
  duration: 12,
};

const PARSED_TRIP = {
  intent: 'START_TRIP',
  route: '510',
  stop_name: 'Spadina <b>Station</b>',
  stop_id: null,
  direction: 'Northbound',
  agency: null,
  vehicle: '4412',
  sentiment: 'NEUTRAL',
  tags: ['crowded'],
  question: null,
};

// Sampling and thinking-budget settings the model rejects.
function assertNoRejectedParams(request) {
  for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) {
    assert.equal(key in request, false, `${key} must not be sent`);
  }
}

// ---------- Trip text parsing ----------

test('parseWithClaude sends a structured-output request to Haiku and sanitizes the result', async () => {
  const { claude, requests, clientOptions, restore } = loadClaude({
    replies: [textReply(JSON.stringify(PARSED_TRIP))],
  });
  try {
    const result = await claude.parseWithClaude('Boarded 510 from Spadina (Vehicle 4412)');

    assert.equal(result.intent, 'START_TRIP');
    assert.equal(result.route, '510');
    assert.equal(result.stop_name, 'Spadina Station'); // HTML stripped
    assert.equal(result.direction, 'Northbound');
    assert.deepEqual(result.tags, ['crowded']);

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.model, 'claude-haiku-5-5');
    assert.equal(request.output_config.effort, 'low');
    assert.equal(request.output_config.format.type, 'json_schema');
    assert.equal(request.output_config.format.schema.additionalProperties, false);
    assert.ok(request.max_tokens >= 1000);
    assertNoRejectedParams(request);
    // No assistant prefill: the only message is the user prompt.
    assert.deepEqual(request.messages.map((m) => m.role), ['user']);
    assert.match(request.messages[0].content, /Boarded 510 from Spadina/);

    assert.equal(clientOptions[0].apiKey, 'test-key');
    assert.equal(clientOptions[0].maxRetries, 2);
  } finally {
    restore();
  }
});

test('parseWithClaude replaces an invalid intent and sentiment like before', async () => {
  const { claude, restore } = loadClaude({
    replies: [textReply(JSON.stringify({ ...PARSED_TRIP, intent: 'DROP_TABLE', sentiment: 'ANGRY' }))],
  });
  try {
    const result = await claude.parseWithClaude('hello');
    assert.equal(result.intent, 'OTHER');
    assert.equal(result.sentiment, 'NEUTRAL');
  } finally {
    restore();
  }
});

test('parseWithClaude truncates long texts to 500 characters', async () => {
  const { claude, requests, restore } = loadClaude({ replies: [textReply(JSON.stringify(PARSED_TRIP))] });
  try {
    await claude.parseWithClaude('a'.repeat(499) + 'KEEP' + 'DROPPED');
    assert.match(requests[0].messages[0].content, /a{499}K"/);
    assert.doesNotMatch(requests[0].messages[0].content, /DROPPED/);
  } finally {
    restore();
  }
});

test('parseWithClaude skips the AI when the key is missing', async () => {
  const { claude, requests, clientOptions, restore } = loadClaude({ apiKey: '' });
  try {
    assert.equal(await claude.parseWithClaude('504 from King'), null);
    assert.equal(requests.length, 0);
    assert.equal(clientOptions.length, 0);
  } finally {
    restore();
  }
});

test('parseWithClaude skips the AI in test mode', async () => {
  const { claude, requests, restore } = loadClaude({ replies: [textReply(JSON.stringify(PARSED_TRIP))] });
  try {
    process.env.TS_TEST_MODE = '1';
    assert.equal(await claude.parseWithClaude('504 from King'), null);
    assert.equal(requests.length, 0);
  } finally {
    restore();
  }
});

for (const stopReason of ['refusal', 'max_tokens']) {
  test(`parseWithClaude falls back to rule-based parsing on stop_reason ${stopReason}`, async () => {
    const { claude, logs, restore } = loadClaude({
      replies: [{
        stop_reason: stopReason,
        stop_details: stopReason === 'refusal' ? { type: 'refusal', category: null } : null,
        content: [{ type: 'text', text: '{"intent":"START_TRIP"' }],
      }],
    });
    try {
      assert.equal(await claude.parseWithClaude('504 from King'), null);
      assert.equal(logs.error[0].data.stopReason, stopReason);
    } finally {
      restore();
    }
  });
}

test('parseWithClaude falls back to rule-based parsing when the API call fails', async () => {
  const rateLimited = new RealAnthropic.RateLimitError(429, { type: 'error' }, 'rate limited', new Headers());
  const { claude, logs, restore } = loadClaude({ replies: [rateLimited] });
  try {
    assert.equal(await claude.parseWithClaude('504 from King'), null);
    assert.equal(logs.error[0].data.kind, 'rate_limit');
  } finally {
    restore();
  }
});

test('parseWithClaude gives up on a hung call in time for the rule-based fallback', async (t) => {
  const advance = useFakeClock(t);
  const { claude, requestOptions, logs, restore } = loadClaude({ replies: [{ hang: true }] });
  try {
    const pending = claude.parseWithClaude('504 from King');
    await advance(15500);
    assert.equal(await settledOr(pending), 'pending');
    await advance(1000);
    assert.equal(await settledOr(pending), null);

    assert.equal(requestOptions[0].timeout, 8000);
    assert.equal(requestOptions[0].maxRetries, 1);
    assert.equal(logs.error[0].data.kind, 'timeout');
    // Worst case, backoff included, leaves well over half the function's time for the fallback.
    assert.ok(Date.now() <= FUNCTION_LIMIT_MS / 2);
  } finally {
    restore();
  }
});

// ---------- ASK ----------

test('answerQueryWithClaude gives up at its deadline and bounds each request by the time left', async (t) => {
  const { ASK_FAILED } = require('./lib/sms-text');
  const advance = useFakeClock(t);
  const { claude, requests, requestOptions, restore } = loadClaude({
    replies: [
      { delayMs: 14000, reply: toolReply(['toolu_1', 'get_riding_streak']) },
      { delayMs: 14000, reply: toolReply(['toolu_2', 'get_riding_streak']) },
      { hang: true },
    ],
  });
  try {
    const pending = claude.answerQueryWithClaude('user-1', 'Longest streak?', [], STATS, []);
    await advance(34500);
    assert.equal(await settledOr(pending), 'pending');
    await advance(500);
    assert.equal(await settledOr(pending), ASK_FAILED);

    assert.equal(requests.length, 3);
    assert.deepEqual(requestOptions.map((o) => o.timeout), [15000, 15000, 7000]);
    for (const options of requestOptions) {
      assert.equal(options.maxRetries, 1);
      assert.ok(options.signal instanceof AbortSignal);
    }
    // A time zone lookup (8 s x 2 attempts + backoff) can run before ASK in the same call.
    assert.ok(Date.now() + 17000 < FUNCTION_LIMIT_MS);
  } finally {
    restore();
  }
});

test('answerQueryWithClaude does not start a request once the deadline has passed', async (t) => {
  const { ASK_FAILED } = require('./lib/sms-text');
  const advance = useFakeClock(t);
  const { claude, requests, restore } = loadClaude({
    replies: [
      { delayMs: 14000, reply: toolReply(['toolu_1', 'get_riding_streak']) },
      { delayMs: 14000, reply: toolReply(['toolu_2', 'get_riding_streak']) },
      { delayMs: 6500, reply: toolReply(['toolu_3', 'get_riding_streak']) },
      textReply('never sent'),
    ],
  });
  try {
    const pending = claude.answerQueryWithClaude('user-1', 'Longest streak?', [], STATS, []);
    await advance(35000);
    assert.equal(await settledOr(pending), ASK_FAILED);
    assert.equal(requests.length, 3);
  } finally {
    restore();
  }
});

test('answerQueryWithClaude returns a failing tool as an error result and carries on', async () => {
  const { claude, requests, queries, logs, restore } = loadClaude({
    tripDocs: [{ route: '510', startStopName: 'Spadina', endStopName: 'Union', ...MARCH_1_TIMES }],
    replies: [
      toolReply(
        ['toolu_1', 'get_trips_for_date', { date: 'March 1' }],
        ['toolu_2', 'get_stop_pair_stats', { start_stop: 42, end_stop: null }],
        ['toolu_3', 'get_all_time_route_stats'],
      ),
      toolReply(['toolu_4', 'get_trips_for_date', { date: '2026-03-01' }]),
      textReply('1 trip on March 1.'),
    ],
  });
  try {
    const answer = await claude.answerQueryWithClaude('user-1', 'Trips on March 1?', [], STATS, []);
    assert.equal(answer, '1 trip on March 1.');
    assert.equal(requests.length, 3);

    // All three results come back in one user message, in call order.
    const results = requests[1].messages.at(-1).content;
    assert.deepEqual(results.map((b) => [b.type, b.tool_use_id, b.is_error === true]), [
      ['tool_result', 'toolu_1', true],
      ['tool_result', 'toolu_2', true],
      ['tool_result', 'toolu_3', false],
    ]);
    assert.match(results[0].content, /YYYY-MM-DD/);
    assert.ok(results[0].content.length < 120);
    // Internal error text is not passed to the model.
    assert.doesNotMatch(results[1].content, /toLowerCase|TypeError/);
    assert.deepEqual(JSON.parse(results[2].content),
      { total_trips: 1, route_count: 1, trips_without_route: 0, top_routes: [['510', 1]] });
    assert.equal(logs.error.filter((entry) => entry.message === 'Claude ASK tool failed').length, 2);

    // The corrected call on the next turn succeeds.
    const retry = requests[2].messages.at(-1).content[0];
    assert.equal(retry.is_error, undefined);
    assert.deepEqual(JSON.parse(retry.content), { date: '2026-03-01', count: 1 });

    for (const query of queries) {
      assert.deepEqual(query.wheres[0], ['userId', '==', 'user-1']);
    }
  } finally {
    restore();
  }
});

test('answerQueryWithClaude answers without tools when the data is already in the prompt', async () => {
  const { claude, requests, queries, restore } = loadClaude({ replies: [textReply(' 12 trips on Fridays. ')] });
  try {
    const answer = await claude.answerQueryWithClaude('user-1', 'How many Friday trips?', [], STATS, []);
    assert.equal(answer, '12 trips on Fridays.');

    const request = requests[0];
    assert.equal(request.model, 'claude-haiku-5-5');
    assert.equal(request.output_config.effort, 'low');
    assert.equal('format' in request.output_config, false);
    assertNoRejectedParams(request);
    assert.equal('tool_choice' in request, false);
    assert.match(request.system, /Never write in the first person/);
    assert.match(request.system, /No markdown/);
    assert.match(request.system, /under 300 characters/);
    assert.match(request.messages.at(-1).content, /Question: "How many Friday trips\?"/);
    assert.equal(queries.length, 0);
  } finally {
    restore();
  }
});

test('answerQueryWithClaude declares every ASK tool in Claude format', async () => {
  const { claude, requests, restore } = loadClaude({ replies: [textReply('ok')] });
  try {
    await claude.answerQueryWithClaude('user-1', 'q', [], STATS, []);
    const tools = requests[0].tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'get_agency_stats', 'get_all_time_route_stats', 'get_all_time_stats', 'get_all_time_stop_stats',
      'get_average_trip_duration', 'get_busiest_weeks', 'get_day_of_week_stats', 'get_day_of_week_stats_for_year',
      'get_monthly_trip_counts',
      'get_riding_streak', 'get_route_stats_for_period', 'get_stop_pair_stats', 'get_trip_details_for_date',
      'get_trips_for_date', 'get_trips_for_date_range', 'get_unique_stops', 'get_weekday_vs_weekend_stats',
    ]);
    for (const tool of tools) {
      assert.equal(tool.input_schema.type, 'object', tool.name);
      assert.equal(typeof tool.description, 'string', tool.name);
      assert.equal('parameters' in tool, false, tool.name);
    }
    // Strict mode: closed schemas with every property listed as required.
    for (const tool of tools) {
      assert.equal(tool.strict, true, tool.name);
      assert.equal(tool.input_schema.additionalProperties, false, tool.name);
      assert.deepEqual(tool.input_schema.required, Object.keys(tool.input_schema.properties), tool.name);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(byName.get_trips_for_date.input_schema.required, ['date']);
    assert.equal(byName.get_trips_for_date.input_schema.properties.date.format, 'date');
    assert.deepEqual(byName.get_stop_pair_stats.input_schema.required, ['start_stop', 'end_stop']);
    assert.deepEqual(byName.get_stop_pair_stats.input_schema.properties.start_stop.type, ['string', 'null']);
    assert.deepEqual(byName.get_average_trip_duration.input_schema.properties.route.type, ['string', 'null']);
    assert.deepEqual(byName.get_all_time_stats.input_schema.properties, {});
    // Agency counts take an optional period and nothing that could name a user or collection.
    assert.deepEqual(byName.get_agency_stats.input_schema.required, ['start_date', 'end_date']);
    for (const key of ['start_date', 'end_date']) {
      assert.deepEqual(byName.get_agency_stats.input_schema.properties[key].type, ['string', 'null']);
      // A date format on a nullable field keeps the model from sending null (seen live).
      assert.equal('format' in byName.get_agency_stats.input_schema.properties[key], false);
    }
  } finally {
    restore();
  }
});

test('get_agency_stats counts trips per agency for the asking user only and reports trips with none', async () => {
  const { claude, requests, queries, restore } = loadClaude({
    tripDocs: [
      { agency: 'TTC' }, { agency: ' ttc ' }, { agency: 'GO Transit' },
      { agency: null }, { agency: '  ' }, { route: '510' }, { agency: 42 },
    ].map((trip) => ({ ...trip, ...MARCH_1_TIMES })),
    replies: [
      toolReply(
        ['toolu_1', 'get_agency_stats', { start_date: null, end_date: null }],
        ['toolu_2', 'get_agency_stats', { start_date: '2026-03-01', end_date: '2026-03-31' }],
        ['toolu_3', 'get_agency_stats', { start_date: '2026-03-01', end_date: null }],
        ['toolu_4', 'get_agency_stats',
          { start_date: null, end_date: null, userId: 'user-2', collection: 'profiles' }],
        ['toolu_5', 'get_trip_details_for_date', { date: '2026-03-01' }],
      ),
      textReply('2 agencies: TTC and GO Transit.'),
    ],
  });
  try {
    const answer = await claude.answerQueryWithClaude('user-1', 'How many agencies?', [], STATS, []);
    assert.equal(answer, '2 agencies: TTC and GO Transit.');

    const results = requests[1].messages.at(-1).content;
    const allTime = JSON.parse(results[0].content);
    // Spelling variants merge; trips with no usable agency are counted, not dropped.
    assert.deepEqual(allTime, {
      period: 'all time',
      total_trips: 7,
      agency_count: 2,
      trips_by_agency: [['TTC', 2], ['GO Transit', 1]],
      trips_without_agency: 4,
    });
    const period = JSON.parse(results[1].content);
    assert.deepEqual(period.period, { start_date: '2026-03-01', end_date: '2026-03-31' });
    assert.equal(period.trips_without_agency, 4);
    // A half-given period is refused instead of silently widened to all time.
    assert.equal(results[2].is_error, true);
    assert.match(results[2].content, /YYYY-MM-DD/);
    // Extra arguments are ignored: the result is the same as the plain all-time call.
    assert.deepEqual(JSON.parse(results[3].content), allTime);
    // Per-trip details carry the agency, or null when the trip has none.
    assert.deepEqual(JSON.parse(results[4].content).trips.map((t) => t.agency),
      ['TTC', 'TTC', 'GO Transit', null, null, null, null]);

    // One read per question, shared by every call: the asking user's trips and
    // imported rides, each filtered only by the handler's user id. Nothing the
    // model sent (user-2, profiles) reaches a query.
    assert.deepEqual(queries.map((query) => query.collection).sort(), ['prestoTransactions', 'trips']);
    for (const query of queries) {
      assert.deepEqual(query.wheres, [['userId', '==', 'user-1']]);
    }
  } finally {
    restore();
  }
});

// Firestore stand-in for the ASK tools: applies the user filter and records each query.
// Imported PRESTO rows, when given, are served only from their own collection.
function fakeTripsDb(tripDocs, prestoDocs = null) {
  const queries = [];
  const compare = { '==': (a, b) => a === b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b };
  const db = {
    collection: (collection) => {
      const query = { collection, wheres: [], fields: null };
      queries.push(query);
      const chain = {
        where: (field, op, value) => { query.wheres.push([field, op, value]); return chain; },
        select: (...fields) => { query.fields = fields; return chain; },
        get: async () => {
          const docs = prestoDocs && collection === 'prestoTransactions' ? prestoDocs : tripDocs;
          const matching = docs.filter((doc) => query.wheres.every(([field, op, value]) =>
            doc[field] != null && compare[op](doc[field], value)));
          return { size: matching.length, docs: matching.map((data) => ({ data: () => data })) };
        },
      };
      return chain;
    },
  };
  return { db, queries };
}

const toronto = (local) => new Date(`${local}-04:00`); // Toronto summer time
const AGREEMENT_TRIPS = [
  // Finished trips.
  { userId: 'user-1', agency: 'TTC', route: '510', startStopName: 'Spadina', endStopName: 'Union',
    startTime: toronto('2026-09-12T09:00:00'), endTime: toronto('2026-09-12T09:20:00'), duration: 20 },
  { userId: 'user-1', agency: 'GO Transit', route: 'LW', startStopName: 'Union', endStopName: 'Exhibition',
    startTime: toronto('2026-10-03T18:00:00'), endTime: toronto('2026-10-03T18:10:00'), duration: 10 },
  // Starts in the last second of September and ends in October: a September trip.
  { userId: 'user-1', agency: 'TTC', route: '506', startStopName: 'Main', endStopName: 'Coxwell',
    startTime: toronto('2026-09-30T23:59:59.500'), endTime: toronto('2026-10-01T00:12:00'), duration: 12 },
  // Never ended (FORGOT): counted, but has no duration.
  { userId: 'user-1', agency: 'TTC', route: '506', startStopName: 'Spadina', incomplete: true,
    startTime: toronto('2026-09-30T18:17:00'), endTime: null },
  // First minute of October.
  { userId: 'user-1', agency: 'ttc', route: '1', startStopName: 'Dundas', endTime: null,
    startTime: toronto('2026-10-01T00:00:30') },
  // Imported history: boarding only, no end time, no route.
  { userId: 'user-1', agency: 'MiWay', startStopName: 'Sherbourne', source: 'legacy-notion',
    startTime: toronto('2024-03-18T18:14:00'), endTime: null, duration: null },
  // 00:30 on the day the clocks go back: before the hour that repeats, still summer time.
  { userId: 'user-1', agency: 'TTC', route: '300', startStopName: 'Yonge',
    startTime: toronto('2026-11-01T00:30:00'), endTime: null },
  // Discarded record with no start time: still a logged trip, so it is counted, without a date.
  { userId: 'user-1', discarded: true, raw_text: 'hello' },
  // Never counted: an unreadable text that was not discarded, and another rider's trip.
  { userId: 'user-1', raw_text: 'what', needs_review: true },
  { userId: 'user-2', agency: 'STM', route: '24', startStopName: 'Sherbrooke',
    startTime: toronto('2026-09-15T08:00:00'), endTime: toronto('2026-09-15T08:30:00'), duration: 30 },
];

test('countedTrips keeps every history trip and finishedTrips only the timed ones', () => {
  const { restore } = loadClaude();
  const tripStats = require('./lib/trip-stats');
  const claude = { selectCountedTrips: tripStats.countedTrips, selectFinishedTrips: tripStats.finishedTrips };
  try {
    const now = Date.parse('2026-11-09T17:00:00Z');
    const inProgress = { route: '510', startTime: new Date(now - 60 * 60 * 1000), endTime: null };
    const timedOut = { route: '510', startTime: new Date(now - 7 * 60 * 60 * 1000), endTime: null };
    const mine = AGREEMENT_TRIPS.filter((trip) => trip.userId === 'user-1');
    const counted = claude.selectCountedTrips([...mine, inProgress, timedOut], now);
    // Everything except the unreadable text and the trip still in progress.
    assert.equal(counted.length, 9);
    assert.equal(counted.includes(inProgress), false);
    assert.equal(counted.includes(timedOut), true);
    assert.equal(counted.some((trip) => trip.needs_review), false);
    // Only trips with an end time and a duration feed duration figures.
    assert.deepEqual(claude.selectFinishedTrips(counted).map((trip) => trip.duration), [20, 10, 12]);
    assert.deepEqual(claude.selectCountedTrips(null), []);
  } finally {
    restore();
  }
});

test('every ASK tool counts the same trips for the same rider', async () => {
  const { claude, restore } = loadClaude();
  try {
    const { db, queries } = fakeTripsDb(AGREEMENT_TRIPS);
    const tools = claude.buildQueryToolExecutors(db, 'user-1', 'America/Toronto');
    const all = await tools.get_all_time_stats();
    const monthly = await tools.get_monthly_trip_counts();
    const weekdays = await tools.get_day_of_week_stats();
    const split = await tools.get_weekday_vs_weekend_stats();
    const agencies = await tools.get_agency_stats({ start_date: null, end_date: null });
    const routes = await tools.get_all_time_route_stats();
    const durations = await tools.get_average_trip_duration({ route: null });
    const pairs = await tools.get_stop_pair_stats({ start_stop: null, end_stop: null });
    const streak = await tools.get_riding_streak();
    const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

    // One total everywhere: 8 trips, 7 of them with a date.
    assert.equal(all.totalTrips, 8);
    for (const total of [monthly.total_trips, weekdays.total_trips, split.total_trips, agencies.total_trips,
      routes.total_trips, durations.total_trips, pairs.total]) {
      assert.equal(total, all.totalTrips);
    }
    assert.equal(monthly.trips_without_date, 1);
    for (const dated of [sum(monthly.by_month), sum(monthly.by_year), sum(weekdays.by_day_of_week),
      split.weekdays + split.weekends, sum(pairs.by_day_of_week)]) {
      assert.equal(dated, all.totalTrips - monthly.trips_without_date);
    }
    assert.deepEqual(monthly.by_month, { '2024-03': 1, '2026-09': 3, '2026-10': 2, '2026-11': 1 });
    assert.deepEqual(monthly.by_year, { 2024: 1, 2026: 6 });
    assert.equal(sum((await tools.get_day_of_week_stats_for_year({ year: 2026 })).by_day_of_week), 6);
    assert.equal(streak.days_ridden, 6);
    assert.equal(streak.longest_streak_days, 2);

    // Agencies and routes agree between the summary and the detailed tools.
    assert.equal(all.uniqueAgencies, agencies.agency_count);
    assert.deepEqual(agencies.trips_by_agency, [['TTC', 5], ['GO Transit', 1], ['MiWay', 1]]);
    assert.equal(all.uniqueRoutes, routes.route_count);
    assert.equal(routes.trips_without_route, 2);

    // Durations cover the three finished trips only, and say so.
    assert.equal(all.timedTrips, 3);
    assert.deepEqual(durations, { average_minutes: 14, longest_minutes: 20, timed_trips: 3, total_trips: 8 });
    assert.equal(pairs.timed_trips, 3);
    assert.deepEqual(pairs.run_times_minutes, [20, 10, 12]);

    // A month asked for as a date range matches the monthly count, for every month.
    const lastDay = { '2024-03': 31, '2026-09': 30, '2026-10': 31, '2026-11': 30 };
    for (const [month, count] of Object.entries(monthly.by_month)) {
      const period = { start_date: `${month}-01`, end_date: `${month}-${lastDay[month]}` };
      assert.equal((await tools.get_trips_for_date_range(period)).count, count, month);
      assert.equal((await tools.get_agency_stats(period)).total_trips, count, month);
      assert.equal(sum(await tools.get_route_stats_for_period(period)) +
        (month === '2024-03' ? 1 : 0), count, month);
    }

    // Trips are assigned to a day by their start, in the rider's time zone.
    assert.equal((await tools.get_trips_for_date({ date: '2026-09-30' })).count, 2);
    assert.equal((await tools.get_trips_for_date({ date: '2026-10-01' })).count, 1);
    assert.equal((await tools.get_trips_for_date({ date: '2026-10-31' })).count, 0);
    assert.equal((await tools.get_trips_for_date({ date: '2026-11-01' })).count, 1);
    assert.deepEqual((await tools.get_trip_details_for_date({ date: '2026-09-30' })).trips.map((t) => t.route),
      ['506', '506']);

    // Every tool shares one read: the asking rider's trips and imported rides, with a field projection.
    assert.deepEqual(queries.map((query) => query.collection).sort(), ['prestoTransactions', 'trips']);
    for (const query of queries) {
      assert.deepEqual(query.wheres, [['userId', '==', 'user-1']]);
      assert.ok(query.fields.length > 0 && !query.fields.includes('raw_text'));
    }
  } finally {
    restore();
  }
});

test('ASK counts imported PRESTO rides once, like the dashboard', async () => {
  const { claude, restore } = loadClaude();
  try {
    // PRESTO rows carry Toronto wall-clock times read as UTC.
    const presto = (userId, wallClock, agency = 'TTC') => ({
      userId, type: 'fare_payment', agency, amountCents: -330, occurredAtSortKey: Date.parse(`${wallClock}Z`),
    });
    const { db, queries } = fakeTripsDb(AGREEMENT_TRIPS, [
      presto('user-1', '2026-09-12T09:03:00'),            // the logged 9:00 ride, recorded again
      presto('user-1', '2026-09-13T08:00:00'),            // not logged: a ninth trip
      presto('user-1', '2026-09-14T08:00:00', 'Mississauga Transit'),
      { userId: 'user-1', type: 'load', agency: 'TTC', occurredAtSortKey: Date.parse('2026-09-15T08:00:00Z') },
      presto('user-2', '2026-09-16T08:00:00'),            // another rider's
    ]);
    const tools = claude.buildQueryToolExecutors(db, 'user-1', 'America/Toronto');
    const all = await tools.get_all_time_stats();
    assert.equal(all.totalTrips, 10);
    // Imported rides add trips, agencies and days, never routes, stops or durations.
    assert.equal(all.uniqueRoutes, 5);
    assert.equal(all.timedTrips, 3);
    assert.deepEqual((await tools.get_agency_stats({ start_date: null, end_date: null })).trips_by_agency,
      [['TTC', 6], ['MiWay', 2], ['GO Transit', 1]]);
    assert.equal((await tools.get_monthly_trip_counts()).by_month['2026-09'], 5);
    assert.equal((await tools.get_trips_for_date({ date: '2026-09-12' })).count, 1);
    assert.equal((await tools.get_riding_streak()).longest_streak_days, 3);
    assert.deepEqual((await tools.get_trip_details_for_date({ date: '2026-09-13' })).trips, [{
      time: '8:00 AM', agency: 'TTC', route: 'Unknown', direction: null, from: 'Unknown', to: null,
      duration_min: null, source: 'PRESTO import',
    }]);
    // One read of each collection, each filtered only by the handler's user id.
    assert.deepEqual(queries.map((query) => [query.collection, query.wheres]).sort(), [
      ['prestoTransactions', [['userId', '==', 'user-1']]],
      ['trips', [['userId', '==', 'user-1']]],
    ]);
  } finally {
    restore();
  }
});

test('ASK tells the model that durations cover timed trips only', async () => {
  const { claude, requests, restore } = loadClaude({ replies: [textReply('ok')] });
  try {
    await claude.answerQueryWithClaude('user-1', 'q', [], STATS, []);
    assert.match(requests[0].system, /Durations come only from trips with a recorded end time/);
    const byName = Object.fromEntries(requests[0].tools.map((t) => [t.name, t]));
    assert.match(byName.get_average_trip_duration.description, /timed_trips/);
    assert.match(byName.get_stop_pair_stats.description, /timed_trips/);
  } finally {
    restore();
  }
});

test('answerQueryWithClaude tells the model not to infer answers the data does not hold', async () => {
  const { claude, requests, restore } = loadClaude({ replies: [textReply('ok')] });
  try {
    await claude.answerQueryWithClaude('user-1', 'q', [], STATS, []);
    assert.match(requests[0].system, /not\s+available in one short sentence/);
    assert.match(requests[0].system, /Do not estimate, guess or infer/);
  } finally {
    restore();
  }
});

test('answerQueryWithClaude returns all tool results for a turn in one user message', async () => {
  const { claude, requests, queries, restore } = loadClaude({
    tripDocs: [
      { route: '510', startStopName: 'Spadina', endStopName: 'Union', ...MARCH_1_TIMES },
      // No end time: still a trip, but not a timed one.
      { route: '504', startStopName: 'King', endStopName: 'Spadina',
        startTime: MARCH_1_TIMES.startTime, endTime: null },
    ],
    replies: [
      toolReply(['toolu_1', 'get_all_time_stats'], ['toolu_2', 'get_all_time_route_stats']),
      textReply('2 trips on 2 routes.'),
    ],
  });
  try {
    const answer = await claude.answerQueryWithClaude('user-1', 'How many trips ever?', [], STATS, []);
    assert.equal(answer, '2 trips on 2 routes.');
    assert.equal(requests.length, 2);

    const [assistantTurn, resultTurn] = requests[1].messages.slice(-2);
    assert.equal(assistantTurn.role, 'assistant');
    // The assistant turn goes back unchanged, thinking block included.
    assert.deepEqual(assistantTurn.content.map((b) => b.type), ['thinking', 'tool_use', 'tool_use']);
    assert.equal(resultTurn.role, 'user');
    assert.deepEqual(resultTurn.content.map((b) => [b.type, b.tool_use_id]), [
      ['tool_result', 'toolu_1'],
      ['tool_result', 'toolu_2'],
    ]);
    assert.deepEqual(JSON.parse(resultTurn.content[0].content),
      { totalTrips: 2, uniqueRoutes: 2, uniqueStops: 3, uniqueAgencies: 0, timedTrips: 1 });
    assert.deepEqual(JSON.parse(resultTurn.content[1].content),
      { total_trips: 2, route_count: 2, trips_without_route: 0, top_routes: [['504', 1], ['510', 1]] });

    // Account separation: every Firestore read is filtered to the asking user.
    assert.deepEqual(queries.map((query) => query.collection).sort(), ['prestoTransactions', 'trips']);
    for (const query of queries) {
      assert.deepEqual(query.wheres[0], ['userId', '==', 'user-1']);
    }
  } finally {
    restore();
  }
});

test('answerQueryWithClaude stops offering tools after three tool rounds', async () => {
  const { claude, requests, restore } = loadClaude({
    replies: [
      toolReply(['toolu_1', 'get_riding_streak']),
      toolReply(['toolu_2', 'get_riding_streak']),
      toolReply(['toolu_3', 'get_riding_streak']),
      textReply('Longest streak: 0 days.'),
    ],
  });
  try {
    const answer = await claude.answerQueryWithClaude('user-1', 'Longest streak?', [], STATS, []);
    assert.equal(answer, 'Longest streak: 0 days.');
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map((r) => r.tool_choice), [undefined, undefined, undefined, { type: 'none' }]);
  } finally {
    restore();
  }
});

test('answerQueryWithClaude reports an unknown tool back as an error result', async () => {
  const { claude, requests, restore } = loadClaude({
    replies: [toolReply(['toolu_1', 'constructor']), textReply('That is not in your trip data.')],
  });
  try {
    await claude.answerQueryWithClaude('user-1', 'q', [], STATS, []);
    const result = requests[1].messages.at(-1).content[0];
    assert.equal(result.is_error, true);
    assert.equal(result.content, 'Tool not found');
  } finally {
    restore();
  }
});

test('answerQueryWithClaude maps stored history roles and starts on a user turn', async () => {
  const { claude, requests, restore } = loadClaude({ replies: [textReply('ok')] });
  try {
    await claude.answerQueryWithClaude('user-1', 'And last week?', [], STATS, [
      { role: 'model', text: 'orphaned answer' },
      { role: 'user', text: 'How many trips this week?' },
      { role: 'model', text: '5 trips this week.' },
      { role: 'user', text: '' },
    ]);
    const messages = requests[0].messages;
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(messages[0].content, 'How many trips this week?');
    assert.equal(messages[1].content, '5 trips this week.');
  } finally {
    restore();
  }
});

test('answerQueryWithClaude says AI is unavailable when the key is missing', async () => {
  const { claude, requests, restore } = loadClaude({ apiKey: '' });
  try {
    assert.equal(await claude.answerQueryWithClaude('user-1', 'q', [], STATS, []), 'AI unavailable right now.');
    assert.equal(requests.length, 0);
  } finally {
    restore();
  }
});

test('answerQueryWithClaude sends the standard failure text on refusal, cut-off or API error', async () => {
  const { ASK_FAILED } = require('./lib/sms-text');
  const serverError = new RealAnthropic.InternalServerError(500, { type: 'error' }, 'boom', new Headers());
  const cases = [
    { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null }, content: [] },
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'You took 1,1' }] },
    textReply(''),
    serverError,
  ];
  for (const reply of cases) {
    const { claude, restore } = loadClaude({ replies: [reply] });
    try {
      assert.equal(await claude.answerQueryWithClaude('user-1', 'q', [], STATS, []), ASK_FAILED);
    } finally {
      restore();
    }
  }
});

// ---------- Agency time zone ----------

test('lookupAgencyTimezone answers known agencies from the table without calling the AI', async () => {
  const { claude, requests, restore } = loadClaude();
  try {
    assert.equal(await claude.lookupAgencyTimezone('TTC'), 'America/Toronto');
    assert.equal(await claude.lookupAgencyTimezone(null), 'America/Toronto');
    assert.equal(requests.length, 0);
  } finally {
    restore();
  }
});

test('lookupAgencyTimezone uses the Firestore cache before the AI', async () => {
  const { claude, requests, restore } = loadClaude({ cachedTimezone: 'Europe/Lisbon' });
  try {
    assert.equal(await claude.lookupAgencyTimezone('Carris Test Agency'), 'Europe/Lisbon');
    assert.equal(requests.length, 0);
  } finally {
    restore();
  }
});

test('lookupAgencyTimezone asks Haiku with structured output and caches the answer', async () => {
  const { claude, requests, requestOptions, timezoneWrites, restore } = loadClaude({
    replies: [textReply(JSON.stringify({ timezone: 'Europe/Lisbon' }))],
  });
  try {
    assert.equal(await claude.lookupAgencyTimezone('Carris Test Agency'), 'Europe/Lisbon');

    const request = requests[0];
    assert.equal(request.model, 'claude-haiku-5-5');
    assert.equal(request.output_config.effort, 'low');
    assert.deepEqual(request.output_config.format.schema.required, ['timezone']);
    assertNoRejectedParams(request);
    assert.match(request.messages[0].content, /"Carris Test Agency"/);

    assert.equal(timezoneWrites.length, 1);
    assert.equal(timezoneWrites[0].id, 'Carris Test Agency');
    assert.equal(timezoneWrites[0].data.timezone, 'Europe/Lisbon');
    assert.deepEqual(requestOptions[0], { timeout: 8000, maxRetries: 1 });
  } finally {
    restore();
  }
});

test('lookupAgencyTimezone does not use or cache a zone that is not a real IANA zone', async () => {
  for (const timezone of ['America/Torontoo', 'Mars/Olympus_Mons', 'North America/Eastern', '/']) {
    const { claude, timezoneWrites, restore } = loadClaude({
      replies: [textReply(JSON.stringify({ timezone }))],
    });
    try {
      assert.equal(await claude.lookupAgencyTimezone('Carris Test Agency'), 'America/Toronto', timezone);
      assert.equal(timezoneWrites.length, 0, timezone);
    } finally {
      restore();
    }
  }
});

test('lookupAgencyTimezone gives up on a hung call and falls back without caching', async (t) => {
  const advance = useFakeClock(t);
  const { claude, timezoneWrites, restore } = loadClaude({ replies: [{ hang: true }] });
  try {
    const pending = claude.lookupAgencyTimezone('Carris Test Agency');
    await advance(16500);
    assert.equal(await settledOr(pending), 'America/Toronto');
    assert.equal(timezoneWrites.length, 0);
  } finally {
    restore();
  }
});

test('lookupAgencyTimezone does not cache ambiguous agency names', async () => {
  const { claude, timezoneWrites, restore } = loadClaude({
    replies: [textReply(JSON.stringify({ timezone: 'America/Chicago' }))],
  });
  try {
    assert.equal(await claude.lookupAgencyTimezone('Transit'), 'America/Chicago');
    assert.equal(timezoneWrites.length, 0);
  } finally {
    restore();
  }
});

test('lookupAgencyTimezone falls back to Toronto on a bad answer, refusal, error or missing key', async () => {
  const authError = new RealAnthropic.AuthenticationError(401, { type: 'error' }, 'bad key', new Headers());
  const cases = [
    { replies: [textReply(JSON.stringify({ timezone: 'Unknown' }))] },
    { replies: [{ stop_reason: 'refusal', stop_details: { type: 'refusal', category: null }, content: [] }] },
    { replies: [{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"timezone":"Europe/Li' }] }] },
    { replies: [authError] },
    { apiKey: '' },
  ];
  for (const options of cases) {
    const { claude, timezoneWrites, restore } = loadClaude(options);
    try {
      assert.equal(await claude.lookupAgencyTimezone('Carris Test Agency'), 'America/Toronto');
      assert.equal(timezoneWrites.length, 0);
    } finally {
      restore();
    }
  }
});

test('a trip with a null start time is counted but never given a date', async () => {
  const { claude, restore } = loadClaude();
  try {
    const { tripStartDate } = require('./lib/trip-stats');
    assert.equal(tripStartDate({ startTime: null }), null);
    assert.equal(tripStartDate({}), null);
    assert.equal(tripStartDate({ startTime: 'not a date' }), null);
    assert.equal(tripStartDate({ startTime: 0 }).getTime(), 0);

    const { db } = fakeTripsDb([
      { userId: 'user-1', agency: 'TTC', route: '510', startTime: toronto('2026-09-12T09:00:00'),
        endTime: toronto('2026-09-12T09:20:00'), duration: 20 },
      { userId: 'user-1', agency: 'TTC', route: '510', startTime: null, endTime: toronto('2026-09-13T09:20:00') },
      { userId: 'user-1', discarded: true, startTime: null },
    ]);
    const tools = claude.buildQueryToolExecutors(db, 'user-1', 'America/Toronto');
    const monthly = await tools.get_monthly_trip_counts();
    assert.deepEqual(monthly,
      { by_month: { '2026-09': 1 }, by_year: { 2026: 1 }, total_trips: 3, trips_without_date: 2 });
    assert.deepEqual((await tools.get_day_of_week_stats()).by_day_of_week, { Saturday: 1 });
    assert.equal((await tools.get_riding_streak()).days_ridden, 1);
    assert.deepEqual(await tools.get_busiest_weeks(), [{ week_starting: '2026-09-07', trips: 1 }]);
    assert.equal((await tools.get_day_of_week_stats_for_year({ year: 1970 })).total_trips, 0);
    assert.equal((await tools.get_trips_for_date_range({ start_date: '1969-12-31', end_date: '1970-01-01' })).count, 0);
  } finally {
    restore();
  }
});

test('a failed all-time read is not remembered, and the read is never shared between questions', async () => {
  const { claude, restore } = loadClaude();
  try {
    const trip = { userId: 'user-1', agency: 'TTC', route: '510', startTime: toronto('2026-09-12T09:00:00'),
      endTime: toronto('2026-09-12T09:20:00'), duration: 20 };
    const { db: working, queries } = fakeTripsDb([trip]);
    let reads = 0;
    const flaky = {
      collection: (name) => {
        const chain = working.collection(name);
        const get = chain.get;
        chain.get = async () => {
          if (name !== 'trips') return get();
          reads++;
          if (reads === 1) throw new Error('UNAVAILABLE');
          return get();
        };
        return chain;
      },
    };
    const tools = claude.buildQueryToolExecutors(flaky, 'user-1', 'America/Toronto');
    // Two tools in the same turn share the one failing read.
    const failed = await Promise.allSettled([tools.get_all_time_stats(), tools.get_monthly_trip_counts()]);
    assert.deepEqual(failed.map((result) => result.status), ['rejected', 'rejected']);
    assert.equal(reads, 1);
    // The retry reads again and works; later tools reuse that read.
    assert.equal((await tools.get_all_time_stats()).totalTrips, 1);
    assert.equal((await tools.get_monthly_trip_counts()).total_trips, 1);
    assert.equal(reads, 2);

    // Another question (another rider) gets its own read, never this one's.
    const before = queries.length;
    const other = claude.buildQueryToolExecutors(working, 'user-2', 'America/Toronto');
    assert.equal((await other.get_all_time_stats()).totalTrips, 0);
    assert.equal(queries.length, before + 2);
    for (const query of queries.slice(before)) assert.deepEqual(query.wheres, [['userId', '==', 'user-2']]);
  } finally {
    restore();
  }
});

test('trips land on the right day when the clocks go forward (a 23-hour day)', async () => {
  const { claude, restore } = loadClaude();
  try {
    // Toronto, 8 March 2026: 02:00 EST jumps to 03:00 EDT.
    const at = (iso) => ({ userId: 'user-1', agency: 'TTC', route: '510', startTime: new Date(iso), endTime: null });
    const { db } = fakeTripsDb([
      at('2026-03-07T23:59:30-05:00'),
      at('2026-03-08T00:00:30-05:00'),
      at('2026-03-08T01:59:30-05:00'),
      at('2026-03-08T03:00:30-04:00'),
      at('2026-03-08T23:59:30-04:00'),
      at('2026-03-09T00:00:30-04:00'),
    ]);
    const tools = claude.buildQueryToolExecutors(db, 'user-1', 'America/Toronto');
    assert.equal((await tools.get_trips_for_date({ date: '2026-03-07' })).count, 1);
    assert.equal((await tools.get_trips_for_date({ date: '2026-03-08' })).count, 4);
    assert.equal((await tools.get_trips_for_date({ date: '2026-03-09' })).count, 1);
    assert.equal((await tools.get_trips_for_date_range({ start_date: '2026-03-07', end_date: '2026-03-08' })).count, 5);
    assert.deepEqual((await tools.get_trip_details_for_date({ date: '2026-03-08' })).trips.map((trip) => trip.time),
      ['12:00 AM', '1:59 AM', '3:00 AM', '11:59 PM']);
    // The all-time tools put the same trips on the same days.
    assert.deepEqual((await tools.get_day_of_week_stats()).by_day_of_week, { Saturday: 1, Sunday: 4, Monday: 1 });
    assert.equal((await tools.get_riding_streak()).days_ridden, 3);
  } finally {
    restore();
  }
});

test('ASK sends date and count questions to the tools, with no daily counts in the prompt', async () => {
  const { claude, requests, restore } = loadClaude({ replies: [textReply('ok')] });
  try {
    await claude.answerQueryWithClaude('user-1', 'q', [], { ...STATS, dailyCounts: { '2026-11-08': 2 } }, []);
    const prompt = requests[0].messages[requests[0].messages.length - 1].content;
    assert.doesNotMatch(prompt, /dailyCounts|Daily trip counts|2026-11-08/);
    assert.match(prompt, /CALL a tool \(get_trips_for_date, get_trips_for_date_range or get_monthly_trip_counts\)/);
    const year = requests[0].tools.find((tool) => tool.name === 'get_day_of_week_stats_for_year').input_schema;
    assert.equal(year.properties.year.type, 'integer');
  } finally {
    restore();
  }
});
