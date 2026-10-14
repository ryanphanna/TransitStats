/**
 * Check-in texts go only to a confirmed phone.
 * Run with: node --test test_ml_tasks.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function load(phoneDocs) {
  const path = require.resolve('./lib/ml-tasks');
  delete require.cache[path];
  const sent = [];
  const task = { data: () => ({ description: 'check', tripTarget: 1 }), ref: { update: async () => {} }, id: 't1' };
  const db = {
    collection: (name) => {
      const query = {
        where: () => query,
        get: async () => {
          if (name === 'phoneNumbers') return { empty: !phoneDocs.length, docs: phoneDocs.map(([id, data]) => ({ id, data: () => data })) };
          if (name === 'mlTasks') return { empty: false, docs: [task] };
          return { docs: [{ data: () => ({ agency: 'TTC' }) }] };
        },
      };
      return query;
    },
  };
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.id === path) {
      if (request === './db') return { db };
      if (request === './twilio') return { sendSmsReply: async (to) => { sent.push(to); } };
      if (request === './logger') return { info() {}, warn() {}, error() {} };
    }
    return original(request, parent, isMain);
  };
  try { return { mod: require('./lib/ml-tasks'), sent }; } finally { Module._load = original; }
}

test('check-in texts skip an unconfirmed number', async () => {
  const { mod, sent } = load([['+15195550101', { userId: 'u1', loginConfirmed: false }]]);
  await mod.checkMlTasks('u1');
  assert.deepEqual(sent, []);
});

test('check-in texts go to a confirmed number, even when an unconfirmed one is listed first', async () => {
  const { mod, sent } = load([
    ['+15195550101', { userId: 'u1', loginConfirmed: false }],
    ['+15195550102', { userId: 'u1' }],
  ]);
  await mod.checkMlTasks('u1');
  assert.deepEqual(sent, ['+15195550102']);
});
