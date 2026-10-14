const twilio = require('twilio');
const { defineSecret } = require('firebase-functions/params');
const { escapeXml } = require('./utils');
const { AsyncLocalStorage } = require('async_hooks');

// API context storage to intercept Twilio SMS replies
const apiContextStorage = new AsyncLocalStorage();

// Test mode: captured replies accumulate here instead of being sent via Twilio.
const _testReplies = [];
function getCapturedReplies() { return [..._testReplies]; }
function clearCapturedReplies() { _testReplies.length = 0; }

const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');
const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioPhoneNumber = defineSecret('TWILIO_PHONE_NUMBER');

/**
 * Get Twilio client. Returns null if credentials are not configured.
 * @returns {twilio.Twilio|null}
 */
function getTwilioClient() {
  try {
    const accountSid = twilioAccountSid.value();
    const authToken = twilioAuthToken.value();

    if (!accountSid || !authToken) {
      console.error('Twilio credentials missing.',
        { hasSid: !!accountSid, hasToken: !!authToken });
      return null;
    }

    return twilio(accountSid, authToken);
  } catch (error) {
    console.error('Error initializing Twilio client:', error);
    return null;
  }
}

/**
 * Get the Twilio phone number to send from
 * @returns {string|null}
 */
function getTwilioPhoneNumber() {
  return twilioPhoneNumber.value();
}

function getMessagingServiceSid() {
  return null;
}

/**
 * Send an SMS reply via Twilio
 * @param {string} to - Recipient phone number
 * @param {string} message - Message body
 * @returns {Promise<boolean>} success status
 */
async function sendSmsReply(to, message) {
  // Check if we are running in an API request context
  const apiContext = apiContextStorage.getStore();
  if (apiContext && apiContext.isApiRequest) {
    apiContext.replies.push(message);
    console.log(`[API Request] Intercepted SMS to ${to}: ${message}`);
    return true;
  }

  if (process.env.TS_TEST_MODE) {
    _testReplies.push({ to, message });
    return true;
  }

  const client = getTwilioClient();
  const messagingServiceSid = getMessagingServiceSid();
  const from = getTwilioPhoneNumber();

  if (!client || (!messagingServiceSid && !from)) {

    console.error('Cannot send message - Twilio not configured');
    return false;
  }

  // Prefer Messaging Service SID: enables automatic RCS upgrade with SMS fallback.
  // Fall back to direct phone number for accounts without a Messaging Service.
  const msgParams = messagingServiceSid
    ? { body: message, messagingServiceSid, to }
    : { body: message, from, to };

  try {
    await client.messages.create(msgParams);
    console.log(`Message sent via ${messagingServiceSid ? 'Messaging Service (RCS/SMS)' : 'direct SMS'}`);
    await logOutboundMessage(message);
    return true;
  } catch (error) {
    console.error('Error sending message:', error);
    // 21610: the recipient replied STOP. Remember it so we never text them again.
    if (error?.code === 21610) await recordOptOut(to);
    return false;
  }
}

async function recordOptOut(phone) {
  try {
    const { getFirestore, FieldValue } = require('./db');
    await getFirestore().collection('smsOptOuts').doc(phone).set({ at: FieldValue.serverTimestamp(), reason: 'twilio-21610' });
  } catch (e) {
    console.error('Failed to record SMS opt-out:', e);
  }
}

/**
 * Log outbound message body hash so the dispatcher can detect loops.
 * @param {string} body
 */
async function logOutboundMessage(body) {
  try {
    const crypto = require('crypto');
    const { getFirestore, FieldValue, Timestamp } = require('./db');
    const db = getFirestore();
    const key = crypto.createHash('sha256').update('outbound|' + body).digest('hex');
    await db.collection('processedMessages').doc('outbound_' + key).set({
      processedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 120000)),
    });
  } catch (e) {
    console.error('Failed to log outbound message:', e);
  }
}

/**
 * Generate TwiML response (fallback if Twilio API fails)
 * @param {string} message - Message body
 * @returns {string} TwiML XML
 */
function twimlResponse(message) {
  if (!message) {
    return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(message)}</Message>
</Response>`;
}

/**
 * Middleware/Helper to validate that POST requests genuinely originate from Twilio.
 * @param {object} req - Express request
 * @returns {boolean} true if valid
 */
function validateTwilioSignature(req) {
  // Allow bypass in Firebase emulator for local development
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    console.warn('⚠️  Twilio signature validation skipped (emulator mode)');
    return true;
  }

  const authToken = twilioAuthToken.value();

  if (!authToken) {
    console.error('Twilio auth token not available');
    return false;
  }

  const twilioSignature = req.headers['x-twilio-signature'];
  if (!twilioSignature) {
    console.warn('Missing X-Twilio-Signature header');
    return false;
  }

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${protocol}://${host}${req.originalUrl}`;

  // Try the primary URL
  let isValid = twilio.validateRequest(authToken, twilioSignature, url, req.body);

  // Fallback to strict /sms URL if originalUrl fails (Firebase function rewriting)
  if (!isValid) {
    const fallbackUrl = `${protocol}://${host}/sms`;
    if (twilio.validateRequest(authToken, twilioSignature, fallbackUrl, req.body)) {
      isValid = true;
    }
  }

  if (!isValid) {
    console.warn('Invalid Twilio webhook signature');
    return false;
  }

  return true;
}

module.exports = {
  getTwilioClient,
  getTwilioPhoneNumber,
  getMessagingServiceSid,
  sendSmsReply,
  twimlResponse,
  validateTwilioSignature,
  getCapturedReplies,
  clearCapturedReplies,
  apiContextStorage,
};
