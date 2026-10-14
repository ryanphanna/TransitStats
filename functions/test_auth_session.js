/**
 * Unit tests for the shared-session cookie endpoint (functions/auth-session.js).
 * Run with: node --test test_auth_session.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadHandler({ adminAuth, db }) {
  const modulePath = require.resolve('./auth-session');
  delete require.cache[modulePath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.id === modulePath) {
      if (request === 'firebase-functions/v2/https') return { onRequest: (_opts, handler) => handler };
      if (request === 'firebase-admin/auth') return { getAuth: () => adminAuth };
      if (request === 'firebase-admin/firestore') return { getFirestore: () => db };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return require('./auth-session').handleAuthSession;
  } finally {
    Module._load = originalLoad;
  }
}

function makeDb() {
  return {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true }) }),
    }),
    runTransaction: async () => {},
  };
}

function makeReq({ method, host, headers = {} }) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, hostname: host, get: (name) => lower[name.toLowerCase()] };
}

function makeRes() {
  const res = {
    headers: {},
    statusCode: null,
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
  return res;
}

const okAuth = {
  verifyIdToken: async () => ({ uid: 'u1', email: 'a@example.com' }),
  createSessionCookie: async () => 'minted-cookie',
};

test('POST on a production host sets a shared-domain Secure cookie', async () => {
  const handler = loadHandler({ adminAuth: okAuth, db: makeDb() });
  const res = makeRes();
  await handler(makeReq({ method: 'POST', host: 'beta.transitstats.fyi', headers: { Authorization: 'Bearer tok' } }), res);
  assert.equal(res.statusCode, 204);
  const cookie = res.headers['Set-Cookie'];
  assert.match(cookie, /^transitstats_session=minted-cookie; Domain=\.transitstats\.fyi; Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=432000/);
});

test('POST on localhost sets a host-only cookie (no Domain, no Secure)', async () => {
  const handler = loadHandler({ adminAuth: okAuth, db: makeDb() });
  const res = makeRes();
  await handler(makeReq({ method: 'POST', host: 'localhost', headers: { Authorization: 'Bearer tok' } }), res);
  const cookie = res.headers['Set-Cookie'];
  assert.doesNotMatch(cookie, /Domain=/);
  assert.doesNotMatch(cookie, /Secure/);
});

test('DELETE clears the cookie with Max-Age=0', async () => {
  const handler = loadHandler({ adminAuth: okAuth, db: makeDb() });
  const res = makeRes();
  await handler(makeReq({ method: 'DELETE', host: 'transitstats.fyi' }), res);
  assert.equal(res.statusCode, 204);
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
});

test('GET with a known-bad cookie erases it', async () => {
  const adminAuth = {
    verifySessionCookie: async () => { throw Object.assign(new Error('expired'), { code: 'auth/session-cookie-expired' }); },
  };
  const handler = loadHandler({ adminAuth, db: makeDb() });
  const res = makeRes();
  await handler(makeReq({ method: 'GET', host: 'transitstats.fyi', headers: { Cookie: 'transitstats_session=old' } }), res);
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
});

test('GET hitting a transient failure keeps the cookie', async () => {
  const adminAuth = {
    verifySessionCookie: async () => { throw Object.assign(new Error('network'), { code: 'app/network-error' }); },
  };
  const handler = loadHandler({ adminAuth, db: makeDb() });
  const res = makeRes();
  await handler(makeReq({ method: 'GET', host: 'transitstats.fyi', headers: { Cookie: 'transitstats_session=ok' } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['Set-Cookie'], undefined);
});
