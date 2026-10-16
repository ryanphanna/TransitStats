const assert = require('node:assert/strict');
const test = require('node:test');
const { createOtpHandlers, normalizePhoneNumber } = require('./lib/otp');
const { createCommandHandler } = require('./lib/api-command');

class FakeResponse {
  constructor() {
    this.statusCode = 200;
    this.body = null;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(body) {
    this.body = body;
    return this;
  }
}

function createFakeDb(seed = {}) {
  const data = new Map(Object.entries(seed));
  const getDocument = (collection, id) => data.get(`${collection}/${id}`) || null;
  const setDocument = (collection, id, value) => data.set(`${collection}/${id}`, value);
  const ref = (collection, id) => ({
    async get() {
      const value = getDocument(collection, id);
      return { exists: Boolean(value), data: () => value };
    },
    async set(value, options = {}) {
      const current = getDocument(collection, id) || {};
      setDocument(collection, id, options.merge ? { ...current, ...value } : value);
    },
    async update(value) {
      const current = getDocument(collection, id) || {};
      const next = { ...current };
      for (const [key, change] of Object.entries(value)) {
        next[key] = change?.constructor?.name === 'NumericIncrementTransform'
          ? Number(current[key] || 0) + change.operand
          : change;
      }
      setDocument(collection, id, next);
    },
    async delete() {
      data.delete(`${collection}/${id}`);
    },
  });

  return {
    collection(collection) {
      return {
        doc(id) {
          return ref(collection, id);
        },
        where(field, operator, value) {
          assert.equal(operator, '==');
          return {
            limit() {
              return {
                async get() {
                  const docs = [...data.entries()]
                    .filter(([key, item]) => key.startsWith(`${collection}/`)
                      && item?.[field] === value)
                    .map(([key, item]) => ({ id: key.split('/').slice(1).join('/'), data: () => item }));
                  return { empty: docs.length === 0, docs };
                },
              };
            },
          };
        },
      };
    },
    // Transactions run one at a time, like Firestore resolving contention by
    // retrying: each sees the previous one's committed writes.
    _txQueue: Promise.resolve(),
    runTransaction(callback) {
      const run = this._txQueue.then(async () => {
        const writes = [];
        const result = await callback({
          get: reference => reference.get(),
          set: (reference, value) => { writes.push(() => reference.set(value)); },
          update: (reference, value) => { writes.push(async () => {
            const current = (await reference.get()).data() || {};
            const next = { ...current };
            for (const [key, change] of Object.entries(value)) {
              next[key] = change?.constructor?.name === 'NumericIncrementTransform'
                ? Number(current[key] || 0) + change.operand
                : change;
            }
            await reference.set(next);
          }); },
          delete: reference => { writes.push(() => reference.delete()); },
        });
        for (const write of writes) await write();
        return result;
      });
      this._txQueue = run.catch(() => {});
      return run;
    },
    read(collection, id) {
      return getDocument(collection, id);
    },
  };
}

function createLogger() {
  return { warn() {}, error() {}, info() {} };
}

function createOtpHarness(seed, {
  isAdmin = false,
  turnstileResult = { success: true, reason: 'ok' },
  turnstileMode = 'enforce',
  logged = [],
  smsResult = true,
} = {}) {
  const db = createFakeDb(seed);
  const sentMessages = [];
  const turnstileCalls = [];
  const handlers = createOtpHandlers({
    db,
    adminAuth: {
      async getUser() {},
      async createUser() {},
      async createCustomToken(uid) { return `token-${uid}`; },
    },
    async sendSmsReply(phone, message) {
      sentMessages.push({ phone, message });
      return smsResult;
    },
    async verifyTurnstile(token, remoteIp) {
      turnstileCalls.push({ token, remoteIp });
      return turnstileResult;
    },
    async getTurnstileMode() {
      return turnstileMode;
    },
    logger: {
      warn: message => logged.push(message),
      error: message => logged.push(message),
      info: message => logged.push(message),
    },
  });
  return { db, handlers, sentMessages, isAdmin, turnstileCalls, logged };
}

test('normalizePhoneNumber formats North American and international numbers as E.164', () => {
  assert.equal(normalizePhoneNumber('(519) 555-0143'), '+15195550143');
  assert.equal(normalizePhoneNumber('+442071234567'), '+442071234567');
});

test('admin phone gets no special treatment: cooldown applies and the response hides admin status', async () => {
  const phone = '+15195550143';
  const { handlers, sentMessages } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'admin-1' },
    'profiles/admin-1': { isAdmin: true },
  });

  const first = new FakeResponse();
  const second = new FakeResponse();
  await handlers.handleRequestOtp({ body: { phoneNumber: phone } }, first, 'trace-1');
  await handlers.handleRequestOtp({ body: { phoneNumber: phone } }, second, 'trace-2');

  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body, { success: true });
  assert.equal(second.statusCode, 429);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].message, /This code expires in 10 minutes\./);
});

