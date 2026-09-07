/**
 * Database module — re-exports all domain modules
 */
const { admin, db, FieldValue, Timestamp } = require('./core');
const { isRateLimited, isGeminiRateLimited, shouldRespondToUnknown, checkIdempotency, checkContentDuplicate } = require('./rate-limit');
const {
  getUserByPhone,
  getUserProfile,
  isEmailAllowed,
  isEmailAdmin,
  isExperimentalIntelligenceEnabled,
  storeVerificationCode,
  getVerificationData,
  consumeQuickLinkCode,
} = require('./users');
const { getActiveTrip, createTrip, getRecentCompletedTrips, hasBlockingCorrection, getPendingState, setPendingState, clearPendingState, getLastTripAgency, getTripCount } = require('./trips');
const { lookupStop, findMatchingStops, getRoutesAtStop, getStopsLibrary } = require('./stops');
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
  getUserByPhone,
  getUserProfile,
  isEmailAllowed,
  isEmailAdmin,
  isExperimentalIntelligenceEnabled,
  storeVerificationCode,
  getVerificationData,
  consumeQuickLinkCode,
  getActiveTrip,
  createTrip,
  getRecentCompletedTrips,
  hasBlockingCorrection,
  getPendingState,
  setPendingState,
  clearPendingState,
  lookupStop,
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
