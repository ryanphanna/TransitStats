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
      setDocument(collection, id, { ...(getDocument(collection, id) || {}), ...value });
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
    async runTransaction(callback) {
      await callback({
        get: reference => reference.get(),
        set: (reference, value) => reference.set(value),
      });
    },
    read(collection, id) {
      return getDocument(collection, id);
    },
  };
}

function createLogger() {
  return { warn() {}, error() {}, info() {} };
}

function createOtpHarness(seed, { isAdmin = false } = {}) {
  const db = createFakeDb(seed);
  const sentMessages = [];
  const handlers = createOtpHandlers({
    db,
    adminAuth: {
      async getUser() {},
      async createUser() {},
      async createCustomToken(uid) { return `token-${uid}`; },
    },
    async sendSmsReply(phone, message) {
      sentMessages.push({ phone, message });
      return true;
    },
    async verifyTurnstile() {
      return true;
    },
    logger: createLogger(),
  });
  return { db, handlers, sentMessages, isAdmin };
}

test('normalizePhoneNumber formats North American and international numbers as E.164', () => {
  assert.equal(normalizePhoneNumber('(519) 276-9853'), '+15192769853');
  assert.equal(normalizePhoneNumber('+442071234567'), '+442071234567');
});

test('admin OTP requests bypass cooldowns', async () => {
  const phone = '+15192769853';
  const { handlers, sentMessages } = createOtpHarness({
    [`phoneNumbers/${phone}`]: { userId: 'admin-1' },
    'profiles/admin-1': { isAdmin: true },
  });

  const first = new FakeResponse();
  const second = new FakeResponse();
  await handlers.handleRequestOtp({ body: { phoneNumber: phone } }, first, 'trace-1');
  await handlers.handleRequestOtp({ body: { phoneNumber: phone } }, second, 'trace-2');

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[0].message, /This code expires in 10 minutes\./);
});

test('regular OTP requests enforce the resend cooldown', async () => {
  const phone = '+15192769853';
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
  const phone = '+15192769853';
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

test('OTP verification returns a custom token for a valid code', async () => {
  const phone = '+15192769853';
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
    traceId: 'trace-1',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.replies, ['Trip logged.']);
});
