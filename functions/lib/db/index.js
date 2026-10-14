/**
 * Database module — re-exports all domain modules
 */
const { admin, db, FieldValue, Timestamp } = require('./core');
const { isRateLimited, isGeminiRateLimited, shouldRespondToUnknown, checkIdempotency, checkContentDuplicate } = require('./rate-limit');
const {
  getAuthUidByEmail,
  getUserByPhone,
  getUserProfile,
  isEmailAllowed,
  isEmailAdmin,
  isExperimentalIntelligenceEnabled,
  storeVerificationCode,
  getVerificationData,
} = require('./users');
const { getActiveTrip, createTrip, getRecentCompletedTrips, hasBlockingCorrection, getPendingState, setPendingState, clearPendingState, getLastTripAgency, getTripCount } = require('./trips');
const { lookupStop, lookupStopCheck, findMatchingStops, getRoutesAtStop, getStopsLibrary } = require('./stops');
const { getConversationHistory, saveConversationTurn } = require('./conversations');

module.exports = {
  admin,
  db,
  FieldValue,
  Timestamp,
  isRateLimited,
  isGeminiRateLimited,
  shouldRespondToUnknown,
  checkIdempotency,
  checkContentDuplicate,
  getAuthUidByEmail,
  getUserByPhone,
  getUserProfile,
  isEmailAllowed,
  isEmailAdmin,
  isExperimentalIntelligenceEnabled,
  storeVerificationCode,
  getVerificationData,
  getActiveTrip,
  createTrip,
  getRecentCompletedTrips,
  hasBlockingCorrection,
  getPendingState,
  setPendingState,
  clearPendingState,
  lookupStop,
  lookupStopCheck,
  findMatchingStops,
  getRoutesAtStop,
  getStopsLibrary,
  getConversationHistory,
  saveConversationTurn,
  getLastTripAgency,
  getTripCount,
  getFirestore: () => db,
  getAdmin: () => admin,
};