test('regular OTP requests enforce the resend cooldown', async () => {
  const phone = '+15195550143';
  const { handlers, sentMessages } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'user-1' },
    'profiles/user-1': { isAdmin: false },
  });

  const first = new FakeResponse();
  const second = new FakeResponse();
  await handlers.handleRequestOtp({ body: { phoneNumber: phone } }, first, 'trace-1');
  await handlers.handleRequestOtp({ body: { phoneNumber: phone } }, second, 'trace-2');

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 429);
  assert.equal(sentMessages.length, 1);
});

test('regular OTP requests enforce the rolling daily limit', async () => {
  const phone = '+15195550143';
  const now = Date.now();
  const { handlers, sentMessages } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'user-1' },
    'profiles/user-1': { isAdmin: false },
    [`phoneLoginOtpLimits/${phone}`]: { sentAt: [now, now, now, now, now] },
  });

  const response = new FakeResponse();
  await handlers.handleRequestOtp({ body: { phoneNumber: phone } }, response, 'trace-1');

  assert.equal(response.statusCode, 429);
  assert.match(response.body.error, /Daily text limit/);
  assert.equal(sentMessages.length, 0);
});

function otpReq(phone, forwardedFor) {
  return { body: { phoneNumber: phone }, headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} };
}

function registeredPhones(count) {
  const seed = {};
  const phones = [];
  for (let i = 0; i < count; i += 1) {
    const phone = `+1519276${String(1000 + i)}`;
    phones.push(phone);
    seed[`phoneNumbers/${phone}`] = { userId: `user-${i}` };
    seed[`profiles/user-${i}`] = { isAdmin: false };
  }
  return { seed, phones };
}

test('OTP requests are limited per source IP across different phone numbers', async () => {
  const { seed, phones } = registeredPhones(11);
  const { handlers, sentMessages } = createOtpHarness(seed);

  const results = [];
  for (const phone of phones) {
    const response = new FakeResponse();
    await handlers.handleRequestOtp(otpReq(phone, '203.0.113.9'), response, 'trace');
    results.push(response.statusCode);
  }

  assert.deepEqual(results.slice(0, 10), Array(10).fill(200));
  assert.equal(results[10], 429);
  assert.equal(sentMessages.length, 10);
});

test('per-IP limit keys on the last X-Forwarded-For entry, not a spoofed first one', async () => {
  const { seed, phones } = registeredPhones(11);
  const { handlers, sentMessages } = createOtpHarness(seed);

  const results = [];
  for (const [i, phone] of phones.entries()) {
    const response = new FakeResponse();
    await handlers.handleRequestOtp(otpReq(phone, `198.51.100.${i}, 203.0.113.9`), response, 'trace');
    results.push(response.statusCode);
  }

  assert.equal(results[10], 429);
  assert.equal(sentMessages.length, 10);
});

test('a different IP is not affected by another IP hitting its limit', async () => {
  const { seed, phones } = registeredPhones(11);
  const { handlers } = createOtpHarness(seed);

  for (const phone of phones.slice(0, 10)) {
    await handlers.handleRequestOtp(otpReq(phone, '203.0.113.9'), new FakeResponse(), 'trace');
  }
  const response = new FakeResponse();
  await handlers.handleRequestOtp(otpReq(phones[10], '203.0.113.10'), response, 'trace');
  assert.equal(response.statusCode, 200);
});

test('global daily send cap blocks further sends and logs an error', async () => {
  const phone = '+15195550143';
  const day = new Date().toISOString().slice(0, 10);
  const db = createFakeDb({
    [`phoneNumbers/${phone}`]: { userId: 'user-1' },
    'profiles/user-1': { isAdmin: false },
    [`phoneLoginGlobalLimits/${day}`]: { count: 200 },
  });
  const logged = [];
  const sentMessages = [];
  const handlers = createOtpHandlers({
    db,
    adminAuth: {},
    async sendSmsReply(to, message) { sentMessages.push({ to, message }); return true; },
    async verifyTurnstile() { return { success: true, reason: 'ok' }; },
    async getTurnstileMode() { return 'enforce'; },
    logger: { warn() {}, info() {}, error: (message) => logged.push(message) },
  });

  const response = new FakeResponse();
  await handlers.handleRequestOtp(otpReq(phone, '203.0.113.9'), response, 'trace');

  assert.equal(response.statusCode, 429);
  assert.equal(sentMessages.length, 0);
  assert.ok(logged.some(message => /shared daily send cap/.test(message)));
});

