/**
 * A number linked from an invite text starts unconfirmed (loginConfirmed ===
 * false). Until the email owner proves they hold that phone by replying with a
 * code emailed to the account, the number may only log trips. Links with the
 * field missing (REGISTER, older links) or true count as confirmed.
 */

// Every reply an unconfirmed number can get, in one place.
const UNLOCK_PROMPT_TEXT = 'We emailed you a code. Reply with it to unlock that.';
const UNLOCK_UNAVAILABLE_TEXT = 'That isn\'t available on this number yet.';
const OTP_UNCONFIRMED_TEXT = 'This number isn\'t unlocked yet. Text us, then reply with the code we email you.';

function isPhoneConfirmed(link) {
  return link?.loginConfirmed !== false;
}

module.exports = { UNLOCK_PROMPT_TEXT, UNLOCK_UNAVAILABLE_TEXT, OTP_UNCONFIRMED_TEXT, isPhoneConfirmed };
