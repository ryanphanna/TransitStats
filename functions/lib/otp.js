const { randomInt } = require('crypto');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_DAILY_LIMIT = 5;
const OTP_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizePhoneNumber(phone) {
  const cleaned = (phone || '').trim().replace(/[^\d]/g, '');
  if (cleaned.length === 10) return '+1' + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return '+' + cleaned;
  return '+' + cleaned;
}

function createOtpHandlers({ db, adminAuth, sendSmsReply, verifyTurnstile, logger }) {
  async function isAdminPhone(phoneDoc) {
    const data = phoneDoc.data() || {};
    if (data.userId) {
      const profile = await db.collection('profiles').doc(data.userId).get();
      if (profile.exists && profile.data()?.isAdmin === true) return true;
    }

    if (data.email) {
      const allowedUser = await db.collection('allowedUsers').doc(String(data.email).toLowerCase()).get();
      return allowedUser.exists && allowedUser.data()?.isAdmin === true;
    }

    return false;
  }

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

      const isAdmin = await isAdminPhone(phoneDoc);
      const verificationRef = db.collection('phoneLoginVerification').doc(phoneNumber);
      const limitRef = db.collection('phoneLoginOtpLimits').doc(phoneNumber);
      const code = randomInt(100000, 1000000).toString();
      const expiresAt = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));
      let secondsRemaining = 0;
      let dailyLimitReached = false;
      const reservedSentAt = Date.now() + Math.random();

      await db.runTransaction(async transaction => {
        const existingVerification = await transaction.get(verificationRef);
        const lastSentAt = existingVerification.exists ? existingVerification.data().sentAt : null;
        if (!isAdmin && lastSentAt?.toDate) {
          secondsRemaining = Math.ceil((lastSentAt.toDate().getTime() + OTP_RESEND_COOLDOWN_MS - Date.now()) / 1000);
          if (secondsRemaining > 0) return;
        }

        if (!isAdmin) {
          const existingLimit = await transaction.get(limitRef);
          const sentAt = existingLimit.exists ? existingLimit.data().sentAt : [];
          const recentSentAt = Array.isArray(sentAt)
            ? sentAt.filter(value => Number(value) > Date.now() - OTP_LIMIT_WINDOW_MS)
            : [];
          if (recentSentAt.length >= OTP_DAILY_LIMIT) {
            dailyLimitReached = true;
            return;
          }

          transaction.set(limitRef, {
            sentAt: [...recentSentAt, reservedSentAt],
            updatedAt: Timestamp.now(),
          });
        }

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

      const message = `Your TransitStats login verification code is: ${code}.\n\n@transitstats.fyi #${code}`;
      const smsSent = await sendSmsReply(phoneNumber, message);
      if (!smsSent) {
        await verificationRef.delete();
        if (!isAdmin) {
          await limitRef.update({ sentAt: FieldValue.arrayRemove(reservedSentAt) }).catch(() => {});
        }
        logger.error('OTP Request failed: Twilio send failed', { phoneNumber, traceId }, traceId);
        res.status(500).json({ error: 'Failed to send SMS verification code. Please try again.' });
        return;
      }

      logger.info('OTP code sent successfully', { phoneNumber, traceId }, traceId);
      res.status(200).json({ success: true, isAdmin });
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
