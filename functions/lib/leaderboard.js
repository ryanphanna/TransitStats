const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { db, FieldValue } = require('./db');
const {
  countLeaderboardTrips,
  buildLeaderboardEntry,
  rankLeaderboardEntries,
} = require('./leaderboard-utils');

async function rebuildLeaderboardEntry(userId) {
  if (!userId) return;

  const [profileSnap, tripsSnap] = await Promise.all([
    db.collection('profiles').doc(userId).get(),
    db.collection('trips').where('userId', '==', userId).get(),
  ]);
  const entryRef = db.collection('leaderboardEntries').doc(userId);

  if (!profileSnap.exists || profileSnap.data().leaderboardOptIn !== true) {
    await entryRef.delete();
    return;
  }

  const trips = tripsSnap.docs.map(doc => doc.data());
  const profile = profileSnap.data();
  const entry = buildLeaderboardEntry(
    profile,
    countLeaderboardTrips(trips),
    FieldValue.serverTimestamp(),
  );

  // A leaderboard entry is a deliberately narrow public projection. It does
  // not contain the account ID, routes, stops, timestamps, or trip documents.
  await entryRef.set(entry);
}

async function handleLeaderboard(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET');
    res.status(204).send('');
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const snapshot = await db.collection('leaderboardEntries').get();
    const entries = snapshot.docs.map(doc => doc.data());
    const ranked = rankLeaderboardEntries(entries);
    const publicEntries = ranked.map(({ displayName, username, emojiUsername, score, rank }) => ({
      displayName,
      username,
      emojiUsername,
      score,
      rank,
    }));
    const requestedUsername = String(req.query.user || '').trim().toLowerCase();
    const viewer = requestedUsername
      ? publicEntries.find(entry => String(entry.username || '').toLowerCase() === requestedUsername) || null
      : null;

    res.status(200).json({
      metric: 'completed_logged_trips',
      entries: publicEntries.slice(0, 100),
      viewer,
    });
  } catch (error) {
    console.error('Leaderboard lookup failed', error.message);
    res.status(500).json({ error: 'Internal error' });
  }
}

// Rebuild instead of incrementing so corrections, deletions, and review flags
// cannot leave a stale score behind. The trigger is separate from the trip
// finalization trigger and never writes back to the trips collection.
const onTripLeaderboardChanged = onDocumentWritten('trips/{tripId}', async event => {
  const beforeUserId = event.data.before?.data()?.userId;
  const afterUserId = event.data.after?.data()?.userId;
  const userIds = [...new Set([beforeUserId, afterUserId].filter(Boolean))];
  await Promise.all(userIds.map(rebuildLeaderboardEntry));
});

const onProfileLeaderboardChanged = onDocumentWritten('profiles/{userId}', async event => {
  await rebuildLeaderboardEntry(event.params.userId);
});

exports.leaderboard = onRequest({ concurrency: 40, maxInstances: 4 }, handleLeaderboard);
exports.onTripLeaderboardChanged = onTripLeaderboardChanged;
exports.onProfileLeaderboardChanged = onProfileLeaderboardChanged;
exports.handleLeaderboard = handleLeaderboard;
exports.rebuildLeaderboardEntry = rebuildLeaderboardEntry;
