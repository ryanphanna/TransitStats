/**
 * SMS Webhook Handler for TransitStats (2nd Generation)
 */

const { onRequest } = require('firebase-functions/v2/https');
const express = require('express');
const { defineSecret } = require('firebase-functions/params');

// Modules
const logger = require('./lib/logger');

/** Local short trace ID generator (defensive against test module mocking) */
function generateTraceIdLocal() {
  try {
    const { randomUUID } = require('crypto');
    return randomUUID().replace(/-/g, '').slice(0, 8);
  } catch {
    return Date.now().toString(36).slice(-8);
  }
}
const {
  validateTwilioSignature,
  twimlResponse,
} = require('./lib/twilio');
const { dispatch } = require('./lib/dispatcher');

// Secrets (Modern defineSecret pattern)
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');
const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioPhoneNumber = defineSecret('TWILIO_PHONE_NUMBER');

const app = express();
app.use(express.urlencoded({ extended: true }));

/**
 * Simplified SMS Webhook Entry Point
 */
async function handleSmsRequest(req, res) {
  const traceId = generateTraceIdLocal();

  try {
    const phoneNumber = req.body.From;
    const body = (req.body.Body || '').trim();
    const messageSid = req.body.MessageSid;
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const mediaUrl = numMedia > 0 ? (req.body.MediaUrl0 || null) : null;

    if (!phoneNumber || (!body && !mediaUrl)) {
      res.status(400).send('Missing phone number or message body');
      return;
    }

    // Delegate all logic to the dispatcher (traceId flows through for correlation)
    await dispatch(phoneNumber, body, messageSid, { numMedia, mediaUrl }, traceId);

    // Twilio expects a valid TwiML response
    res.type('text/xml').send(twimlResponse(''));
  } catch (err) {
    logger.error('CRITICAL SMS DISPATCH ERROR', {
      error: err.message,
      stack: err.stack,
      request: logger.describeRequest(req.body),
      traceId,
    }, traceId);
    res.status(500).send('Internal Error');
  }
}

// Routes with Signature Validation
app.post('/', (req, res, next) => {
  if (validateTwilioSignature(req)) return next();
  res.status(403).send('Forbidden');
}, handleSmsRequest);

// Export 2nd Gen Function
exports.sms = onRequest({
  secrets: [geminiApiKey, twilioAuthToken, twilioAccountSid, twilioPhoneNumber],
  memory: '512MiB', // 256MiB default ran out under load (dropped trip texts)
  concurrency: 50, // Optimize costs by handling more requests on one instance
  maxInstances: 10,
}, app);
