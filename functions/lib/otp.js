const { createHash, randomInt } = require('crypto');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_DAILY_LIMIT = 5;
const OTP_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
// Per-phone limits don't stop one client cycling through many registered
// numbers, so also cap sends per source IP and per day across everyone.
const OTP_IP_HOURLY_LIMIT = 10;
const OTP_IP_WINDOW_MS = 60 * 60 * 1000;
const OTP_GLOBAL_DAILY_LIMIT = 200;

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

function createOtpHandlers({ db, adminAuth, sendSmsReply, verifyTurnstile, logger }) {
  async function handleRequestOtp(req, res, traceId) {
    const phoneNumber = normalizePhoneNumber(req.body.phoneNumber);

    if (phoneNumber.length < 8) {
      res.status(400).json({ error: 'Invalid phone number format.' });
      return;
    }

    try {
      const phoneDoc = await db.collection('phoneNumbers').doc(phoneNumber).get();
      if (!phoneDoc.exists) {
        logger.warn('OTP Request denied: Phone number not registered', { phoneNumber, traceId }, traceId);
        res.status(400).json({
          error: 'This phone number is not registered. Please register your number via SMS first.',
        });
        return;
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
      const reservedSentAt = Date.now() + Math.random();

      await db.runTransaction(async transaction => {
        const existingVerification = await transaction.get(verificationRef);
        const lastSentAt = existingVerification.exists ? existingVerification.data().sentAt : null;
        if (lastSentAt?.toDate) {
          secondsRemaining = Math.ceil((lastSentAt.toDate().getTime() + OTP_RESEND_COOLDOWN_MS - Date.now()) / 1000);
          if (secondsRemaining > 0) return;
        }

        const existingLimit = await transaction.get(limitRef);
        const existingIpLimit = await transaction.get(ipRef);
        const existingGlobal = await transaction.get(globalRef);
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

        const globalCount = existingGlobal.exists ? Number(existingGlobal.data().count || 0) : 0;
        if (globalCount >= OTP_GLOBAL_DAILY_LIMIT) {
          globalLimitReached = true;
          return;
        }

        transaction.set(ipRef, {
          sentAt: [...recentIpSentAt, reservedSentAt],
          updatedAt: Timestamp.now(),
        });
        transaction.set(globalRef, { count: globalCount + 1, updatedAt: Timestamp.now() });
        transaction.set(limitRef, {
          sentAt: [...recentSentAt, reservedSentAt],
          updatedAt: Timestamp.now(),
        });

        transaction.set(verificationRef, {
          code,
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

      if (globalLimitReached) {
        logger.error('OTP Request blocked: global daily send cap reached', { cap: OTP_GLOBAL_DAILY_LIMIT, traceId }, traceId);
        res.status(429).json({ error: 'Text sign-in is temporarily unavailable. Try again tomorrow.' });
        return;
      }

      const message = `Your TransitStats login verification code is: ${code}.\n\nThis code expires in 10 minutes.\n\n@transitstats.fyi #${code}`;
      const smsSent = await sendSmsReply(phoneNumber, message);
      if (!smsSent) {
        await verificationRef.delete();
        await limitRef.update({ sentAt: FieldValue.arrayRemove(reservedSentAt) }).catch(() => {});
        await ipRef.update({ sentAt: FieldValue.arrayRemove(reservedSentAt) }).catch(() => {});
        await globalRef.update({ count: FieldValue.increment(-1) }).catch(() => {});
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
      const verifyDoc = await verifyRef.get();
      if (!verifyDoc.exists) {
        res.status(400).json({ error: 'No pending verification found. Please request a new code.' });
        return;
      }

      const verifyData = verifyDoc.data();
      if (verifyData.expiresAt.toDate() < new Date()) {
        await verifyRef.delete();
        res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
        return;
      }

      if (verifyData.attempts >= 3) {
        await verifyRef.delete();
        res.status(400).json({ error: 'Too many failed verification attempts. Please request a new code.' });
        return;
      }

      if (verifyData.code !== code) {
        await verifyRef.update({ attempts: FieldValue.increment(1) });
        res.status(400).json({ error: 'Invalid verification code.' });
        return;
      }

      await verifyRef.delete();
      const phoneDoc = await db.collection('phoneNumbers').doc(phoneNumber).get();
      if (!phoneDoc.exists) {
        res.status(400).json({ error: 'Registration record not found for this phone number.' });
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
      logger.info('OTP verification successful. Minted custom token.', { phoneNumber, userId, traceId }, traceId);
      res.status(200).json({ success: true, token: customToken });
    } catch (error) {
      logger.error('Error in verify_otp handler', { error: error.message, phoneNumber, traceId }, traceId);
      res.status(500).json({ error: 'Internal Server Error', traceId });
    }
  }

  return { handleRequestOtp, handleVerifyOtp };
}

module.exports = { createOtpHandlers, normalizePhoneNumber };