test('admin phone is subject to the per-IP and global caps', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const phone = '+15195550143';
  const { handlers, sentMessages } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'admin-1' },
    'profiles/admin-1': { isAdmin: true },
    [`phoneLoginGlobalLimits/${day}`]: { count: 200 },
  });

  const response = new FakeResponse();
  await handlers.handleRequestOtp(otpReq(phone, '203.0.113.9'), response, 'trace');
  assert.equal(response.statusCode, 429);
  assert.equal(sentMessages.length, 0);
});

test('OTP verification returns a custom token for a valid code', async () => {
  const phone = '+15195550143';
  const { db, handlers } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'user-1' },
    [`phoneLoginVerification/${phone}`]: {
      code: '123456',
      attempts: 0,
      expiresAt: { toDate: () => new Date(Date.now() + 60000) },
    },
  });

  const response = new FakeResponse();
  await handlers.handleVerifyOtp({ body: { phoneNumber: phone, code: '123456' } }, response, 'trace-1');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.token, 'token-user-1');
  assert.equal(db.read(`phoneLoginVerification`, phone), null);
});

test('parallel wrong guesses cannot exceed the 3-attempt limit, and a correct code is single-use', async () => {
  const phone = '+15195550143';
  const seed = () => ({
    [`phoneNumbers/${phone}`]: { userId: 'user-1' },
    [`phoneLoginVerification/${phone}`]: {
      code: '123456',
      attempts: 0,
      expiresAt: { toDate: () => new Date(Date.now() + 60000) },
    },
  });

  const { handlers } = createOtpHarness(seed());
  const guesses = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const response = new FakeResponse();
    await handlers.handleVerifyOtp({ body: { phoneNumber: phone, code: String(100000 + i) } }, response, `t${i}`);
    return response;
  }));
  assert.equal(guesses.filter(r => r.body.error === 'Invalid verification code.').length, 3);
  assert.ok(guesses.every(r => r.statusCode === 400 && !r.body.token));

  // After lockout the right code no longer works.
  const late = new FakeResponse();
  await handlers.handleVerifyOtp({ body: { phoneNumber: phone, code: '123456' }, headers: {} }, late, 'late');
  assert.equal(late.statusCode, 400);
  assert.equal(late.body.token, undefined);

  // Two simultaneous correct submissions: exactly one gets a token.
  const second = createOtpHarness(seed());
  const both = await Promise.all([0, 1].map(async () => {
    const response = new FakeResponse();
    await second.handlers.handleVerifyOtp({ body: { phoneNumber: phone, code: '123456' } }, response, 't');
    return response;
  }));
  assert.equal(both.filter(r => r.statusCode === 200).length, 1);
});

test('phone login sends no code for a text-provisioned link that is not yet confirmed', async () => {
  const phone = '+15195550143';
  const { handlers, sentMessages } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'user-1', loginConfirmed: false },
    'profiles/user-1': { isAdmin: false },
  });
  const request = new FakeResponse();
  await handlers.handleRequestOtp({ body: { phoneNumber: phone }, headers: {} }, request, 't1');
  // Same answer as a registered number, but nothing is sent.
  assert.equal(request.statusCode, 200);
  assert.deepEqual(request.body, { success: true });
  assert.equal(sentMessages.length, 0);

  const { handlers: confirmed, sentMessages: sent } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'user-1', loginConfirmed: true },
    'profiles/user-1': { isAdmin: false },
  });
  const ok = new FakeResponse();
  await confirmed.handleRequestOtp({ body: { phoneNumber: phone }, headers: {} }, ok, 't2');
  assert.equal(ok.statusCode, 200);
  assert.equal(sent.length, 1);
});

