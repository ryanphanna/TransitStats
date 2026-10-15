/**
 * Tests for TransferEngine
 * Run with: node test_transfer.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TransferEngine } = require('./lib/transfer');

// Helper to build a fake trip
function trip({ route, startStop, endStop, startTime, endTime, journeyId } = {}) {
  const toTS = (d) => ({ toDate: () => d });
  return {
    id: Math.random().toString(36).slice(2),
    route: route || '510',
    startStopName: startStop || 'Spadina / College',
    endStopName: endStop || 'Spadina Station',
    startTime: toTS(startTime || new Date('2026-04-15T20:00:00Z')),
    endTime: toTS(endTime || new Date('2026-04-15T20:10:00Z')),
    journeyId: journeyId || null,
  };
}

// Build a pair of linked trips (with journeyId) for history
function linkedPair({ routeA = '510', routeB = '2', endStop = 'Spadina Station', startStop = 'Spadina Station', gap = 5, baseTime = new Date('2026-04-15T20:00:00Z') } = {}) {
  const id = Math.random().toString(36).slice(2);
  const endTime = new Date(baseTime.getTime() + 10 * 60000);
  const nextStart = new Date(endTime.getTime() + gap * 60000);
  const nextEnd = new Date(nextStart.getTime() + 8 * 60000);
  return [
    trip({ route: routeA, endStop, endTime, journeyId: id, startTime: baseTime }),
    trip({ route: routeB, startStop, startTime: nextStart, endTime: nextEnd, journeyId: id }),
  ];
}

// ─── extractTransfers ────────────────────────────────────────────────────────

test('extractTransfers: finds transfer from linked pair', () => {
  const history = linkedPair({ routeA: '510', routeB: '2', endStop: 'Spadina Station', startStop: 'Spadina Station', gap: 5 });
  const transfers = TransferEngine.extractTransfers(history);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].routeA, '510');
  assert.equal(transfers[0].routeB, '2');
  assert.ok(Math.abs(transfers[0].gap - 5) < 1);
});

test('extractTransfers: ignores trips without journeyId', () => {
  const history = [trip(), trip()];
  const transfers = TransferEngine.extractTransfers(history);
  assert.equal(transfers.length, 0);
});

test('extractTransfers: ignores single-trip journeys', () => {
  const t = trip({ journeyId: 'abc' });
  const transfers = TransferEngine.extractTransfers([t]);
  assert.equal(transfers.length, 0);
});

// ─── score ───────────────────────────────────────────────────────────────────

test('score: cold start, small gap links', () => {
  const prev = trip({ endStop: 'Spadina Station', endTime: new Date('2026-04-15T20:10:00Z') });
  const next = trip({ startStop: 'Spadina Station', startTime: new Date('2026-04-15T20:20:00Z') });
  const confidence = TransferEngine.score(prev, next, []);
  assert.ok(confidence >= TransferEngine.CONFIDENCE_THRESHOLD, `Expected >= ${TransferEngine.CONFIDENCE_THRESHOLD}, got ${confidence}`);
});

test('score: cold start, large gap does not link', () => {
  const prev = trip({ endStop: 'Spadina Station', endTime: new Date('2026-04-15T20:10:00Z') });
  const next = trip({ startStop: 'Spadina Station', startTime: new Date('2026-04-15T21:00:00Z') });
  const confidence = TransferEngine.score(prev, next, []);
  assert.ok(confidence < TransferEngine.CONFIDENCE_THRESHOLD);
});

test('score: known stop pair within typical gap links', () => {
  const history = [
    ...linkedPair({ routeA: '47', routeB: '506', endStop: 'Laurel / Willow', startStop: 'Laurel / Willow', gap: 4 }),
    ...linkedPair({ routeA: '47', routeB: '506', endStop: 'Laurel / Willow', startStop: 'Laurel / Willow', gap: 6 }),
  ];
  const prev = trip({ route: '47', endStop: 'Laurel / Willow', endTime: new Date('2026-04-15T20:10:00Z') });
  const next = trip({ route: '506', startStop: 'Laurel / Willow', startTime: new Date('2026-04-15T20:15:00Z') });
  const confidence = TransferEngine.score(prev, next, history);
  assert.ok(confidence >= TransferEngine.CONFIDENCE_THRESHOLD, `Expected >= ${TransferEngine.CONFIDENCE_THRESHOLD}, got ${confidence}`);
});

test('score: known stop pair but gap way outside historical range does not link', () => {
  // Historical transfers at this stop averaged 5 min — 31 min should not link
  const history = [
    ...linkedPair({ endStop: 'Laurel / Willow', startStop: 'Laurel / Willow', gap: 4 }),
    ...linkedPair({ endStop: 'Laurel / Willow', startStop: 'Laurel / Willow', gap: 5 }),
    ...linkedPair({ endStop: 'Laurel / Willow', startStop: 'Laurel / Willow', gap: 6 }),
  ];
  const prev = trip({ endStop: 'Laurel / Willow', endTime: new Date('2026-04-15T20:10:00Z') });
  const next = trip({ startStop: 'Laurel / Willow', startTime: new Date('2026-04-15T20:41:00Z') }); // 31 min gap
  const confidence = TransferEngine.score(prev, next, history);
  assert.ok(confidence < TransferEngine.CONFIDENCE_THRESHOLD, `Expected < ${TransferEngine.CONFIDENCE_THRESHOLD}, got ${confidence}`);
});

test('score: negative gap returns 0', () => {
  const prev = trip({ endTime: new Date('2026-04-15T20:10:00Z') });
  const next = trip({ startTime: new Date('2026-04-15T20:05:00Z') });
  assert.equal(TransferEngine.score(prev, next, []), 0);
});

test('score: gap over 90 min returns 0', () => {
  const prev = trip({ endTime: new Date('2026-04-15T20:00:00Z') });
  const next = trip({ startTime: new Date('2026-04-15T21:31:00Z') });
  assert.equal(TransferEngine.score(prev, next, []), 0);
});

test('score: tonight\'s false positive (31 min, no history) does not link', () => {
  // Before TransferEngine, two 47 trips 31 min apart got linked — should not happen without history
  const prev = trip({ route: '47', endStop: 'Hazel / Laurel', endTime: new Date('2026-04-16T00:56:00Z') });
  const next = trip({ route: '47', startStop: 'Hazel / Laurel', startTime: new Date('2026-04-16T01:00:00Z') });
  // With only 4 min gap it would still link — the issue was 31 min. Let's test 31 min.
  const prev2 = trip({ route: '47', endStop: 'Laurel / Willow', endTime: new Date('2026-04-16T00:20:00Z') });
  const next2 = trip({ route: '47', startStop: 'Laurel / Willow', startTime: new Date('2026-04-16T00:51:00Z') });
  const confidence = TransferEngine.score(prev2, next2, []);
  assert.ok(confidence < TransferEngine.CONFIDENCE_THRESHOLD, `31-min gap with no history should not link, got ${confidence}`);
});

// ─── _stopMatch ──────────────────────────────────────────────────────────────

test('_stopMatch: same name matches', () => {
  assert.equal(TransferEngine._stopMatch('Spadina Station', 'Spadina Station'), true);
});

test('_stopMatch: different punctuation matches', () => {
  assert.equal(TransferEngine._stopMatch('Laurel / Willow', 'Laurel/Willow'), true);
});

test('_stopMatch: case insensitive', () => {
  assert.equal(TransferEngine._stopMatch('spadina station', 'Spadina Station'), true);
});

test('_stopMatch: different stops do not match', () => {
  assert.equal(TransferEngine._stopMatch('Spadina Station', 'Bathurst Station'), false);
});

test('_stopMatch: null inputs return false', () => {
  assert.equal(TransferEngine._stopMatch(null, 'Spadina Station'), false);
  assert.equal(TransferEngine._stopMatch('Spadina Station', null), false);
});

test('_stopMatch: connected transfer-complex stops match', () => {
  assert.equal(
    TransferEngine._stopMatch('College St at Yonge St - College Station', 'College Station'),
    true
  );
});

test('_stopMatch: king complex connected stops match', () => {
  assert.equal(
    TransferEngine._stopMatch('Adelaide St West at Yonge St - King Station', 'King'),
    true
  );
});

test('_stopMatch: dundas west complex connected stops match', () => {
  assert.equal(
    TransferEngine._stopMatch('Dundas West Station', 'Dundas West'),
    true
  );
});

test('_stopMatch: bloor-yonge complex connected stops match', () => {
  assert.equal(
    TransferEngine._stopMatch('Bloor-Yonge Station', 'Bloor-Yonge'),
    true
  );
});

test('_stopMatch: cedarvale complex connected stops match', () => {
  assert.equal(
    TransferEngine._stopMatch('Cedarvale Station', 'Cedarvale'),
    true
  );
});

test('_stopMatch: keelesdale complex connected stops match', () => {
  assert.equal(
    TransferEngine._stopMatch('Keelesdale Station', 'Keelesdale'),
    true
  );
});

test('_stopMatch: st george complex connected stops match', () => {
  assert.equal(
    TransferEngine._stopMatch('St George Station', 'Stgeorge'),
    true
  );
});

test('_stopMatch: lawrence west complex connected stops match', () => {
  assert.equal(
    TransferEngine._stopMatch('LAWRENCE W STATION', 'Lawrence West'),
    true
  );
});

test('_stopMatch: sheppard-yonge complex connected stops match', () => {
  assert.equal(
    TransferEngine._stopMatch('SHEPPARD-YONGE', 'Sheppard-Yonge Station'),
    true
  );
});

test('_stopMatch: osgoode complex connected stops match', () => {
  assert.equal(
    TransferEngine._stopMatch('OSGOODE', 'Osgoode Station'),
    true
  );
});

test('_stopMatch: college bay pair matches college station', () => {
  assert.equal(
    TransferEngine._stopMatch('College / Bay', 'College Station'),
    true
  );
});

test('_stopMatch: college station pair matches college yonge', () => {
  assert.equal(
    TransferEngine._stopMatch('College Station', 'College / Yonge'),
    true
  );
});

test('_stopMatch: queens quay spadina pair matches', () => {
  assert.equal(
    TransferEngine._stopMatch('Spadina / Queens Quay', 'Spadina / Queens Quay West'),
    true
  );
});

test('_stopMatch: queen and spadina corner pair matches', () => {
  assert.equal(
    TransferEngine._stopMatch('Queen St West at Spadina Ave', 'Spadina Ave at Queen St West North Side'),
    true
  );
});

test('_stopMatch: dufferin lawrence pair matches', () => {
  assert.equal(
    TransferEngine._stopMatch('Dufferin / Lawrence', 'Lawrence / Dufferin'),
    true
  );
});

test('_stopMatch: harbord spadina pair matches', () => {
  assert.equal(
    TransferEngine._stopMatch('Harbord / Spadina', '8124 Spadina and Harbord'),
    true
  );
});

test('_stopMatch: spadina harbord reverse pair matches', () => {
  assert.equal(
    TransferEngine._stopMatch('Spadina / Harbord', 'Harbord / Spadina'),
    true
  );
});

test('_stopMatch: spadina king numbered stop pair matches', () => {
  assert.equal(
    TransferEngine._stopMatch('Spadina / King', '13161 Spadina / King'),
    true
  );
});

test('_stopMatch: carlaw queen numbered stop pair matches', () => {
  assert.equal(
    TransferEngine._stopMatch('Queen St E / Carlaw Av', '4858 Carlaw & Queen St E'),
    true
  );
});

test('_stopMatch: dufferin college drift matches', () => {
  assert.equal(
    TransferEngine._stopMatch('Dufferin&college', '826 College & Dufferin'),
    true
  );
});

test('_stopMatch: dundas sterling typo matches', () => {
  assert.equal(
    TransferEngine._stopMatch('Dundas/Sterling', 'Dundas/Sterlingp'),
    true
  );
});

test('_stopMatch: keelsdale typo matches keelesdale', () => {
  assert.equal(
    TransferEngine._stopMatch('Keelsdale', 'Keelesdale'),
    true
  );
});

// ─── score: NetworkEngine signal (v1.1) ──────────────────────────────────────

test('score: cold start + network connection extends window to 20 min', () => {
  // 17 min gap — would not link without network evidence (cold start limit is 15)
  const prev = trip({ route: '510', endStop: 'Spadina Station', endTime: new Date('2026-04-15T20:00:00Z') });
  const next = trip({ route: '2', startStop: 'Spadina Station', startTime: new Date('2026-04-15T20:17:00Z') });
  const noNetwork = TransferEngine.score(prev, next, []);
  assert.ok(noNetwork < TransferEngine.CONFIDENCE_THRESHOLD, `17 min with no network should not link, got ${noNetwork}`);
  const withNetwork = TransferEngine.score(prev, next, [], { '510_to_2': 3 });
  assert.ok(withNetwork >= TransferEngine.CONFIDENCE_THRESHOLD, `17 min with known network connection should link, got ${withNetwork}`);
});

test('score: no-pattern + strong network connection links at short gap', () => {
  // Has history but no matching stop or route pair — network connection should push over threshold
  const history = linkedPair({ routeA: '47', routeB: '506', endStop: 'Laurel / Willow', startStop: 'Laurel / Willow' });
  const prev = trip({ route: '510', endStop: 'Spadina Station', endTime: new Date('2026-04-15T20:00:00Z') });
  const next = trip({ route: '2', startStop: 'Spadina Station', startTime: new Date('2026-04-15T20:08:00Z') });
  const noNetwork = TransferEngine.score(prev, next, history);
  assert.ok(noNetwork < TransferEngine.CONFIDENCE_THRESHOLD, `No-pattern with no network should not link, got ${noNetwork}`);
  const withNetwork = TransferEngine.score(prev, next, history, { '510_to_2': 4 });
  assert.ok(withNetwork >= TransferEngine.CONFIDENCE_THRESHOLD, `No-pattern with known connection + 8 min gap should link, got ${withNetwork}`);
});

test('score: network connection count < 2 does not boost', () => {
  // Only 1 observation — not enough to trust
  const prev = trip({ route: '510', endStop: 'Spadina Station', endTime: new Date('2026-04-15T20:00:00Z') });
  const next = trip({ route: '2', startStop: 'Spadina Station', startTime: new Date('2026-04-15T20:17:00Z') });
  const confidence = TransferEngine.score(prev, next, [], { '510_to_2': 1 });
  assert.ok(confidence < TransferEngine.CONFIDENCE_THRESHOLD, `Single observation should not boost cold start, got ${confidence}`);
});

test('score: connected transfer-complex stop pair links from history', () => {
  const history = [
    ...linkedPair({
      routeA: '506',
      routeB: '1',
      endStop: 'College St at Yonge St - College Station',
      startStop: 'College Station',
      gap: 3,
    }),
  ];
  const prev = trip({
    route: '506',
    endStop: 'College St at Yonge St - College Station',
    endTime: new Date('2026-04-15T20:10:00Z'),
  });
  const next = trip({
    route: '1',
    startStop: 'College Station',
    startTime: new Date('2026-04-15T20:13:00Z'),
  });
  const confidence = TransferEngine.score(prev, next, history);
  assert.ok(confidence >= TransferEngine.CONFIDENCE_THRESHOLD, `Expected connected stop pair to link, got ${confidence}`);
});

test('score: bloor-yonge complex stop pair links from history', () => {
  const history = [
    ...linkedPair({
      routeA: '1',
      routeB: '2',
      endStop: 'Bloor-Yonge Station',
      startStop: 'Bloor-Yonge',
      gap: 4,
    }),
  ];
  const prev = trip({
    route: '1',
    endStop: 'Bloor-Yonge Station',
    endTime: new Date('2026-04-15T20:10:00Z'),
  });
  const next = trip({
    route: '2',
    startStop: 'Bloor-Yonge',
    startTime: new Date('2026-04-15T20:14:00Z'),
  });
  const confidence = TransferEngine.score(prev, next, history);
  assert.ok(confidence >= TransferEngine.CONFIDENCE_THRESHOLD, `Expected Bloor-Yonge stop pair to link, got ${confidence}`);
});

test('score: sheppard-yonge complex stop pair links from history', () => {
  const history = [
    ...linkedPair({
      routeA: '1',
      routeB: '84A',
      endStop: 'SHEPPARD-YONGE',
      startStop: 'Sheppard-Yonge Station',
      gap: 6,
    }),
  ];
  const prev = trip({
    route: '1',
    endStop: 'SHEPPARD-YONGE',
    endTime: new Date('2026-04-15T20:10:00Z'),
  });
  const next = trip({
    route: '84A',
    startStop: 'Sheppard-Yonge Station',
    startTime: new Date('2026-04-15T20:16:00Z'),
  });
  const confidence = TransferEngine.score(prev, next, history);
  assert.ok(confidence >= TransferEngine.CONFIDENCE_THRESHOLD, `Expected Sheppard-Yonge stop pair to link, got ${confidence}`);
});

test('score: connected stop pair links from history for intersection-style transfer', () => {
  const history = [
    ...linkedPair({
      routeA: '509',
      routeB: '510',
      endStop: 'Spadina / Queens Quay',
      startStop: 'Spadina / Queens Quay West',
      gap: 5,
    }),
  ];
  const prev = trip({
    route: '509',
    endStop: 'Spadina / Queens Quay',
    endTime: new Date('2026-04-15T20:10:00Z'),
  });
  const next = trip({
    route: '510',
    startStop: 'Spadina / Queens Quay West',
    startTime: new Date('2026-04-15T20:15:00Z'),
  });
  const confidence = TransferEngine.score(prev, next, history);
  assert.ok(confidence >= TransferEngine.CONFIDENCE_THRESHOLD, `Expected connected stop pair to link, got ${confidence}`);
});

// ─── suggestConnectedPairs ───────────────────────────────────────────────────

test('suggestConnectedPairs: surfaces repeated short-gap unknown pairs', () => {
  const history = [
    ...linkedPair({
      routeA: '506',
      routeB: '1',
      endStop: 'College St at Spadina Ave',
      startStop: 'Spadina Station',
      gap: 4,
    }),
    ...linkedPair({
      routeA: '506',
      routeB: '1',
      endStop: 'College St at Spadina Ave',
      startStop: 'Spadina Station',
      gap: 5,
      baseTime: new Date('2026-04-16T20:00:00Z'),
    }),
    ...linkedPair({
      routeA: '506',
      routeB: '1',
      endStop: 'College St at Spadina Ave',
      startStop: 'Spadina Station',
      gap: 6,
      baseTime: new Date('2026-04-17T20:00:00Z'),
    }),
  ];

  const suggestions = TransferEngine.suggestConnectedPairs(history);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].count, 3);
  assert.equal(suggestions[0].medianGap, 5);
  assert.equal(suggestions[0].topRoutePairs[0].routePair, '506 -> 1');
});

test('suggestConnectedPairs: ignores pairs already in transfer connections', () => {
  const history = [
    ...linkedPair({
      routeA: '506',
      routeB: '1',
      endStop: 'College Station',
      startStop: 'College / Yonge',
      gap: 3,
    }),
    ...linkedPair({
      routeA: '506',
      routeB: '1',
      endStop: 'College Station',
      startStop: 'College / Yonge',
      gap: 4,
      baseTime: new Date('2026-04-16T20:00:00Z'),
    }),
    ...linkedPair({
      routeA: '506',
      routeB: '1',
      endStop: 'College Station',
      startStop: 'College / Yonge',
      gap: 5,
      baseTime: new Date('2026-04-17T20:00:00Z'),
    }),
  ];

  const suggestions = TransferEngine.suggestConnectedPairs(history);
  assert.equal(suggestions.length, 0);
});

test('suggestConnectedPairs: filters out weak or slow pairs', () => {
  const history = [
    ...linkedPair({
      routeA: '47',
      routeB: '29',
      endStop: 'Laurel / Willow',
      startStop: 'Grove / Juniper',
      gap: 20,
    }),
    ...linkedPair({
      routeA: '47',
      routeB: '29',
      endStop: 'Laurel / Willow',
      startStop: 'Grove / Juniper',
      gap: 18,
      baseTime: new Date('2026-04-16T20:00:00Z'),
    }),
    ...linkedPair({
      routeA: '47',
      routeB: '29',
      endStop: 'Laurel / Willow',
      startStop: 'Grove / Juniper',
      gap: 16,
      baseTime: new Date('2026-04-17T20:00:00Z'),
    }),
  ];

  const suggestions = TransferEngine.suggestConnectedPairs(history);
  assert.equal(suggestions.length, 0);
});

test('score: typo-cleaned stop pair links from history', () => {
  const history = [
    ...linkedPair({
      routeA: '41',
      routeB: '5',
      endStop: 'Keelsdale',
      startStop: 'Keelesdale',
      gap: 6,
    }),
  ];
  const prev = trip({
    route: '41',
    endStop: 'Keelsdale',
    endTime: new Date('2026-04-15T20:10:00Z'),
  });
  const next = trip({
    route: '5',
    startStop: 'Keelesdale',
    startTime: new Date('2026-04-15T20:16:00Z'),
  });
  const confidence = TransferEngine.score(prev, next, history);
  assert.ok(confidence >= TransferEngine.CONFIDENCE_THRESHOLD, `Expected typo-cleaned stop pair to link, got ${confidence}`);
});
