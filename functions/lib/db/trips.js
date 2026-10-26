/**
 * Trip and SMS state management
 */
const { db, FieldValue, Timestamp } = require('./core');
const { getUserProfile } = require('./users');
const { timezoneForAgency } = require('../constants');
const { ACTIVE_TRIP_WINDOW_MS } = require('../trip-stats');

const HIGH_IMPACT_CORRECTION_FIELDS = new Set([
  'route',
  'direction',
  'agency',
  'startStop',
  'startStopCode',
  'startStopName',
  'endStop',
  'endStopCode',
  'endStopName',
]);

function hasBlockingCorrection(trip) {
  if (!trip) return false;
  if (trip.exclude_from_training || trip.exclude_from_accuracy || trip.needs_reprocess) return true;
  const correctedFields = Array.isArray(trip.correctedFields) ? trip.correctedFields : [];
  return correctedFields.some(field => HIGH_IMPACT_CORRECTION_FIELDS.has(field));
}

async function getActiveTrip(userId) {
  const now = new Date();
  // Same 6-hour window the dashboard and public profile use (js/shared/trip-stats.js).
  const sixHoursAgo = Timestamp.fromDate(new Date(now.getTime() - ACTIVE_TRIP_WINDOW_MS));

  const snapshot = await db.collection('trips')
    .where('userId', '==', userId)
    .where('endTime', '==', null)
    .where('startTime', '>=', sixHoursAgo)
    .orderBy('startTime', 'desc')
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function createTrip(tripData) {
  const hasBoardingStop = [tripData.startStopCode, tripData.startStopName, tripData.startStop]
    .some(value => value !== null && value !== undefined && String(value).trim() !== '');
  if (!hasBoardingStop) {
    throw new Error('Cannot create a trip without a boarding stop');
  }

  const profile = await getUserProfile(tripData.userId);
  const { startTime: startTimeOverride, ...restTripData } = tripData;
  const startTime = startTimeOverride
    ? Timestamp.fromDate(new Date(startTimeOverride))
    : FieldValue.serverTimestamp();

  // Unknown agencies get no timezone (not 'UTC'), so readers fall back to their own default.
  const timezone = timezoneForAgency(tripData.agency);
  const docRef = await db.collection('trips').add({
    ...restTripData,
    startTime,
    endTime: null,
    source: tripData.source || 'sms',
    timing_reliability: tripData.timing_reliability || 'actual',
    endStopCode: null,
    endStopName: null,
    exitLocation: null,
    isPublic: profile?.isPublic || false,
    ...(timezone ? { timezone } : {}),
  });
  return docRef.id;
}

async function getRecentCompletedTrips(userId, limit = 50) {
  const snapshot = await db.collection('trips')
    .where('userId', '==', userId)
    .where('endTime', '!=', null)
    .orderBy('endTime', 'desc')
    .limit(limit)
    .get();

  return snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter((t) => {
      if (t.incomplete || t.discarded || t.needs_review) return false;
      if (hasBlockingCorrection(t)) return false;
      const stopMatched = t.stop_matched != null ? !!t.stop_matched : !!t.verified;
      return stopMatched;
    });
}

async function getPendingState(phoneNumber) {
  const stateDoc = await db.collection('smsState').doc(phoneNumber).get();
  if (!stateDoc.exists) return null;
  const data = stateDoc.data();
  if (data.expiresAt && data.expiresAt.toDate() < new Date()) {
    await db.collection('smsState').doc(phoneNumber).delete();
    return null;
  }
  return data;
}

async function setPendingState(phoneNumber, state, ttlMs = 5 * 60 * 1000) {
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + ttlMs));
  await db.collection('smsState').doc(phoneNumber).set({ ...state, expiresAt });
}

async function clearPendingState(phoneNumber) {
  await db.collection('smsState').doc(phoneNumber).delete();
}

async function getLastTripAgency(userId) {
  const snap = await db.collection('trips')
    .where('userId', '==', userId)
    .orderBy('startTime', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].data().agency || null;
}

async function getTripCount(userId) {
  const snap = await db.collection('trips')
    .where('userId', '==', userId)
    .count().get();
  return snap.data().count;
}

module.exports = {
  getActiveTrip,
  createTrip,
  getTripCount,
  getRecentCompletedTrips,
  hasBlockingCorrection,
  getPendingState,
  setPendingState,
  clearPendingState,
  getLastTripAgency,
};