test('request_otp answers an unregistered number exactly like a registered one', async () => {
  const known = '+15195550143';
  const unknown = '+15195550142';
  const { handlers, sentMessages } = createOtpHarness({
    [`phoneNumbers/${known}`]: { userId: 'user-1' },
  });
  const a = new FakeResponse();
  const b = new FakeResponse();
  await handlers.handleRequestOtp({ body: { phoneNumber: known }, headers: {} }, a, 't1');
  await handlers.handleRequestOtp({ body: { phoneNumber: unknown }, headers: {} }, b, 't2');
  assert.equal(b.statusCode, a.statusCode);
  assert.deepEqual(b.body, a.body);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].phone, known);

  // The decoy can never be redeemed, whatever code is guessed.
  const guess = new FakeResponse();
  await handlers.handleVerifyOtp({ body: { phoneNumber: unknown, code: '123456' } }, guess, 't3');
  assert.equal(guess.statusCode, 400);
  assert.equal(guess.body.token, undefined);
});

test('verifying a code is also refused for an unconfirmed link', async () => {
  const phone = '+15195550143';
  const { handlers } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'user-1', loginConfirmed: false },
    [`phoneLoginVerification/${phone}`]: {
      code: '123456', attempts: 0, expiresAt: { toDate: () => new Date(Date.now() + 60000) },
    },
  });
  const response = new FakeResponse();
  await handlers.handleVerifyOtp({ body: { phoneNumber: phone, code: '123456' } }, response, 't');
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.token, undefined);
});

test('authenticated command dispatch returns captured replies', async () => {
  const db = createFakeDb({
    'allowedUsers/test@example.com': { isAdmin: false },
    'phoneNumbers/phone-1': { userId: 'user-1' },
  });
  const contextStorage = { async run(context, callback) { this.context = context; await callback(); } };
  const response = new FakeResponse();
  const handler = createCommandHandler({
    db,
    apiContextStorage: contextStorage,
    generateTraceId: () => 'mock',
    logger: createLogger(),
    async dispatch() { contextStorage.context.replies.push('Trip logged.'); },
  });

  await handler({ body: { command: '506 College' } }, response, {
    uid: 'user-1',
    email: 'test@example.com',
    emailVerified: true,
    traceId: 'trace-1',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.replies, ['Trip logged.']);
});

test('the API acts as the verified owner under its own web: identity, never as a phone', async () => {
  const seed = {
    'allowedUsers/test@example.com': { isAdmin: false },
    'phoneNumbers/+15195550143': { userId: 'user-1', loginConfirmed: false },
  };
  const calls = [];
  const build = () => createCommandHandler({
    db: createFakeDb(seed),
    apiContextStorage: { async run(context, callback) { await callback(); } },
    generateTraceId: () => 'mock',
    logger: createLogger(),
    async dispatch(phone, command, sid, media) { calls.push({ phone, command, media }); },
  });

  const ok = new FakeResponse();
  await build()({ body: { command: 'STATS' } }, ok, { uid: 'user-1', email: 'test@example.com', emailVerified: true, traceId: 't' });
  assert.equal(ok.statusCode, 200);
  assert.equal(calls[0].phone, 'web:user-1');
  assert.deepEqual(calls[0].media.apiOwner, { userId: 'user-1', email: 'test@example.com' });

  for (const emailVerified of [false, undefined]) {
    const refused = new FakeResponse();
    await build()({ body: { command: 'STATS' } }, refused, { uid: 'user-1', email: 'test@example.com', emailVerified, traceId: 't' });
    assert.equal(refused.statusCode, 403);
  }
  assert.equal(calls.length, 1);
});

test('decoy OTP requests do not use the global send cap but do use the per-IP limit', async () => {
  const ip = '203.0.113.9';
  const { db, handlers, sentMessages } = createOtpHarness({});
  for (const phone of ['+15195550101', '+15195550102']) {
    const res = new FakeResponse();
    await handlers.handleRequestOtp({ body: { phoneNumber: phone }, headers: { 'x-forwarded-for': ip } }, res, 't');
    assert.equal(res.statusCode, 200);
  }
  assert.equal(sentMessages.length, 0);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(db.read('phoneLoginGlobalLimits', day), null);
  const ipKey = require('node:crypto').createHash('sha256').update(ip).digest('hex').slice(0, 32);
  assert.equal(db.read('phoneLoginIpLimits', ipKey).sentAt.length, 2);
});

// --- Turnstile bot check on request_otp (#257) ---

const { verifyTurnstile, createTurnstileModeReader, TURNSTILE_ACTION } = require('./lib/turnstile');

function turnstileReq(phone, token) {
  return { body: { phoneNumber: phone, turnstileToken: token }, headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' } };
}

function noLimitDocsWritten(db, phone) {
  return !db.read('phoneLoginOtpLimits', phone)
    && !db.read('phoneLoginVerification', phone)
    && !db.read('phoneLoginGlobalLimits', new Date().toISOString().slice(0, 10));
}

for (const reason of ['missing_token', 'rejected:invalid-input-response', 'hostname:evil.example', 'siteverify_unreachable']) {
  test(`enforce mode blocks request_otp when Turnstile fails (${reason}) before any limit or send`, async () => {
    const phone = '+15195550143';
    const { db, handlers, sentMessages } = createOtpHarness({
      [`phoneNumbers/${phone}`]: { userId: 'user-1' },
    }, { turnstileResult: { success: false, reason }, turnstileMode: 'enforce' });

    const response = new FakeResponse();
    await handlers.handleRequestOtp(turnstileReq(phone, 'tok'), response, 'trace');

    assert.equal(response.statusCode, 403);
    assert.match(response.body.error, /Security check failed/);
    assert.equal(sentMessages.length, 0);
    assert.ok(noLimitDocsWritten(db, phone));
  });
}

test('enforce mode gives a registered and an unregistered number the same blocked answer', async () => {
  const known = '+15195550143';
  const { handlers } = createOtpHarness({
    [`phoneNumbers/${known}`]: { userId: 'user-1' },
  }, { turnstileResult: { success: false, reason: 'missing_token' } });
  const a = new FakeResponse();
  const b = new FakeResponse();
  await handlers.handleRequestOtp(turnstileReq(known, ''), a, 't1');
  await handlers.handleRequestOtp(turnstileReq('+15195550142', ''), b, 't2');
  assert.equal(a.statusCode, b.statusCode);
  assert.deepEqual(a.body, b.body);
});

test('monitor mode logs a failed Turnstile check but still sends the code', async () => {
  const phone = '+15195550143';
  const logged = [];
  const { handlers, sentMessages } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'user-1' },
  }, { turnstileResult: { success: false, reason: 'missing_token' }, turnstileMode: 'monitor', logged });

  const response = new FakeResponse();
  await handlers.handleRequestOtp(turnstileReq(phone, ''), response, 'trace');

  assert.equal(response.statusCode, 200);
  assert.equal(sentMessages.length, 1);
  assert.ok(logged.some(message => /\(missing_token, origin none\); monitor mode/.test(message)));
});

