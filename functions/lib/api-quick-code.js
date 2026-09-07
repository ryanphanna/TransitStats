const { generateVerificationCode } = require('./utils');

const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Mints a one-time SMS quick-link code for the authenticated caller. The
 * code is later consumed by handleQuickLinkCode when it arrives as a text
 * from an unregistered phone number (see dispatcher.js).
 */
function createQuickCodeHandler({ db, Timestamp, logger, getTwilioPhoneNumber }) {
  return async function handleGenerateSmsQuickCode(req, res, { uid, email, traceId }) {
    if (!email) {
      res.status(400).json({ error: 'No email on account' });
      return;
    }

    const allowedDoc = await db.collection('allowedUsers').doc(email.toLowerCase()).get();
    if (!allowedDoc.exists) {
      logger.warn('SMS quick-code denied: not whitelisted', { email, traceId }, traceId);
      res.status(403).json({ error: 'Access denied: User is not whitelisted' });
      return;
    }

    const existingPhone = await db.collection('phoneNumbers').where('userId', '==', uid).limit(1).get();
    if (!existingPhone.empty) {
      res.status(400).json({ error: 'A phone number is already linked to this account.' });
      return;
    }

    let code = null;
    for (let attempt = 0; attempt < 5 && !code; attempt++) {
      const candidate = generateVerificationCode();
      const ref = db.collection('smsQuickCodes').doc(candidate);
      const created = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (snap.exists) return false;
        transaction.set(ref, {
          userId: uid,
          email: email.toLowerCase(),
          expiresAt: Timestamp.fromDate(new Date(Date.now() + CODE_TTL_MS)),
        });
        return true;
      });
      if (created) code = candidate;
    }

    if (!code) {
      logger.error('SMS quick-code generation failed after retries', { uid, traceId }, traceId);
      res.status(500).json({ error: 'Could not generate a code, try again.' });
      return;
    }

    logger.info('SMS quick-code generated', { uid, traceId }, traceId);
    res.status(200).json({
      code,
      smsNumber: getTwilioPhoneNumber(),
      expiresInSeconds: CODE_TTL_MS / 1000,
    });
  };
}

module.exports = { createQuickCodeHandler };
