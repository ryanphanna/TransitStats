/**
 * repair-trip-directions.js (CIV-1458)
 *
 * One-time repair of stored trips:
 *   - Direction typos and case variants ("SOUTH", "North", "WB", "Northq") become the app's direction
 *     values (Northbound/Southbound/Eastbound/Westbound/Clockwise/Counterclockwise/Inbound/Outbound),
 *     using the same helpers new trips use (functions/lib/utils.js normalizeDirection, then the parser's
 *     near-miss check). Destination-style text ("Downtown", "To SJ", "West (Santa Monica)") and other
 *     non-compass words are left as typed. Missing directions are only counted, never guessed.
 *   - Zero-length trips (endTime equal to startTime) that are not already marked get the same marking
 *     FORGOT uses: incomplete: true, duration: null. Trips already marked incomplete are skipped.
 *
 * Dry run by default (reads only). With --apply it first writes an undo file, then writes.
 *
 *   node Tools/repair-trip-directions.js                      # dry run, prints the plan
 *   node Tools/repair-trip-directions.js --apply              # writes undo file, then applies
 * Options: --key <service-account.json>  --user <uid>  --undo-dir <dir>  --verbose
 *
 * Key default: ~/Developer/Credentials/Firebase for TransitStats.json. Without it, the script uses the
 * gcloud application-default login (`gcloud auth application-default login`) through firebase-admin,
 * for both the dry run and --apply; writes then need that login to have write access.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const APPLY = flag('--apply');
const VERBOSE = flag('--verbose');
const KEY_PATH = value('--key') || path.join(os.homedir(), 'Developer/Credentials/Firebase for TransitStats.json');
const ONLY_USER = value('--user');
const UNDO_DIR = value('--undo-dir') || path.join(__dirname, 'undo');
const PROJECT_ID = 'transitstats-21ba4';

const APP_DIRECTIONS = new Set([
  'Northbound', 'Southbound', 'Eastbound', 'Westbound',
  'Clockwise', 'Counterclockwise', 'Inbound', 'Outbound',
]);

const fromFunctions = id => require(require.resolve(id, { paths: [path.join(__dirname, '..', 'functions')] }));

/** The app direction a stored value should be, or null when it should stay as it is. */
function repairedDirection(stored) {
  if (typeof stored !== 'string' || !stored.trim() || APP_DIRECTIONS.has(stored)) return null;
  const { normalizeDirection } = require('../functions/lib/utils');
  const { looseDirection } = require('../functions/lib/parsing');
  const exact = normalizeDirection(stored);
  const fixed = APP_DIRECTIONS.has(exact) ? exact : looseDirection(stored);
  return APP_DIRECTIONS.has(fixed) ? fixed : null;
}

const millis = v => (v == null ? null : v.toMillis ? v.toMillis() : new Date(v).getTime());

async function main() {
  const { initializeApp, cert, applicationDefault } = fromFunctions('firebase-admin/app');
  const { getFirestore } = fromFunctions('firebase-admin/firestore');
  const haveKey = fs.existsSync(KEY_PATH);
  initializeApp(haveKey
    ? { credential: cert(JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'))) }
    : { credential: applicationDefault(), projectId: PROJECT_ID });
  const db = getFirestore();

  console.log(APPLY ? '[APPLY]' : '[DRY RUN] No writes will be made.');
  if (!haveKey) console.log('(No admin key found; using the gcloud application-default login.)');

  const query = ONLY_USER ? db.collection('trips').where('userId', '==', ONLY_USER) : db.collection('trips');
  const snap = await query.get();
  const trips = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  // sms_fallback rows are unparsed texts kept for review, not trips.
  const realTrips = trips.filter(t => t.source !== 'sms_fallback');

  const directionFixes = [];
  const keptAsTyped = new Map();
  let missingDirection = 0;
  for (const t of realTrips) {
    if (t.direction == null || (typeof t.direction === 'string' && !t.direction.trim())) {
      missingDirection += 1;
      continue;
    }
    const fixed = repairedDirection(t.direction);
    if (fixed) directionFixes.push({ id: t.id, from: t.direction, to: fixed });
    else if (!APP_DIRECTIONS.has(t.direction)) keptAsTyped.set(t.direction, (keptAsTyped.get(t.direction) || 0) + 1);
  }

  const zeroLength = realTrips.filter(t => t.endTime != null && millis(t.endTime) === millis(t.startTime));
  const zeroToMark = zeroLength.filter(t => t.incomplete !== true || t.duration != null);

  const tally = {};
  directionFixes.forEach(f => { const k = `${JSON.stringify(f.from)} -> ${f.to}`; tally[k] = (tally[k] || 0) + 1; });

  console.log(`\nTrips read: ${trips.length} (${realTrips.length} excluding sms_fallback rows)`);
  console.log(`\nDirection fixes: ${directionFixes.length}`);
  Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${n} x ${k}`));
  console.log(`Directions kept as typed (not compass words): ${[...keptAsTyped.values()].reduce((a, b) => a + b, 0)}`);
  if (VERBOSE) [...keptAsTyped].forEach(([d, n]) => console.log(`  ${n} x ${JSON.stringify(d)}`));
  console.log(`Trips with no direction (left alone): ${missingDirection}`);
  console.log(`\nZero-length trips: ${zeroLength.length} (already marked incomplete: ${zeroLength.length - zeroToMark.length})`);
  console.log(`Zero-length trips to mark incomplete: ${zeroToMark.length}`);
  if (VERBOSE) zeroToMark.forEach(t => console.log(`  ${t.id} route ${t.route} incomplete=${t.incomplete} duration=${t.duration}`));

  if (!APPLY) return console.log('\nDry run only. Re-run with --apply to write (an undo file is written first).');

  fs.mkdirSync(UNDO_DIR, { recursive: true });
  const undoPath = path.join(UNDO_DIR, `repair-trip-directions-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const undo = {
    createdAt: new Date().toISOString(),
    directions: directionFixes.map(({ id, from }) => ({ id, priorDirection: from })),
    zeroLength: zeroToMark.map(t => ({ id: t.id, priorIncomplete: t.incomplete ?? null, priorDuration: t.duration ?? null })),
  };
  fs.writeFileSync(undoPath, JSON.stringify(undo, null, 2));
  console.log(`Undo file written: ${undoPath}`);

  const writes = [
    ...directionFixes.map(f => [f.id, { direction: f.to }]),
    ...zeroToMark.map(t => [t.id, { incomplete: true, duration: null }]),
  ];
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    writes.slice(i, i + 400).forEach(([id, data]) => batch.update(db.collection('trips').doc(id), data));
    await batch.commit();
  }
  console.log(`Applied ${writes.length} updates.`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { repairedDirection };
