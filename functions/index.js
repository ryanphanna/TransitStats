/**
 * Firebase Cloud Functions for TransitStats
 * Entry point — exports all cloud functions.
 * SMS webhook for Twilio-based trip tracking.
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize Admin SDK if not already initialized
if (getApps().length === 0) {
  initializeApp({
    serviceAccountId: 'firebase-adminsdk-fbsvc@transitstats-21ba4.iam.gserviceaccount.com',
  });
}

const { sms } = require('./sms');
const { api } = require('./api');
const { authSession } = require('./auth-session');
const { createAdminMetricsHandler } = require('./lib/admin-metrics');
const { atlasStops } = require('./atlas-stops');
const { atlasStopsMeta } = require('./atlas-stops-meta');
const { atlasRoutes } = require('./atlas-routes');
const { publicProfile } = require('./lib/public-profile');
const { publicProfileOg } = require('./lib/public-profile-og');
const { publicProfilePage } = require('./lib/public-profile-page');
const {
  leaderboard,
  onTripLeaderboardChanged,
  onProfileLeaderboardChanged,
} = require('./lib/leaderboard');
const { onDocumentWritten, onDocumentCreated } = require('firebase-functions/v2/firestore');
const finalization = require('./lib/finalization');
const { enrichStopDoc } = require('./lib/atlas-enrich');

// Export the SMS webhook function
exports.sms = sms;

// Export the iOS companion app API endpoint
exports.api = api;

// Shared parent-domain session used to move an authenticated user between
// the regular, beta, and admin surfaces without putting an ID token in a URL.
exports.authSession = authSession;

// Admin-only operational metrics. The browser cannot read other users' trips
// under Firestore rules, so this endpoint returns aggregate counts only after
// verifying the caller against the admin whitelist.
exports.adminMetrics = createAdminMetricsHandler();

// Public Atlas proxies used by the map and heatmap views.
exports.atlasStops = atlasStops;
exports.atlasStopsMeta = atlasStopsMeta;
exports.atlasRoutes = atlasRoutes;

// Public profile stats — the only sanctioned way to read another user's trip
// data. Trips are not publicly readable via Firestore rules; this endpoint
// reads them with the Admin SDK and returns only aggregate/anonymized fields.
exports.publicProfile = publicProfile;
exports.publicProfileOg = publicProfileOg;
exports.publicProfilePage = publicProfilePage;

// Public leaderboard contains only opt-in aggregate scores and identity.
exports.leaderboard = leaderboard;

// Background trigger: fill Layer-2 facts (direction, routes, official-name alias)
// on newly created stop docs from Atlas R2 stops-meta. No-ops gracefully while
// the artifact doesn't exist yet; never touches the user-chosen name.
exports.onStopCreated = onDocumentCreated('stops/{stopId}', async (event) => {
  const stop = event.data?.data();
  if (!stop) return;
  try {
    const db = getFirestore();
    const outcome = await enrichStopDoc(db, event.params.stopId, stop);
    console.log(`onStopCreated ${event.params.stopId}: ${outcome}`);
  } catch (err) {
    console.error('onStopCreated enrichment failed', err.message);
  }
});

exports.onTripLeaderboardChanged = onTripLeaderboardChanged;
exports.onProfileLeaderboardChanged = onProfileLeaderboardChanged;

// Background trigger: runs post-end finalization (learning, grading, journey linking, etc.)
// when a trip first receives endTime. Heavy side-effects are fully out of the SMS path.
// High-impact corrections set exclusion flags on the trip but do NOT auto-trigger
// re-finalization (prevents tainting accuracy metrics / models from known-bad data).
// Use triggerManualFinalization(tripId) for explicit reprocessing after corrections.
exports.onTripFinalized = onDocumentWritten('trips/{tripId}', async (event) => {
  const before = event.data.before?.data();
  const after = event.data.after?.data();
  if (!before || !after) return;

  const tripId = event.params.tripId;
  const justEnded = before.endTime == null && after.endTime != null;

  if (justEnded) {
    console.log(`[Background] Running finalization for trip ${tripId} (reason: ended)`);

    try {
      // after.data() never includes the doc's own ID — runPostEndFinalization
      // and everything it calls (gradeAllPredictions, the backgroundFinalizedAt
      // write) key off tripData.id, so it must be merged in here explicitly.
      await finalization.runPostEndFinalization({ id: tripId, ...after });
    } catch (err) {
      console.error(`[Background] Finalization failed for ${tripId}`, err);
    }
  }
});
// Tue  5 May 2026 10:55:13 EDT
// Tue  5 May 2026 11:08:01 EDT
// Tue  5 May 2026 11:19:21 EDT