test('a passing Turnstile check sends the code and verifies with the trusted client IP', async () => {
  const phone = '+15195550143';
  const { handlers, sentMessages, turnstileCalls } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'user-1' },
  });
  const response = new FakeResponse();
  await handlers.handleRequestOtp(turnstileReq(phone, 'good-token'), response, 'trace');
  assert.equal(response.statusCode, 200);
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(turnstileCalls, [{ token: 'good-token', remoteIp: '203.0.113.9' }]);
});

function fakeFetch(payload, { fail = false } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(init.body) });
    if (fail) throw new Error('network down');
    return { json: async () => payload };
  };
  return { impl, calls };
}

test('verifyTurnstile accepts a valid token for a production hostname and the OTP action', async () => {
  const { impl, calls } = fakeFetch({ success: true, hostname: 'transitstats.fyi', action: TURNSTILE_ACTION });
  const result = await verifyTurnstile('tok', '203.0.113.9', { fetchImpl: impl, secret: 's' });
  assert.deepEqual(result, { success: true, reason: 'ok' });
  assert.deepEqual(calls[0].body, { secret: 's', response: 'tok', remoteip: '203.0.113.9' });
});

test('verifyTurnstile rejects missing tokens without calling Cloudflare', async () => {
  const { impl, calls } = fakeFetch({ success: true });
  assert.equal((await verifyTurnstile('', '1.2.3.4', { fetchImpl: impl, secret: 's' })).reason, 'missing_token');
  assert.equal((await verifyTurnstile(undefined, '1.2.3.4', { fetchImpl: impl, secret: 's' })).reason, 'missing_token');
  assert.equal(calls.length, 0);
});

