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
    tripDocs: [{ route: '510', startStopName: 'Spadina', endStopName: 'Union' }],
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
    assert.deepEqual(JSON.parse(results[2].content), [['510', 1]]);
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
      'get_all_time_route_stats', 'get_all_time_stats', 'get_all_time_stop_stats', 'get_average_trip_duration',
      'get_busiest_weeks', 'get_day_of_week_stats', 'get_day_of_week_stats_for_year', 'get_monthly_trip_counts',
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
  } finally {
    restore();
  }
});

test('answerQueryWithClaude returns all tool results for a turn in one user message', async () => {
  const { claude, requests, queries, restore } = loadClaude({
    tripDocs: [
      { route: '510', startStopName: 'Spadina', endStopName: 'Union' },
      { route: '504', startStopName: 'King', endStopName: 'Spadina' },
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
    assert.deepEqual(JSON.parse(resultTurn.content[0].content), { totalTrips: 2, uniqueRoutes: 2, uniqueStops: 3 });
    assert.deepEqual(JSON.parse(resultTurn.content[1].content), [['504', 1], ['510', 1]]);

    // Account separation: every Firestore read is filtered to the asking user.
    assert.ok(queries.length > 0);
    for (const query of queries) {
      assert.equal(query.collection, 'trips');
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
