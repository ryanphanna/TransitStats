/**
 * Tests for HabitEngine.
 * Run with: node test_habit.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HabitEngine } = require('./lib/habit');

// ─── helpers ───────────────────────────────────────────────────────────────
// Trips without an agency use America/Toronto local time, so dates are built in
// Toronto local time (correcting for DST) regardless of the machine's TZ.

function localDate(y, m, d, hour) {
  let t = new Date(Date.UTC(y, m, d, hour + 4));
  for (let i = 0; i < 3; i++) {
    const h = HabitEngine._localParts(t, null).hour;
    if (h === hour) break;
    t = new Date(t.getTime() + (hour - h) * 3600000);
  }
  return t;
}

function makeDate(dayOfWeek, hour, daysAgo = 0) {
  // 2026-05-11 is a Monday (day 1). Returns that week's dayOfWeek at `hour` Toronto time.
  const offset = ((dayOfWeek - 1) + 7) % 7;
  return localDate(2026, 4, 11 + offset - daysAgo, hour);
}

function makeTrip(route, stop, direction, dayOfWeek, hour, endStop = 'Spadina Station', daysAgo = 0) {
  return {
    route,
    startStopName: stop,
    direction,
    startTime: makeDate(dayOfWeek, hour, daysAgo),
    endStopName: endStop,
    agency: 'TTC',
  };
}

function makeTripHistory(n, route, stop, direction, dayOfWeek, hour, endStop = 'Spadina Station') {
  return Array.from({ length: n }, (_, i) => makeTrip(route, stop, direction, dayOfWeek, hour, endStop, i * 7));
}

function makeDb(existingHabits = null) {
  let stored = null;
  return {
    _getStored: () => stored,
    collection: (name) => ({
      doc: (id) => ({
        get: async () => ({
          exists: existingHabits !== null,
          data: () => ({ habits: existingHabits || [] }),
        }),
        set: async (data) => { stored = data; },
      }),
    }),
  };
}

// ─── extractHabits ─────────────────────────────────────────────────────────

test('extractHabits: returns empty array for empty input', () => {
  assert.deepEqual(HabitEngine.extractHabits([]), []);
});

test('extractHabits: skips trips missing required fields', () => {
  const trips = [
    { startStopName: 'King / Spadina', startTime: new Date() },         // no route
    { route: '510', startTime: new Date() },                             // no stop
    { route: '510', startStopName: 'King / Spadina', direction: 'W' },  // no startTime
  ];
  assert.deepEqual(HabitEngine.extractHabits(trips), []);
});

test('extractHabits: skips trips with invalid startTime', () => {
  const trips = [{ route: '510', startStopName: 'King / Spadina', direction: 'Westbound', startTime: 'not-a-date' }];
  assert.deepEqual(HabitEngine.extractHabits(trips), []);
});

test('extractHabits: below MIN_OBSERVATIONS threshold returns nothing', () => {
  const trips = [
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8),
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8),
  ]; // only 2, threshold is 3
  assert.deepEqual(HabitEngine.extractHabits(trips), []);
});

test('extractHabits: at MIN_OBSERVATIONS returns a habit', () => {
  const trips = makeTripHistory(3, '510', 'King / Spadina', 'Westbound', 1, 8);
  const habits = HabitEngine.extractHabits(trips);
  assert.equal(habits.length, 1);
  assert.equal(habits[0].route, '510');
  assert.equal(habits[0].stop, 'King / Spadina');
  assert.equal(habits[0].direction, 'Westbound');
  assert.equal(habits[0].dayGroup, 'weekday');
  assert.equal(habits[0].agency, 'TTC');
  assert.equal(habits[0].schema, HabitEngine.SCHEMA);
  assert.equal(habits[0].count, 3);
});

test('extractHabits: hourMin and hourMax computed correctly', () => {
  // Hours 8 and 9 both fall in the 8–11 bucket, so all 3 trips group together.
  const trips = [
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8),
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8),
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 9),
  ];
  const habits = HabitEngine.extractHabits(trips);
  assert.equal(habits[0].hourMin, 8);
  assert.equal(habits[0].hourMax, 9);
});

test('extractHabits: weekday and weekend trips form separate habits', () => {
  const monday = makeTripHistory(3, '510', 'King / Spadina', 'Westbound', 1, 8);
  const saturday = makeTripHistory(3, '510', 'King / Spadina', 'Westbound', 6, 8);
  const habits = HabitEngine.extractHabits([...monday, ...saturday]);
  assert.equal(habits.length, 2);
  assert.deepEqual(habits.map(h => h.dayGroup).sort(), ['weekday', 'weekend']);
});

test('extractHabits: different weekdays at the same time group together', () => {
  const trips = [
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8),
    makeTrip('510', 'King / Spadina', 'Westbound', 2, 8),
    makeTrip('510', 'King / Spadina', 'Westbound', 4, 9),
  ];
  const habits = HabitEngine.extractHabits(trips);
  assert.equal(habits.length, 1);
  assert.equal(habits[0].count, 3);
});

test('extractHabits: uses agency local time, not server time (Friday 9pm stays a weekday)', () => {
  // Friday 21:00 in Toronto is Saturday 01:00 UTC.
  const trips = [0, 7, 14].map(daysAgo => makeTrip('504', 'King / Spadina', 'Eastbound', 5, 21, 'Broadview Station', daysAgo));
  assert.equal(trips[0].startTime.getUTCDay(), 6);
  const habits = HabitEngine.extractHabits(trips);
  assert.equal(habits.length, 1);
  assert.equal(habits[0].dayGroup, 'weekday');
  assert.equal(habits[0].hourMin, 21);
});

test('extractHabits: end stop names counted case-insensitively', () => {
  const trips = [
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, 'Spadina Station'),
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, 'SPADINA STATION', 7),
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, 'Roncesvalles', 14),
  ];
  const habits = HabitEngine.extractHabits(trips);
  assert.equal(habits[0].endStopCount, 2);
  assert.equal(habits[0].endStop, 'Spadina Station'); // newest spelling
});

test('extractHabits: same stop different hours far apart stay in different buckets', () => {
  // hour 8 → bucket 8 (8–11), hour 17 → bucket 16 (16–19)
  const morning = makeTripHistory(3, '510', 'King / Spadina', 'Westbound', 1, 8);
  const evening = makeTripHistory(3, '510', 'King / Spadina', 'Westbound', 1, 17);
  const habits = HabitEngine.extractHabits([...morning, ...evening]);
  assert.equal(habits.length, 2);
  const buckets = habits.map(h => h.bucket).sort((a, b) => a - b);
  assert.deepEqual(buckets, [8, 16]);
});

test('extractHabits: most common endStop selected', () => {
  const trips = [
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, 'Spadina Station'),
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, 'Spadina Station'),
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, 'Roncesvalles'),
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, 'Roncesvalles'),
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, 'Roncesvalles'),
  ];
  const habits = HabitEngine.extractHabits(trips);
  assert.equal(habits[0].endStop, 'Roncesvalles');
});

test('extractHabits: endStop null when no trips have endStopName', () => {
  const trips = Array.from({ length: 3 }, () => ({
    route: '510',
    startStopName: 'King / Spadina',
    direction: 'Westbound',
    startTime: makeDate(1, 8),
  }));
  const habits = HabitEngine.extractHabits(trips);
  assert.equal(habits[0].endStop, null);
});

test('extractHabits: stop names normalized for grouping (case/trim)', () => {
  const trips = [
    makeTrip('510', 'King / Spadina', 'Westbound', 1, 8),
    makeTrip('510', 'KING / SPADINA', 'Westbound', 1, 8),
    makeTrip('510', '  king / spadina  ', 'Westbound', 1, 8),
  ];
  const habits = HabitEngine.extractHabits(trips);
  assert.equal(habits.length, 1);
  assert.equal(habits[0].count, 3);
});

test('extractHabits: confidence field is present and between 0 and 1', () => {
  const trips = makeTripHistory(5, '510', 'King / Spadina', 'Westbound', 1, 8);
  const habits = HabitEngine.extractHabits(trips);
  assert.ok(habits[0].confidence >= 0 && habits[0].confidence <= 1);
});

test('extractHabits: route stored as string even if numeric', () => {
  const trips = Array.from({ length: 3 }, () => ({
    route: 510,
    startStopName: 'King / Spadina',
    direction: 'Westbound',
    startTime: makeDate(1, 8),
    endStopName: 'Spadina Station',
  }));
  const habits = HabitEngine.extractHabits(trips);
  assert.equal(typeof habits[0].route, 'string');
  assert.equal(habits[0].route, '510');
});

// ─── _confidence ───────────────────────────────────────────────────────────

const habitRec = (count, endStopCount, daysAgo = 0) => ({ count, endStopCount, lastSeen: Date.now() - daysAgo * 86400000 });

test('_confidence: consistent end stop scores high (4/4 fresh → 0.8)', () => {
  assert.equal(HabitEngine._confidence(habitRec(4, 4)), 0.8);
});

test('_confidence: decays with age', () => {
  const fresh = HabitEngine._confidence(habitRec(5, 5));
  const old = HabitEngine._confidence(habitRec(5, 5, 60));
  assert.ok(old < fresh);
  assert.ok(Math.abs(old - fresh / 2) < 0.01, 'halves after HALF_LIFE_DAYS');
});

test('_confidence: mixed end stops score low', () => {
  const pure = HabitEngine._confidence(habitRec(5, 5));
  const mixed = HabitEngine._confidence(habitRec(5, 2));
  assert.ok(mixed < pure);
  assert.ok(mixed < HabitEngine.CONFIDENCE_THRESHOLD);
});

test('_confidence: zero without a known end stop', () => {
  assert.equal(HabitEngine._confidence(habitRec(5, 0)), 0);
});

// ─── match ─────────────────────────────────────────────────────────────────

test('match: returns null for empty habits', () => {
  assert.equal(HabitEngine.match([], 'King / Spadina', new Date()), null);
});

test('match: returns null for null inputs', () => {
  assert.equal(HabitEngine.match(null, 'King / Spadina', new Date()), null);
  assert.equal(HabitEngine.match([], null, new Date()), null);
  assert.equal(HabitEngine.match([], 'King', null), null);
});

test('match: returns habit when day/hour/stop/confidence all match', () => {
  const now = makeDate(1, 8); // Monday 8am
  const habits = HabitEngine.extractHabits(makeTripHistory(10, '510', 'King / Spadina', 'Westbound', 1, 8));
  const result = HabitEngine.match(habits, 'King / Spadina', now);
  assert.ok(result !== null);
  assert.equal(result.route, '510');
});

test('match: weekday habit does not fire on a weekend', () => {
  const habits = HabitEngine.extractHabits(makeTripHistory(10, '510', 'King / Spadina', 'Westbound', 1, 8));
  const saturday = makeDate(6, 8);
  assert.equal(HabitEngine.match(habits, 'King / Spadina', saturday), null);
});

test('match: weekday habit fires on another weekday', () => {
  const habits = HabitEngine.extractHabits(makeTripHistory(10, '510', 'King / Spadina', 'Westbound', 1, 8));
  assert.ok(HabitEngine.match(habits, 'King / Spadina', makeDate(3, 8)) !== null);
});

test('match: agency filter matches habits built from trips with an agency', () => {
  const habits = HabitEngine.extractHabits(makeTripHistory(5, '510', 'King / Spadina', 'Westbound', 1, 8));
  const now = makeDate(1, 8);
  const result = HabitEngine.match(habits, 'King / Spadina', now, { route: '510', direction: 'Westbound', agency: 'TTC' });
  assert.ok(result !== null, 'serving always passes an agency; v1 habits never matched it');
  assert.equal(result.endStop, 'Spadina Station');
  assert.equal(HabitEngine.match(habits, 'King / Spadina', now, { route: '510', agency: 'MiWay' }), null);
});

test('match: habit with inconsistent end stops does not fire', () => {
  const stops = ['Spadina Station', 'Bathurst', 'Roncesvalles', 'Dufferin', 'Strachan'];
  const trips = stops.map((stop, i) => makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, stop, i * 7));
  const habits = HabitEngine.extractHabits(trips);
  assert.equal(habits.length, 1);
  assert.equal(HabitEngine.match(habits, 'King / Spadina', makeDate(1, 8)), null);
});

test('match: ignores old-schema (v1) records until rebuilt', () => {
  const v1 = [{ stop: 'King / Spadina', route: '510', direction: 'Westbound', endStop: 'Spadina Station',
    day: 1, bucket: 8, hourMin: 8, hourMax: 8, count: 10, lastSeen: makeDate(1, 8).getTime(), stale: false }];
  assert.equal(HabitEngine.match(v1, 'King / Spadina', makeDate(1, 8)), null);
});

test('match: stop name matched case-insensitively', () => {
  const habits = HabitEngine.extractHabits(makeTripHistory(10, '510', 'King / Spadina', 'Westbound', 1, 8));
  const now = makeDate(1, 8);
  const result = HabitEngine.match(habits, 'KING / SPADINA', now);
  assert.ok(result !== null);
});

test('match: hour within ±1 of window is accepted', () => {
  // habit window 8–8 (all at hour 8), testing at hour 7 (hourMin - 1)
  const trips = makeTripHistory(10, '510', 'King / Spadina', 'Westbound', 1, 8);
  const habits = HabitEngine.extractHabits(trips);
  const earlyMonday = makeDate(1, 7);
  assert.ok(HabitEngine.match(habits, 'King / Spadina', earlyMonday) !== null);
});

test('match: hour outside ±1 window returns null', () => {
  const trips = makeTripHistory(10, '510', 'King / Spadina', 'Westbound', 1, 8);
  const habits = HabitEngine.extractHabits(trips);
  const lateMonday = makeDate(1, 14); // 6 hours after hourMax
  assert.equal(HabitEngine.match(habits, 'King / Spadina', lateMonday), null);
});

test('match: low-confidence habit filtered out', () => {
  // 3 trips taken 300 days ago → very low confidence
  const trips = Array.from({ length: 3 }, (_, i) => makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, 'Spadina Station', 301 + i * 7));
  const habits = HabitEngine.extractHabits(trips);
  // All habits should have confidence well below threshold
  const now = makeDate(1, 8);
  assert.equal(HabitEngine.match(habits, 'King / Spadina', now), null);
});

test('match: returns highest-confidence habit among multiple candidates', () => {
  // Two habits at same stop/day/hour: one with 10 trips, one with 3
  const strong = makeTripHistory(10, '510', 'King / Spadina', 'Westbound', 1, 8);
  const weak = makeTripHistory(3, '29', 'King / Spadina', 'Northbound', 1, 8);
  const habits = HabitEngine.extractHabits([...strong, ...weak]);
  const now = makeDate(1, 8);
  const result = HabitEngine.match(habits, 'King / Spadina', now);
  // The 510 habit should have higher confidence
  assert.equal(result.route, '510');
});

test('match: route filter rejects habit for different route', () => {
  const habits = HabitEngine.extractHabits(makeTripHistory(10, '510', 'King / Spadina', 'Westbound', 1, 8));
  const now = makeDate(1, 8);
  // User is at same stop/time but on route 29 — habit for 510 should not fire
  assert.equal(HabitEngine.match(habits, 'King / Spadina', now, { route: '29' }), null);
});

test('match: route filter accepts habit for matching route', () => {
  const habits = HabitEngine.extractHabits(makeTripHistory(10, '510', 'King / Spadina', 'Westbound', 1, 8));
  const now = makeDate(1, 8);
  const result = HabitEngine.match(habits, 'King / Spadina', now, { route: '510' });
  assert.ok(result !== null);
  assert.equal(result.route, '510');
});

test('match: direction filter rejects habit for different direction', () => {
  const habits = HabitEngine.extractHabits(makeTripHistory(10, '510', 'King / Spadina', 'Westbound', 1, 8));
  const now = makeDate(1, 8);
  assert.equal(HabitEngine.match(habits, 'King / Spadina', now, { route: '510', direction: 'Eastbound' }), null);
});

test('match: no filters still returns best habit (backward-compatible)', () => {
  const habits = HabitEngine.extractHabits(makeTripHistory(10, '510', 'King / Spadina', 'Westbound', 1, 8));
  const now = makeDate(1, 8);
  const result = HabitEngine.match(habits, 'King / Spadina', now);
  assert.ok(result !== null);
});

// ─── load / save ───────────────────────────────────────────────────────────

test('load: returns empty array when no doc exists', async () => {
  const db = makeDb(null);
  const result = await HabitEngine.load(db, 'user1');
  assert.deepEqual(result, []);
});

test('load: returns habits array from existing doc', async () => {
  const stored = [{ stop: 'King / Spadina', route: '510', direction: 'Westbound', count: 5 }];
  const db = makeDb(stored);
  const result = await HabitEngine.load(db, 'user1');
  assert.deepEqual(result, stored);
});

test('load: returns empty array for null db or userId', async () => {
  assert.deepEqual(await HabitEngine.load(null, 'u1'), []);
  assert.deepEqual(await HabitEngine.load(makeDb(), null), []);
});

test('save: writes habits with userId and updatedAt', async () => {
  const db = makeDb(null);
  const habits = [{ stop: 'King', route: '510', confidence: 0.9 }];
  await HabitEngine.save(db, 'user1', habits);
  const stored = db._getStored();
  assert.equal(stored.userId, 'user1');
  assert.deepEqual(stored.habits, habits);
  assert.ok(typeof stored.updatedAt === 'string');
});

test('save: no-ops on null db or userId', async () => {
  await HabitEngine.save(null, 'u1', []);
  await HabitEngine.save(makeDb(), null, []);
  // no error thrown = pass
});

// ─── rebuild ───────────────────────────────────────────────────────────────

test('rebuild: extracts and saves habits, returns them', async () => {
  const db = makeDb(null);
  const trips = makeTripHistory(5, '510', 'King / Spadina', 'Westbound', 1, 8);
  const result = await HabitEngine.rebuild(db, 'user1', trips);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  const stored = db._getStored();
  assert.deepEqual(stored.habits, result);
});

test('rebuild: returns empty array when trips dont meet threshold', async () => {
  const db = makeDb(null);
  const trips = makeTripHistory(2, '510', 'King / Spadina', 'Westbound', 1, 8);
  const result = await HabitEngine.rebuild(db, 'user1', trips);
  assert.deepEqual(result, []);
});

// ─── habit change detection ─────────────────────────────────────────────────

test('rebuild: marks habit stale when different route emerges in same slot recently', async () => {
  const db = makeDb(null);

  // Old habit: 5 trips on the 510, taken 9-13 weeks ago (all Mondays, outside 30-day window)
  const oldTrips = Array.from({ length: 5 }, (_, i) => {
    return makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, 'Spadina Station', (9 + i) * 7);
  });

  // New pattern: 3 trips on the 29, taken in the last 3 weeks (all Mondays, inside 30-day window)
  const newTrips = Array.from({ length: 3 }, (_, i) => {
    return makeTrip('29', 'King / Spadina', 'Northbound', 1, 8, 'Lawrence Station', (1 + i) * 7);
  });

  const result = await HabitEngine.rebuild(db, 'user1', [...oldTrips, ...newTrips]);
  const staleHabit = result.find(h => h.route === '510');
  assert.ok(staleHabit, '510 habit should still exist in results');
  assert.equal(staleHabit.stale, true, '510 habit should be marked stale');
  assert.equal(staleHabit.replacedBy.route, '29');
});

test('rebuild: does not mark habit stale when recent trips match it', async () => {
  const db = makeDb(null);
  const trips = makeTripHistory(8, '510', 'King / Spadina', 'Westbound', 1, 8);
  const result = await HabitEngine.rebuild(db, 'user1', trips);
  assert.equal(result[0].stale, false);
});

test('match: stale habits are filtered out', async () => {
  const db = makeDb(null);

  const oldTrips = Array.from({ length: 5 }, (_, i) => {
    return makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, 'Spadina Station', (9 + i) * 7);
  });
  const newTrips = Array.from({ length: 3 }, (_, i) => {
    return makeTrip('29', 'King / Spadina', 'Northbound', 1, 8, 'Lawrence Station', (1 + i) * 7);
  });

  const habits = await HabitEngine.rebuild(db, 'user1', [...oldTrips, ...newTrips]);
  const now = makeDate(1, 8);
  // 510 is stale — match with 510 filter should return null
  assert.equal(HabitEngine.match(habits, 'King / Spadina', now, { route: '510' }), null);
});

test('rebuild: two routes ridden from the same stop and slot do not mark each other stale', async () => {
  const db = makeDb(null);
  const a = [1, 2, 3].map(w => makeTrip('510', 'King / Spadina', 'Westbound', 1, 8, 'Spadina Station', w * 7));
  const b = [1, 2, 3].map(w => makeTrip('29', 'King / Spadina', 'Northbound', 2, 9, 'Lawrence Station', w * 7));
  const habits = await HabitEngine.rebuild(db, 'user1', [...a, ...b]);
  assert.equal(habits.length, 2);
  assert.ok(habits.every(h => h.stale === false));
});
