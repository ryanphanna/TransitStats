/**
 * REGISTER / verification must resolve the account through Firebase Auth,
 * never through the client-writable profile `email` field.
 * Run with: node --test test_register.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { FieldValue: realFieldValue } = require('firebase-admin/firestore');

function load({ authUid = 'auth-uid', verification = null } = {}) {
  const path = require.resolve('./lib/handlers-commands');
  delete require.cache[path];
  const calls = { sms: [], phoneSets: [], profileQueries: [], authLookups: [] };
  const store = { verification: verification && { expiresAt: { toDate: () => new Date(Date.now() + 60000) }, ...verification } };

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
    FieldValue: realFieldValue,
    Timestamp: { fromDate: (d) => d },
    db: {
      _tx: Promise.resolve(),
      // One transaction at a time, each seeing the previous one's writes.
      runTransaction(callback) {
        const run = this._tx.then(async () => {
          const writes = [];
          const result = await callback({
            get: ref => ref.get(),
            update: (ref, value) => writes.push(() => ref.update(value)),
            delete: ref => writes.push(() => ref.delete()),
          });
          for (const write of writes) await write();
          return result;
        });
        this._tx = run.catch(() => {});
        return run;
      },
      collection: (name) => ({
        add: async () => {},
        doc: (id) => ({
          set: async (value) => { if (name === 'phoneNumbers') calls.phoneSets.push({ id, value }); },
          update: async (value) => {
            if (name !== 'smsVerification' || !store.verification) return;
            for (const [key, change] of Object.entries(value)) {
              store.verification[key] = change?.constructor?.name === 'NumericIncrementTransform'
                ? Number(store.verification[key] || 0) + change.operand
                : change;
            }
          },
          delete: async () => { if (name === 'smsVerification') store.verification = null; },
          get: async () => name === 'smsVerification'
            ? { exists: Boolean(store.verification), data: () => store.verification }
            : { exists: false },
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
    return { mod: require('./lib/handlers-commands'), calls, store };
  } finally {
    Module._load = originalLoad;
  }
}

test('REGISTER finds the account via Firebase Auth, not a profiles query', async () => {
  const { mod, calls } = load({ authUid: 'auth-uid' });
  await mod.handleRegister('+15195550143', 'Rider@Example.com');
  assert.equal(calls.authLookups.length, 1);
  assert.equal(calls.profileQueries.length, 0);
  assert.match(calls.sms.at(-1), /Code sent/);
});

test('REGISTER refuses when no verified Firebase Auth account has that email', async () => {
  const { mod, calls } = load({ authUid: null });
  await mod.handleRegister('+15195550143', 'rider@example.com');
  assert.match(calls.sms.at(-1), /No account found/);
});

test('verification links the phone to the Auth uid, ignoring any profile with a matching email', async () => {
  const { mod, calls } = load({
    authUid: 'auth-uid',
    verification: { code: '123456', attempts: 0, email: 'rider@example.com' },
  });
  await mod.handleVerificationCode('+15195550143', '123456');
  assert.equal(calls.profileQueries.length, 0);
  assert.equal(calls.phoneSets.length, 1);
  assert.equal(calls.phoneSets[0].value.userId, 'auth-uid');
});

test('verification does not link when the Auth account is gone or unverified', async () => {
  const { mod, calls } = load({
    authUid: null,
    verification: { code: '123456', attempts: 0, email: 'rider@example.com' },
  });
  await mod.handleVerificationCode('+15195550143', '123456');
  assert.equal(calls.phoneSets.length, 0);
  assert.match(calls.sms.at(-1), /Account not found/);
});

test('parallel wrong codes cannot exceed 3 attempts, and a correct code is single-use', async () => {
  const { mod, calls } = load({
    authUid: 'auth-uid',
    verification: { code: '123456', attempts: 0, email: 'rider@example.com' },
  });
  await Promise.all(Array.from({ length: 12 }, (_, i) => mod.handleVerificationCode('+15195550143', String(100000 + i))));
  assert.equal(calls.sms.filter(message => message === 'Invalid code.').length, 3);

  // Locked now: the right code does not link the phone.
  await mod.handleVerificationCode('+15195550143', '123456');
  assert.equal(calls.phoneSets.length, 0);
});

test('two simultaneous correct submissions link the phone exactly once', async () => {
  const { mod, calls } = load({
    authUid: 'auth-uid',
    verification: { code: '123456', attempts: 0, email: 'rider@example.com' },
  });
  await Promise.all([0, 1].map(() => mod.handleVerificationCode('+15195550143', '123456')));
  assert.equal(calls.phoneSets.length, 1);
  assert.equal(calls.sms.filter(message => /Phone linked/.test(message)).length, 1);
});

test('help text never advertises a bare STOP line as a way to end a trip (STOP is a Twilio opt-out keyword)', async () => {
  const { mod, calls } = load();
  await mod.handleHelp('+15195550143');
  const help = calls.sms.at(-1);
  assert.match(help, /END \[?|END\n/);
  assert.doesNotMatch(help, /^STOP$/m);
  assert.doesNotMatch(help, /\bSTOP\b to end|END or STOP|END\/STOP/i);
});
