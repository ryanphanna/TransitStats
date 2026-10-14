const { onRequest } = require('firebase-functions/v2/https');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const ALLOWED_ORIGINS = new Set([
  'https://transitstats.fyi',
  'https://www.transitstats.fyi',
  'https://beta.transitstats.fyi',
  'https://admin.transitstats.fyi',
  'http://localhost:5177',
  'http://127.0.0.1:5177',
]);

function setCors(req, res) {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Max-Age', '3600');
  }
}

function isRecent(value, cutoff) {
  if (!value) return false;
  const date = value?.toDate ? value.toDate() : new Date(value);
  return !Number.isNaN(date.getTime()) && date >= cutoff;
}

function toRecord(snapshot) {
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

function summarizeAdminMetrics({
  profiles = [], stops = [], trips = [], predictionStats = [], allowedUsers = [],
  loginActivity = [], queryLogCount = 0, now = new Date(),
}) {
  const completedTrips = trips.filter(trip => trip.endTime != null);
  const getMatchStatus = trip => trip.stop_matched != null ? trip.stop_matched : trip.verified;
  const matchedTrips = completedTrips.filter(trip => getMatchStatus(trip) === true);
  const unmatchedTrips = completedTrips.filter(trip => getMatchStatus(trip) === false);
  const unknownMatchTrips = completedTrips.filter(trip => getMatchStatus(trip) == null).length;
  const recentCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const predictionVersions = predictionStats.reduce((counts, stat) => {
    const version = String(stat.version || 'unknown').toLowerCase();
    const key = version.startsWith('v4') ? 'v4'
      : version.startsWith('v5') ? 'v5'
        : version.startsWith('v3') ? 'v3' : 'other';
    counts[key] += 1;
    return counts;
  }, { v3: 0, v4: 0, v5: 0, other: 0 });

  return {
    generatedAt: now.toISOString(),
    accounts: {
      total: profiles.length,
      admins: profiles.filter(profile => profile.isAdmin === true).length,
      experimentalIntelligence: allowedUsers
        .filter(user => user.experimentalIntelligence === true).length,
      totalLogins: loginActivity.reduce((sum, activity) => sum + Number(activity.loginCount || 0), 0),
      activeLogins30d: loginActivity.filter(activity => isRecent(activity.lastLoginAt, recentCutoff)).length,
    },
    rides: {
      total: trips.length,
      completed: completedTrips.length,
      active: trips.filter(trip => trip.endTime == null && trip.discarded !== true).length,
      needsReview: trips.filter(trip => trip.needs_review === true).length,
      awaitingFinalization: completedTrips.filter(trip => !trip.backgroundFinalizedAt).length,
    },
    stops: {
      library: stops.length,
      gtfs: stops.filter(stop => stop.source === 'gtfs').length,
      verified: stops.filter(stop => stop.source === 'verified').length,
      matchedTrips: matchedTrips.length,
      unmatchedTrips: unmatchedTrips.length,
      unknownMatchTrips,
    },
    intelligence: {
      predictionRows: predictionStats.length,
      v3Rows: predictionVersions.v3,
      v4Rows: predictionVersions.v4,
      v5Rows: predictionVersions.v5,
      otherRows: predictionVersions.other,
      questions: Number(queryLogCount || 0),
    },
  };
}

async function loadAdminMetrics(db) {
  const [profilesSnap, stopsSnap, tripsSnap, predictionStatsSnap, allowedUsersSnap,
    loginActivitySnap, queryLogsCountSnap] = await Promise.all([
    db.collection('profiles').get(),
    db.collection('stops').get(),
    db.collection('trips').get(),
    db.collection('predictionStats').get(),
    db.collection('allowedUsers').get(),
    db.collection('loginActivity').get(),
    db.collection('queryLogs').count().get(),
  ]);

  return summarizeAdminMetrics({
    profiles: toRecord(profilesSnap),
    stops: toRecord(stopsSnap),
    trips: toRecord(tripsSnap),
    predictionStats: toRecord(predictionStatsSnap),
    allowedUsers: toRecord(allowedUsersSnap),
    loginActivity: toRecord(loginActivitySnap),
    queryLogCount: queryLogsCountSnap.data().count,
  });
}

async function handleAdminMetrics(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const adminAuth = getAuth();
    const decoded = await adminAuth.verifyIdToken(authHeader.slice(7));
    const db = getFirestore();
    const allowed = await db.collection('allowedUsers').doc(String(decoded.email || '').toLowerCase()).get();
    if (decoded.email_verified !== true || !allowed.exists || allowed.data()?.isAdmin !== true) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    res.set('Cache-Control', 'no-store');
    res.status(200).json(await loadAdminMetrics(db));
  } catch (error) {
    console.error('Admin metrics request failed:', error.message);
    res.status(500).json({ error: 'Could not load admin metrics' });
  }
}

function createAdminMetricsHandler() {
  return onRequest({ concurrency: 20, maxInstances: 2 }, handleAdminMetrics);
}

module.exports = {
  ALLOWED_ORIGINS,
  handleAdminMetrics,
  loadAdminMetrics,
  summarizeAdminMetrics,
  createAdminMetricsHandler,
  isRecent,
};
