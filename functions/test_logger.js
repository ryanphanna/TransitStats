const test = require('node:test');
const assert = require('node:assert');
const logger = require('./lib/logger');

function capture(method, fn) {
  const calls = [];
  const orig = console[method];
  console[method] = (...args) => calls.push(args);
  try { fn(); } finally { console[method] = orig; }
  return calls;
}

test('warn logs its data object instead of dropping it', () => {
  const [call] = capture('warn', () => logger.warn('limit reached', { ip: 'x', count: 5 }));
  assert.strictEqual(call[0], '[WARN] limit reached');
  assert.deepStrictEqual(call[1], { ip: 'x', count: 5 });
});

test('warn uses traceId from data or third argument, never "[object Object]"', () => {
  const [a] = capture('warn', () => logger.warn('m', { traceId: 'abc12345', k: 1 }));
  assert.strictEqual(a[0], '[WARN][t:abc12345] m');
  assert.deepStrictEqual(a[1], { k: 1 });
  const [b] = capture('warn', () => logger.warn('m', { k: 1 }, 'trace999'));
  assert.strictEqual(b[0], '[WARN][t:trace999] m');
  const [c] = capture('warn', () => logger.warn('m', 'oldstyle'));
  assert.strictEqual(c[0], '[WARN][t:oldstyle] m');
});

test('warn masks phone numbers and redacts bodies', () => {
  const [call] = capture('warn', () => logger.warn('m', { phoneNumber: '+16471234567', phone: '+14165550123', Body: 'secret text' }));
  assert.strictEqual(call[1].phoneNumber, '+1647***4567');
  assert.strictEqual(call[1].phone, '+1416***0123');
  assert.match(call[1].Body, /REDACTED/);
  assert.ok(!JSON.stringify(call).includes('6471234567'));
});

test('warn with no data logs just the message', () => {
  const [call] = capture('warn', () => logger.warn('plain'));
  assert.deepStrictEqual(call, ['[WARN] plain', '']);
  const [n] = capture('warn', () => logger.warn('plain', null));
  assert.deepStrictEqual(n, ['[WARN] plain', '']);
});

test('error masks phone numbers even without a traceId, and keeps Error objects intact', () => {
  const [a] = capture('error', () => logger.error('boom', { phoneNumber: '+16471234567' }));
  assert.strictEqual(a[1].phoneNumber, '+1647***4567');
  const err = new Error('bad');
  const [b] = capture('error', () => logger.error('boom', err));
  assert.strictEqual(b[1], err);
});

test('info still logs data and masks phones', () => {
  const [call] = capture('log', () => logger.info('hi', { phone: '+16471234567', n: 1 }));
  assert.deepStrictEqual(call[1], { phone: '+1647***4567', n: 1 });
});