test('verifyTurnstile rejects Cloudflare failures, wrong hostnames, wrong actions and network errors', async () => {
  const cases = [
    [{ success: false, 'error-codes': ['invalid-input-response'] }, 'rejected:invalid-input-response'],
    [{ success: true, hostname: 'evil.example', action: TURNSTILE_ACTION }, 'hostname:evil.example'],
    [{ success: true, hostname: 'example.com', action: TURNSTILE_ACTION }, 'hostname:example.com'],
    [{ success: true, hostname: 'transitstats.fyi', action: 'other' }, 'action:other'],
    [{ success: true, hostname: 'transitstats.fyi' }, 'action:undefined'],
  ];
  for (const [payload, reason] of cases) {
    const { impl } = fakeFetch(payload);
    assert.deepEqual(await verifyTurnstile('tok', '1.2.3.4', { fetchImpl: impl, secret: 's' }), { success: false, reason });
  }
  const { impl } = fakeFetch(null, { fail: true });
  assert.deepEqual(await verifyTurnstile('tok', '1.2.3.4', { fetchImpl: impl, secret: 's' }),
    { success: false, reason: 'siteverify_unreachable' });
});

test('Turnstile mode defaults to enforce; only an exact "monitor" relaxes it; keeps the last mode on read errors', async () => {
  let doc = null;
  let fail = false;
  let clock = 0;
  const db = { collection: () => ({ doc: () => ({ async get() {
    if (fail) throw new Error('unavailable');
    return { exists: Boolean(doc), data: () => doc };
  } }) }) };
  const read = createTurnstileModeReader(db, { now: () => clock });

  assert.equal(await read(), 'enforce');            // missing doc
  doc = { mode: 'monitor' };
  clock += 31000;
  assert.equal(await read(), 'monitor');            // exact value relaxes
  fail = true;
  clock += 31000;
  assert.equal(await read(), 'monitor');            // read error keeps last known
  fail = false;
  for (const bad of ['garbage', 'Monitor', 'monitor ', 'MONITOR', '', null, 7, undefined]) {
    doc = { mode: bad };
    clock += 31000;
    assert.equal(await read(), 'enforce', `mode ${JSON.stringify(bad)} must enforce`);
  }
  doc = { other: true };                            // doc without a mode field
  clock += 31000;
  assert.equal(await read(), 'enforce');
});

test('Turnstile mode enforces when config is unreadable on a cold instance, and retries next call', async () => {
  let fail = true;
  let clock = 0;
  const db = { collection: () => ({ doc: () => ({ async get() {
    if (fail) throw new Error('unavailable');
    return { exists: true, data: () => ({ mode: 'monitor' }) };
  } }) }) };
  const read = createTurnstileModeReader(db, { now: () => clock });
  assert.equal(await read(), 'enforce');
  fail = false;
  assert.equal(await read(), 'monitor');            // the failed read wasn't cached
});

// --- Shared vs reserved daily text cap (CIV-275) ---

const { Timestamp: AdminTimestamp } = require('firebase-admin/firestore');
const {
  OTP_GLOBAL_SHARED_LIMIT,
  OTP_GLOBAL_RESERVE_LIMIT,
  OTP_GLOBAL_DAILY_LIMIT,
} = require('./lib/otp');

const DAY_MS = 24 * 60 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);

function capSeed({ count = OTP_GLOBAL_SHARED_LIMIT, reserveCount = 0, phones = {} } = {}) {
  const seed = { [`phoneLoginGlobalLimits/${today()}`]: { count, reserveCount } };
  for (const [phone, lastVerifiedDaysAgo] of Object.entries(phones)) {
    seed[`phoneNumbers/${phone}`] = { userId: `user-${phone}` };
    if (lastVerifiedDaysAgo !== null) {
      seed[`phoneLoginActivity/${phone}`] = {
        lastVerifiedAt: AdminTimestamp.fromMillis(Date.now() - lastVerifiedDaysAgo * DAY_MS),
      };
    }
  }
  return seed;
}

test('the daily cap stays 200 in total: 150 shared plus a 50 reserve', () => {
  assert.equal(OTP_GLOBAL_SHARED_LIMIT, 150);
  assert.equal(OTP_GLOBAL_RESERVE_LIMIT, 50);
  assert.equal(OTP_GLOBAL_DAILY_LIMIT, 200);
});

test('below the shared cap, sends count against the shared part only', async () => {
  const phone = '+15195550143';
  const { db, handlers, sentMessages } = createOtpHarness(capSeed({ count: 10, phones: { [phone]: null } }));
  const response = new FakeResponse();
  await handlers.handleRequestOtp(otpReq(phone, '203.0.113.9'), response, 't');
  assert.equal(response.statusCode, 200);
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(
    { count: db.read('phoneLoginGlobalLimits', today()).count, reserveCount: db.read('phoneLoginGlobalLimits', today()).reserveCount },
    { count: 11, reserveCount: 0 },
  );
});

