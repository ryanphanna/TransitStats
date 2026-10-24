/**
 * Weekly V4/V5 shadow grading (scripts/weekly-shadow-grade.js, CIV-425): replay rules and
 * accuracy arithmetic on fixtures, with stub engines.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { gradeWindow, publicSummary, isGradableTrip, windowStart } = require('./scripts/weekly-shadow-grade');

const DAY = 24 * 60 * 60 * 1000;
const END = new Date('2026-10-26T04:00:00Z');
const START = new Date(END.getTime() - 7 * DAY);
const ts = d => ({ toDate: () => new Date(d) });
const noCorrection = () => false;

function trip(id, startIso, endStopName, extra = {}) {
  const start = new Date(startIso).getTime();
  return {
    id, userId: 'u1', agency: 'TTC', source: 'sms', route: '510', direction: 'Southbound',
    startStopName: 'Spadina Station', endStopName, stop_matched: true,
    startTime: ts(start), endTime: ts(start + 15 * 60000), ...extra,
  };
}

// 20 clean trips before the window: enough history for the V4/V5 eligibility gate (15).
const HISTORY = Array.from({ length: 20 }, (_, i) =>
  trip(`h${i}`, new Date(START.getTime() - (i + 1) * DAY).toISOString(), 'Queens Quay'));

// Stub engines answer from a per-trip table keyed by the trip's start time; stops match exactly.
function engines(table, calls = []) {
  const byTime = ctx => table[ctx.time.toISOString()] || {};
  return {
    v3: {
      stopsLibrary: null, networkGraph: null,
      _stopMatch: (a, b) => a === b,
      guessEndStop(history, ctx) {
        calls.push({ engine: 'v3', historyLen: history.length, ctx, networkGraph: this.networkGraph });
        const stop = byTime(ctx).v3;
        return stop ? { stop, confidence: 60 } : null;
      },
    },
    v4: { guessTopEndStops: (ctx, n) => { calls.push({ engine: 'v4', n, ctx }); const s = byTime(ctx).v4; return s ? [{ stop: s, confidence: 50 }] : []; } },
    v5: { guessTopEndStops: async (ctx, n) => { calls.push({ engine: 'v5', n, ctx }); const s = byTime(ctx).v5; return s ? [{ stop: s, confidence: 50 }] : []; } },
  };
}
const META = { feature_schema_version: 2, label_schema: 'agency::end_stop', agencies: ['TTC'] };

test('shadow grading: top-1, coverage, right-when-answered and the paired slice', async () => {
  const t1 = '2026-10-20T13:00:00.000Z';
  const t2 = '2026-10-21T13:00:00.000Z';
  const t3 = '2026-10-22T13:00:00.000Z';
  const t4 = '2026-10-23T13:00:00.000Z';
  const trips = [
    ...HISTORY,
    trip('a', t1, 'Queens Quay'),
    trip('b', t2, 'Union'),
    trip('c', t3, 'King'),
    trip('d', t4, 'Queens Quay'),
  ];
  const table = {
    [t1]: { v3: 'Queens Quay', v4: 'Queens Quay', v5: 'Union' }, // V3 hit, V4 hit, V5 miss
    [t2]: { v3: 'Queens Quay', v4: 'Union', v5: 'Union' }, //       V3 miss, V4 hit, V5 hit
    [t3]: { v4: 'King' }, //                                         V3/V5 silent, V4 hit (not paired)
    [t4]: { v3: 'Queens Quay', v4: 'King', v5: 'Queens Quay' }, //  V3 hit, V4 miss, V5 hit
  };
  const result = await gradeWindow({
    trips, start: START, end: END, engines: engines(table), metas: { v4: META, v5: META },
    hasBlockingCorrection: noCorrection,
  });

  assert.equal(result.tripsInWindow, 4);
  assert.equal(result.graded, 4);
  assert.equal(result.ineligible, 0);
  assert.deepEqual(
    { answered: result.engines.v3.answered, hits: result.engines.v3.hits, top1: result.engines.v3.top1, when: result.engines.v3.top1WhenAnswered },
    { answered: 3, hits: 2, top1: 0.5, when: 2 / 3 },
  );
  assert.deepEqual(
    { answered: result.engines.v4.answered, hits: result.engines.v4.hits, top1: result.engines.v4.top1, coverage: result.engines.v4.coverage },
    { answered: 4, hits: 3, top1: 0.75, coverage: 1 },
  );
  assert.equal(result.engines.v5.hits, 2);
  assert.equal(result.engines.v5.coverage, 0.75);
  // Paired: trips a, b, d (all three answered).
  assert.equal(result.paired.n, 3);
  assert.equal(result.paired.v3Top1, 2 / 3);
  assert.equal(result.paired.v4Top1, 2 / 3);
  assert.equal(result.paired.v5Top1, 2 / 3);
  // The stored summary carries counts only, never per-trip rows or stop names.
  assert.ok(!('rows' in publicSummary(result)));
  assert.doesNotMatch(JSON.stringify(publicSummary(result)), /Queens Quay|Union|King|Spadina/);
});

test('shadow grading: replays the live trip-start inputs (history before the trip, no network graph)', async () => {
  const t1 = '2026-10-20T13:00:00.000Z';
  const t2 = '2026-10-20T13:30:00.000Z';
  const calls = [];
  const trips = [
    ...HISTORY,
    trip('a', t1, 'Union', { route: '504' }),
    trip('b', t2, 'Queens Quay'),
    // Ends after b starts, so it can't be in b's history.
    trip('late', '2026-10-20T13:20:00.000Z', 'King', { endTime: ts('2026-10-20T14:30:00.000Z'), source: 'legacy-notion' }),
  ];
  await gradeWindow({
    trips, start: START, end: END, engines: engines({}, calls), metas: { v4: META, v5: META },
    hasBlockingCorrection: noCorrection,
  });
  const forB = calls.filter(c => c.ctx.time.toISOString() === t2);
  const v3 = forB.find(c => c.engine === 'v3');
  assert.equal(v3.historyLen, 21); // HISTORY + trip a, not the trip that was still running
  assert.equal(v3.networkGraph, null);
  assert.equal(v3.ctx.lastRoute, '504');
  assert.equal(v3.ctx.lastEndStopName, 'Union');
  assert.equal(v3.ctx.minutesSinceLastTrip, 30);
  assert.equal(v3.ctx.networkGraph, null);
  assert.equal(forB.find(c => c.engine === 'v4').n, 1);
  // The same context object goes to all three engines.
  assert.equal(forB.find(c => c.engine === 'v4').ctx, v3.ctx);
});

test('shadow grading: only texted, finished, clean trips in the window are graded', () => {
  const s = START.getTime();
  const e = END.getTime();
  const inside = '2026-10-21T13:00:00.000Z';
  assert.equal(isGradableTrip(trip('ok', inside, 'X'), s, e, noCorrection), true);
  assert.equal(isGradableTrip(trip('mms', inside, 'X', { source: 'mms' }), s, e, noCorrection), true);
  assert.equal(isGradableTrip(trip('outage', inside, 'X', { source: 'outage-recovery' }), s, e, noCorrection), false);
  assert.equal(isGradableTrip(trip('import', inside, 'X', { source: 'legacy-notion' }), s, e, noCorrection), false);
  assert.equal(isGradableTrip(trip('review', inside, 'X', { needs_review: true }), s, e, noCorrection), false);
  assert.equal(isGradableTrip(trip('unmatched', inside, 'X', { stop_matched: false }), s, e, noCorrection), false);
  assert.equal(isGradableTrip(trip('active', inside, 'X', { endTime: null }), s, e, noCorrection), false);
  assert.equal(isGradableTrip(trip('noend', inside, ''), s, e, noCorrection), false);
  assert.equal(isGradableTrip(trip('corrected', inside, 'X'), s, e, () => true), false);
  assert.equal(isGradableTrip(trip('old', '2026-10-10T13:00:00.000Z', 'X'), s, e, noCorrection), false);
});

test('shadow grading: trips live would not have run V4/V5 on are skipped, not counted as misses', async () => {
  const t1 = '2026-10-20T13:00:00.000Z';
  const fewHistory = HISTORY.slice(0, 5); // below the 15-trip eligibility gate
  const result = await gradeWindow({
    trips: [...fewHistory, trip('a', t1, 'Queens Quay')], start: START, end: END,
    engines: engines({ [t1]: { v3: 'Queens Quay', v4: 'Queens Quay', v5: 'Queens Quay' } }),
    metas: { v4: META, v5: META }, hasBlockingCorrection: noCorrection,
  });
  assert.equal(result.ineligible, 1);
  assert.equal(result.graded, 0);
  assert.equal(result.engines.v4.top1, null);

  const noAgency = await gradeWindow({
    trips: [...HISTORY, trip('a', t1, 'Queens Quay')], start: START, end: END,
    engines: engines({}), metas: { v4: { ...META, agencies: ['GO'] }, v5: META }, hasBlockingCorrection: noCorrection,
  });
  assert.equal(noAgency.ineligible, 1);
});

test('shadow grading: the window never reaches back before the published models were trained', () => {
  // Published Monday 2026-10-19 09:37 UTC; a 14-day window would grade trips the models trained on.
  assert.equal(windowStart(END, 14, '20261019T093750Z').toISOString(), '2026-10-19T09:37:50.000Z');
  // Published before the 7-day window: the window is unchanged.
  assert.equal(windowStart(END, 7, '20261012T040000Z').toISOString(), START.toISOString());
  // Local model folders have no version time.
  assert.equal(windowStart(END, 7, 'local').toISOString(), START.toISOString());
});
