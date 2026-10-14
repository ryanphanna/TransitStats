/**
 * User lookup, profiles, auth whitelist, and verification
 */
const { getAuth } = require('firebase-admin/auth');
const { admin, db, Timestamp } = require('./core');

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

// Resolve an account by its Firebase Auth email, never by a profile field:
// profile docs are client-writable, so a profile's `email` proves nothing.
// Only a verified email counts as owning the account.
async function getAuthUidByEmail(email) {
  try {
    const record = await getAuth(admin).getUserByEmail(String(email || '').toLowerCase());
    return record.emailVerified ? record.uid : null;
  } catch (error) {
    if (error?.code === 'auth/user-not-found') return null;
    throw error;
  }
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

module.exports = {
  getAuthUidByEmail,
  getUserByPhone,
  getUserProfile,
  isEmailAllowed,
  isEmailAdmin,
  isExperimentalIntelligenceEnabled,
  storeVerificationCode,
  getVerificationData,
};