test('when the shared cap is full, a number that signed in recently still gets a code from the reserve', async () => {
  const active = '+15195550143';
  const logged = [];
  const { db, handlers, sentMessages } = createOtpHarness(capSeed({ phones: { [active]: 3 } }), { logged });
  const response = new FakeResponse();
  await handlers.handleRequestOtp(otpReq(active, '203.0.113.9'), response, 't');
  assert.equal(response.statusCode, 200);
  assert.equal(sentMessages.length, 1);
  const global = db.read('phoneLoginGlobalLimits', today());
  assert.equal(global.count, OTP_GLOBAL_SHARED_LIMIT);
  assert.equal(global.reserveCount, 1);
  assert.ok(logged.some(message => /shared daily send cap/.test(message)));
});

test('when the shared cap is full, inactive, stale and unregistered numbers all get the same blocked answer', async () => {
  const inactive = '+15195550143';
  const stale = '+15195550144';
  const unregistered = '+15195550145';
  const { handlers, sentMessages } = createOtpHarness(capSeed({ phones: { [inactive]: null, [stale]: 31 } }));
  const answers = [];
  for (const [i, phone] of [inactive, stale, unregistered].entries()) {
    const response = new FakeResponse();
    await handlers.handleRequestOtp(otpReq(phone, `203.0.113.${i + 1}`), response, 't');
    answers.push({ status: response.statusCode, body: response.body });
  }
  assert.equal(answers[0].status, 429);
  assert.match(answers[0].body.error, /temporarily unavailable/);
  assert.deepEqual(answers[1], answers[0]);
  assert.deepEqual(answers[2], answers[0]);
  assert.equal(sentMessages.length, 0);
});

test('a full reserve blocks recently active numbers too, so the total never passes 200', async () => {
  const active = '+15195550143';
  const { db, handlers, sentMessages } = createOtpHarness(
    capSeed({ reserveCount: OTP_GLOBAL_RESERVE_LIMIT, phones: { [active]: 1 } }),
  );
  const response = new FakeResponse();
  await handlers.handleRequestOtp(otpReq(active, '203.0.113.9'), response, 't');
  assert.equal(response.statusCode, 429);
  assert.equal(sentMessages.length, 0);
  const global = db.read('phoneLoginGlobalLimits', today());
  assert.equal(global.count + global.reserveCount, OTP_GLOBAL_DAILY_LIMIT);
});

test('many recently active numbers can fill the reserve exactly, never past it', async () => {
  const phones = {};
  for (let i = 0; i < 12; i += 1) phones[`+1519555${String(1000 + i)}`] = 1;
  const { db, handlers } = createOtpHarness(capSeed({ phones }));
  let sent = 0;
  for (const [i, phone] of Object.keys(phones).entries()) {
    for (let n = 0; n < 5; n += 1) {
      // Clear the 60s resend wait between attempts.
      db.collection('phoneLoginVerification').doc(phone).delete();
      const response = new FakeResponse();
      await handlers.handleRequestOtp(otpReq(phone, `198.51.${i}.${n}`), response, 't');
      if (response.statusCode === 200) sent += 1;
    }
  }
  assert.equal(sent, OTP_GLOBAL_RESERVE_LIMIT);
  assert.equal(db.read('phoneLoginGlobalLimits', today()).reserveCount, OTP_GLOBAL_RESERVE_LIMIT);
});

test('a failed Twilio send gives the slot back to the part it came from', async () => {
  const active = '+15195550143';
  const fromReserve = createOtpHarness(capSeed({ phones: { [active]: 1 } }), { smsResult: false });
  await fromReserve.handlers.handleRequestOtp(otpReq(active, '203.0.113.9'), new FakeResponse(), 't');
  assert.deepEqual(
    [fromReserve.db.read('phoneLoginGlobalLimits', today()).count, fromReserve.db.read('phoneLoginGlobalLimits', today()).reserveCount],
    [OTP_GLOBAL_SHARED_LIMIT, 0],
  );

  const fromShared = createOtpHarness(capSeed({ count: 10, phones: { [active]: null } }), { smsResult: false });
  await fromShared.handlers.handleRequestOtp(otpReq(active, '203.0.113.9'), new FakeResponse(), 't');
  assert.deepEqual(
    [fromShared.db.read('phoneLoginGlobalLimits', today()).count, fromShared.db.read('phoneLoginGlobalLimits', today()).reserveCount],
    [10, 0],
  );
});

