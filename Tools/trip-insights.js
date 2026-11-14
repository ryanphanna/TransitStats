/**
 * trip-insights.js
 *
 * Private, read-only report of patterns in one rider's trips, for finding things worth talking
 * about. Writes a self-contained HTML page (no network needed to view it) to _reports/, which is
 * listed in .git/info/exclude. Never commit the output: it holds personal trip data.
 *
 *   node Tools/trip-insights.js                 # the admin profile's trips -> _reports/trip-insights.html
 * Options: --user <uid>  --key <service-account.json>  --out <file.html>
 *
 * Key default: ~/Developer/Credentials/Firebase for TransitStats.json. Without it, the script uses
 * the gcloud application-default login (`gcloud auth application-default login`). Reads only.
 *
 * Stops resolve the app's way: a stop code becomes its stop record's name (within the trip's
 * agency), the name goes through the app's alias lookup (js/predict.js _canonicalizeStop), and
 * platform records group under their station (functions/lib/utils.js stopNameKey).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// ---- Thresholds (change here) ----
/** A route, or a route between two stops, needs at least this many timed trips to be reported. */
const MIN_ROUTE_TRIPS = 10;
/** A time-of-day group needs at least this many trips to be compared. */
const MIN_BUCKET_TRIPS = 5;
/** Any other finding (an agency, a place away from home, a weekday) needs at least this many trips. */
const MIN_FINDING_TRIPS = 5;
/** Trips longer than this are treated as a forgotten end, not a real ride. */
const MAX_TRIP_MINUTES = 180;

const args = process.argv.slice(2);
const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const ROOT = path.join(__dirname, '..');
const KEY_PATH = value('--key') || path.join(os.homedir(), 'Developer/Credentials/Firebase for TransitStats.json');
const OUT_PATH = path.resolve(value('--out') || path.join(ROOT, '_reports', 'trip-insights.html'));
const PROJECT_ID = 'transitstats-21ba4';

const fromFunctions = id => require(require.resolve(id, { paths: [path.join(ROOT, 'functions')] }));
const TS = require('../functions/lib/trip-stats');
const { stopNameKey, stationBaseName } = require('../functions/lib/utils');

const TIME_OF_DAY = [
  { key: 'morning', label: 'morning peak (6 to 10 am)', from: 6, to: 10 },
  { key: 'midday', label: 'midday (10 am to 3 pm)', from: 10, to: 15 },
  { key: 'afternoon', label: 'afternoon peak (3 to 7 pm)', from: 15, to: 19 },
  { key: 'evening', label: 'evening and night (7 pm to 6 am)', from: 19, to: 6 },
];

