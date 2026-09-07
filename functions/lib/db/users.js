/**
 * User lookup, profiles, auth whitelist, and verification
 */
const { db, Timestamp } = require('./core');

async function getUserByPhone(phoneNumber) {
  const phoneDoc = await db.collection('phoneNumbers').doc(phoneNumber).get();
  if (!phoneDoc.exists) return null;
  return phoneDoc.data();
}

async function getUserProfile(userId) {
  const profileDoc = await db.collection('profiles').doc(userId).get();
  if (!profileDoc.exists) return null;
  return profileDoc.data();
}

async function isEmailAllowed(email) {
  const allowedDoc = await db.collection('allowedUsers').doc(email.toLowerCase()).get();
  return allowedDoc.exists;
}

async function isEmailAdmin(email) {
  if (!email) return false;
  const allowedDoc = await db.collection('allowedUsers').doc(email.toLowerCase()).get();
  return allowedDoc.exists && allowedDoc.data()?.isAdmin === true;
}

async function isExperimentalIntelligenceEnabled(email) {
  if (!email) return false;
  const allowedDoc = await db.collection('allowedUsers').doc(email.toLowerCase()).get();
  return allowedDoc.exists && allowedDoc.data()?.experimentalIntelligence === true;
}

async function storeVerificationCode(phoneNumber, email, code, ttlMs = 15 * 60 * 1000) {
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + ttlMs));
  await db.collection('smsVerification').doc(phoneNumber).set({ email, code, expiresAt, attempts: 0 });
}

async function getVerificationData(phoneNumber) {
  const doc = await db.collection('smsVerification').doc(phoneNumber).get();
  if (!doc.exists) return null;
  const data = doc.data();
  // Don't delete a locked doc — lockout must expire naturally
  const isLocked = data.lockedUntil && data.lockedUntil.toDate() > new Date();
  if (!isLocked && data.expiresAt && data.expiresAt.toDate() < new Date()) {
    await db.collection('smsVerification').doc(phoneNumber).delete();
    return null;
  }
  return data;
}

/**
 * Consume a one-time SMS quick-link code: reads and deletes it atomically so
 * it can only ever be used once, even if two texts race each other.
 * @returns {{userId: string, email: string}|null} null if missing, already used, or expired
 */
async function consumeQuickLinkCode(code) {
  const ref = db.collection('smsQuickCodes').doc(code);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return null;
    transaction.delete(ref);
    const data = snap.data();
    if (!data.expiresAt || data.expiresAt.toDate() < new Date()) return null;
    return { userId: data.userId, email: data.email };
  });
}

module.exports = {
  getUserByPhone,
  getUserProfile,
  isEmailAllowed,
  isEmailAdmin,
  isExperimentalIntelligenceEnabled,
  storeVerificationCode,
  getVerificationData,
  consumeQuickLinkCode,
};
