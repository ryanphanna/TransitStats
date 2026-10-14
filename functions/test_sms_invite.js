/**
 * Text-first setup for invited people (functions/lib/sms-invite.js) and the
 * script that adds a phone to an invite.
 * Run with: node --test test_sms_invite.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createInviteHandlers, WELCOME_TEXT, SETUP_TEXT, LINKED_TEXT, NOT_INVITED_TEXT, SETUP_PROBLEM_TEXT, PROVISIONED_CLAIM,
} = require('./lib/sms-invite');
const { setInvitePhone } = require('./scripts/set-invite-phone');

class AlreadyExists extends Error { constructor() { super('already exists'); this.code = 6; } }

function fakeDb(seed = {}) {
  const data = new Map(Object.entries(seed));
  const ref = (collection, id) => ({
    id,
    async get() { const v = data.get(`${collection}/${id}`); return { exists: Boolean(v), data: () => v }; },
    async set(value) { data.set(`${collection}/${id}`, value); },
    async create(value) { if (data.has(`${collection}/${id}`)) throw new AlreadyExists(); data.set(`${collection}/${id}`, value); },
    async update(value) { data.set(`${collection}/${id}`, { ...data.get(`${collection}/${id}`), ...value }); },
    async delete() { data.delete(`${collection}/${id}`); },
  });
  return {
    data,
    collection(collection) {
      return {
        doc: id => ref(collection, id),
        async add(value) { data.set(`${collection}/auto-${data.size}`, value); },
        where(field, _op, value) {
          const run = () => [...data.entries()]
            .filter(([key, item]) => key.startsWith(`${collection}/`) && item?.[field] === value)
            .map(([key, item]) => ({ id: key.slice(collection.length + 1), data: () => item }));
          return { limit: () => ({ get: async () => ({ docs: run() }) }), get: async () => ({ docs: run() }) };
        },
      };
    },
  };
}

function fakeAuth(users = []) {
  const byEmail = new Map(users.map(u => [u.email, { customClaims: {}, ...u }]));
  const calls = { created: [], claims: [], links: [] };
  return {
    calls,
    async getUserByEmail(email) {
      const user = byEmail.get(email);
      if (!user) throw Object.assign(new Error('nope'), { code: 'auth/user-not-found' });
      return user;
    },
    async createUser({ email, emailVerified }) {
      const user = { uid: `uid-${email}`, email, emailVerified, customClaims: {} };
      byEmail.set(email, user); calls.created.push({ email, emailVerified });
      return user;
    },
    async setCustomUserClaims(uid, claims) {
      calls.claims.push({ uid, claims });
      for (const user of byEmail.values()) if (user.uid === uid) user.customClaims = claims;
    },
    async generateSignInWithEmailLink(email, settings) { calls.links.push({ email, settings }); return `https://example.test/link?e=${email}`; },
  };
}

const FieldValue = { serverTimestamp: () => 'TS' };
const PHONE = '+14165550123';

function build({ seed = {}, users = [], respond = true, sendOk = true } = {}) {
  const db = fakeDb(seed);
  const adminAuth = fakeAuth(users);
  const sms = [];
  const handlers = createInviteHandlers({
    db, adminAuth, FieldValue,
    sendSmsReply: async (to, message) => { sms.push({ to, message }); return sendOk; },
    shouldRespondToUnknown: async () => respond,
  });
  return { db, adminAuth, sms, handlers };
}

const invited = { 'allowedUsers/new@example.com': { email: 'new@example.com', phone: PHONE } };

test('invited, no account yet: creates the account and profile, links the phone, emails a sign-in link, texts', async () => {
  const { db, adminAuth, sms, handlers } = build({ seed: invited });
  await handlers.handleUnknownSender(PHONE);

  assert.deepEqual(adminAuth.calls.created, [{ email: 'new@example.com', emailVerified: false }]);
  assert.deepEqual(adminAuth.calls.claims[0].claims, { [PROVISIONED_CLAIM]: true });
  const link = db.data.get(`phoneNumbers/${PHONE}`);
  assert.equal(link.userId, 'uid-new@example.com');
  assert.equal(link.email, 'new@example.com');
  const profile = db.data.get('profiles/uid-new@example.com');
  assert.equal(profile.isAdmin, false);
  assert.equal(profile.isPremium, false);
  assert.equal(profile.userId, 'uid-new@example.com');
  assert.equal(adminAuth.calls.links.length, 1);
  assert.equal(adminAuth.calls.links[0].settings.handleCodeInApp, true);
  const mail = [...db.data.entries()].find(([key]) => key.startsWith('mail/'));
  assert.equal(mail[1].to, 'new@example.com');
  assert.match(mail[1].message.text, /example\.test\/link/);
  assert.deepEqual(sms, [{ to: PHONE, message: SETUP_TEXT }]);
  assert.doesNotMatch(SETUP_TEXT, /invit/i);
});

test('invited, verified account already exists: links the phone to it and confirms by text, no new account or email', async () => {
  const { db, adminAuth, sms, handlers } = build({
    seed: { ...invited, 'profiles/existing-uid': { displayName: 'Keep me' } },
    users: [{ uid: 'existing-uid', email: 'new@example.com', emailVerified: true }],
  });
  await handlers.handleUnknownSender(PHONE);

  assert.equal(adminAuth.calls.created.length, 0);
  assert.equal(adminAuth.calls.links.length, 0);
  assert.equal(db.data.get(`phoneNumbers/${PHONE}`).userId, 'existing-uid');
  assert.equal(db.data.get('profiles/existing-uid').displayName, 'Keep me');
  assert.deepEqual(sms, [{ to: PHONE, message: LINKED_TEXT }]);
});

test('an unverified account we did not create is NOT linked (pre-registered squat)', async () => {
  const { db, sms, handlers } = build({
    seed: invited,
    users: [{ uid: 'squatter', email: 'new@example.com', emailVerified: false }],
  });
  await handlers.handleUnknownSender(PHONE);

  assert.equal(db.data.has(`phoneNumbers/${PHONE}`), false);
  assert.deepEqual(sms, [{ to: PHONE, message: SETUP_PROBLEM_TEXT }]);
  // No email was sent in this case, so the text must not point at one.
  assert.doesNotMatch(SETUP_PROBLEM_TEXT, /email/i);
});

test('an unverified account we provisioned earlier is accepted', async () => {
  const { db, handlers } = build({
    seed: invited,
    users: [{ uid: 'ours', email: 'new@example.com', emailVerified: false, customClaims: { [PROVISIONED_CLAIM]: true } }],
  });
  await handlers.handleUnknownSender(PHONE);
  assert.equal(db.data.get(`phoneNumbers/${PHONE}`).userId, 'ours');
});

test('not invited: replies invite-only, with no "sign up on the website" line, and creates nothing', async () => {
  const { db, adminAuth, sms, handlers } = build({ seed: invited });
  await handlers.handleUnknownSender('+14165559999');

  assert.deepEqual(sms, [{ to: '+14165559999', message: NOT_INVITED_TEXT }]);
  assert.match(NOT_INVITED_TEXT, /^TransitStats is invite-only\./);
  assert.doesNotMatch(NOT_INVITED_TEXT, /sign up|transitstats\.fyi/i);
  assert.equal(adminAuth.calls.created.length, 0);
  assert.equal(db.data.has('phoneNumbers/+14165559999'), false);
});

test('rate limit: once the per-number limit is hit, nothing is sent or created', async () => {
  const notInvited = build({ seed: invited, respond: false });
  await notInvited.handlers.handleUnknownSender('+14165559999');
  assert.equal(notInvited.sms.length, 0);

  const inviteLimited = build({ seed: invited, respond: false });
  await inviteLimited.handlers.handleUnknownSender(PHONE);
  assert.equal(inviteLimited.sms.length, 0);
  assert.equal(inviteLimited.adminAuth.calls.created.length, 0);
  assert.equal(inviteLimited.adminAuth.calls.links.length, 0);
});

test('a number on two invites is ambiguous and is not set up for either', async () => {
  const { db, adminAuth, handlers } = build({
    seed: { ...invited, 'allowedUsers/other@example.com': { phone: PHONE } },
  });
  await handlers.handleUnknownSender(PHONE);
  assert.equal(adminAuth.calls.created.length, 0);
  assert.equal(db.data.has(`phoneNumbers/${PHONE}`), false);
});

test('an existing phone link is never overwritten', async () => {
  const { db, sms, handlers } = build({
    seed: { ...invited, [`phoneNumbers/${PHONE}`]: { userId: 'someone-else', email: 'x@example.com' } },
  });
  await handlers.handleUnknownSender(PHONE);
  assert.equal(db.data.get(`phoneNumbers/${PHONE}`).userId, 'someone-else');
  assert.equal(sms.length, 0);
});

test('welcome text: sent once per number, with the agreed copy, and never repeats', async () => {
  const { sms, db, handlers } = build();
  assert.equal(await handlers.sendWelcomeOnce(PHONE, 'a@example.com'), 'sent');
  assert.equal(await handlers.sendWelcomeOnce(PHONE, 'a@example.com'), 'already-sent');
  assert.equal(sms.length, 1);
  assert.equal(sms[0].message, WELCOME_TEXT);
  assert.ok(db.data.get(`smsWelcomes/${PHONE}`).sentAt);
  assert.match(WELCOME_TEXT, /^Next stop: TransitStats\. You're in!/);
  assert.match(WELCOME_TEXT, /transitstats\.fyi\/import/);
  assert.match(WELCOME_TEXT, /Reply STOP to opt out\.$/);
  assert.doesNotMatch(WELCOME_TEXT, /invit/i);
});

test('welcome text: parallel triggers still send once', async () => {
  const { sms, handlers } = build();
  await Promise.all([1, 2, 3].map(() => handlers.sendWelcomeOnce(PHONE, 'a@example.com')));
  assert.equal(sms.length, 1);
});

test('welcome text: an opted-out number is never texted', async () => {
  const { sms, handlers } = build({ seed: { [`smsOptOuts/${PHONE}`]: { reason: 'inbound-keyword' } } });
  assert.equal(await handlers.sendWelcomeOnce(PHONE, 'a@example.com'), 'opted-out');
  assert.equal(sms.length, 0);
});

test('welcome text: a refused send frees the marker so a later edit can retry', async () => {
  const { db, handlers } = build({ sendOk: false });
  assert.equal(await handlers.sendWelcomeOnce(PHONE, 'a@example.com'), 'send-failed');
  assert.equal(db.data.has(`smsWelcomes/${PHONE}`), false);
});

test('trigger: texts when a phone is added or changed, not on other edits', async () => {
  const { sms, handlers } = build();
  assert.equal(await handlers.onInvitePhoneWritten({ email: 'A@Example.com', before: { email: 'a' }, after: { email: 'a', phone: '(416) 555-0123' } }), 'sent');
  assert.equal(sms[0].to, PHONE);
  assert.equal(await handlers.onInvitePhoneWritten({ email: 'a@example.com', before: { phone: PHONE }, after: { phone: PHONE, isAdmin: true } }), 'unchanged');
  assert.equal(await handlers.onInvitePhoneWritten({ email: 'a@example.com', before: { phone: PHONE }, after: { email: 'a' } }), 'unchanged');
  assert.equal(sms.length, 1);
});

test('script: normalises the phone, refuses unknown invites, duplicates and linked numbers, and supports --dry-run', async () => {
  const db = fakeDb({
    'allowedUsers/a@example.com': { email: 'a@example.com' },
    'allowedUsers/b@example.com': { email: 'b@example.com', phone: '+14165550999' },
    '': undefined,
  });
  db.data.set('phoneNumbers/+14165550888', { email: 'someone@example.com' });
  const fv = { serverTimestamp: () => 'TS' };

  const dry = await setInvitePhone({ db, email: 'A@example.com', phone: '(416) 555-0123', dryRun: true, FieldValueImpl: fv });
  assert.deepEqual(dry, { email: 'a@example.com', phone: PHONE, applied: false });
  assert.equal(db.data.get('allowedUsers/a@example.com').phone, undefined);

  const done = await setInvitePhone({ db, email: 'a@example.com', phone: '416-555-0123', FieldValueImpl: fv });
  assert.equal(done.applied, true);
  assert.equal(db.data.get('allowedUsers/a@example.com').phone, PHONE);

  await assert.rejects(setInvitePhone({ db, email: 'nobody@example.com', phone: PHONE, FieldValueImpl: fv }), /No invite found/);
  await assert.rejects(setInvitePhone({ db, email: 'a@example.com', phone: '12', FieldValueImpl: fv }), /not a valid phone/);
  await assert.rejects(setInvitePhone({ db, email: 'a@example.com', phone: '+14165550999', FieldValueImpl: fv }), /already on the invite for b@example.com/);
  await assert.rejects(setInvitePhone({ db, email: 'a@example.com', phone: '+14165550888', FieldValueImpl: fv }), /already linked/);
});
