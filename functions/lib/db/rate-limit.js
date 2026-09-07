/**
 * Rate limiting, idempotency, and deduplication
 */
const crypto = require('crypto');
const { db, FieldValue, Timestamp } = require('./core');
const logger = require('../logger');

async function isRateLimited(phoneNumber) {
  if (process.env.TS_TEST_MODE) return false;
  const rateLimitRef = db.collection('rateLimits').doc(phoneNumber);
  const doc = await rateLimitRef.get();
  const now = new Date();

  const windowMs = 60 * 1000;
  const maxRequests = 8;

  if (!doc.exists) {
    await rateLimitRef.set({
      count: 1,
      resetAt: Timestamp.fromDate(new Date(now.getTime() + windowMs)),
    });
    return false;
  }

  const data = doc.data();
  const resetAt = data.resetAt.toDate();

  if (now >= resetAt) {
    await rateLimitRef.set({
      count: 1,
      resetAt: Timestamp.fromDate(new Date(now.getTime() + windowMs)),
    });
    return false;
  }

  if (data.count >= maxRequests) {
    console.log(`Rate limit exceeded for ${phoneNumber}: ${data.count} requests within 1 minute.`);
    return true;
  }

  await rateLimitRef.update({ count: FieldValue.increment(1) });
  return false;
}

async function isGeminiRateLimited(phoneNumber, isPremium = false, isAdmin = false) {
  if (isAdmin) return false;
  const limit = isPremium ? 50 : 10;
  const rateLimitRef = db.collection('geminiRateLimits').doc(phoneNumber);
  const doc = await rateLimitRef.get();
  const now = new Date();

  if (!doc.exists) {
    await rateLimitRef.set({
      count: 1,
      resetAt: Timestamp.fromDate(new Date(now.getTime() + 60 * 60 * 1000)),
    });
    return false;
  }

  const data = doc.data();
  const resetAt = data.resetAt.toDate();

  if (now >= resetAt) {
    await rateLimitRef.set({
      count: 1,
      resetAt: Timestamp.fromDate(new Date(now.getTime() + 60 * 60 * 1000)),
    });
    return false;
  }

  if (data.count >= limit) {
    logger.info('Gemini rate limit exceeded', { From: phoneNumber, isPremium, isAdmin });
    return true;
  }

  await rateLimitRef.update({ count: FieldValue.increment(1) });
  return false;
}

async function shouldRespondToUnknown(phoneNumber) {
  const unknownRef = db.collection('unknownNumbers').doc(phoneNumber);
  const doc = await unknownRef.get();
  const now = new Date();

  if (!doc.exists) {
    await unknownRef.set({
      firstMessageAt: FieldValue.serverTimestamp(),
      messageCount: 1,
      resetAt: Timestamp.fromDate(new Date(now.getTime() + 60 * 60 * 1000)),
    });
    return true;
  }

  const data = doc.data();
  const resetAt = data.resetAt.toDate();

  if (now >= resetAt) {
    await unknownRef.set({
      firstMessageAt: FieldValue.serverTimestamp(),
      messageCount: 1,
      resetAt: Timestamp.fromDate(new Date(now.getTime() + 60 * 60 * 1000)),
    });
    return true;
  }

  await unknownRef.update({ messageCount: FieldValue.increment(1) });
  console.log('Ignoring repeat message from unknown number');
  return false;
}

async function checkIdempotency(messageSid) {
  if (process.env.TS_TEST_MODE) return false;
  if (!messageSid) return false;
  const msgRef = db.collection('processedMessages').doc(messageSid);
  try {
    await msgRef.create({
      processedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 3600000)),
    });
    return false;
  } catch (e) {
    if (e.code === 6) return true;
    throw e;
  }
}

async function checkContentDuplicate(phoneNumber, body) {
  if (process.env.TS_TEST_MODE) return false;
  if (!phoneNumber || !body) return false;
  const key = crypto.createHash('sha256').update(phoneNumber + '|' + body).digest('hex');
  const ref = db.collection('processedMessages').doc('content_' + key);
  // Wide enough to absorb carrier-level SMS retries on spotty signal (subway,
  // tunnels, inclines), which can redeliver the same text a couple minutes
  // late with a new MessageSid, bypassing checkIdempotency.
  const WINDOW_MS = 300000;

  try {
    await ref.create({
      processedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromDate(new Date(Date.now() + WINDOW_MS)),
    });
    return false;
  } catch (e) {
    if (e.code === 6) {
      const doc = await ref.get();
      if (doc.exists) {
        const processedAt = doc.data().processedAt?.toDate?.();
        if (processedAt && (Date.now() - processedAt.getTime()) < WINDOW_MS) return true;
        await ref.set({
          processedAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromDate(new Date(Date.now() + WINDOW_MS)),
        });
      }
      return false;
    }
    throw e;
  }
}

module.exports = {
  isRateLimited,
  isGeminiRateLimited,
  shouldRespondToUnknown,
  checkIdempotency,
  checkContentDuplicate,
};
