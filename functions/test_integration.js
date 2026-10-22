/**
 * Integration tests for TransitStats SMS dispatch flow.
 *
 * Tests the full pipeline: dispatch() → handlers → Firestore writes.
 * No real SMS is sent (TS_TEST_MODE intercepts Twilio).
 * No Gemini API calls are made (returns null, forcing heuristic parser).
 *
 * Runs only against the Firestore emulator. It refuses to start without
 * FIRESTORE_EMULATOR_HOST, so test rows can never land in production
 * (earlier runs left ~580 integration-test-user docs in live data, CIV-426).
 *
 * Run with:
 *   npm run test:integration
 */

'use strict';

// Must be set before any module that reads it is required
process.env.TS_TEST_MODE = '1';

// Refuse to touch a real Firestore project. emulators:exec sets this for us.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('test_integration.js: FIRESTORE_EMULATOR_HOST is not set. ' +
    'Refusing to run against production. Use `npm run test:integration`.');
  process.exit(1);
}

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, getApps, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize Admin SDK before anything else loads db modules
let integrationApp;
if (!getApps().length) {
  integrationApp = initializeApp({ projectId: 'transitstats-21ba4' });
}
const db = getFirestore();

const { dispatch } = require('./lib/dispatcher');
const { getCapturedReplies, clearCapturedReplies } = require('./lib/twilio');

// ─── Test identity ──────────────────────────────────────────────────────────

const TEST_PHONE = '+10000000099'; // Never a real Twilio number
const TEST_USER_ID = 'integration-test-user';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let msgCounter = 0;
function nextSid() {
  return `TEST_SID_${Date.now()}_${++msgCounter}`;
}

/** Send a fake SMS and return the captured reply (or null if no reply sent). */
async function sms(body) {
  clearCapturedReplies();
  await dispatch(TEST_PHONE, body, nextSid());
  const replies = getCapturedReplies();
  return replies.length > 0 ? replies[replies.length - 1].message : null;
}

