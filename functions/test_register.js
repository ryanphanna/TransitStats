/**
 * REGISTER / verification must resolve the account through Firebase Auth,
 * never through the client-writable profile `email` field.
 * Run with: node --test test_register.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function load({ authUid = 'auth-uid', verification = null } = {}) {
  const path = require.resolve('./lib/handlers-commands');
  delete require.cache[path];
  const calls = { sms: [], phoneSets: [], profileQueries: [], authLookups: [] };

  const dbModule = {
    sendSmsReply: async () => {},
    getActiveTrip: async () => null,
    getRecentCompletedTrips: async () => [],
    setPendingState: async () => {},
    clearPendingState: async () => {},
    storeVerificationCode: async () => {},
    getVerificationData: async () => verification,
    isEmailAllowed: async () => true,
    isEmailAdmin: async () => false,
    getUserByPhone: async () => null,
    getUserProfile: async () => null,
    getAuthUidByEmail: async (email) => { calls.authLookups.push(email); return authUid; },
    FieldValue: { serverTimestamp: () => 'ts', increment: (n) => `inc${n}` },
    Timestamp: { fromDate: (d) => d },
    db: {
      collection: (name) => ({
        add: async () => {},
        doc: (id) => ({
          set: async (value) => { if (name === 'phoneNumbers') calls.phoneSets.push({ id, value }); },
          update: async () => {},
          delete: async () => {},
          get: async () => ({ exists: false }),
        }),
        where: (...args) => {
          if (name === 'profiles') calls.profileQueries.push(args);
          return { limit: () => ({ get: async () => ({ empty: false, docs: [{ id: 'PROFILE-UID' }] }) }) };
        },
      }),
    },
  };

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (parent && parent.id === path) {
      if (request === './db') return dbModule;
      if (request === './twilio') return { sendSmsReply: async (_to, message) => { calls.sms.push(message); } };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return { mod: require('./lib/handlers-commands'), calls };
  } finally {
    Module._load = originalLoad;
  }
}

test('REGISTER finds the account via Firebase Auth, not a profiles query', async () => {
  const { mod, calls } = load({ authUid: 'auth-uid' });
  await mod.handleRegister('+15192769853', 'Rider@Example.com');
  assert.equal(calls.authLookups.length, 1);
  assert.equal(calls.profileQueries.length, 0);
  assert.match(calls.sms.at(-1), /Code sent/);
});

test('REGISTER refuses when no verified Firebase Auth account has that email', async () => {
  const { mod, calls } = load({ authUid: null });
  await mod.handleRegister('+15192769853', 'rider@example.com');
  assert.match(calls.sms.at(-1), /No account found/);
});

test('verification links the phone to the Auth uid, ignoring any profile with a matching email', async () => {
  const { mod, calls } = load({
    authUid: 'auth-uid',
    verification: { code: '123456', attempts: 0, email: 'rider@example.com' },
  });
  await mod.handleVerificationCode('+15192769853', '123456');
  assert.equal(calls.profileQueries.length, 0);
  assert.equal(calls.phoneSets.length, 1);
  assert.equal(calls.phoneSets[0].value.userId, 'auth-uid');
});

test('verification does not link when the Auth account is gone or unverified', async () => {
  const { mod, calls } = load({
    authUid: null,
    verification: { code: '123456', attempts: 0, email: 'rider@example.com' },
  });
  await mod.handleVerificationCode('+15192769853', '123456');
  assert.equal(calls.phoneSets.length, 0);
  assert.match(calls.sms.at(-1), /Account not found/);
});
