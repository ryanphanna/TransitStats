// Pull every ride into ml/lab/data/ for the analysis lab, counted exactly the way the app counts.
//
// Unlike ml/export_trips.py (training-clean trips only), nothing is filtered out: logged trips of
// every source, incomplete and review-flagged ones included, plus imported PRESTO rides that were
// not also logged. Each logged trip gets `counted` from the app's own countedRides(), so lab totals
// match the website and ASK. Never writes ml/trips.csv (training reads it; EVAL.md pins its own
// snapshot).
//
// Usage (from the repo root):   node ml/lab/export_all.mjs
// Writes: data/rides.jsonl (one ride per line) and data/stops.json (the stops library).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DATA = path.join(HERE, 'data');
const KEY_PATH = process.env.TRANSITSTATS_KEY || path.join(os.homedir(), 'Developer/Credentials/Firebase for TransitStats.json');

const fnRequire = createRequire(path.join(ROOT, 'functions/lib/index.js'));
const { initializeApp, cert } = fnRequire('firebase-admin/app');
const { getFirestore } = fnRequire('firebase-admin/firestore');
initializeApp({ credential: cert(JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'))) });
const db = getFirestore();

const { countedRides } = fnRequire('./trip-stats.js');
const { buildPrestoTrips } = fnRequire('./presto-trips.js');

// Same rider the MCP server answers for: the single admin profile.
const admins = await db.collection('profiles').where('isAdmin', '==', true).get();
if (admins.size !== 1) throw new Error(`Expected exactly one admin profile, found ${admins.size}.`);
const userId = admins.docs[0].id;

const plain = v => {
  if (v && typeof v.toDate === 'function') return v.toDate().toISOString();
  if (v && typeof v.latitude === 'number' && typeof v.longitude === 'number') return { lat: v.latitude, lng: v.longitude };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v instanceof Date ? v.toISOString() : v;
};

const [tripSnap, prestoSnap, stopSnap] = await Promise.all([
  db.collection('trips').where('userId', '==', userId).get(),
  db.collection('prestoTransactions').where('userId', '==', userId).get(),
  db.collection('stops').get(),
]);

const logged = tripSnap.docs.map(doc => ({ ...doc.data(), _id: doc.id }));
const rides = countedRides(logged, buildPrestoTrips(prestoSnap.docs.map(d => d.data())));
const countedIds = new Set(rides.filter(r => r._id).map(r => r._id));
const imported = rides.filter(r => r.imported);

fs.mkdirSync(DATA, { recursive: true });
const out = fs.createWriteStream(path.join(DATA, 'rides.jsonl'));
for (const t of logged) {
  const { userId: _u, ...rest } = t;
  out.write(JSON.stringify({ ...plain(rest), counted: countedIds.has(t._id) }) + '\n');
}
imported.forEach((r, i) => out.write(JSON.stringify({ ...plain(r), _id: `presto-${i}`, source: 'presto', counted: true }) + '\n'));
await new Promise(resolve => out.end(resolve));

const stops = stopSnap.docs.map(d => {
  const s = d.data();
  return { name: s.name, aliases: s.aliases || [], agency: s.agency, agencies: s.agencies || [], lat: s.lat ?? null, lng: s.lng ?? null, code: s.code ?? null };
});
fs.writeFileSync(path.join(DATA, 'stops.json'), JSON.stringify(stops));

console.log(`${logged.length} logged trips (${countedIds.size} counted) + ${imported.length} PRESTO rides = ${rides.length} counted rides; ${stops.length} stops`);
