/**
 * Dispatcher regression tests for idempotency and duplicate handling.
 * Run with: node test_dispatcher.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function buildHarness({
  idempotent = false,
  contentDuplicate = false,
  parseEndTripResult = null,
  user = { userId: 'user_1' },
  shouldRespondToUnknown = false,
  pendingState = null,
} = {}) {
  const calls = {
    checkIdempotency: 0,
    checkContentDuplicate: 0,
    handleEndTrip: 0,
    handleTripLog: 0,
    handleQuery: 0,
    handleAddNotes: [],
    handleMmsTrip: [],
    sendSmsReply: [],
    setPendingState: [],
    clearPendingState: 0,
    handleTripLogArgs: [],
    unknownSender: [],
    optOuts: [],
    optOutDeletes: [],
  };

  const handlers = {
    handleHelp: async () => {},
    handleRegister: async () => {},
    handleStatus: async () => {},
    handleStatsCommand: async () => {},
    handleIncomplete: async () => {},
    handleDiscard: async () => {},
    handleUnlink: async () => {},
    handleAddNotes: async (phoneNumber, userData, notes) => {
      calls.handleAddNotes.push({ phoneNumber, userData, notes });
    },
    handleMmsTrip: async (phoneNumber, userData, mediaUrl, receivedAt) => {
      calls.handleMmsTrip.push({ phoneNumber, userData, mediaUrl, receivedAt });
    },
    handleTripLog: async (...args) => {
      calls.handleTripLog++;
      calls.handleTripLogArgs.push(args);
    },
    handleEndTrip: async () => { calls.handleEndTrip++; },
    handleQuery: async () => { calls.handleQuery++; },
    fillPredictions: async () => {},
    handleConfirmStart: async () => {},
    handleVerificationCode: async () => {},
  };

  const dbModule = {
    isRateLimited: async () => false,
    checkIdempotency: async () => {
      calls.checkIdempotency++;
      return idempotent;
    },
    checkContentDuplicate: async () => {
      calls.checkContentDuplicate++;
      return contentDuplicate;
    },
    getFirestore: () => ({
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: false }),
        }),
      }),
    }),
    getPendingState: async () => pendingState,
    getUserByPhone: async () => user,
    getUserProfile: async () => ({ defaultAgency: 'TTC' }),
    isEmailAdmin: async () => false,
    shouldRespondToUnknown: async () => shouldRespondToUnknown,
    clearPendingState: async () => { calls.clearPendingState++; },
    setPendingState: async (_phoneNumber, state) => { calls.setPendingState.push(state); },
    db: {
      collection: (name) => ({
        add: async () => {},
        doc: (id) => ({
          update: async () => {},
          delete: async () => { if (name === 'smsOptOuts') calls.optOutDeletes.push(id); },
        }),
      }),
    },
    FieldValue: {
      delete: () => ({ _op: 'delete' }),
      increment: v => ({ _op: 'increment', v }),
      serverTimestamp: () => new Date(),
      arrayUnion: (...vals) => ({ _op: 'arrayUnion', vals }),
    },
    Timestamp: {
      now: () => ({ toDate: () => new Date() }),
      fromDate: (d) => ({ toDate: () => d }),
    },
  };

  const twilio = {
    sendSmsReply: async (phoneNumber, message) => {
      calls.sendSmsReply.push({ phoneNumber, message });
    },
    getTwilioPhoneNumber: () => '+19999999999',
  };

  const gemini = {
    parseWithGemini: async () => null,
    constructStopInput: () => null,
  };

  const parsing = {
    parseMultiLineTripFormat: () => null,
    parseSingleLineTripFormat: () => null,
    parseCasualTripFormat: () => null,
    parseEndTripFormat: () => parseEndTripResult,
  };

  const utils = {
    isValidRoute: () => true,
    normalizeDirection: (v) => v,
    getRouteDisplay: (route, dir) => (dir ? `${route} ${dir}` : `${route}`),
    getStopDisplay: (code, name, fallback) => code || name || fallback || 'Unknown',
    normalizeAgency: (v) => v,
  };

  const logger = {
    info: () => {},
    error: () => {},
  };

  const dispatcherPath = require.resolve('./lib/dispatcher');
  delete require.cache[dispatcherPath];

  const originalLoad = Module._load;
  const patchedLoad = function patchedLoad(request, parent, isMain) {
    if (parent && parent.id === dispatcherPath) {
      if (request === './db') return dbModule;
      if (request === './twilio') return twilio;
      if (request === './gemini') return gemini;
      if (request === './parsing') return parsing;
      if (request === './utils') return utils;
      if (request === './handlers') return handlers;
      if (request === './logger') return logger;
      if (request === './sms-invite') {
        return {
          createInviteHandlers: () => ({
            handleUnknownSender: async (phone) => { calls.unknownSender.push(phone); },
            markOptedOut: async (phone, reason) => { calls.optOuts.push([phone, reason]); },
          }),
        };
      }
      if (request === 'firebase-admin/auth') return { getAuth: () => ({}) };
    }
    return originalLoad(request, parent, isMain);
  };
  Module._load = patchedLoad;

  let realDispatch;
  try {
    ({ dispatch: realDispatch } = require('./lib/dispatcher'));
  } finally {
    Module._load = originalLoad;
  }

  const dispatch = async (...args) => {
    Module._load = patchedLoad;
    try {
      return await realDispatch(...args);
    } finally {
      Module._load = originalLoad;
    }
  };

  return { dispatch, calls };
}

test('dispatcher: duplicate MessageSid short-circuits before content dedup', async () => {
  const { dispatch, calls } = buildHarness({ idempotent: true, contentDuplicate: true });
  await dispatch('+14165551234', 'END Union', 'SM_DUPLICATE');

  assert.equal(calls.checkIdempotency, 1);
  assert.equal(calls.checkContentDuplicate, 0);
  assert.equal(calls.handleEndTrip, 0);
  assert.equal(calls.handleTripLog, 0);
  assert.equal(calls.handleQuery, 0);
});

test('dispatcher: END command bypasses content dedup and reaches end handler', async () => {
  const { dispatch, calls } = buildHarness({
    contentDuplicate: true,
    parseEndTripResult: { isEnd: true, stop: 'Union Station', notes: null },
  });
  await dispatch('+14165551234', 'END\nUnion Station', 'SM_END_1');

  assert.equal(calls.checkIdempotency, 1);
  assert.equal(calls.checkContentDuplicate, 0);
  assert.equal(calls.handleEndTrip, 1);
  assert.equal(calls.handleTripLog, 0);
});

test('dispatcher: single-line END [stop] also bypasses content dedup', async () => {
  const { dispatch, calls } = buildHarness({
    contentDuplicate: true,
    parseEndTripResult: null,
  });
  await dispatch('+14165551234', 'END College / Spadina', 'SM_END_2');

  assert.equal(calls.checkContentDuplicate, 0);
  assert.equal(calls.handleEndTrip, 1);
  assert.equal(calls.handleTripLog, 0);
});

test('dispatcher: non-END duplicate content is dropped before parsing', async () => {
  const { dispatch, calls } = buildHarness({
    contentDuplicate: true,
    parseEndTripResult: null,
  });
  await dispatch('+14165551234', '510 Spadina North', 'SM_DUP_CONTENT');

  assert.equal(calls.checkIdempotency, 1);
  assert.equal(calls.checkContentDuplicate, 1);
  assert.equal(calls.handleEndTrip, 0);
  assert.equal(calls.handleTripLog, 0);
  assert.equal(calls.handleQuery, 0);
});

test('dispatcher: NOTES command routes note text to add-notes handler', async () => {
  const { dispatch, calls } = buildHarness();
  await dispatch('+14165551234', 'NOTES train was packed', 'SM_NOTES_1');

  assert.equal(calls.handleAddNotes.length, 1);
  assert.equal(calls.handleAddNotes[0].phoneNumber, '+14165551234');
  assert.equal(calls.handleAddNotes[0].userData.userId, 'user_1');
  assert.equal(calls.handleAddNotes[0].notes, 'train was packed');
  assert.equal(calls.handleTripLog, 0);
  assert.equal(calls.handleEndTrip, 0);
});

test('dispatcher: multiline NOTES command routes note text to add-notes handler', async () => {
  const { dispatch, calls } = buildHarness();
  await dispatch('+14165551234', 'NOTES\nIt Was A Bus Replacement.', 'SM_NOTES_2');

  assert.equal(calls.handleAddNotes.length, 1);
  assert.equal(calls.handleAddNotes[0].phoneNumber, '+14165551234');
  assert.equal(calls.handleAddNotes[0].userData.userId, 'user_1');
  assert.equal(calls.handleAddNotes[0].notes, 'It Was A Bus Replacement.');
  assert.equal(calls.handleTripLog, 0);
  assert.equal(calls.handleEndTrip, 0);
});

test('dispatcher: MMS from known user triggers Snap-to-Start handler', async () => {
  const { dispatch, calls } = buildHarness({
    user: { userId: 'user_mms' },
  });
  await dispatch('+14165551234', '', 'SM_MMS_1', { numMedia: 1, mediaUrl: 'https://example.com/stop.jpg' });

  assert.equal(calls.handleMmsTrip.length, 1);
  assert.equal(calls.handleMmsTrip[0].phoneNumber, '+14165551234');
  assert.equal(calls.handleMmsTrip[0].userData.userId, 'user_mms');
  assert.equal(calls.handleMmsTrip[0].mediaUrl, 'https://example.com/stop.jpg');
  assert.equal(typeof calls.handleMmsTrip[0].receivedAt, 'number');
  assert.equal(calls.sendSmsReply.length, 0);
});

test('dispatcher: MMS from an unlinked number goes to invite handling, not trip logging', async () => {
  const { dispatch, calls } = buildHarness({ user: null });
  await dispatch('+14165550000', '', 'SM_MMS_2', { numMedia: 1, mediaUrl: 'https://example.com/stop.jpg' });

  assert.equal(calls.handleMmsTrip.length, 0);
  assert.deepEqual(calls.unknownSender, ['+14165550000']);
  assert.equal(calls.setPendingState.length, 0);
});

test('dispatcher: a text from an unlinked number goes to invite handling', async () => {
  const { dispatch, calls } = buildHarness({ user: null });
  await dispatch('+14165550001', '504 King to Spadina', 'SM_UNKNOWN_1');

  assert.deepEqual(calls.unknownSender, ['+14165550001']);
  assert.equal(calls.handleTripLog, 0);
});

test('dispatcher: STOP from an unlinked number records an opt-out and sends nothing', async () => {
  const { dispatch, calls } = buildHarness({ user: null });
  await dispatch('+14165550002', 'stop', 'SM_UNKNOWN_STOP');

  assert.deepEqual(calls.optOuts, [['+14165550002', 'inbound-keyword']]);
  assert.equal(calls.unknownSender.length, 0);
  assert.equal(calls.sendSmsReply.length, 0);
});

test('dispatcher: START / UNSTOP from a linked number clears the opt-out and carries on', async () => {
  const { dispatch, calls } = buildHarness({ user: { userId: 'u1' } });
  await dispatch('+14165550003', 'UNSTOP', 'SM_LINKED_UNSTOP');
  assert.deepEqual(calls.optOutDeletes, ['+14165550003']);
});

test('dispatcher: STOP / STOPALL from a linked number record an opt-out; other words do not', async () => {
  const { dispatch, calls } = buildHarness({ user: { userId: 'u1' } });
  await dispatch('+14165550004', 'stop', 'SM_LINKED_STOP');
  await dispatch('+14165550004', 'STOPALL', 'SM_LINKED_STOPALL');
  await dispatch('+14165550004', 'unsubscribe', 'SM_LINKED_UNSUB');
  assert.deepEqual(calls.optOuts, [['+14165550004', 'inbound-keyword'], ['+14165550004', 'inbound-keyword']]);
});

test('dispatcher: STARTUP and START also clear the opt-out', async () => {
  const { dispatch, calls } = buildHarness({ user: { userId: 'u1' } });
  await dispatch('+14165550005', 'startup', 'SM_STARTUP');
  assert.deepEqual(calls.optOutDeletes, ['+14165550005']);
});

test('dispatcher: mms_stop_needed single route uses stop reply and preserves receivedAt', async () => {
  const { dispatch, calls } = buildHarness({
    user: { userId: 'user_mms_followup' },
    pendingState: {
      type: 'mms_stop_needed',
      routeCandidates: [{ route: '510', agency: 'TTC' }],
      defaultAgency: 'TTC',
      receivedAt: 1710000000123,
    },
  });

  await dispatch('+14165557777', 'Spadina / College', 'SM_MMS_FOLLOWUP_1');

  assert.equal(calls.clearPendingState, 1);
  assert.equal(calls.handleTripLog, 1);
  const [, , stopInput, route, direction, agency, options] = calls.handleTripLogArgs[0];
  assert.equal(stopInput, 'Spadina / College');
  assert.equal(route, '510');
  assert.equal(direction, null);
  assert.equal(agency, 'TTC');
  assert.deepEqual(options, {
    parsed_by: 'mms',
    startTime: 1710000000123,
    source: 'mms',
    timing_reliability: 'approximate',
  });
});

test('dispatcher: mms_stop_needed multiple routes sets confirm_mms_route pending state', async () => {
  const { dispatch, calls } = buildHarness({
    user: { userId: 'user_mms_followup' },
    pendingState: {
      type: 'mms_stop_needed',
      routeCandidates: [{ route: '510', agency: 'TTC' }, { route: '310', agency: 'TTC' }],
      defaultAgency: 'TTC',
      receivedAt: 1710000000456,
    },
  });

  await dispatch('+14165557777', 'Spadina / College', 'SM_MMS_FOLLOWUP_2');

  assert.equal(calls.handleTripLog, 0);
  assert.equal(calls.setPendingState.length, 1);
  assert.equal(calls.setPendingState[0].type, 'confirm_mms_route');
  assert.equal(calls.setPendingState[0].stopInput, 'Spadina / College');
  assert.equal(calls.setPendingState[0].receivedAt, 1710000000456);
  assert.equal(calls.sendSmsReply.length, 1);
  assert.match(calls.sendSmsReply[0].message, /Which route\?/i);
});

test('dispatcher: confirm_mms_route selection starts trip with preserved timing metadata', async () => {
  const { dispatch, calls } = buildHarness({
    user: { userId: 'user_mms_followup' },
    pendingState: {
      type: 'confirm_mms_route',
      stopInput: 'Spadina / College',
      routeCandidates: [{ route: '510', agency: 'TTC' }, { route: '310', agency: 'TTC' }],
      defaultAgency: 'TTC',
      receivedAt: 1710000000789,
    },
  });

  await dispatch('+14165557777', '2', 'SM_MMS_FOLLOWUP_3');

  assert.equal(calls.clearPendingState, 1);
  assert.equal(calls.handleTripLog, 1);
  const [, , stopInput, route, direction, agency, options] = calls.handleTripLogArgs[0];
  assert.equal(stopInput, 'Spadina / College');
  assert.equal(route, '310');
  assert.equal(direction, null);
  assert.equal(agency, 'TTC');
  assert.deepEqual(options, {
    parsed_by: 'mms',
    startTime: 1710000000789,
    source: 'mms',
    timing_reliability: 'approximate',
  });
});

test('dispatcher: confirm_stop "1" clears state and updates trip', async () => {
  const stopCandidates = [
    { stopCode: '161', stopName: 'Bathurst / King', routes: ['511'], direction: null },
    { stopCode: '162', stopName: 'Bathurst / King', routes: ['511'], direction: null },
  ];
  const { dispatch, calls } = buildHarness({
    user: { userId: 'u_stop_choice' },
    pendingState: {
      type: 'confirm_stop',
      tripId: 'trip_abc',
      route: '511',
      direction: 'Northbound',
      agency: 'TTC',
      options: {},
      stopCandidates,
    },
  });

  await dispatch('+14165550099', '1', 'SM_STOP_CHOICE');

  assert.equal(calls.clearPendingState, 1, 'should clear pending state');
  assert.equal(calls.sendSmsReply.length, 1, 'should send stop confirmation');
  assert.match(calls.sendSmsReply[0].message, /Stop set to Bathurst \/ King/);
});

test('dispatcher: confirm_stop unrecognized input clears the optional prompt', async () => {
  const stopCandidates = [
    { stopCode: '161', stopName: 'Bathurst / King', routes: ['511'], direction: null },
    { stopCode: '162', stopName: 'Bathurst / King', routes: ['511'], direction: null },
  ];
  const { dispatch, calls } = buildHarness({
    user: { userId: 'u_stop_noise' },
    pendingState: {
      type: 'confirm_stop',
      tripId: 'trip_xyz',
      route: '511',
      direction: 'Northbound',
      agency: 'TTC',
      options: {},
      stopCandidates,
    },
  });

  await dispatch('+14165550099', '511 King Northbound', 'SM_STOP_NOISE');

  assert.equal(calls.clearPendingState, 1, 'should clear the optional prompt');
  assert.equal(calls.handleTripLog, 0, 'should not start a new trip');
  assert.equal(calls.handleQuery, 1, 'should continue normal dispatch');
  assert.equal(calls.sendSmsReply.length, 0, 'should not send the old reminder');
});

test('dispatcher: confirm_stop END falls through so the trip can be ended', async () => {
  const stopCandidates = [
    { stopCode: '161', stopName: 'Bathurst / King', routes: ['511'], direction: null },
    { stopCode: '162', stopName: 'Bathurst / King', routes: ['511'], direction: null },
  ];
  const { dispatch, calls } = buildHarness({
    user: { userId: 'u_stop_end' },
    pendingState: {
      type: 'confirm_stop',
      tripId: 'trip_xyz',
      route: '511',
      direction: 'Northbound',
      agency: 'TTC',
      options: {},
      stopCandidates,
    },
  });

  await dispatch('+14165550099', 'END Spadina Station', 'SM_STOP_END');

  assert.equal(calls.handleEndTrip, 1, 'END should reach handleEndTrip');
  assert.equal(calls.clearPendingState, 1, 'should clear the optional prompt');
});

test('dispatcher: confirm_stop SKIP dismisses the choice and keeps the trip', async () => {
  const stopCandidates = [
    { stopCode: '760', stopName: 'College Station', routes: ['506'], direction: 'Westbound' },
    { stopCode: '761', stopName: 'College Station', routes: ['506'], direction: 'Eastbound' },
  ];
  const { dispatch, calls } = buildHarness({
    user: { userId: 'u_stop_skip' },
    pendingState: {
      type: 'confirm_stop',
      tripId: 'trip_keep',
      route: '506',
      direction: null,
      agency: 'TTC',
      options: {},
      stopCandidates,
    },
  });

  await dispatch('+14165550099', 'SKIP', 'SM_STOP_SKIP');

  assert.equal(calls.clearPendingState, 1, 'should clear pending state');
  assert.equal(calls.sendSmsReply.length, 1, 'should confirm');
  assert.match(calls.sendSmsReply[0].message, /trip continues/i);
});

test('dispatcher: confirm_stop SKIP without tripId calls handleTripLog with skipDisambiguation', async () => {
  const stopCandidates = [
    { stopCode: '760', stopName: 'College Station', routes: ['506'], direction: 'Westbound' },
    { stopCode: '761', stopName: 'College Station', routes: ['506'], direction: 'Eastbound' },
  ];
  const { dispatch, calls } = buildHarness({
    user: { userId: 'u_stop_skip_no_trip' },
    pendingState: {
      type: 'confirm_stop',
      tripId: null,
      route: '506',
      direction: null,
      agency: 'TTC',
      options: { test: true },
      stopCandidates,
      stopInput: 'College Station',
    },
  });

  await dispatch('+14165550099', 'SKIP', 'SM_STOP_SKIP_NO_TRIP');

  assert.equal(calls.clearPendingState, 1, 'should clear pending state');
  assert.equal(calls.handleTripLog, 1, 'should call handleTripLog');
  const args = calls.handleTripLogArgs[0];
  assert.equal(args[2], 'College Station', 'should pass stopInput as third arg');
  assert.equal(args[3], '506', 'should pass route');
  assert.equal(args[4], null, 'should pass direction');
  assert.equal(args[5], 'TTC', 'should pass agency');
  assert.deepEqual(args[6], { test: true, skipDisambiguation: true }, 'should pass skipDisambiguation in options');
});

test('dispatcher: bare number with no pending state gets expiry note, not fallback', async () => {
  const { dispatch, calls } = buildHarness({ user: { userId: 'u_expired' } });

  await dispatch('+14165550099', '1', 'SM_EXPIRED_CHOICE');

  assert.equal(calls.sendSmsReply.length, 1, 'should send one reply');
  assert.match(calls.sendSmsReply[0].message, /choice expired/i);
  assert.doesNotMatch(calls.sendSmsReply[0].message, /Could not understand/);
});

test('dispatcher: confirm_stop STATUS falls through to normal dispatch', async () => {
  const stopCandidates = [
    { stopCode: '161', stopName: 'Bathurst / King', routes: ['511'], direction: null },
    { stopCode: '162', stopName: 'Bathurst / King', routes: ['511'], direction: null },
  ];
  const { dispatch, calls } = buildHarness({
    user: { userId: 'u_stop_status' },
    pendingState: {
      type: 'confirm_stop',
      tripId: 'trip_xyz',
      route: '511',
      direction: 'Northbound',
      agency: 'TTC',
      options: {},
      stopCandidates,
    },
  });

  await dispatch('+14165550099', 'STATUS', 'SM_STOP_STATUS');

  assert.equal(calls.clearPendingState, 1, 'should clear the optional prompt');
  assert.equal(calls.handleTripLog, 0, 'should not log a trip');
});
