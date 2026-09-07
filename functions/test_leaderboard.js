const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isLeaderboardTrip,
  countLeaderboardTrips,
  rankLeaderboardEntries,
} = require('./lib/leaderboard-utils');

test('leaderboard counts completed, usable logged trips only', () => {
  const valid = { endTime: new Date() };
  assert.equal(isLeaderboardTrip(valid), true);
  assert.equal(isLeaderboardTrip({ ...valid, incomplete: true }), false);
  assert.equal(isLeaderboardTrip({ ...valid, discarded: true }), false);
  assert.equal(isLeaderboardTrip({ ...valid, needs_review: true }), false);
  assert.equal(isLeaderboardTrip({ startTime: new Date() }), false);
  assert.equal(countLeaderboardTrips([valid, { ...valid, needs_review: true }]), 1);
});

test('leaderboard ranking gives tied scores the same rank', () => {
  const ranked = rankLeaderboardEntries([
    { username: 'second', score: 4 },
    { username: 'leader', score: 7 },
    { username: 'tie', score: 7 },
  ]);

  assert.deepEqual(ranked.map(entry => [entry.username, entry.rank]), [
    ['leader', 1],
    ['tie', 1],
    ['second', 3],
  ]);
});
