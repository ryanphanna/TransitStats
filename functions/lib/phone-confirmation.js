/**
 * A number linked from an invite text starts unconfirmed (loginConfirmed ===
 * false). Until the email owner proves they hold that phone by replying with a
 * code emailed to the account, the number may only log trips. Links with the
 * field missing (REGISTER, older links) or true count as confirmed.
 */

// Every reply an unconfirmed number can get lives in sms-text.js; re-exported
// here for existing callers.
const {
  UNLOCK_PROMPT_TEXT,
  UNLOCK_UNAVAILABLE_TEXT,
  UNLOCKED_TEXT,
  EMAIL_NOT_FOUND_TEXT,
  LINKED_NEUTRAL_TEXT,
  OTP_UNCONFIRMED_TEXT,
  LOCKED_TRIP_TEXT,
} = require('./sms-text');

const { createHmac } = require('crypto');

function isPhoneConfirmed(link) {
  return link?.loginConfirmed !== false;
}

// Stored on trips started by a real inbound text, so an unconfirmed number can
// only end a trip that it started itself. It is a keyed hash (HMAC-SHA256), not
// the number, and the key is derived from the Twilio auth token, a secret every
// function that handles texts already has. Fails closed: with no secret, or for
// an app identity ("web:<uid>"), there is no tag, so no trip is owned by any number.
function phoneTag(phoneNumber) {
  const secret = process.env.TWILIO_AUTH_TOKEN;
  const phone = String(phoneNumber || '');
  if (!secret || !phone || phone.startsWith('web:')) return null;
  const key = createHmac('sha256', secret).update('transitstats:source-phone:v1').digest();
  return createHmac('sha256', key).update(phone).digest('hex').slice(0, 32);
}

// True only when this number really started the trip.
function tripStartedByPhone(trip, phoneNumber) {
  const tag = phoneTag(phoneNumber);
  return tag !== null && typeof trip?.sourcePhone === 'string' && trip.sourcePhone === tag;
}

module.exports = { EMAIL_NOT_FOUND_TEXT, UNLOCKED_TEXT, LINKED_NEUTRAL_TEXT, phoneTag, tripStartedByPhone, LOCKED_TRIP_TEXT, UNLOCK_PROMPT_TEXT, UNLOCK_UNAVAILABLE_TEXT, OTP_UNCONFIRMED_TEXT, isPhoneConfirmed };
