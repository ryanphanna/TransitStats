const { createHash, randomInt } = require('crypto');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const { OTP_UNCONFIRMED_TEXT: PHONE_LOGIN_UNCONFIRMED, isPhoneConfirmed } = require('./phone-confirmation');
// Roughly the latency of one Twilio send.
const DECOY_DELAY_MIN_MS = 300;
const DECOY_DELAY_SPREAD_MS = 500;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_DAILY_LIMIT = 5;
const OTP_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
// Per-phone limits don't stop one client cycling through many registered
// numbers, so also cap sends per source IP and per day across everyone.
const OTP_IP_HOURLY_LIMIT = 10;
const OTP_IP_WINDOW_MS = 60 * 60 * 1000;
// The daily cap guards Twilio spend: 200 texts a day in total. 150 are shared
// by everyone; the last 50 only go to numbers that completed a text sign-in in
// the last 30 days, so someone who knows enough linked numbers to use up the
// shared part can't lock everyone out. An attacker can take at most
// 5 (OTP_DAILY_LIMIT) x (recently active numbers) from the reserve, so 50 holds
// while fewer than 10 numbers are active. Revisit it if text sign-in grows past
// about 10 active numbers.
const OTP_GLOBAL_SHARED_LIMIT = 150;
const OTP_GLOBAL_RESERVE_LIMIT = 50;
const OTP_GLOBAL_DAILY_LIMIT = OTP_GLOBAL_SHARED_LIMIT + OTP_GLOBAL_RESERVE_LIMIT;
const OTP_RESERVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Cloud Functions sits behind Google's frontend, which appends the real peer
// address as the LAST X-Forwarded-For entry. Earlier entries are whatever the
// client sent and can be spoofed, so never use the first one (or req.ip, which
// follows the first entry when proxies are trusted).
function getTrustedClientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded.join(',') : String(forwarded || '');
  const entries = header.split(',').map(entry => entry.trim()).filter(Boolean);
  return entries.length ? entries[entries.length - 1] : (req?.socket?.remoteAddress || 'unknown');
}