// ---- Small helpers ----
const toDate = v => (v == null ? null : v.toDate ? v.toDate() : new Date(v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = n => Number(n).toLocaleString('en-CA');
const mins = m => `${Math.round(m)} min`;
const pct = (a, b) => `${Math.round((a / b) * 100)}%`;
const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? '' : 's'}`;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}
function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: percentile(s, 50), p25: percentile(s, 25), p75: percentile(s, 75), min: s[0], max: s[s.length - 1] };
}

/** "HIGHWAY 407 STATION" reads as "Highway 407 Station"; mixed-case names stay as typed. */
function displayName(label) {
  const text = stationBaseName(String(label || '').trim());
  if (/[a-z]/.test(text) || !/[A-Z]{3}/.test(text)) return text;
  return text.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

/** Route family: 510A and 510B ride as 510 (same rule as the prediction engine); "Line 1" stays. */
function routeFamily(route) {
  const s = String(route ?? '').trim();
  return /^\d/.test(s) ? s.match(/^\d+/)[0] : s;
}

function tripMinutes(trip) {
  const start = toDate(trip.startTime);
  const end = toDate(trip.endTime);
  if (start && end) return (end - start) / 60000;
  return Number(trip.duration) > 0 ? Number(trip.duration) : null;
}

/** Usable for durations: not discarded or ended early, longer than zero, no longer than the cap. */
function isTimed(trip) {
  if (trip.discarded || trip.incomplete) return false;
  const m = tripMinutes(trip);
  return m !== null && m > 0 && m <= MAX_TRIP_MINUTES;
}

function bucketOf(hour) {
  if (hour == null) return null;
  const b = TIME_OF_DAY.find(x => (x.from < x.to ? hour >= x.from && hour < x.to : hour >= x.from || hour < x.to));
  return b ? b.key : null;
}

function localDateTime(trip) {
  const d = toDate(trip.startTime);
  if (!d) return '';
  return d.toLocaleString('en-CA', { timeZone: TS.storedTripTimeZone(trip), dateStyle: 'medium', timeStyle: 'short' });
}
const prettyDay = dayKey => new Date(`${dayKey}T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', dateStyle: 'long' });

// ---- Data ----
async function loadData() {
  const { initializeApp, cert, applicationDefault } = fromFunctions('firebase-admin/app');
  const { getFirestore } = fromFunctions('firebase-admin/firestore');
  const haveKey = fs.existsSync(KEY_PATH);
  initializeApp(haveKey
    ? { credential: cert(JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'))) }
    : { credential: applicationDefault(), projectId: PROJECT_ID });
  const db = getFirestore();
  if (!haveKey) console.log('(No admin key found; using the gcloud application-default login.)');

  let uid = value('--user');
  if (!uid) {
    const admins = await db.collection('profiles').where('isAdmin', '==', true).get();
    if (admins.size !== 1) throw new Error(`Found ${admins.size} admin profiles; pass --user <uid>.`);
    uid = admins.docs[0].id;
  }
  const [tripSnap, stopSnap] = await Promise.all([
    db.collection('trips').where('userId', '==', uid).get(),
    db.collection('stops').get(),
  ]);
  return {
    trips: tripSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    stops: stopSnap.docs.map(d => d.data()),
  };
}

/** Stop resolver: code -> record name within the agency, then the app's alias lookup, then station key. */
async function makeResolver(stops) {
  const { PredictionEngine } = await import(pathToFileURL(path.join(ROOT, 'js/predict.js')).href);
  PredictionEngine.stopsLibrary = stops;
  const byCode = new Map();
  stops.forEach(s => {
    if (!s.code || !s.name) return;
    const agencies = [s.agency, ...(s.agencies || [])].filter(Boolean).map(a => String(a).toLowerCase());
    agencies.forEach(a => { const k = `${a}|${String(s.code).trim()}`; if (!byCode.has(k)) byCode.set(k, s.name); });
  });
  const labels = new Map(); // station key -> Map(display name -> count)
  return {
    resolve(rawLabel, agency) {
      const raw = String(rawLabel || '').trim();
      if (!raw || /^(incomplete|unknown)/i.test(raw)) return null;
      const named = (/^\d+$/.test(raw) && byCode.get(`${String(agency || '').toLowerCase()}|${raw}`)) || raw;
      const key = stopNameKey(PredictionEngine._canonicalizeStop(named, agency) || named);
      if (!key) return null;
      if (!labels.has(key)) labels.set(key, new Map());
      const shown = displayName(named);
      labels.get(key).set(shown, (labels.get(key).get(shown) || 0) + 1);
      return key;
    },
    label(key) {
      const seen = labels.get(key);
      return seen ? [...seen.entries()].sort((a, b) => b[1] - a[1])[0][0] : key;
    },
  };
}

// ---- Analysis ----
function analyze(allTrips, resolver) {
  const counted = TS.countedTrips(allTrips);
  const timed = counted.filter(isTimed);
  const homeZone = Object.entries(counted.reduce((acc, t) => { const z = TS.storedTripTimeZone(t); acc[z] = (acc[z] || 0) + 1; return acc; }, {}))
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  // Resolve every stop once, so labels pick the most common spelling.
  counted.forEach(t => {
    const agency = TS.tripAgency(t);
    t._start = resolver.resolve(TS.boardingStop(t), agency);
    t._end = resolver.resolve(TS.exitStop(t), agency);
    t._min = tripMinutes(t);
    t._day = TS.tripLocalDay(t);
    t._hour = TS.tripLocalHour(t);
  });

  // Totals
  const dated = counted.filter(t => t._day).sort((a, b) => toDate(a.startTime) - toDate(b.startTime));
  const byDate = TS.tripsByDate(counted);
  const hours = timed.reduce((s, t) => s + t._min, 0) / 60;
  const agencies = TS.tripsByAgency(counted).counts;
  const routes = TS.tripsByRoute(counted).counts;
  // Most-ridden routes per agency ("1" alone could be any agency's route 1).
  const byAgencyRoute = new Map();
  counted.forEach(t => { const a = TS.tripAgency(t) || 'No agency'; if (!byAgencyRoute.has(a)) byAgencyRoute.set(a, []); byAgencyRoute.get(a).push(t); });
  const topRoutes = [...byAgencyRoute.entries()]
    .flatMap(([a, ts]) => TS.tripsByRoute(ts).counts.map(([route, n]) => [`${a} ${route}`, n]))
    .sort((x, y) => y[1] - x[1]).slice(0, 10);
  const stopUses = new Map();
  counted.forEach(t => [t._start, t._end].forEach(k => k && stopUses.set(k, (stopUses.get(k) || 0) + 1)));
  const topStops = [...stopUses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => [resolver.label(k), n]);
  const countries = {};
  counted.forEach(t => { const c = TS.agencyCountry(t.agency); if (c) countries[c] = (countries[c] || 0) + 1; });

  // Streaks with dates
  const days = Object.keys(byDate.byDay).sort();
  const dayNum = k => Math.round(Date.parse(`${k}T00:00:00Z`) / 86400000);
  let best = { len: 0 }; let runStart = 0;
  days.forEach((d, i) => {
    if (i === 0 || dayNum(d) - dayNum(days[i - 1]) !== 1) runStart = i;
    const len = i - runStart + 1;
    if (len > best.len) best = { len, from: days[runStart], to: d, trips: days.slice(runStart, i + 1).reduce((s, k) => s + byDate.byDay[k], 0) };
  });
  const busiestDay = Object.entries(byDate.byDay).sort((a, b) => b[1] - a[1])[0];
  const busiestMonth = Object.entries(byDate.byMonth).sort((a, b) => b[1] - a[1])[0];
  const weekdays = TS.DAY_NAMES.map(d => [d, byDate.byWeekday[d] || 0]).sort((a, b) => b[1] - a[1]);
  const hourCounts = new Array(24).fill(0);
  counted.forEach(t => { if (t._hour != null) hourCounts[t._hour]++; });
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

  // Firsts per agency
  const firstByAgency = new Map();
  dated.forEach(t => { const a = TS.tripAgency(t); if (a && !firstByAgency.has(a)) firstByAgency.set(a, t); });
  const agencyFirsts = agencies.filter(([, n]) => n >= MIN_FINDING_TRIPS)
    .map(([a, n]) => ({ agency: a, n, first: firstByAgency.get(a) }))
    .filter(x => x.first)
    .sort((a, b) => toDate(a.first.startTime) - toDate(b.first.startTime));

  // Route + stop pairs (direction matters), route families merged
  const pairs = new Map();
  const routeTimes = new Map();
  timed.forEach(t => {
    const agency = TS.tripAgency(t) || '';
    const fam = routeFamily(t.route);
    if (!fam) return;
    const rk = `${agency}\u0000${fam}`;
    if (!routeTimes.has(rk)) routeTimes.set(rk, { agency, route: fam, trips: [] });
    routeTimes.get(rk).trips.push(t);
    if (!t._start || !t._end || t._start === t._end) return;
    const pk = `${rk}\u0000${t._start}\u0000${t._end}`;
    if (!pairs.has(pk)) pairs.set(pk, { agency, route: fam, from: resolver.label(t._start), to: resolver.label(t._end), trips: [] });
    pairs.get(pk).trips.push(t);
  });
  const regular = [...pairs.values()].filter(p => p.trips.length >= MIN_ROUTE_TRIPS).map(p => {
    const s = stats(p.trips.map(t => t._min));
    const sorted = [...p.trips].sort((a, b) => a._min - b._min);
    const buckets = TIME_OF_DAY.map(b => {
      const ms = p.trips.filter(t => bucketOf(t._hour) === b.key).map(t => t._min);
      return { ...b, ...stats(ms) };
    }).filter(b => b.n >= MIN_BUCKET_TRIPS);
    return { ...p, s, fastest: sorted[0], slowest: sorted[sorted.length - 1], buckets, spread: s.p75 - s.p25 };
  }).sort((a, b) => b.trips.length - a.trips.length);

  const steadiest = [...regular].filter(p => p.s.median >= 5).sort((a, b) => a.spread / a.s.median - b.spread / b.s.median).slice(0, 5);
  const leastSteady = [...regular].sort((a, b) => b.spread / b.s.median - a.spread / a.s.median).slice(0, 5);
  const timeOfDay = regular.filter(p => p.buckets.length >= 2).map(p => {
    const sorted = [...p.buckets].sort((a, b) => a.median - b.median);
    const fast = sorted[0]; const slow = sorted[sorted.length - 1];
    return { ...p, fast, slow, diff: slow.median - fast.median };
  }).filter(p => Math.round(p.diff) >= 1).sort((a, b) => b.diff - a.diff).slice(0, 8);
  const routeLengths = [...routeTimes.values()].filter(r => r.trips.length >= MIN_ROUTE_TRIPS)
    .map(r => ({ ...r, s: stats(r.trips.map(t => t._min)) }))
    .sort((a, b) => b.s.median - a.s.median);

  // Away from home (trips in another time zone), grouped by agency
  const away = new Map();
  counted.filter(t => TS.storedTripTimeZone(t) !== homeZone && t.timezone).forEach(t => {
    const a = TS.tripAgency(t) || 'No agency';
    if (!away.has(a)) away.set(a, []);
    away.get(a).push(t);
  });
  const awayRows = [...away.entries()].filter(([, ts]) => ts.length >= MIN_FINDING_TRIPS).map(([agency, ts]) => {
    const ds = ts.filter(t => t._day).map(t => t._day.dayKey).sort();
    const tm = ts.filter(isTimed).map(t => t._min);
    const routesHere = new Set(ts.map(t => routeFamily(t.route)).filter(Boolean));
    return { agency, n: ts.length, zone: TS.storedTripTimeZone(ts[0]), country: TS.agencyCountry(agency), from: ds[0], to: ds[ds.length - 1], days: new Set(ds).size, routes: routesHere.size, timed: tm.length, s: tm.length >= MIN_FINDING_TRIPS ? stats(tm) : null };
  }).sort((a, b) => b.n - a.n);

  return {
    all: allTrips.length, counted: counted.length, timed: timed.length, hours, homeZone,
    first: dated[0], last: dated[dated.length - 1], daysRidden: byDate.daysRidden,
    agencies, routes, topRoutes, topStops, countries, best, busiestDay, busiestMonth, weekdays, hourCounts, peakHour,
    agencyFirsts, regular, steadiest, leastSteady, timeOfDay, routeLengths, awayRows,
  };
}

// ---- HTML ----
function render(r) {
  const routeName = p => `${esc(p.agency)} ${esc(p.route)}`;
  const pairName = p => `${routeName(p)}, ${esc(p.from)} to ${esc(p.to)}`;
  const section = (title, body, note = '') => `<section><h2>${title}</h2>${note ? `<p class="note">${note}</p>` : ''}${body}</section>`;
  const list = items => (items.length ? `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>` : '<p class="note">Nothing meets the threshold yet.</p>');
  const table = (head, rows) => (rows.length
    ? `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '<p class="note">Nothing meets the threshold yet.</p>');
  const range = s => `${mins(s.p25)} to ${mins(s.p75)}`;
  const hourLabel = h => new Date(Date.UTC(2000, 0, 1, h)).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric' });

  const totals = list([
    `<b>${fmtInt(r.counted)}</b> trips logged, from ${esc(localDateTime(r.first))} to ${esc(localDateTime(r.last))}, on ${plural(r.daysRidden, 'day')}.`,
    `<b>${Math.round(r.hours).toLocaleString('en-CA')} hours</b> on transit, counting the ${fmtInt(r.timed)} trips with a usable time (the rest have no end time, ended early, or ran over ${MAX_TRIP_MINUTES / 60} hours).`,
    `<b>${r.routes.length}</b> routes, <b>${r.agencies.length}</b> agencies, <b>${Object.keys(r.countries).length}</b> countries (${Object.entries(r.countries).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${esc(c)} ${fmtInt(n)}`).join(', ')}).`,
    `Most trips start around <b>${hourLabel(r.peakHour)}</b> (${fmtInt(r.hourCounts[r.peakHour])} trips start in that hour). Busiest weekday: <b>${esc(r.weekdays[0][0])}</b> (${fmtInt(r.weekdays[0][1])}); quietest: ${esc(r.weekdays[6][0])} (${fmtInt(r.weekdays[6][1])}).`,
  ]);
  const topRoutes = table(['Route', 'Trips'], r.topRoutes.map(([n, c]) => [esc(n), fmtInt(c)]));
  const topStops = table(['Stop or station', 'Times boarded or left'], r.topStops.map(([n, c]) => [esc(n), fmtInt(c)]));
  const topAgencies = table(['Agency', 'Trips', 'Share'], r.agencies.slice(0, 12).map(([a, n]) => [esc(a), fmtInt(n), pct(n, r.counted)]));

  const streaks = list([
    `Longest run of days in a row with at least one trip: <b>${plural(r.best.len, 'day')}</b>, ${esc(prettyDay(r.best.from))} to ${esc(prettyDay(r.best.to))} (${fmtInt(r.best.trips)} trips).`,
    `Most trips in one day: <b>${fmtInt(r.busiestDay[1])}</b> on ${esc(prettyDay(r.busiestDay[0]))}.`,
    `Busiest month: <b>${esc(new Date(`${r.busiestMonth[0]}-15T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'long', year: 'numeric' }))}</b>, ${fmtInt(r.busiestMonth[1])} trips.`,
  ]);

  const firsts = table(['Agency', 'First trip', 'Route', 'Trips since'], r.agencyFirsts.map(x => [esc(x.agency), esc(localDateTime(x.first)), esc(x.first.route || ''), fmtInt(x.n)]));

  const steady = list(r.steadiest.map(p => `${pairName(p)}: usually <b>${mins(p.s.median)}</b>, and the middle half of trips fall within ${range(p.s)} (a ${Math.round(p.spread)}-minute window). ${p.s.n} trips.`));
  const unsteady = list(r.leastSteady.map(p => `${pairName(p)}: usually <b>${mins(p.s.median)}</b>, but the middle half ranges ${range(p.s)} (a ${Math.round(p.spread)}-minute window). Fastest ${mins(p.s.min)}, slowest ${mins(p.s.max)}. ${p.s.n} trips.`));

  const tod = list(r.timeOfDay.map(p => `${pairName(p)}: <b>${mins(p.slow.median)}</b> in the ${esc(p.slow.label)} (${p.slow.n} trips) vs <b>${mins(p.fast.median)}</b> in the ${esc(p.fast.label)} (${p.fast.n} trips), a ${Math.round(p.diff)}-minute difference (typical times). ${p.s.n} trips in all.`));

  const extremes = table(['Trip', 'Trips', 'Typical', 'Fastest', 'Slowest'], r.regular.slice(0, 15).map(p => [
    pairName(p), fmtInt(p.s.n), mins(p.s.median),
    `${mins(p.fastest._min)}<br><span class="note">${esc(localDateTime(p.fastest))}</span>`,
    `${mins(p.slowest._min)}<br><span class="note">${esc(localDateTime(p.slowest))}</span>`,
  ]));

  const routeLens = table(['Route', 'Timed trips', 'Typical ride', 'Middle half'], r.routeLengths.slice(0, 15).map(x => [routeName(x), fmtInt(x.s.n), mins(x.s.median), range(x.s)]));

  const away = table(['Agency', 'Country or time zone', 'Trips', 'Days', 'Routes', 'When', 'Typical ride'], r.awayRows.map(x => [
    esc(x.agency), esc(x.country || x.zone), fmtInt(x.n), fmtInt(x.days), fmtInt(x.routes),
    x.from === x.to ? esc(prettyDay(x.from)) : `${esc(prettyDay(x.from))} to ${esc(prettyDay(x.to))}`,
    x.s ? `${mins(x.s.median)} <span class="note">(${x.s.n} timed)</span>` : '<span class="note">too few timed trips</span>',
  ]));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trip insights</title>
<style>
  :root { color-scheme: light dark; --bg: #fafaf8; --fg: #1d1d1f; --muted: #6b6b70; --line: #e3e3e0; --accent: #1f6feb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #ececee; --muted: #9a9aa0; --line: #2c2c30; --accent: #6ea8ff; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 20px; margin: 36px 0 8px; padding-top: 16px; border-top: 1px solid var(--line); }
  .note { color: var(--muted); font-size: 14px; }
  ul { padding-left: 20px; } li { margin: 6px 0; }
  b { color: var(--accent); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin: 8px 0; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  .scroll { overflow-x: auto; }
</style></head><body><main>
<h1>Trip insights</h1>
<p class="note">Generated ${esc(new Date().toLocaleString('en-CA', { timeZone: r.homeZone, dateStyle: 'long', timeStyle: 'short' }))} from ${fmtInt(r.counted)} logged trips. Private: personal trip data, not for sharing as is.</p>
<section><h2>Rules for this report</h2><ul>
  <li>A route, or a route between two stops, is only reported with at least <b>${MIN_ROUTE_TRIPS}</b> timed trips.</li>
  <li>A time-of-day comparison only uses time groups with at least <b>${MIN_BUCKET_TRIPS}</b> trips each.</li>
  <li>Other findings (agencies, trips away from home) need at least <b>${MIN_FINDING_TRIPS}</b> trips. Totals count everything.</li>
  <li>Trip times skip trips marked FORGOT or incomplete, discarded trips, zero-length trips and trips over ${MAX_TRIP_MINUTES / 60} hours.</li>
  <li>"Typical" is the median. "Middle half" is the range the middle 50% of trips fall in. Route variants ride together (510A and 510B count as 510), and platforms count as their station. A trip between two stops counts one direction only.</li>
</ul></section>
${section('Totals', totals)}
<div class="scroll">${section('Most-ridden routes', topRoutes, 'Branches like 510A and 510B are listed separately here.')}</div>
<div class="scroll">${section('Most-used stops and stations', topStops)}</div>
<div class="scroll">${section('Agencies', topAgencies)}</div>
${section('Streaks and busy stretches', streaks)}
<div class="scroll">${section('Firsts with each agency', firsts, `Agencies with at least ${MIN_FINDING_TRIPS} trips, oldest first.`)}</div>
${section('Steadiest regular trips', steady, 'Trips whose time barely changes, compared by how wide the middle half is next to the typical time.')}
${section('Least predictable regular trips', unsteady)}
${section('Biggest time-of-day differences on the same trip', tod)}
<div class="scroll">${section('Fastest and slowest on regular trips', extremes, 'The 15 most-repeated trips between two stops.')}</div>
<div class="scroll">${section('Longest typical rides by route', routeLens, 'Any start and end stop on that route.')}</div>
<div class="scroll">${section('Trips away from home', away, `Trips logged in a time zone other than ${esc(r.homeZone)}, by agency. The app doesn't store a city, so agency and country stand in for it.`)}</div>
</main></body></html>
`;
}

async function main() {
  const { trips, stops } = await loadData();
  const resolver = await makeResolver(stops);
  const result = analyze(trips, resolver);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, render(result));
  console.log(`Read ${trips.length} trips and ${stops.length} stops. ${result.regular.length} regular trips between two stops (${MIN_ROUTE_TRIPS}+ timed trips).`);
  console.log(`Report: ${OUT_PATH}`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
