/**
 * HTTP API for the TransitStats companion app.
 * OTP login and authenticated command dispatch live in their own modules.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { dispatch } = require('./lib/dispatcher');
const { apiContextStorage, sendSmsReply } = require('./lib/twilio');
const { createOtpHandlers } = require('./lib/otp');
const { verifyTurnstile, turnstileSecretKey } = require('./lib/turnstile');
const { createCommandHandler } = require('./lib/api-command');
const logger = require('./lib/logger');

if (getApps().length === 0) {
  initializeApp({
    serviceAccountId: 'firebase-adminsdk-fbsvc@transitstats-21ba4.iam.gserviceaccount.com',
  });
}

const db = getFirestore();
const adminAuth = getAuth();

function generateTraceId() {
  try {
    const { randomUUID } = require('crypto');
    return randomUUID().replace(/-/g, '').slice(0, 8);
  } catch {
    return Date.now().toString(36).slice(-8);
  }
}

const { handleRequestOtp, handleVerifyOtp } = createOtpHandlers({
  db,
  adminAuth,
  sendSmsReply,
  verifyTurnstile,
  logger,
});

const handleAuthenticatedCommand = createCommandHandler({
  db,
  apiContextStorage,
  dispatch,
  logger,
  generateTraceId,
});

async function handleApiRequest(req, res) {
  const traceId = generateTraceId();

  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');
    return;
  }

  try {
    const action = req.body?.action;
    if (action === 'request_otp') {
      await handleRequestOtp(req, res, traceId);
      return;
    }
    if (action === 'verify_otp') {
      await handleVerifyOtp(req, res, traceId);
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('API authentication failed: Missing or invalid token format', { traceId }, traceId);
      res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
      return;
    }

    let decodedToken;
    try {
      decodedToken = await adminAuth.verifyIdToken(authHeader.slice('Bearer '.length));
    } catch (authError) {
      logger.warn('API authentication failed: Invalid ID token', { error: authError.message, traceId }, traceId);
      res.status(401).json({ error: 'Unauthorized: Invalid token' });
      return;
    }

    await handleAuthenticatedCommand(req, res, {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      emailVerified: decodedToken.email_verified === true,
      traceId,
    });
  } catch (error) {
    logger.error('CRITICAL API DISPATCH ERROR', {
      error: error.message,
      stack: error.stack,
      request: logger.describeRequest(req.body),
      traceId,
    }, traceId);
    res.status(500).json({ error: 'Internal Server Error', traceId });
  }
}

const { defineSecret } = require('firebase-functions/params');
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');
const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioPhoneNumber = defineSecret('TWILIO_PHONE_NUMBER');

exports.api = onRequest({
  secrets: [geminiApiKey, twilioAuthToken, twilioAccountSid, twilioPhoneNumber, turnstileSecretKey],
  concurrency: 80,
  maxInstances: 10,
}, handleApiRequest);