function ipLimitKey(ip) {
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

function normalizePhoneNumber(phone) {
  const cleaned = (phone || '').trim().replace(/[^\d]/g, '');
  if (cleaned.length === 10) return '+1' + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return '+' + cleaned;
  return '+' + cleaned;
}

function createOtpHandlers({ db, adminAuth, sendSmsReply, verifyTurnstile, getTurnstileMode, logger }) {
  async function handleRequestOtp(req, res, traceId) {
    const phoneNumber = normalizePhoneNumber(req.body.phoneNumber);

    if (phoneNumber.length < 8) {
      res.status(400).json({ error: 'Invalid phone number format.' });
      return;
    }

    try {
      // Bot check runs before anything else, so a failed request never looks
      // up the number or uses up a limit slot, and every number gets the same
      // answer. 'monitor' mode only logs; 'enforce' blocks.
      const turnstileMode = await getTurnstileMode();
      const turnstile = await verifyTurnstile(req.body.turnstileToken, getTrustedClientIp(req));
      if (!turnstile.success) {
        // Log the page's origin too: the widget only issues tokens on hostnames
        // allowed in the Cloudflare dashboard, so a login page served elsewhere
        // shows up here as missing_token.
        const origin = String(req.headers?.origin || 'none').slice(0, 100);
        if (turnstileMode === 'enforce') {
          // logger.warn only prints the message, so the reason goes in it.
          logger.warn(`OTP Request blocked: Turnstile check failed (${turnstile.reason}, origin ${origin})`, traceId);
          res.status(403).json({ error: 'Security check failed. Please refresh the page and try again.' });
          return;
        }
        logger.warn(`OTP Request Turnstile check failed (${turnstile.reason}, origin ${origin}); monitor mode, allowed`, traceId);
      } else {
        logger.info('OTP Request Turnstile check passed', { mode: turnstileMode, traceId }, traceId);
      }

      // The response must not reveal whether a number is registered or confirmed.
      // Ineligible numbers go through the same limits, store a decoy record whose
      // empty code can never match, send nothing, and get the same answer.
      const phoneDoc = await db.collection('phoneNumbers').doc(phoneNumber).get();
      const eligible = phoneDoc.exists && isPhoneConfirmed(phoneDoc.data());
      if (!eligible) {
        logger.warn('OTP Request skipped: number not registered or not confirmed', { phoneNumber, traceId }, traceId);
      }

      const verificationRef = db.collection('phoneLoginVerification').doc(phoneNumber);
      const limitRef = db.collection('phoneLoginOtpLimits').doc(phoneNumber);
      const code = randomInt(100000, 1000000).toString();
      const expiresAt = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));
      let secondsRemaining = 0;
      let dailyLimitReached = false;
      let ipLimitReached = false;
      let globalLimitReached = false;
      const clientIp = getTrustedClientIp(req);
      const ipRef = db.collection('phoneLoginIpLimits').doc(ipLimitKey(clientIp));
      const globalDay = new Date().toISOString().slice(0, 10);
      const globalRef = db.collection('phoneLoginGlobalLimits').doc(globalDay);
      const activityRef = db.collection('phoneLoginActivity').doc(phoneNumber);
      const reservedSentAt = Date.now() + Math.random();
      let usedReserve = false;
      let sharedFull = false;

      await db.runTransaction(async transaction => {
        // Firestore re-runs this callback when it retries a contended
        // transaction, so every outcome flag starts fresh on each attempt.
        secondsRemaining = 0;
        dailyLimitReached = false;
        ipLimitReached = false;
        globalLimitReached = false;
        usedReserve = false;
        sharedFull = false;

        const existingVerification = await transaction.get(verificationRef);
        const lastSentAt = existingVerification.exists ? existingVerification.data().sentAt : null;
        if (lastSentAt?.toDate) {
          secondsRemaining = Math.ceil((lastSentAt.toDate().getTime() + OTP_RESEND_COOLDOWN_MS - Date.now()) / 1000);
          if (secondsRemaining > 0) return;
        }

        const existingLimit = await transaction.get(limitRef);
        const existingIpLimit = await transaction.get(ipRef);
        const existingGlobal = await transaction.get(globalRef);
        const existingActivity = await transaction.get(activityRef);
        const sentAt = existingLimit.exists ? existingLimit.data().sentAt : [];
        const recentSentAt = Array.isArray(sentAt)
          ? sentAt.filter(value => Number(value) > Date.now() - OTP_LIMIT_WINDOW_MS)
          : [];
        if (recentSentAt.length >= OTP_DAILY_LIMIT) {
          dailyLimitReached = true;
          return;
        }

        const ipSentAt = existingIpLimit.exists ? existingIpLimit.data().sentAt : [];
        const recentIpSentAt = Array.isArray(ipSentAt)
          ? ipSentAt.filter(value => Number(value) > Date.now() - OTP_IP_WINDOW_MS)
          : [];
        if (recentIpSentAt.length >= OTP_IP_HOURLY_LIMIT) {
          ipLimitReached = true;
          return;
        }

        // A decoy sends nothing, so it never uses up the cap (it still counts
        // toward the IP limit). But once the shared part is full, every number
        // that can't use the reserve gets the same answer, registered or not.
        const globalData = existingGlobal.exists ? existingGlobal.data() : {};
        const sharedCount = Number(globalData.count || 0);
        const reserveCount = Number(globalData.reserveCount || 0);
        if (sharedCount >= OTP_GLOBAL_SHARED_LIMIT) {
          sharedFull = true;
          const lastVerifiedAt = existingActivity.exists ? existingActivity.data().lastVerifiedAt : null;
          const recentlyActive = eligible && typeof lastVerifiedAt?.toMillis === 'function'
            && lastVerifiedAt.toMillis() > Date.now() - OTP_RESERVE_WINDOW_MS;
          if (!recentlyActive || reserveCount >= OTP_GLOBAL_RESERVE_LIMIT) {
            globalLimitReached = true;
            return;
          }
          usedReserve = true;
        }

        transaction.set(ipRef, {
          sentAt: [...recentIpSentAt, reservedSentAt],
          updatedAt: Timestamp.now(),
        });
        if (eligible) {
          transaction.set(globalRef, {
            count: usedReserve ? sharedCount : sharedCount + 1,
            reserveCount: usedReserve ? reserveCount + 1 : reserveCount,
            updatedAt: Timestamp.now(),
          });
        }
        transaction.set(limitRef, {
          sentAt: [...recentSentAt, reservedSentAt],
          updatedAt: Timestamp.now(),
        });

        transaction.set(verificationRef, {
          code: eligible ? code : '',
          expiresAt,
          attempts: 0,
          sentAt: Timestamp.now(),
        });
      });

      if (secondsRemaining > 0) {
        res.status(429).json({ error: `Please wait ${secondsRemaining} seconds before requesting another code.` });
        return;
      }

      if (dailyLimitReached) {
        res.status(429).json({ error: 'Daily text limit reached. Try again tomorrow.' });
        return;
      }

      if (ipLimitReached) {
        logger.warn('OTP Request blocked: per-IP hourly limit reached', { phoneNumber, traceId }, traceId);
        res.status(429).json({ error: 'Too many text requests. Try again later.' });
        return;
      }

      if (sharedFull) {
        const capMessage = 'OTP Request: shared daily send cap reached (possible attack); '
          + 'only recent text sign-ins get codes';
        logger.error(capMessage, {
          sharedCap: OTP_GLOBAL_SHARED_LIMIT,
          reserveCap: OTP_GLOBAL_RESERVE_LIMIT,
          usedReserve,
          blocked: globalLimitReached,
          traceId,
        }, traceId);
      }

      if (globalLimitReached) {
        res.status(429).json({ error: 'Text sign-in is temporarily unavailable. Try again tomorrow.' });
        return;
      }

      if (!eligible) {
        // Take about as long as a real send, so timing doesn't give the number away.
        await new Promise(resolve => setTimeout(resolve, DECOY_DELAY_MIN_MS + Math.random() * DECOY_DELAY_SPREAD_MS));
        res.status(200).json({ success: true });
        return;
      }

      const message = `Your TransitStats login verification code is: ${code}.\n\nThis code expires in 10 minutes.\n\n@transitstats.fyi #${code}`;
      const smsSent = await sendSmsReply(phoneNumber, message);
      if (!smsSent) {
        await verificationRef.delete();
        await limitRef.update({ sentAt: FieldValue.arrayRemove(reservedSentAt) }).catch(() => {});
        await ipRef.update({ sentAt: FieldValue.arrayRemove(reservedSentAt) }).catch(() => {});
        const globalField = usedReserve ? 'reserveCount' : 'count';
        await globalRef.update({ [globalField]: FieldValue.increment(-1) }).catch(() => {});
        logger.error('OTP Request failed: Twilio send failed', { phoneNumber, traceId }, traceId);
        res.status(500).json({ error: 'Failed to send SMS verification code. Please try again.' });
        return;
      }

      logger.info('OTP code sent successfully', { phoneNumber, traceId }, traceId);
      res.status(200).json({ success: true });
    } catch (error) {
      logger.error('Error in request_otp handler', { error: error.message, phoneNumber, traceId }, traceId);
      res.status(500).json({ error: 'Internal Server Error', traceId });
    }
  }

  async function handleVerifyOtp(req, res, traceId) {
    const phoneNumber = normalizePhoneNumber(req.body.phoneNumber);
    const code = (req.body.code || '').trim();

    if (!code) {
      res.status(400).json({ error: 'Missing verification code.' });
      return;
    }

    try {
      const verifyRef = db.collection('phoneLoginVerification').doc(phoneNumber);
      // Check, count and consume the code in ONE transaction. Done as separate
      // reads and writes, parallel guesses all saw the same attempts value and
      // could exceed the 3-attempt limit (or reuse one correct code twice).
      const outcome = await db.runTransaction(async transaction => {
        const verifyDoc = await transaction.get(verifyRef);
        if (!verifyDoc.exists) return 'missing';
        const verifyData = verifyDoc.data();
        if (verifyData.expiresAt.toDate() < new Date()) {
          transaction.delete(verifyRef);
          return 'expired';
        }
        if (verifyData.attempts >= 3) {
          transaction.delete(verifyRef);
          return 'locked';
        }
        if (verifyData.code !== code) {
          transaction.update(verifyRef, { attempts: FieldValue.increment(1) });
          return 'invalid';
        }
        transaction.delete(verifyRef);
        return 'ok';
      });

      const failures = {
        missing: 'No pending verification found. Please request a new code.',
        expired: 'Verification code has expired. Please request a new one.',
        locked: 'Too many failed verification attempts. Please request a new code.',
        invalid: 'Invalid verification code.',
      };
      if (outcome !== 'ok') {
        res.status(400).json({ error: failures[outcome] });
        return;
      }

      const phoneDoc = await db.collection('phoneNumbers').doc(phoneNumber).get();
      if (!phoneDoc.exists) {
        res.status(400).json({ error: 'Registration record not found for this phone number.' });
        return;
      }
      if (!isPhoneConfirmed(phoneDoc.data())) {
        res.status(400).json({ error: PHONE_LOGIN_UNCONFIRMED });
        return;
      }

      const userId = phoneDoc.data().userId;
      if (typeof userId !== 'string' || !userId.trim()) {
        res.status(400).json({ error: 'Registration record is missing its account link.' });
        return;
      }

      try {
        await adminAuth.getUser(userId);
      } catch (error) {
        if (error.code !== 'auth/user-not-found') throw error;
        await adminAuth.createUser({ uid: userId });
      }

      const customToken = await adminAuth.createCustomToken(userId);
      // Marks this number as recently active, so it can use the reserved part
      // of the daily text cap. A failure here must not block the sign-in.
      await db.collection('phoneLoginActivity').doc(phoneNumber)
        .set({ lastVerifiedAt: Timestamp.now() })
        .catch(error => logger.error('Failed to record phone sign-in activity',
          { error: error.message, traceId }, traceId));
      logger.info('OTP verification successful. Minted custom token.', { phoneNumber, userId, traceId }, traceId);
      res.status(200).json({ success: true, token: customToken });
    } catch (error) {
      logger.error('Error in verify_otp handler', { error: error.message, phoneNumber, traceId }, traceId);
      res.status(500).json({ error: 'Internal Server Error', traceId });
    }
  }

  return { handleRequestOtp, handleVerifyOtp };
}

module.exports = {
  createOtpHandlers,
  normalizePhoneNumber,
  OTP_GLOBAL_SHARED_LIMIT,
  OTP_GLOBAL_RESERVE_LIMIT,
  OTP_GLOBAL_DAILY_LIMIT,
};