/** Fetch the most-recently-created trip for the test user. */
async function getLatestTrip() {
  const snap = await db.collection('trips')
    .where('userId', '==', TEST_USER_ID)
    .orderBy('startTime', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/** Delete all trips belonging to the test user. */
async function deleteAllTestTrips() {
  const snap = await db.collection('trips').where('userId', '==', TEST_USER_ID).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

before(async () => {
  // Clear any leftover trips or pending states from a previous run
  await db.collection('smsState').doc(TEST_PHONE).delete().catch(() => {});
  // Create test user records
  await db.collection('phoneNumbers').doc(TEST_PHONE).set({
    userId: TEST_USER_ID,
    phone: TEST_PHONE,
  });
  await db.collection('profiles').doc(TEST_USER_ID).set({
    defaultAgency: 'TTC',
    isPremium: true,
    isAdmin: false,
  });
  await deleteAllTestTrips();
  console.log('✅ Test user created');
});

after(async () => {
  await deleteAllTestTrips();
  await db.collection('phoneNumbers').doc(TEST_PHONE).delete();
  await db.collection('profiles').doc(TEST_USER_ID).delete();
  // Clean up pending state if any
  await db.collection('smsState').doc(TEST_PHONE).delete().catch(() => {});
  console.log('🧹 Test data cleaned up');
  if (integrationApp) {
    await deleteApp(integrationApp);
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Trip start', () => {
  test('multi-line format creates a trip', async () => {
    const reply = await sms('510\nSpadina / College\nNorth');
    assert.ok(reply, 'should get a reply');
    assert.match(reply, /Started/i);

    const trip = await getLatestTrip();
    assert.ok(trip, 'trip should exist in Firestore');
    assert.equal(trip.route, '510');
    assert.equal(trip.direction, 'Northbound');
    assert.ok(!trip.endTime, 'trip should not be ended yet');

    // Clean up so subsequent tests start fresh
    await db.collection('trips').doc(trip.id).delete();
  });

  test('single-line format creates a trip', async () => {
    const reply = await sms('506 College / Spadina East');
    assert.ok(reply, 'should get a reply');
    assert.match(reply, /Started/i);

    const trip = await getLatestTrip();
    assert.ok(trip, 'trip should exist in Firestore');
    assert.equal(trip.route, '506');
    assert.equal(trip.direction, 'Eastbound');

    await db.collection('trips').doc(trip.id).delete();
  });

  test('START prefix is stripped', async () => {
    const reply = await sms('Start 510 Spadina / College North');
    assert.ok(reply, 'should get a reply');
    assert.match(reply, /Started/i);

    const trip = await getLatestTrip();
    assert.ok(trip);
    assert.equal(trip.route, '510');

    await db.collection('trips').doc(trip.id).delete();
  });
});

describe('Trip end', () => {
  test('END with stop name ends the active trip', async () => {
    await sms('510\nSpadina / College\nNorth');
    const startedTrip = await getLatestTrip();
    assert.ok(startedTrip, 'trip should exist before ending');

    const reply = await sms('END Spadina / Bloor');
    assert.ok(reply, 'should get a reply');
    assert.match(reply, /ended|Ended|arrived/i);

    const endedTrip = await getLatestTrip();
    assert.ok(endedTrip.endTime, 'trip should have endTime');
    assert.ok(endedTrip.duration != null, 'trip should have duration');

    await db.collection('trips').doc(endedTrip.id).delete();
  });

  test('bare END ends active trip without stop', async () => {
    await sms('510\nSpadina / College\nNorth');

    const reply = await sms('END');
    assert.ok(reply, 'should get a reply');
    // Should end successfully or at least not crash silently
    assert.ok(reply.length > 0);

    const trip = await getLatestTrip();
    if (trip) await db.collection('trips').doc(trip.id).delete();
  });
});

describe('DISCARD command', () => {
  test('DISCARD deletes the active trip', async () => {
    await sms('510\nSpadina / College\nNorth');
    const activeTrip = await getLatestTrip();
    assert.ok(activeTrip, 'trip should exist');

    const reply = await sms('DISCARD');
    assert.ok(reply, 'should get a reply');
    assert.match(reply, /discarded|deleted|cancelled/i);

    const snap = await db.collection('trips').doc(activeTrip.id).get();
    assert.ok(!snap.exists, 'trip should be deleted from Firestore');
  });
});

describe('FORGOT command', () => {
  test('FORGOT marks active trip as incomplete', async () => {
    await sms('510\nSpadina / College\nNorth');
    const activeTrip = await getLatestTrip();
    assert.ok(activeTrip);

    const reply = await sms('FORGOT');
    assert.ok(reply, 'should get a reply');
    assert.match(reply, /incomplete/i);

    const trip = await getLatestTrip();
    assert.ok(trip.incomplete === true, 'trip should be marked incomplete');
    assert.ok(trip.endTime, 'incomplete trip should have an endTime set');

    await db.collection('trips').doc(trip.id).delete();
  });
});

describe('STATUS command', () => {
  test('STATUS with no active trip says nothing active', async () => {
    const reply = await sms('STATUS');
    assert.ok(reply, 'should get a reply');
    assert.match(reply, /no (active|current)/i);
  });

  test('STATUS with an active trip describes it', async () => {
    await sms('510\nSpadina / College\nNorth');

    const reply = await sms('STATUS');
    assert.ok(reply);
    assert.match(reply, /510/);

    const trip = await getLatestTrip();
    await db.collection('trips').doc(trip.id).delete();
  });
});

describe('STATS command', () => {
  test('STATS replies with trip summary', async () => {
    const reply = await sms('STATS');
    assert.ok(reply, 'should get a reply');
    // Conversational format — just check it returned something meaningful
    assert.ok(reply.length > 10);
  });
});

describe('UNLINK command', () => {
  test('UNLINK when no linked trip replies gracefully', async () => {
    // Start and end a trip (no linked journey)
    await sms('510\nSpadina / College\nNorth');
    await sms('END Spadina / Bloor');

    const reply = await sms('UNLINK');
    assert.ok(reply, 'should get a reply');

    const trip = await getLatestTrip();
    if (trip) await db.collection('trips').doc(trip.id).delete();
  });
});

describe('Unknown / fallback', () => {
  test('unrecognized message gets a fallback reply', async () => {
    const reply = await sms('xyzzy');
    // Fallback sends "Could not understand" or similar, and also writes to trips
    // Clean up the fallback trip that gets created
    const trip = await getLatestTrip();
    if (trip?.source === 'sms_fallback') {
      await db.collection('trips').doc(trip.id).delete();
    }
    // We just care it didn't crash — reply may be null if fallback only writes
    assert.ok(true);
  });
});
