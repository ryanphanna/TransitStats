/**
 * RCS tap-to-end buttons: config switch, card send, SMS fallback, inbound taps.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRcsConfigReader,
  buildEndButtonCardParams,
  deliverReply,
  normalizeInbound,
} = require('./lib/rcs-buttons');

const TO = '+14165550101';
const FROM = '+13433160660';
const MG = 'MG' + '0'.repeat(32);
const HX = { 1: 'HX' + '1'.repeat(32), 2: 'HX' + '2'.repeat(32), 3: 'HX' + '3'.repeat(32) };
const BODY = 'Started 510 Westbound from Spadina.\n\nWhere to?\n1. Union\n2. Bathurst\n\nEND 1, or END 2 to end.\n\nEND [stop] to finish. FORGOT if forgot to end.';
const ON = { enabled: true, allowlist: [], messagingServiceSid: MG, templates: HX };
const quietLogger = { warn: () => {} };

function fakeClient({ failCard = false } = {}) {
  const sent = [];
  return {
    sent,
    messages: {
      create: async (params) => {
        sent.push(params);
        if (failCard && params.contentSid) {
          const err = new Error('RCS sender not approved');
          err.code = 63032;
          throw err;
        }
        return { sid: 'SM1' };
      },
    },
  };
}

function fakeDb(doc, { fail = false } = {}) {
  let reads = 0;
  return {
    get reads() { return reads; },
    collection: (name) => ({
      doc: (id) => ({
        get: async () => {
          reads++;
          assert.equal(`${name}/${id}`, 'config/rcsButtons');
          if (fail) throw new Error('unavailable');
          return doc ? { exists: true, data: () => doc } : { exists: false };
        },
      }),
    }),
  };
}

test('rcs config: missing doc means off', async () => {
  const read = createRcsConfigReader(fakeDb(null));
  assert.equal((await read()).enabled, false);
});

test('rcs config: read error on cold start means off', async () => {
  const read = createRcsConfigReader(fakeDb(null, { fail: true }));
  assert.equal((await read()).enabled, false);
});

test('rcs config: enabled doc is normalized and cached', async () => {
  const db = fakeDb({ enabled: true, messagingServiceSid: MG, templates: { 1: HX[1], 2: HX[2], 3: 'not-a-sid' }, allowlist: [TO] });
  let t = 0;
  const read = createRcsConfigReader(db, { now: () => t });
  const config = await read();
  assert.equal(config.enabled, true);
  assert.equal(config.messagingServiceSid, MG);
  assert.deepEqual(config.templates, { 1: HX[1], 2: HX[2] });
  assert.deepEqual(config.allowlist, [TO]);
  t = 10000;
  await read();
  assert.equal(db.reads, 1);
});

test('switch off: reply is the plain SMS exactly as today', async () => {
  for (const rcsConfig of [null, { enabled: false }]) {
    const client = fakeClient();
    const via = await deliverReply(client, { from: FROM, to: TO, message: BODY, endButtons: 2, rcsConfig, logger: quietLogger });
    assert.equal(via, 'sms');
    assert.deepEqual(client.sent, [{ body: BODY, from: FROM, to: TO }]);
  }
});

test('switch on: card send with the right template, buttons count and identical body', async () => {
  for (const n of [1, 2, 3]) {
    const client = fakeClient();
    const via = await deliverReply(client, { from: FROM, to: TO, message: BODY, endButtons: n, rcsConfig: ON, logger: quietLogger });
    assert.equal(via, 'card');
    assert.equal(client.sent.length, 1);
    const params = client.sent[0];
    assert.equal(params.contentSid, HX[n], `template for ${n} button(s)`);
    assert.equal(params.messagingServiceSid, MG);
    assert.equal(params.to, TO);
    assert.deepEqual(JSON.parse(params.contentVariables), { 1: BODY });
    assert.equal(params.body, undefined);
  }
});

test('switch on: no numbered list, unknown count or missing template sends plain SMS', async () => {
  for (const endButtons of [0, 4, undefined]) {
    assert.equal(buildEndButtonCardParams(ON, TO, BODY, endButtons), null);
  }
  assert.equal(buildEndButtonCardParams({ ...ON, templates: { 1: HX[1] } }, TO, BODY, 2), null);
  assert.equal(buildEndButtonCardParams({ ...ON, messagingServiceSid: null }, TO, BODY, 2), null);
  assert.equal(buildEndButtonCardParams(ON, TO, 'x'.repeat(5000), 2), null);
});

test('switch on with allowlist: only listed numbers get the card', async () => {
  const config = { ...ON, allowlist: ['+14165559999'] };
  assert.equal(buildEndButtonCardParams(config, TO, BODY, 2), null);
  assert.ok(buildEndButtonCardParams(config, '+14165559999', BODY, 2));
});

test('card send failure falls back to the plain SMS reply', async () => {
  const client = fakeClient({ failCard: true });
  const via = await deliverReply(client, { from: FROM, to: TO, message: BODY, endButtons: 2, rcsConfig: ON, logger: quietLogger });
  assert.equal(via, 'sms');
  assert.equal(client.sent.length, 2);
  assert.ok(client.sent[0].contentSid);
  assert.deepEqual(client.sent[1], { body: BODY, from: FROM, to: TO });
});

test('inbound: ButtonPayload end2 becomes the text END 2', () => {
  assert.deepEqual(normalizeInbound({ From: TO, Body: '', ButtonPayload: 'end2' }), { from: TO, body: 'END 2' });
  assert.deepEqual(normalizeInbound({ From: TO, Body: 'END 2', ButtonPayload: 'end2' }), { from: TO, body: 'END 2' });
});

test('inbound: rcs: sender prefix is stripped; other payloads and plain texts are untouched', () => {
  assert.deepEqual(normalizeInbound({ From: `rcs:${TO}`, ButtonPayload: 'END3' }), { from: TO, body: 'END 3' });
  assert.deepEqual(normalizeInbound({ From: TO, Body: ' hello ', ButtonPayload: 'end9' }), { from: TO, body: 'hello' });
  assert.deepEqual(normalizeInbound({ From: TO, Body: 'END Union' }), { from: TO, body: 'END Union' });
  const raw = { From: `rcs:${TO}`, Body: '', ButtonPayload: 'end1' };
  normalizeInbound(raw);
  assert.deepEqual(raw, { From: `rcs:${TO}`, Body: '', ButtonPayload: 'end1' }, 'request body is not mutated');
});