test('a successful code sign-in records recent activity; a wrong code does not', async () => {
  const phone = '+15195550143';
  const { db, handlers } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'user-1' },
    [`phoneLoginVerification/${phone}`]: {
      code: '123456',
      attempts: 0,
      expiresAt: AdminTimestamp.fromMillis(Date.now() + 60000),
    },
  });

  const wrong = new FakeResponse();
  await handlers.handleVerifyOtp({ body: { phoneNumber: phone, code: '000000' } }, wrong, 't1');
  assert.equal(wrong.statusCode, 400);
  assert.equal(db.read('phoneLoginActivity', phone), null);

  const right = new FakeResponse();
  const before = Date.now();
  await handlers.handleVerifyOtp({ body: { phoneNumber: phone, code: '123456' } }, right, 't2');
  assert.equal(right.statusCode, 200);
  assert.ok(db.read('phoneLoginActivity', phone).lastVerifiedAt.toMillis() >= before);
});

test('a failure to record sign-in activity does not block the sign-in', async () => {
  const phone = '+15195550143';
  const { db, handlers } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'user-1' },
    [`phoneLoginVerification/${phone}`]: {
      code: '123456',
      attempts: 0,
      expiresAt: AdminTimestamp.fromMillis(Date.now() + 60000),
    },
  });
  const original = db.collection.bind(db);
  db.collection = name => {
    const col = original(name);
    if (name !== 'phoneLoginActivity') return col;
    return { doc: id => ({ ...col.doc(id), set: async () => { throw new Error('write failed'); } }) };
  };
  const response = new FakeResponse();
  await handlers.handleVerifyOtp({ body: { phoneNumber: phone, code: '123456' } }, response, 't');
  assert.equal(response.statusCode, 200);
  assert.ok(response.body.token);
});

test('a retried transaction starts its outcome flags fresh, so the refund and answer match the final attempt', async () => {
  const active = '+15195550143';
  const { db, handlers, sentMessages } = createOtpHarness(
    capSeed({ count: OTP_GLOBAL_SHARED_LIMIT - 1, phones: { [active]: 1 } }),
    { smsResult: false },
  );
  // The discarded first attempt sees the shared part full and would use the
  // reserve; on the retry the shared part has room. Everything after the
  // transaction must follow the retry, not the discarded attempt.
  const realRun = db.runTransaction.bind(db);
  db.runTransaction = async callback => {
    const globalDoc = db.collection('phoneLoginGlobalLimits').doc(today());
    await globalDoc.set({ count: OTP_GLOBAL_SHARED_LIMIT, reserveCount: OTP_GLOBAL_RESERVE_LIMIT });
    await callback({ get: ref => ref.get(), set() {}, update() {}, delete() {} }); // discarded attempt
    await globalDoc.set({ count: OTP_GLOBAL_SHARED_LIMIT - 1, reserveCount: 0 });
    return realRun(callback);
  };

  const response = new FakeResponse();
  await handlers.handleRequestOtp(otpReq(active, '203.0.113.9'), response, 't');

  // The retry used a shared slot; the failed send refunds that same slot.
  assert.equal(sentMessages.length, 1);
  assert.equal(response.statusCode, 500);
  const global = db.read('phoneLoginGlobalLimits', today());
  assert.equal(global.count, OTP_GLOBAL_SHARED_LIMIT - 1);
  assert.equal(global.reserveCount, 0);
});

test('a retried transaction does not keep a stale block from a discarded attempt', async () => {
  const active = '+15195550143';
  const { db, handlers, sentMessages } = createOtpHarness(capSeed({ phones: { [active]: 1 } }));
  const realRun = db.runTransaction.bind(db);
  db.runTransaction = async callback => {
    const globalDoc = db.collection('phoneLoginGlobalLimits').doc(today());
    await globalDoc.set({ count: OTP_GLOBAL_SHARED_LIMIT, reserveCount: OTP_GLOBAL_RESERVE_LIMIT });
    await callback({ get: ref => ref.get(), set() {}, update() {}, delete() {} }); // blocked attempt
    await globalDoc.set({ count: 10, reserveCount: 0 });
    return realRun(callback);
  };

  const response = new FakeResponse();
  await handlers.handleRequestOtp(otpReq(active, '203.0.113.9'), response, 't');
  assert.equal(response.statusCode, 200);
  assert.equal(sentMessages.length, 1);
  assert.equal(db.read('phoneLoginGlobalLimits', today()).count, 11);
});
