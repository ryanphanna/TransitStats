const assert = require('node:assert/strict');
const test = require('node:test');
const { createQuickCodeHandler } = require('./lib/api-quick-code');

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
    async set(value) {
      setDocument(collection, id, value);
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
                    .filter(([key, item]) => key.startsWith(`${collection}/`) && item?.[field] === value)
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
      return callback({
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

test('handleGenerateSmsQuickCode: rejects when a phone is already linked, even with no email', async () => {
  const db = createFakeDb({ 'phoneNumbers/+14165550000': { userId: 'u1' } });
  const handle = createQuickCodeHandler({
    db, Timestamp: { fromDate: d => ({ toDate: () => d }) }, logger: createLogger(), getTwilioPhoneNumber: () => '+19998887777',
  });
  const res = new FakeResponse();

  await handle({}, res, { uid: 'u1', email: '', traceId: 't1' });

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /already linked/i);
});

test('handleGenerateSmsQuickCode: rejects an unwhitelisted email', async () => {
  const db = createFakeDb({});
  const handle = createQuickCodeHandler({
    db, Timestamp: { fromDate: d => ({ toDate: () => d }) }, logger: createLogger(), getTwilioPhoneNumber: () => '+19998887777',
  });
  const res = new FakeResponse();

  await handle({}, res, { uid: 'u2', email: 'nobody@example.com', traceId: 't2' });

  assert.equal(res.statusCode, 403);
});

test('handleGenerateSmsQuickCode: mints a code and returns the SMS number for a whitelisted, unlinked account', async () => {
  const db = createFakeDb({ 'allowedUsers/rider@example.com': { isAdmin: false } });
  const handle = createQuickCodeHandler({
    db, Timestamp: { fromDate: d => ({ toDate: () => d }) }, logger: createLogger(), getTwilioPhoneNumber: () => '+19998887777',
  });
  const res = new FakeResponse();

  await handle({}, res, { uid: 'u3', email: 'rider@example.com', traceId: 't3' });

  assert.equal(res.statusCode, 200);
  assert.match(res.body.code, /^\d{6}$/);
  assert.equal(res.body.smsNumber, '+19998887777');
  assert.equal(res.body.expiresInSeconds, 600);

  const stored = db.read('smsQuickCodes', res.body.code);
  assert.equal(stored.userId, 'u3');
  assert.equal(stored.email, 'rider@example.com');
});
