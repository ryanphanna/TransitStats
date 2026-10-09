const { onRequest } = require('firebase-functions/v2/https');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const SESSION_COOKIE = 'transitstats_session';
const SESSION_MAX_AGE_SECONDS = 5 * 24 * 60 * 60;
const LOGIN_ACTIVITY_WINDOW_MS = 15 * 60 * 1000;
const ALLOWED_HOSTS = new Set([
  'transitstats.fyi',
  'www.transitstats.fyi',
  'beta.transitstats.fyi',
  'admin.transitstats.fyi',
  'localhost',
  '127.0.0.1',
]);

function cookieHeader(value, maxAge, host = '') {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  // Domain must match the request host or browsers drop the cookie. Local
  // Vite/emulator sessions need a host-only cookie; production keeps the
  // shared .transitstats.fyi domain across subdomains.
  if (host.endsWith('transitstats.fyi')) {
    parts.splice(1, 0, 'Domain=.transitstats.fyi');
    parts.push('Secure');
  }
  return parts.join('; ');
}

function isInvalidSessionCookieError(error) {
  const code = String(error?.code || '');
  return code.includes('session-cookie')
    || code.includes('invalid-argument')
    || code === 'auth/argument-error'
    || code === 'auth/invalid-session-cookie'
    || code === 'auth/session-cookie-expired'
    || code === 'auth/session-cookie-revoked';
}

function getHost(req) {
  return String(req.hostname || req.get('host') || '').split(':')[0].toLowerCase();
}

function getCookie(req) {
  const header = req.get('cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}

async function recordLoginActivity(uid, host) {
  if (!uid) return;
  const db = getFirestore();
  const ref = db.collection('loginActivity').doc(uid);
  const now = new Date();

  try {
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.exists ? snapshot.data() : {};
      const previous = data.lastLoginAt?.toDate ? data.lastLoginAt.toDate() : null;
      if (previous && now.getTime() - previous.getTime() < LOGIN_ACTIVITY_WINDOW_MS) return;

      transaction.set(ref, {
        userId: uid,
        loginCount: Number(data.loginCount || 0) + 1,
        lastLoginAt: now,
        lastHost: host || null,
      }, { merge: true });
    });
  } catch (error) {
    // Login tracking is diagnostic only and must never block authentication.
    console.warn('Login activity could not be recorded:', error.message);
  }
}

async function isAllowedUser(uid, email) {
  const db = getFirestore();
  if (email) {
    const allowed = await db.collection('allowedUsers').doc(email.toLowerCase()).get();
    return allowed.exists;
  }

  const phone = await db.collection('phoneNumbers').where('userId', '==', uid).limit(1).get();
  return !phone.empty;
}

async function handleAuthSession(req, res) {
  if (!ALLOWED_HOSTS.has(getHost(req))) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  res.set('Cache-Control', 'no-store');

  const host = getHost(req);

  if (req.method === 'DELETE') {
    res.set('Set-Cookie', cookieHeader('', 0, host));
    res.status(204).end();
    return;
  }

  try {
    const adminAuth = getAuth();
    if (req.method === 'POST') {
      const authHeader = req.get('authorization') || '';
      if (!authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing authentication token' });
        return;
      }

      const decoded = await adminAuth.verifyIdToken(authHeader.slice(7));
      if (!(await isAllowedUser(decoded.uid, decoded.email || ''))) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      await recordLoginActivity(decoded.uid, host);

      const sessionCookie = await adminAuth.createSessionCookie(authHeader.slice(7), {
        expiresIn: SESSION_MAX_AGE_SECONDS * 1000,
      });
      res.set('Set-Cookie', cookieHeader(sessionCookie, SESSION_MAX_AGE_SECONDS, host));
      res.status(204).end();
      return;
    }

    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const sessionCookie = getCookie(req);
    if (!sessionCookie) {
      res.status(401).json({ error: 'No shared session' });
      return;
    }

    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true);
    if (!(await isAllowedUser(decoded.uid, decoded.email || ''))) {
      res.set('Set-Cookie', cookieHeader('', 0, host));
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const customToken = await adminAuth.createCustomToken(decoded.uid);
    res.status(200).json({ token: customToken });
  } catch (error) {
    // Only erase the cookie when it is known-bad. Transient Admin SDK / network
    // failures used to Max-Age=0 the backstop and turn one flake into a logout.
    if (req.method === 'GET' && isInvalidSessionCookieError(error)) {
      res.set('Set-Cookie', cookieHeader('', 0, host));
    }
    res.status(401).json({ error: 'Shared session is invalid' });
  }
}

exports.handleAuthSession = handleAuthSession;
exports.authSession = onRequest({ concurrency: 80, maxInstances: 10 }, handleAuthSession);
exports.recordLoginActivity = recordLoginActivity;
