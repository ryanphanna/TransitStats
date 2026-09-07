function isLeaderboardTrip(trip) {
  return !!trip
    && trip.endTime != null
    && !trip.incomplete
    && !trip.discarded
    && !trip.needs_review;
}

function countLeaderboardTrips(trips = []) {
  return trips.filter(isLeaderboardTrip).length;
}

function buildLeaderboardEntry(profile = {}, score = 0, updatedAt = null) {
  return {
    displayName: profile.displayName || profile.name || null,
    username: profile.username || null,
    emojiUsername: profile.emojiUsername || null,
    score,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function rankLeaderboardEntries(entries = []) {
  const sorted = [...entries]
    .sort((a, b) => {
      const scoreDifference = Number(b.score || 0) - Number(a.score || 0);
      if (scoreDifference !== 0) return scoreDifference;
      return String(a.username || '').localeCompare(String(b.username || ''));
    });

  let previousScore = null;
  let previousRank = 0;
  return sorted.map((entry, index) => {
    const score = Number(entry.score || 0);
    const rank = score === previousScore ? previousRank : index + 1;
    previousScore = score;
    previousRank = rank;
    return { ...entry, rank };
  });
}

module.exports = {
  isLeaderboardTrip,
  countLeaderboardTrips,
  buildLeaderboardEntry,
  rankLeaderboardEntries,
};
