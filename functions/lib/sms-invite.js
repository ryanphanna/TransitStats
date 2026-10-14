/**
 * Text-first setup for invited people.
 *
 * An admin adds a `phone` (E.164) to an allowedUsers/{email} entry. From then on:
 *  - a welcome text goes out once per number (onInvitePhoneWritten), and
 *  - when that number texts us before it has an account, we create or find the
 *    Firebase Auth user for that email, create the profile, link the phone and
 *    email a website sign-in link (handleUnknownSender).
 *
 * Safety notes:
 *  - Accounts are resolved through Firebase Auth, never through profile fields.
 *  - A spoofed sender can at most link the invited phone to the invited account
 *    early. It gets no data: replies, the sign-in link and OTP login codes all
 *    go to the real phone / real email.
 *  - Nothing here tells the user they were "invited" in user-facing text.
 */
const { normalizePhoneNumber } = require('./otp');

const WELCOME_TEXT = [
  'Next stop: TransitStats. You\'re in! Two ways to add trips:',
  '1. Text them here as you ride, like \'504 King to Spadina\'',
  '2. Import your PRESTO history at transitstats.fyi/import',
  'Reply STOP to opt out.',
].join('\n');

const SETUP_TEXT = 'You\'re all set! Text your trips here as you ride, like \'504 King to Spadina\'. '
  + 'We also emailed you a link to sign in on the website.';
const CONFIRM_TEXT = 'Almost there! We emailed a 6-digit code to the address on your account. Reply with it to finish setting up.';
const SETUP_PROBLEM_TEXT = 'We couldn\'t finish setting up this number. Please contact us for help.';
const NOT_INVITED_TEXT = 'This number isn\'t linked to a TransitStats account yet. Text REGISTER and your account email to link it.';
const SIGN_IN_URL = 'https://transitstats.fyi/import';
const PROVISIONED_CLAIM = 'smsInviteProvisioned';

