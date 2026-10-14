/**
 * backfill-atlas-stops.js
 *
 * One-time repair for trips whose stop codes were not in the stops library at the time: looks each
 * unmatched trip's start and end stop up with the same read-only check the app now uses (library,
 * then the TRIP'S OWN agency's Atlas stops-meta), then
 *   - adds the missing Atlas stops to the library (deterministic id atlas_<slug>_<code>), and
 *   - marks a trip stop_matched only when BOTH ends resolve.
 * Never crosses agencies and never touches a trip it could not fully resolve or whose lookup errored.
 *
 * Dry run by default (reads only). With --apply it first writes an undo file, then writes.
 *
 *   node Tools/backfill-atlas-stops.js                      # dry run, prints the plan
 *   node Tools/backfill-atlas-stops.js --apply              # writes undo file, then applies
 *   node Tools/backfill-atlas-stops.js --undo <undo-file>   # dry run of the undo; add --apply to do it
 * Options: --key <service-account.json>  --user <uid>  --undo-dir <dir>
 *
 * Key default: ~/Developer/Credentials/Firebase for TransitStats.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const APPLY = flag('--apply');
const KEY_PATH = value('--key') || path.join(os.homedir(), 'Developer/Credentials/Firebase for TransitStats.json');
const ONLY_USER = value('--user');
const UNDO_FILE = value('--undo');
const UNDO_DIR = value('--undo-dir') || path.join(__dirname, 'undo');

// Load firebase-admin from functions/ so the app registry is shared with functions/lib/db/core.js.
const fromFunctions = id => require(require.resolve(id, { paths: [path.join(__dirname, '..', 'functions')] }));

async function main() {
  const { initializeApp, cert } = fromFunctions('firebase-admin/app');
  const { FieldValue } = fromFunctions('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'))) });
  const { db } = require('../functions/lib/db/core');

  if (UNDO_FILE) return undo({ db, FieldValue });

  const { lookupStopCheck } = require('../functions/lib/db/stops');
  console.log(APPLY ? '[APPLY]' : '[DRY RUN] No writes will be made.');

  let query = db.collection('trips').where('endTime', '!=', null);
  if (ONLY_USER) query = db.collection('trips').where('userId', '==', ONLY_USER).where('endTime', '!=', null);
  const tripsSnap = await query.get();

  const isMatched = t => (t.stop_matched != null ? !!t.stop_matched : !!t.verified);
  const candidates = tripsSnap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(t => !isMatched(t) && !t.discarded && t.agency
      && (t.startStopCode || t.startStopName || t.startStop) && (t.endStopCode || t.endStopName || t.endStop));

  const cache = new Map();
  const check = async (code, name, trip) => {
    const key = [trip.agency, code || '', name || '', trip.route || '', trip.direction || ''].join('|');
    if (!cache.has(key)) cache.set(key, lookupStopCheck(code, name, trip.agency, trip.route, trip.direction));
    return cache.get(key);
  };

  const flips = [];
  let atlasFlips = 0;
  const stopsToAdd = new Map(); // id -> record
  const skipped = { unresolved: [], errors: 0 };
  for (const trip of candidates) {
    const [start, end] = await Promise.all([
      check(trip.startStopCode, trip.startStopName || trip.startStop, trip),
      check(trip.endStopCode, trip.endStopName || trip.endStop, trip),
    ]);
    if (start.status === 'error' || end.status === 'error') { skipped.errors += 1; continue; }
    if (start.status !== 'found' || end.status !== 'found') {
      skipped.unresolved.push({ trip: trip.id, agency: trip.agency, start: start.status, end: end.status,
        codes: [trip.startStopCode, trip.endStopCode].filter(Boolean) });
      continue;
    }
    let usesAtlas = false;
    for (const found of [start.stop, end.stop]) {
      if (found?.source === 'atlas' && String(found.id).startsWith('atlas_')) { stopsToAdd.set(found.id, found); usesAtlas = true; }
    }
    if (usesAtlas) atlasFlips += 1;
    flips.push({ id: trip.id, userId: trip.userId, agency: trip.agency, prior: trip.stop_matched === undefined ? null : trip.stop_matched });
  }

  // Skip stop docs that already exist.
  for (const id of [...stopsToAdd.keys()]) {
    if ((await db.collection('stops').doc(id).get()).exists) stopsToAdd.delete(id);
  }

  const byAgency = {};
  for (const f of flips) byAgency[f.agency] = (byAgency[f.agency] || 0) + 1;
  console.log(`Unmatched trips considered: ${candidates.length}`);
  console.log(`Stops to add: ${stopsToAdd.size}`);
  for (const s of stopsToAdd.values()) console.log(`  + ${s.id}  ${s.agency}  ${s.code}  ${s.name}`);
  console.log(`Trips to flip to matched: ${flips.length}  ${JSON.stringify(byAgency)}  (${atlasFlips} depend on an Atlas stop, ${flips.length - atlasFlips} resolve from the existing library)`);
  console.log(`Left alone: ${skipped.unresolved.length} unresolved, ${skipped.errors} lookup errors`);
  for (const u of skipped.unresolved.slice(0, 40)) console.log(`  - ${u.trip} ${u.agency} start=${u.start} end=${u.end} codes=${u.codes.join(',')}`);
  if (!APPLY) return console.log('\nDry run only. Re-run with --apply to write (an undo file is written first).');

  fs.mkdirSync(UNDO_DIR, { recursive: true });
  const undoPath = path.join(UNDO_DIR, `backfill-atlas-stops-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(undoPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    createdStopIds: [...stopsToAdd.keys()],
    flippedTrips: flips.map(({ id, prior }) => ({ id, priorStopMatched: prior })),
  }, null, 2));
  console.log(`Undo file written: ${undoPath}`);

  for (const stop of stopsToAdd.values()) {
    const { id, stopCode, stopName, ...data } = stop;
    // create() fails if the doc appeared meanwhile, so an existing stop is never overwritten.
    await db.collection('stops').doc(id).create({ ...data, createdAt: new Date(), updatedAt: new Date() });
  }
  for (let i = 0; i < flips.length; i += 400) {
    const batch = db.batch();
    for (const f of flips.slice(i, i + 400)) batch.update(db.collection('trips').doc(f.id), { stop_matched: true });
    await batch.commit();
  }
  console.log(`Applied: ${stopsToAdd.size} stops added, ${flips.length} trips flipped.`);
}

async function undo({ db, FieldValue }) {
  const plan = JSON.parse(fs.readFileSync(UNDO_FILE, 'utf8'));
  console.log(`${APPLY ? '[APPLY]' : '[DRY RUN]'} Undo of ${UNDO_FILE}`);
  console.log(`Stops to delete: ${plan.createdStopIds.length}; trips to restore: ${plan.flippedTrips.length}`);
  if (!APPLY) return console.log('Dry run only. Re-run with --apply to undo.');
  for (let i = 0; i < plan.flippedTrips.length; i += 400) {
    const batch = db.batch();
    for (const t of plan.flippedTrips.slice(i, i + 400)) {
      batch.update(db.collection('trips').doc(t.id), {
        stop_matched: t.priorStopMatched === null ? FieldValue.delete() : t.priorStopMatched,
      });
    }
    await batch.commit();
  }
  for (const id of plan.createdStopIds) await db.collection('stops').doc(id).delete();
  console.log('Undo applied.');
}

main().catch(error => { console.error(error); process.exit(1); });
