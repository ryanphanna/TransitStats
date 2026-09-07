/**
 * User lookup, profiles, auth whitelist, and verification
 */
const { db } = require('./core');

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
  isEmailAdmin,
  isExperimentalIntelligenceEnabled,
  consumeQuickLinkCode,
};
