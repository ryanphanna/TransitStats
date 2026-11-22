/**
 * backfill-presto-stop-matches.js
 *
 * Matches already-imported PRESTO rows to the stop library (then Atlas stops) and saves the result on each row
 * (stopMatchStatus + matchedStop), the same way the importer now does at import. Also the re-match
 * pass for rows that didn't match before (say, after adding a stop alias): rows already matched are
 * left alone.
 *
 * Dry run by default (reads only). With --apply it first writes an undo file, then writes.
 *   node Tools/backfill-presto-stop-matches.js                     # dry run, the admin profile's rows
 *   node Tools/backfill-presto-stop-matches.js --apply             # writes undo file, then applies
 *   node Tools/backfill-presto-stop-matches.js --undo <file> --apply
 * Options: --key <service-account.json>  --user <uid>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const APPLY = flag('--apply');
const UNDO_FILE = value('--undo');
const ROOT = path.join(__dirname, '..');
const KEY_PATH = value('--key') || path.join(os.homedir(), 'Developer/Credentials/Firebase for TransitStats.json');
const UNDO_DIR = path.join(__dirname, 'undo');
const ATLAS_STOPS_URL = 'https://us-central1-transitstats-21ba4.cloudfunctions.net/atlasStops';
const fromFunctions = id => require(require.resolve(id, { paths: [path.join(ROOT, 'functions')] }));

async function main() {
  const { initializeApp, cert, applicationDefault } = fromFunctions('firebase-admin/app');
  const { getFirestore, FieldValue } = fromFunctions('firebase-admin/firestore');
  initializeApp(fs.existsSync(KEY_PATH)
    ? { credential: cert(JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'))) }
    : { credential: applicationDefault(), projectId: 'transitstats-21ba4' });
  const db = getFirestore();

  if (UNDO_FILE) {
    const undo = JSON.parse(fs.readFileSync(UNDO_FILE, 'utf8'));
    console.log(`${APPLY ? 'Restoring' : 'Would restore'} ${undo.length} rows from ${UNDO_FILE}`);
    if (APPLY) await writeAll(db, undo.map(u => ({ id: u.id, data: {
      stopMatchStatus: u.stopMatchStatus ?? FieldValue.delete(),
      matchedStop: u.matchedStop ?? FieldValue.delete(),
    } })));
    return;
  }

  let uid = value('--user');
  if (!uid) {
    const admins = await db.collection('profiles').where('isAdmin', '==', true).get();
    if (admins.size !== 1) throw new Error(`Found ${admins.size} admin profiles; pass --user <uid>.`);
    uid = admins.docs[0].id;
  }

  const { preparePrestoStops, prestoMatchFields } = await import(pathToFileURL(path.join(ROOT, 'js/presto-stop-matcher.js')).href);
  const [rowSnap, stopSnap] = await Promise.all([
    db.collection('prestoTransactions').where('userId', '==', uid).get(),
    db.collection('stops').get(),
  ]);
  // Atlas (each agency's full GTFS stop list) fills in stops the library doesn't have, as at import.
  const agencies = [...new Set(rowSnap.docs.map(d => d.data().agency).filter(Boolean))];
  const atlasStops = (await Promise.all(agencies.map(async agency => {
    const res = await fetch(`${ATLAS_STOPS_URL}?agency=${encodeURIComponent(agency)}`);
    if (!res.ok) { console.log(`(Atlas stops unavailable for ${agency})`); return []; }
    return Object.entries(await res.json()).map(([code, stop]) => ({ code, name: stop.name, lat: Number(stop.lat), lng: Number(stop.lon), agency }))
      .filter(stop => stop.name && Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
  }))).flat();
  const stops = preparePrestoStops({ firestoreStops: stopSnap.docs.map(d => ({ id: d.id, ...d.data() })), atlasStops });

  const counts = { matched: 0, ambiguous: 0, unmatched: 0, alreadyMatched: 0 };
  const unmatched = new Map();
  const changes = [];
  const undo = [];
  rowSnap.docs.forEach(doc => {
    const row = doc.data();
    if (row.type !== 'fare_payment') return;
    if (row.stopMatchStatus === 'matched' && row.matchedStop) { counts.alreadyMatched++; return; }
    const fields = prestoMatchFields(row, stops);
    counts[fields.stopMatchStatus]++;
    if (fields.stopMatchStatus !== 'matched') {
      const key = `${row.agency}: ${row.locationLabel || row.location} (${fields.stopMatchStatus})`;
      unmatched.set(key, (unmatched.get(key) || 0) + 1);
    }
    if (fields.stopMatchStatus === row.stopMatchStatus && !fields.matchedStop) return;
    changes.push({ id: doc.id, data: fields });
    undo.push({ id: doc.id, stopMatchStatus: row.stopMatchStatus ?? null, matchedStop: row.matchedStop ?? null });
  });

  console.log(`Rows: ${rowSnap.size}. Matched ${counts.matched}, ambiguous ${counts.ambiguous}, unmatched ${counts.unmatched}, already matched ${counts.alreadyMatched}.`);
  [...unmatched.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${n} × ${k}`));
  console.log(`${APPLY ? 'Writing' : 'Would write'} ${changes.length} rows.`);
  if (!APPLY || !changes.length) return;

  fs.mkdirSync(UNDO_DIR, { recursive: true });
  const undoPath = path.join(UNDO_DIR, `presto-stop-matches-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(undoPath, JSON.stringify(undo, null, 2));
  console.log(`Undo file: ${undoPath}`);
  await writeAll(db, changes);
  console.log('Done.');
}

async function writeAll(db, changes) {
  for (let i = 0; i < changes.length; i += 400) {
    const batch = db.batch();
    changes.slice(i, i + 400).forEach(c => batch.update(db.collection('prestoTransactions').doc(c.id), c.data));
    await batch.commit();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
