const { defineSecret } = require('firebase-functions/params');

const turnstileSecretKey = defineSecret('TURNSTILE_SECRET_KEY');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 5000;
// Must match the `action` the login page passes to turnstile.render().
const TURNSTILE_ACTION = 'otp_request';
const ALLOWED_HOSTNAMES = new Set([
  'transitstats.fyi',
  'www.transitstats.fyi',
  'transitstats-21ba4.web.app',
  'transitstats-21ba4.firebaseapp.com',
]);
// Cloudflare's test keys report this hostname; only accept it in the emulator.
const TEST_HOSTNAME = 'example.com';

// Mode lives in Firestore (config/turnstile { mode: 'monitor' | 'enforce' }) so
// it can be flipped without a deploy. The collection has no client access in
// firestore.rules, so only the Admin SDK / console can change it.
const MODE_CACHE_MS = 30 * 1000;
// Fail closed: only an exact 'monitor' in config/turnstile relaxes the check.
const DEFAULT_MODE = 'enforce';

function isEmulator() {
  return process.env.FUNCTIONS_EMULATOR === 'true';
}

/**
 * Checks a Turnstile token with Cloudflare. Never throws.
 * @returns {Promise<{ success: boolean, reason: string }>}
 */
async function verifyTurnstile(token, remoteIp, { fetchImpl = fetch, secret } = {}) {
  if (!token || typeof token !== 'string') return { success: false, reason: 'missing_token' };
  if (token.length > 2048) return { success: false, reason: 'malformed_token' };

  const body = new URLSearchParams({ secret: secret ?? turnstileSecretKey.value(), response: token });
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);

  let data;
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    data = await response.json();
  } catch {
    return { success: false, reason: 'siteverify_unreachable' };
  }

  if (data?.success !== true) {
    const codes = Array.isArray(data?.['error-codes']) ? data['error-codes'].join(',') : '';
    return { success: false, reason: `rejected${codes ? `:${codes}` : ''}` };
  }
  const hostnameOk = ALLOWED_HOSTNAMES.has(data.hostname)
    || (isEmulator() && (data.hostname === TEST_HOSTNAME || data.hostname === 'localhost'));
  if (!hostnameOk) return { success: false, reason: `hostname:${data.hostname}` };
  // Test keys return no action; real widgets always echo the one we set.
  if (data.action !== TURNSTILE_ACTION && !(isEmulator() && !data.action)) {
    return { success: false, reason: `action:${data.action}` };
  }
  return { success: true, reason: 'ok' };
}

function createTurnstileModeReader(db, { logger, now = Date.now } = {}) {
  let cached = null;
  let cachedAt = 0;
  return async function getTurnstileMode() {
    if (cached && now() - cachedAt < MODE_CACHE_MS) return cached;
    try {
      const snapshot = await db.collection('config').doc('turnstile').get();
      const mode = snapshot.exists ? snapshot.data()?.mode : null;
      cached = mode === 'monitor' ? 'monitor' : DEFAULT_MODE;
      cachedAt = now();
    } catch (error) {
      // Keep the last known mode on a read error; with none yet (cold start), enforce.
      logger?.warn?.('Turnstile mode read failed', { error: error.message });
      if (!cached) return DEFAULT_MODE;
    }
    return cached;
  };
}

module.exports = {
  verifyTurnstile,
  turnstileSecretKey,
  createTurnstileModeReader,
  TURNSTILE_ACTION,
};