function createInviteHandlers({
  db, adminAuth, sendSmsReply, shouldRespondToUnknown, FieldValue, logger,
  storeVerificationCode, setPendingState, generateVerificationCode,
}) {
  const log = logger || { info() {}, warn() {}, error() {} };

  async function isOptedOut(phone) {
    return (await db.collection('smsOptOuts').doc(phone).get()).exists;
  }

  async function markOptedOut(phone, reason = 'twilio-21610') {
    await db.collection('smsOptOuts').doc(phone).set({ at: FieldValue.serverTimestamp(), reason });
  }

  // Phone must identify exactly one invite; two entries with the same number
  // would let the wrong person's account be set up, so treat that as no match.
  async function findInviteByPhone(phone) {
    const snapshot = await db.collection('allowedUsers').where('phone', '==', phone).limit(2).get();
    if (snapshot.docs.length !== 1) {
      if (snapshot.docs.length > 1) log.warn('Multiple invites share a phone number; ignoring', { phone });
      return null;
    }
    return { email: String(snapshot.docs[0].id).toLowerCase(), data: snapshot.docs[0].data() };
  }

  async function getOrCreateAuthUser(email) {
    try {
      const existing = await adminAuth.getUserByEmail(email);
      // Verified accounts are theirs. An unverified one is only ours if we made
      // it (custom claim): otherwise someone could have pre-registered the
      // invited address to capture the phone link.
      const provisionedByUs = existing.customClaims?.[PROVISIONED_CLAIM] === true;
      if (!existing.emailVerified && !provisionedByUs) return { error: 'unverified-existing' };
      // A verified account may hold someone's data: linking a phone to it needs
      // the email owner's confirmation. One we created (unverified, our claim)
      // is still empty and handled like a brand-new account.
      return { uid: existing.uid, needsConfirmation: existing.emailVerified === true };
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
    const created = await adminAuth.createUser({ email, emailVerified: false });
    await adminAuth.setCustomUserClaims(created.uid, { [PROVISIONED_CLAIM]: true });
    return { uid: created.uid, needsConfirmation: false };
  }

  async function ensureProfile(uid, email) {
    const ref = db.collection('profiles').doc(uid);
    if ((await ref.get()).exists) return;
    await ref.set({
      userId: uid,
      email,
      displayName: 'Traveler',
      defaultAgency: null,
      defaultAgencyMode: 'automatic',
      primaryAgency: null,
      isPremium: false,
      isAdmin: false,
      isPublic: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  async function sendSignInEmail(email) {
    const link = await adminAuth.generateSignInWithEmailLink(email, { url: SIGN_IN_URL, handleCodeInApp: true });
    await db.collection('mail').add({
      to: email,
      message: {
        subject: 'Your TransitStats sign-in link',
        text: `Your TransitStats account is ready. Open this link to sign in on the website:\n\n${link}\n\nYou can also just text your trips to our number.`,
        html: `<p>Your TransitStats account is ready. <a href="${link}">Sign in on the website</a>.</p><p>You can also just text your trips to our number.</p>`,
      },
    });
  }

  // Same proof REGISTER asks for: a code sent to the account's own email,
  // replied to from this phone. Replying runs through handleVerificationCode,
  // which links by Firebase Auth lookup and is attempt-limited.
  async function startPhoneConfirmation(phoneNumber, email) {
    const code = generateVerificationCode();
    await storeVerificationCode(phoneNumber, email, code, 20 * 60 * 1000);
    await db.collection('mail').add({
      to: email,
      message: {
        subject: 'Your TransitStats text code',
        text: `Your code is: ${code}\n\nReply to the text message with this code to finish connecting your phone. If this wasn't you, ignore this email.`,
        html: `<p>Your code is: <strong>${code}</strong></p><p>Reply to the text message with this code to finish connecting your phone. If this wasn't you, ignore this email.</p>`,
      },
    });
    await setPendingState(phoneNumber, { type: 'awaiting_verification', email }, 20 * 60 * 1000);
  }

  /**
   * An unlinked number texted us. Returns true when it was handled (replied or
   * deliberately ignored), so the dispatcher stops there.
   */
  async function handleUnknownSender(phoneNumber, traceId = null) {
    const invite = await findInviteByPhone(phoneNumber);

    if (!invite) {
      // Not invited: one short reply, rate-limited per number.
      if (await shouldRespondToUnknown(phoneNumber)) {
        await sendSmsReply(phoneNumber, NOT_INVITED_TEXT);
      }
      return true;
    }

    // Setup is idempotent and rate-limited by the same per-number counter, so
    // a number can't be used to make us send repeated emails.
    if (!(await shouldRespondToUnknown(phoneNumber))) return true;

    const account = await getOrCreateAuthUser(invite.email);
    if (account.error) {
      log.warn('Invite setup refused: existing unverified account', { email: invite.email, traceId });
      await sendSmsReply(phoneNumber, SETUP_PROBLEM_TEXT);
      return true;
    }

    if (account.needsConfirmation) {
      await startPhoneConfirmation(phoneNumber, invite.email);
      await sendSmsReply(phoneNumber, CONFIRM_TEXT);
      return true;
    }

    await ensureProfile(account.uid, invite.email);

    // Never overwrite an existing link (a race, or the number already belongs
    // to someone): create-only.
    try {
      await db.collection('phoneNumbers').doc(phoneNumber).create({
        userId: account.uid,
        email: invite.email,
        registeredAt: FieldValue.serverTimestamp(),
        source: 'invite',
        // Texting trips works right away, but phone-code LOGIN stays off until
        // the email owner signs in on the website (a recycled or mistyped
        // number must not unlock an account the invitee later fills).
        loginConfirmed: false,
      });
    } catch (error) {
      if (error?.code !== 6 && !/already exists/i.test(error?.message || '')) throw error;
      log.info('Phone already linked during invite setup', { traceId });
      return true;
    }

    try {
      await sendSignInEmail(invite.email);
    } catch (error) {
      log.error('Invite sign-in email failed', { error: error.message, traceId });
    }
    await sendSmsReply(phoneNumber, SETUP_TEXT);
    return true;
  }

  /**
   * Welcome text, at most once per number. The marker is written first so a
   * retry or duplicate trigger can't send twice; opted-out numbers are skipped.
   */
  async function sendWelcomeOnce(phone, email) {
    if (!phone) return 'no-phone';
    if (await isOptedOut(phone)) return 'opted-out';
    const marker = db.collection('smsWelcomes').doc(phone);
    try {
      await marker.create({ email, startedAt: FieldValue.serverTimestamp() });
    } catch (error) {
      if (error?.code === 6 || /already exists/i.test(error?.message || '')) return 'already-sent';
      throw error;
    }
    const sent = await sendSmsReply(phone, WELCOME_TEXT);
    if (!sent) {
      // Allow a later phone edit to retry if Twilio refused the send.
      await marker.delete().catch(() => {});
      return 'send-failed';
    }
    await marker.update({ sentAt: FieldValue.serverTimestamp() });
    return 'sent';
  }

  /** Trigger body for allowedUsers/{email} writes. */
  async function onInvitePhoneWritten({ email, before, after }) {
    const next = after?.phone ? normalizePhoneNumber(after.phone) : null;
    const previous = before?.phone ? normalizePhoneNumber(before.phone) : null;
    if (!next || next === previous) return 'unchanged';
    return sendWelcomeOnce(next, String(email).toLowerCase());
  }

  return { findInviteByPhone, startPhoneConfirmation, handleUnknownSender, sendWelcomeOnce, onInvitePhoneWritten, isOptedOut, markOptedOut };
}

module.exports = {
  createInviteHandlers,
  WELCOME_TEXT,
  SETUP_TEXT,
  CONFIRM_TEXT,
  NOT_INVITED_TEXT,
  SETUP_PROBLEM_TEXT,
  PROVISIONED_CLAIM,
};
