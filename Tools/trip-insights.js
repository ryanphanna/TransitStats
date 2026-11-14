/**
 * trip-insights.js
 *
 * Private, read-only report on what changes one rider's trip times. For every regular trip (same route, direction,
 * start and end stop, with enough timed trips) it tests time of day, weekday against weekend, change over time,
 * winter against the rest of the year and direction, then compares regular trips with each other (most and least
 * predictable, subway against streetcar) and lists the worst delays. Each comparison gets a bootstrap 95% interval on
 * the difference in medians and a Mann-Whitney test; only differences of about a minute or more whose interval
 * excludes zero are reported as findings. Writes a self-contained HTML page to _reports/, which is listed in
 * .git/info/exclude. Never commit the output: it holds personal trip data.
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
/** A regular trip (route + direction + start + end) needs at least this many timed trips. */
const MIN_ROUTE_TRIPS = 10;
/** Each side of a comparison needs at least this many trips. */
const MIN_GROUP_TRIPS = 5;
/** A difference smaller than this (minutes) is not reported as a finding, however certain. */
const MIN_DIFF_MINUTES = 1;
/** Trips longer than this are treated as a forgotten end, not a real ride. */
const MAX_TRIP_MINUTES = 180;
/** Bootstrap resamples per comparison. */
const BOOT_REPS = 4000;
/** Most finding cards on the page; the rest go in the collapsed section. */
const MAX_CARDS = 8;
/** Subway and streetcar predictability is compared on trips with a typical time in this range (minutes). */
const COMPARABLE_RANGE = [5, 15];

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
  { key: 'morning', short: 'Morning peak', from: 6, to: 10, peak: true },
  { key: 'midday', short: 'Midday', from: 10, to: 15 },
  { key: 'afternoon', short: 'Afternoon peak', from: 15, to: 19, peak: true },
  { key: 'evening', short: 'Evening and night', from: 19, to: 6 },
];
const WINTER_MONTHS = new Set([12, 1, 2, 3]);
const KIND_NAMES = { tod: 'Time of day', weekend: 'Weekends', trend: 'Change over time', winter: 'Winter', direction: 'Direction', mode: 'Vehicle type' };
const listJoin = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** How the "nothing changes it" card names the comparisons it ran: "at midday and in the afternoon peak, in winter and lately alike". */
function steadyWords(tests) {
  const tod = { morning: 'in the morning peak', midday: 'at midday', afternoon: 'in the afternoon peak', evening: 'in the evening' };
  const times = TIME_OF_DAY.filter(b => tests.some(t => t.kind === 'tod' && t.bucket === b.key)).map(b => tod[b.key]);
  const alike = [['weekend', 'on weekends'], ['winter', 'in winter'], ['trend', 'lately']].filter(([k]) => tests.some(t => t.kind === k)).map(([, w]) => w);
  return [listJoin(times), alike.length ? `${listJoin(alike)} alike` : ''].filter(Boolean).join(', ');
}

// ---- Small helpers ----
const toDate = v => (v == null ? null : v.toDate ? v.toDate() : new Date(v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = n => Number(n).toLocaleString('en-CA');
/** A typical time: one decimal under 10 minutes, whole minutes above. */
const mins = m => `${Math.abs(m) < 10 ? (Math.round(m * 10) / 10).toFixed(1) : Math.round(m)} min`;
/** A difference, always one decimal. */
const dmins = m => `${(Math.round(Math.abs(m) * 10) / 10).toFixed(1)} min`;
const signed = m => `${m >= 0 ? '+' : '−'}${dmins(m)}`;

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
const median = values => percentile([...values].sort((a, b) => a - b), 50);

// ---- Statistics ----
/** Small seeded generator (mulberry32), so the same data gives the same intervals on every run. */
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Bootstrap 95% interval on median(a) - median(b). */
function bootstrapDiff(a, b, seed) {
  const rand = seededRandom(seed);
  const resample = x => { const y = new Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[Math.floor(rand() * x.length)]; return y; };
  const out = new Float64Array(BOOT_REPS);
  for (let i = 0; i < BOOT_REPS; i++) out[i] = median(resample(a)) - median(resample(b));
  out.sort();
  return { lo: out[Math.floor(0.025 * BOOT_REPS)], hi: out[Math.ceil(0.975 * BOOT_REPS) - 1] };
}
/** Two-sided Mann-Whitney U test, normal approximation with tie and continuity correction. */
function mannWhitneyP(a, b) {
  const all = a.map(v => [v, 0]).concat(b.map(v => [v, 1])).sort((x, y) => x[0] - y[0]);
  let rankA = 0; let ties = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (all[k][1] === 0) rankA += rank;
    const t = j - i + 1; ties += t ** 3 - t; i = j + 1;
  }
  const n1 = a.length; const n2 = b.length; const N = n1 + n2;
  const u = rankA - (n1 * (n1 + 1)) / 2;
  const sd = Math.sqrt(((n1 * n2) / 12) * (N + 1 - ties / (N * (N - 1))));
  if (!sd) return 1;
  const z = Math.max(0, Math.abs(u - (n1 * n2) / 2) - 0.5) / sd;
  // erfc(z / sqrt 2), Numerical Recipes approximation
  const x = z / Math.SQRT2; const t = 1 / (1 + 0.5 * x);
  const erfc = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return Math.min(1, erfc);
}

// ---- Sparklines ----
// Copies the look of Atlas's sparkline bars (src/components/charts/HourSpark.tsx and sparkParts.tsx): one narrow
// rounded bar per column (60% of the column, 3 to 12 px wide, 2 px corners, 1 px gap), 90% opacity, at least 2 px tall,
// empty columns left empty rather than drawn as zero, the tallest bar's value written above it in small bold text, a
// dashed reference line in the dim text colour, and small dim labels under the first and last columns, hung from the edges.
const SPARK_COL = { min: 5, max: 20 };
/**
 * values: one per column, oldest first; null leaves the column empty. Options: height (bar area, px), width (target
 * px; columns stay 5 to 20 px), scaleMax (shared top for small multiples), ref (dashed line value), format, labels
 * ([first, last] under the edges), titles (hover text per column), marks (columns drawn darker), ariaLabel.
 */
function sparkline(values, { height = 64, width = 240, scaleMax, ref = null, format = v => String(v), labels = null, titles = [], marks = null, ariaLabel = '' } = {}) {
  const n = values.length;
  if (!n) return '';
  const col = Math.max(SPARK_COL.min, Math.min(SPARK_COL.max, width / n));
  const w = col * n;
  const top = 15; // room for the peak value
  const bottomH = labels ? 16 : 0;
  const shown = values.filter(v => v != null);
  const max = Math.max(scaleMax ?? 0, ...shown, ref ?? 0) || 1;
  const y = v => top + height - (Math.max(0, v) / max) * height;
  const barW = Math.max(3, Math.min(12, (col - 1) * 0.6));
  let peak = -1;
  values.forEach((v, i) => { if (v != null && v > 0 && (peak < 0 || v > values[peak])) peak = i; });
  const bars = values.map((v, i) => {
    if (v == null) return '';
    const h = Math.max(2, (Math.max(0, v) / max) * height);
    const x = i * col + (col - 1 - barW) / 2;
    const tip = titles[i] ? `<title>${esc(titles[i])}</title>` : '';
    const opacity = marks ? (marks[i] ? 0.9 : 0.35) : 0.9;
    return `<rect x="${x.toFixed(1)}" y="${(top + height - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="var(--accent)" opacity="${opacity}">${tip}</rect>`;
  }).join('');
  const refLine = ref != null ? `<line x1="0" x2="${w}" y1="${y(ref).toFixed(1)}" y2="${y(ref).toFixed(1)}" stroke="var(--text-dim)" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>` : '';
  const anchorOf = i => (i < 2 ? ['start', i * col] : i > n - 3 ? ['end', (i + 1) * col - 1] : ['middle', i * col + (col - 1) / 2]);
  const peakText = peak >= 0 ? (([a, x]) => `<text x="${x.toFixed(1)}" y="${(y(values[peak]) - 3).toFixed(1)}" text-anchor="${a}" class="spark-peak">${esc(format(values[peak]))}</text>`)(anchorOf(peak)) : '';
  const under = labels ? `<text x="0" y="${top + height + 14}" text-anchor="start" class="spark-label">${esc(labels[0])}</text>${n > 1 && labels[1] ? `<text x="${w - 1}" y="${top + height + 14}" text-anchor="end" class="spark-label">${esc(labels[1])}</text>` : ''}` : '';
  return `<svg class="spark" width="${w}" height="${top + height + bottomH}" viewBox="0 0 ${w} ${top + height + bottomH}" role="img" aria-label="${esc(ariaLabel)}">${refLine}${bars}${peakText}${under}</svg>`;
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

/** Vehicle type from the route number. Only the TTC's numbering is known; other agencies come back as "other". */
function modeOf(agency, route) {
  if (String(agency).toUpperCase() !== 'TTC') return 'other';
  const n = Number(route);
  if (n >= 1 && n <= 4) return 'subway';
  if (n === 5 || n === 6) return 'light rail';
  if ((n >= 500 && n < 600) || [301, 304, 305, 306, 310, 312].includes(n)) return 'streetcar';
  return Number.isFinite(n) ? 'bus' : 'other';
}

function tripMinutes(trip) {
  const start = toDate(trip.startTime);
  const end = toDate(trip.endTime);
  if (start && end) return (end - start) / 60000;
  return Number(trip.duration) > 0 ? Number(trip.duration) : null;
}

/** Usable for durations: not discarded or ended early (FORGOT), longer than zero, no longer than the cap. */
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
const shortDay = dayKey => new Date(`${dayKey}T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', dateStyle: 'medium' });
const monthName = (k, style = 'short') => new Date(`${k.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', month: style, year: 'numeric' });

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

  timed.forEach(t => {
    const agency = TS.tripAgency(t);
    t._start = resolver.resolve(TS.boardingStop(t), agency);
    t._end = resolver.resolve(TS.exitStop(t), agency);
    t._min = tripMinutes(t);
    t._day = TS.tripLocalDay(t);
    t._hour = TS.tripLocalHour(t);
    t._ms = toDate(t.startTime)?.getTime() ?? NaN;
  });
  const dated = timed.filter(t => t._day && Number.isFinite(t._ms)).sort((a, b) => a._ms - b._ms);

  // Regular trips: same route family, direction, start and end stop.
  const pairs = new Map();
  dated.forEach(t => {
    const fam = routeFamily(t.route);
    if (!fam || !t._start || !t._end || t._start === t._end) return;
    const agency = TS.tripAgency(t) || '';
    const pk = [agency, fam, t._start, t._end].join('\u0000');
    if (!pairs.has(pk)) pairs.set(pk, { key: pk, agency, route: fam, startKey: t._start, endKey: t._end, trips: [] });
    pairs.get(pk).trips.push(t);
  });
  const regular = [...pairs.values()].filter(p => p.trips.length >= MIN_ROUTE_TRIPS).map(p => {
    const s = stats(p.trips.map(t => t._min));
    p.trips.forEach(t => { t._delay = t._min - s.median; });
    return { ...p, from: resolver.label(p.startKey), to: resolver.label(p.endKey), s, spread: s.p75 - s.p25, rel: (s.p75 - s.p25) / s.median, mode: modeOf(p.agency, p.route) };
  }).sort((a, b) => b.trips.length - a.trips.length);

  // ---- Comparisons ----
  const tests = [];
  const compare = (scope, kind, a, b, extra = {}) => {
    const base = { scope, kind, a: { label: a.label, n: a.values.length }, b: { label: b.label, n: b.values.length }, ...extra };
    if (a.values.length < MIN_GROUP_TRIPS || b.values.length < MIN_GROUP_TRIPS) { tests.push({ ...base, skipped: true }); return; }
    base.a.median = median(a.values);
    base.b.median = median(b.values);
    const diff = base.a.median - base.b.median;
    const { lo, hi } = bootstrapDiff(a.values, b.values, tests.length + 1);
    const p = mannWhitneyP(a.values, b.values);
    const real = Math.round(Math.abs(diff) * 10) / 10 >= MIN_DIFF_MINUTES && (lo > 0 || hi < 0);
    tests.push({ ...base, diff, lo, hi, p, real, strength: real ? Math.min(Math.abs(lo), Math.abs(hi)) : 0 });
  };
  const isWeekend = t => t._day.weekday === 'Saturday' || t._day.weekday === 'Sunday';
  const isWinter = t => WINTER_MONTHS.has(Number(t._day.month.slice(5)));
  /** The standard set of tests on one group of trips; value(t) is the trip time or its delay. */
  const testGroup = (scope, trips, value) => {
    const vals = f => trips.filter(f).map(value);
    TIME_OF_DAY.forEach(b => compare(scope, 'tod', { label: b.short, values: vals(t => bucketOf(t._hour) === b.key) }, { label: 'Rest of the day', values: vals(t => bucketOf(t._hour) !== b.key) }, { bucket: b.key }));
    compare(scope, 'weekend', { label: 'Weekend', values: vals(isWeekend) }, { label: 'Weekdays', values: vals(t => !isWeekend(t)) });
    const third = Math.floor(trips.length / 3);
    if (third >= 1) {
      const early = trips.slice(0, third); const late = trips.slice(-third);
      const when = ts => `${shortDay(ts[0]._day.dayKey)} to ${shortDay(ts[ts.length - 1]._day.dayKey)}`;
      compare(scope, 'trend', { label: `Latest third (${when(late)})`, values: late.map(value) }, { label: `Earliest third (${when(early)})`, values: early.map(value) });
    }
    compare(scope, 'winter', { label: 'December to March', values: vals(isWinter) }, { label: 'April to November', values: vals(t => !isWinter(t)) });
  };

  regular.forEach(p => testGroup(p, p.trips, t => t._min));
  // Direction: the same route both ways between the same two stops.
  const byKey = new Map(regular.map(p => [p.key, p]));
  regular.forEach(p => {
    const back = byKey.get([p.agency, p.route, p.endKey, p.startKey].join('\u0000'));
    if (back && p.key < back.key) compare(p, 'direction', { label: `${p.from} to ${p.to}`, values: p.trips.map(t => t._min) }, { label: `${back.from} to ${back.to}`, values: back.trips.map(t => t._min) }, { other: back });
  });
  // Pooled: every regular trip as minutes over or under that trip's own typical time, overall and per route.
  const pooledScopes = [{ name: 'All regular trips', pairs: regular, trips: regular.flatMap(p => p.trips) }];
  const byRoute = new Map();
  regular.forEach(p => { const k = `${p.agency}\u0000${p.route}`; if (!byRoute.has(k)) byRoute.set(k, []); byRoute.get(k).push(p); });
  byRoute.forEach(ps => { if (ps.length >= 2) pooledScopes.push({ name: `All regular trips on ${routeLabel(ps[0])}`, pairs: ps, trips: ps.flatMap(p => p.trips) }); });
  pooledScopes.forEach(sc => { sc.trips.sort((a, b) => a._ms - b._ms); sc.pooled = true; testGroup(sc, sc.trips, t => t._delay); });
  // Subway against streetcar (and bus, if any): how far trips land from their own typical time, on trips of similar length.
  const comparable = regular.filter(p => p.s.median >= COMPARABLE_RANGE[0] && p.s.median <= COMPARABLE_RANGE[1]);
  const modeMiss = new Map();
  comparable.forEach(p => { if (!modeMiss.has(p.mode)) modeMiss.set(p.mode, { pairs: [], values: [] }); modeMiss.get(p.mode).pairs.push(p); modeMiss.get(p.mode).values.push(...p.trips.map(t => Math.abs(t._delay))); });
  const modes = [...modeMiss.keys()].filter(m => m !== 'other').sort();
  const modeScope = { name: `Trips of ${COMPARABLE_RANGE[0]} to ${COMPARABLE_RANGE[1]} min`, pooled: true };
  modes.forEach((m1, i) => modes.slice(i + 1).forEach(m2 => compare(modeScope, 'mode', { label: m1, values: modeMiss.get(m1).values }, { label: m2, values: modeMiss.get(m2).values })));

  const delays = regular.flatMap(p => p.trips.map(t => ({ p, t }))).sort((a, b) => b.t._delay - a.t._delay);
  const months = [];
  if (dated.length) {
    let [y, m] = dated[0]._day.month.split('-').map(Number);
    const [ly, lm] = dated[dated.length - 1]._day.month.split('-').map(Number);
    while (y < ly || (y === ly && m <= lm)) { months.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  }
  return { counted: counted.length, timed: dated.length, homeZone, first: dated[0], last: dated[dated.length - 1], regular, tests, delays, modeMiss, comparable, months };
}

/** "Line 1" for TTC subway and light rail numbers, "the 510" for other routes in sentences. */
function routeLabel(p, { bare = false } = {}) {
  const ttc = String(p.agency).toUpperCase() === 'TTC';
  if (ttc && /^[1-6]$/.test(p.route)) return `Line ${p.route}`;
  const name = ttc ? p.route : `${p.agency} ${p.route}`;
  return bare ? name : `the ${name}`;
}
/** Short stop name: drops "South Side" and the street before "at" ("Spadina Ave at Nassau St South Side" -> "Nassau St"). */
function shortStop(name) {
  const t = String(name).replace(/\s+(north|south|east|west)\s*side$/i, '').trim();
  const m = t.match(/^.+?\s+at\s+(.+)$/i);
  return m ? m[1] : t;
}
const tripName = p => `${routeLabel(p)} from ${shortStop(p.from)} to ${shortStop(p.to)}`;
const tripShort = p => `${routeLabel(p, { bare: true })} ${shortStop(p.from)} → ${shortStop(p.to)}`;
const scopeName = sc => (sc.pooled ? sc.name : tripShort(sc));

// ---- HTML ----
function render(r) {
  const table = (head, rows) => (rows.length
    ? `<div class="scroll"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<p class="note">Nothing meets the threshold yet.</p>');
  const CHART_W = 268;
  const card = ({ heading, answer, chart = '', counts = '' }) => `<article class="card">
    <h3>${heading}</h3>
    <p class="answer">${answer}</p>
    ${chart ? `<div class="chart">${chart}</div>` : ''}
    ${counts ? `<div class="card-note">${counts}</div>` : ''}
  </article>`;
  /** Horizontal bars in the sparkline's style: rows of { label, value, display?, mark? }. */
  const bars = rows => {
    const max = Math.max(...rows.map(x => Math.abs(x.value)), 0) || 1;
    const marked = rows.some(x => x.mark);
    return `<div class="bars${marked ? ' has-mark' : ''}">${rows.map(x => `<div class="bar-row${x.mark ? ' is-mark' : ''}"><span class="bar-label" title="${esc(x.label)}">${esc(x.label)}</span><span class="bar-track"><span class="bar" style="width:${Math.max(1, (Math.abs(x.value) / max) * 100).toFixed(1)}%"></span></span><span class="bar-value">${esc(x.display ?? mins(x.value))}</span></div>`).join('')}</div>`;
  };
  const range = t => `95% range ${signed(t.lo)} to ${signed(t.hi)}`;
  const n = (k, word = 'trip') => `${fmtInt(k)} ${k === 1 ? word : `${word}s`}`;

  /** Typical time per time-of-day group with enough trips, the tested group marked. */
  const todBars = (p, markKey, value = t => t._min, display = mins) => bars(TIME_OF_DAY.map(b => {
    const v = p.trips.filter(t => bucketOf(t._hour) === b.key).map(value);
    return v.length >= MIN_GROUP_TRIPS ? { label: b.short, value: median(v), display: display(median(v)), mark: b.key === markKey, n: v.length } : null;
  }).filter(Boolean));
  const todCounts = p => TIME_OF_DAY.map(b => [b.short, p.trips.filter(t => bucketOf(t._hour) === b.key).length]).filter(([, k]) => k > 0).map(([s, k]) => `${s.toLowerCase()} ${k}`).join(', ');
  /** Typical time per calendar month, winter months marked. */
  const monthSpark = p => {
    const ms = r.months.filter(k => k >= p.trips[0]._day.month && k <= p.trips[p.trips.length - 1]._day.month);
    const vals = ms.map(k => { const v = p.trips.filter(t => t._day.month === k).map(t => t._min); return v.length ? median(v) : null; });
    return sparkline(vals, {
      height: 56, width: CHART_W, ref: p.s.median, format: mins, labels: [monthName(ms[0]), monthName(ms[ms.length - 1])],
      marks: ms.map(k => WINTER_MONTHS.has(Number(k.slice(5)))),
      titles: ms.map((k, i) => `${monthName(k, 'long')}: ${vals[i] == null ? 'no trips' : `${mins(vals[i])}, ${n(p.trips.filter(t => t._day.month === k).length)}`}`),
      ariaLabel: `Typical time per month for ${tripName(p)}; darker bars are December to March; dashed line is the typical time overall`,
    });
  };
  const tripSpark = (p, height = 56) => sparkline(p.trips.map(t => t._min), {
    height, width: CHART_W, ref: p.s.median, format: mins,
    labels: [p.trips[0], p.trips[p.trips.length - 1]].map(t => shortDay(t._day.dayKey)),
    titles: p.trips.map(t => `${localDateTime(t)}: ${mins(t._min)}`),
    ariaLabel: `Each trip on ${tripName(p)}, oldest first; dashed line is the typical time`,
  });

  // ---- Finding cards ----
  // Real differences, one card per trip and kind, strongest first (strength = the interval's end nearest zero, so a
  // Strongest = clearest evidence (lowest Mann-Whitney p), then the bigger difference. Winter and change over time on
  // the same trip share a card, since a short history can't tell the two apart. A pooled group (all trips on a route)
  // only gets a card when none of its own regular trips already shows that kind of difference.
  const pairKind = t => `${t.kind === 'trend' || t.kind === 'winter' ? 'season' : t.kind}`;
  const realPair = new Set(r.tests.filter(t => t.real && !t.scope.pooled).map(t => `${t.scope.key}|${pairKind(t)}`));
  const real = r.tests.filter(t => t.real && !(t.scope.pairs && t.scope.pairs.some(p => realPair.has(`${p.key}|${pairKind(t)}`))));
  const groups = new Map();
  real.forEach(t => {
    const kind = t.kind === 'trend' || t.kind === 'winter' ? 'season' : t.kind;
    const key = `${scopeName(t.scope)}|${kind}`;
    if (!groups.has(key)) groups.set(key, { scope: t.scope, kind, tests: [] });
    groups.get(key).tests.push(t);
  });
  const findingCards = [...groups.values()].map(g => {
    g.tests.sort((a, b) => a.p - b.p || Math.abs(b.diff) - Math.abs(a.diff));
    const t = g.tests[0]; const sc = g.scope;
    const slower = t.diff > 0;
    const longer = slower ? 'longer' : 'shorter';
    const counts = [];
    let heading; let answer; let chart = '';
    if (g.kind === 'tod') {
      const b = TIME_OF_DAY.find(x => x.key === t.bucket);
      const subject = sc.pooled ? sc.name.replace(/^All regular trips/, 'your regular trips').replace(/^your regular trips on /, '') : tripName(sc);
      heading = b.peak ? `Does rush hour slow down ${subject}?` : `Does time of day change ${subject}?`;
      const verdict = b.peak && !slower ? 'No, the opposite.' : 'Yes.';
      if (sc.pooled) {
        answer = `${verdict} ${b.short} trips run ${signed(t.a.median)} against their usual time, ${dmins(t.diff)} ${slower ? 'slower' : 'faster'} than the rest of the day.`;
        counts.push(`${b.short} ${t.a.n}, rest of the day ${t.b.n}`, range(t));
      } else {
        answer = `${verdict} ${b.short} trips take ${mins(t.a.median)}, ${dmins(t.diff)} ${longer} than the rest of the day (${mins(t.b.median)}).`;
        chart = todBars(sc, b.key);
        counts.push(`Trips: ${todCounts(sc)}`, range(t));
      }
    } else if (g.kind === 'weekend') {
      heading = `Are weekends different on ${sc.pooled ? 'your regular trips' : tripName(sc)}?`;
      answer = `Yes. Weekend trips take ${sc.pooled ? signed(t.a.median) : mins(t.a.median)}, ${dmins(t.diff)} ${longer} than on weekdays (${sc.pooled ? signed(t.b.median) : mins(t.b.median)}).`;
      counts.push(`Weekend ${t.a.n}, weekdays ${t.b.n}`, range(t));
    } else if (g.kind === 'season') {
      const w = r.tests.find(x => x.scope === sc && x.kind === 'winter' && !x.skipped);
      const tr = r.tests.find(x => x.scope === sc && x.kind === 'trend' && !x.skipped);
      const subject = sc.pooled ? 'your regular trips' : tripName(sc);
      if (t.kind === 'winter') {
        heading = `Is ${subject} slower in winter?`;
        answer = `${slower ? 'Yes' : 'No, faster'}. December to March trips took ${mins(t.a.median)}, ${dmins(t.diff)} ${longer} than the rest of the year (${mins(t.b.median)}).`;
        counts.push(`December to March ${t.a.n}, April to November ${t.b.n}`, range(t));
        if (tr?.real) counts.push(`Your latest third of trips is also ${dmins(tr.diff)} ${tr.diff > 0 ? 'slower' : 'faster'} than your first, so winter and change over time can't be told apart yet`);
      } else {
        heading = `Is ${subject} getting slower or faster?`;
        answer = `${slower ? 'Slower' : 'Faster'}. Your latest ${t.a.n} trips took ${mins(t.a.median)}, ${dmins(t.diff)} ${longer} than your first ${t.b.n} (${mins(t.b.median)}).`;
        const when = x => x.label.replace(/^.*\((.*)\)$/, '$1');
        counts.push(`First ${t.b.n}: ${when(t.b)}; latest ${t.a.n}: ${when(t.a)}`, range(t));
        if (w?.real) counts.push(`December to March trips also took ${dmins(w.diff)} ${w.diff > 0 ? 'longer' : 'less'}, so winter and change over time can't be told apart yet`);
      }
      if (!sc.pooled) chart = sc.trips.length >= 20 ? monthSpark(sc) : tripSpark(sc);
      if (!sc.pooled) counts.push(sc.trips.length >= 20 ? 'Typical time per month; darker bars are December to March' : 'Each trip, oldest first');
    } else if (g.kind === 'direction') {
      const o = t.other;
      heading = `Is ${routeLabel(sc)} slower one way between ${shortStop(sc.from)} and ${shortStop(sc.to)}?`;
      const [slow, fast] = slower ? [sc, o] : [o, sc];
      answer = `Yes. ${shortStop(slow.from)} to ${shortStop(slow.to)} takes ${mins(slow.s.median)}, ${dmins(t.diff)} longer than the other way (${mins(fast.s.median)}).`;
      chart = bars([sc, o].map(x => ({ label: `${shortStop(x.from)} → ${shortStop(x.to)}`, value: x.s.median, mark: x === slow })));
      counts.push(`Trips: ${t.a.n} and ${t.b.n}`, range(t));
    } else if (g.kind === 'mode') {
      heading = `Subway or streetcar: which is more predictable?`;
      const [worse, better] = slower ? [t.a, t.b] : [t.b, t.a];
      answer = `${better.label[0].toUpperCase()}${better.label.slice(1)}. On ${COMPARABLE_RANGE[0]} to ${COMPARABLE_RANGE[1]} min trips, ${worse.label} trips miss their usual time by ${mins(worse.median)}, ${better.label} by ${mins(better.median)}.`;
      counts.push(`${t.a.label} ${t.a.n}, ${t.b.label} ${t.b.n}`, range(t));
    }
    return { p: t.p, diff: Math.abs(t.diff), html: card({ heading: esc(heading), answer: esc(answer), chart, counts: counts.map(esc).join(' · ') }) };
  }).sort((a, b) => a.p - b.p || b.diff - a.diff);

  // Trips with nothing that moves them: the most-ridden regular trip where every comparison came out level.
  const testsFor = p => r.tests.filter(t => t.scope === p && !t.skipped);
  const steady = r.regular.find(p => testsFor(p).length >= 3 && !testsFor(p).some(t => t.real));
  const steadyCard = steady && card({
    heading: esc(`Does anything change ${tripName(steady)}?`),
    answer: esc(`No. It takes about ${mins(steady.s.median)} ${steadyWords(testsFor(steady))}.`),
    chart: todBars(steady, null),
    counts: esc(`${n(steady.s.n)}: ${todCounts(steady)} · none of ${testsFor(steady).length} comparisons found a difference of ${MIN_DIFF_MINUTES} min or more`),
  });

  // Predictability across regular trips: the middle half of trips as a share of the typical time.
  const byRel = [...r.regular].sort((a, b) => a.rel - b.rel);
  const pctOf = x => `${Math.round(x * 100)}%`;
  const modeTest = r.tests.find(t => t.kind === 'mode' && !t.skipped);
  const predictCard = byRel.length >= 2 && card({
    heading: 'Which regular trips are the most and least predictable?',
    answer: esc(`Most: ${tripShort(byRel[0])}, where half of trips land within ${pctOf(byRel[0].rel)} of ${mins(byRel[0].s.median)}. Least: ${tripShort(byRel[byRel.length - 1])}, ${pctOf(byRel[byRel.length - 1].rel)} of ${mins(byRel[byRel.length - 1].s.median)}.`),
    chart: bars(byRel.map((p, i) => ({ label: tripShort(p), value: p.rel, display: pctOf(p.rel), mark: i === 0 || i === byRel.length - 1 }))),
    counts: esc([
      'Bar: middle half of trip times as a share of the typical time; shorter is more predictable',
      modeTest && !modeTest.real ? `Subway and streetcar are about as predictable: on ${COMPARABLE_RANGE[0]} to ${COMPARABLE_RANGE[1]} min trips the typical miss is ${mins(modeTest.a.median)} on the ${modeTest.a.label} (${modeTest.a.n} trips) and ${mins(modeTest.b.median)} on the ${modeTest.b.label} (${modeTest.b.n})` : '',
    ].filter(Boolean).join(' · ')),
  });

  // Worst delays: trip time against that trip's own typical time.
  const worst = r.delays.slice(0, 5);
  const delayCard = worst.length && card({
    heading: 'What were the worst delays on regular trips?',
    answer: esc(`${tripShort(worst[0].p)} on ${shortDay(worst[0].t._day.dayKey)}: ${mins(worst[0].t._min)}, ${dmins(worst[0].t._delay)} over its usual ${mins(worst[0].p.s.median)}.`),
    chart: bars(worst.map(({ p, t }, i) => ({ label: `${shortDay(t._day.dayKey)}, ${tripShort(p)}`, value: t._delay, display: `+${dmins(t._delay)}`, mark: i === 0 }))),
    counts: 'Minutes over that trip’s typical time',
  });

  // How often anything mattered at all.
  const tested = r.tests.filter(t => !t.skipped);
  const kinds = Object.keys(KIND_NAMES).map(k => ({ k, all: tested.filter(t => t.kind === k), real: tested.filter(t => t.kind === k && t.real) })).filter(x => x.all.length);
  const never = kinds.filter(x => !x.real.length).map(x => KIND_NAMES[x.k].toLowerCase());
  const tallyCard = card({
    heading: 'How often did anything make a real difference?',
    answer: esc(`Rarely: ${tested.filter(t => t.real).length} of ${tested.length} comparisons${never.length ? `; ${listJoin(never)} never did` : ''}.`),
    chart: bars(kinds.map(x => ({ label: KIND_NAMES[x.k], value: x.real.length / x.all.length, display: `${x.real.length} of ${x.all.length}` }))),
    counts: esc(`Real difference: ${MIN_DIFF_MINUTES} min or more, and the 95% range excludes zero. At this many tests, about ${Math.round(tested.length * 0.05)} could pass by chance.`),
  });

  const extras = [steadyCard, predictCard, delayCard, tallyCard].filter(Boolean);
  const findingSlots = Math.max(0, MAX_CARDS - extras.length);
  const topCards = [...findingCards.slice(0, findingSlots).map(c => c.html), ...extras].join('');
  const moreCards = findingCards.slice(findingSlots).map(c => c.html).join('');

  // ---- Full tables (collapsed) ----
  const fmtVal = (t, side) => (t.scope.pooled && t.kind !== 'mode' ? signed(side.median) : mins(side.median));
  const compareRows = r.tests.filter(t => !t.skipped).sort((a, b) => Number(b.real) - Number(a.real) || a.p - b.p).map(t => [
    esc(scopeName(t.scope)), esc(KIND_NAMES[t.kind]),
    `${esc(t.a.label)}<br><span class="note">${fmtVal(t, t.a)}, ${t.a.n}</span>`,
    `${esc(t.b.label)}<br><span class="note">${fmtVal(t, t.b)}, ${t.b.n}</span>`,
    `${signed(t.diff)}<br><span class="note">${signed(t.lo)} to ${signed(t.hi)}</span>`,
    t.p < 0.001 ? '&lt;0.001' : t.p.toFixed(3),
    t.real ? '<strong>Real difference</strong>' : 'No clear difference',
  ]);
  const skipped = r.tests.filter(t => t.skipped).length;
  const details = [
    ['Every comparison tested', `${tested.length} comparisons with at least ${MIN_GROUP_TRIPS} trips on each side; ${skipped} more were skipped for too few trips. "All regular trips" rows compare minutes over or under each trip's own typical time. Subway or streetcar rows compare how far trips land from their usual time. Range: bootstrap 95% interval on the difference in medians. p: Mann-Whitney.`,
      table(['Trips', 'Comparison', 'Group', 'Against', 'Difference', 'p', 'Result'], compareRows)],
    ['Regular trips', `Same route, direction, start and end stop, with ${MIN_ROUTE_TRIPS}+ timed trips. One bar per trip in date order; the dashed line is the typical time.`,
      table(['Trip', 'Type', 'Trips', 'Typical', 'Middle half', 'Each trip, oldest first'], r.regular.map(p => [esc(tripShort(p)), esc(p.mode), fmtInt(p.s.n), mins(p.s.median), `${mins(p.s.p25)} to ${mins(p.s.p75)}<br><span class="note">${pctOf(p.rel)} of typical</span>`, tripSpark(p, 38)]))],
    ['Worst delays', 'The 15 trips furthest over their own typical time.',
      table(['When', 'Trip', 'Took', 'Typical', 'Over'], r.delays.slice(0, 15).map(({ p, t }) => [esc(localDateTime(t)), esc(tripShort(p)), mins(t._min), mins(p.s.median), `+${dmins(t._delay)}`]))],
  ].map(([title, note, body]) => `<h3 class="table-title">${title}</h3>${note ? `<p class="note">${esc(note)}</p>` : ''}${body}`).join('');

  const span = r.first ? `${monthName(r.first._day.dayKey)} to ${monthName(r.last._day.dayKey)}` : '';
  const onRegular = r.regular.reduce((s, p) => s + p.trips.length, 0);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trip insights</title>
<style>
  /* Type, colours and spacing copied from Atlas (src/styles/index.css, src/styles.ts, Interval/cardUi.tsx, pageStyles.ts TILE). */
  :root { color-scheme: light; --bg-app: #f0f0f0; --bg-panel: rgba(255, 255, 255, 0.9); --border-primary: rgba(0, 0, 0, 0.1);
    --text-primary: #111827; --text-secondary: #374151; --text-muted: #5b6270; --text-dim: #5f5f5f; --bg-btn: rgba(0, 0, 0, 0.05); --accent: #3f3f46; }
  * { box-sizing: border-box; }
  html { font-size: 14px; font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  body { margin: 0; background: var(--bg-app); color: var(--text-primary); line-height: 1.5; }
  main { max-width: 1200px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 24px; font-weight: 900; letter-spacing: -0.025em; margin: 0; }
  .summary { font-size: 12px; font-weight: 500; color: var(--text-dim); margin: 4px 0 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); align-items: start; gap: 16px; margin-top: 24px; }
  .grid.more { margin-top: 16px; }
  .card { min-width: 0; border-radius: 16px; padding: 16px; background: var(--bg-panel); border: 1px solid var(--border-primary); }
  .card h3 { font-size: 16px; font-weight: 900; line-height: 1.3; letter-spacing: -0.01em; margin: 0; overflow-wrap: anywhere; }
  .answer { font-size: 14px; font-weight: 500; color: var(--text-secondary); margin: 8px 0 0; }
  .chart { margin-top: 16px; min-width: 0; }
  .card-note { font-size: 12px; font-weight: 500; color: var(--text-dim); margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--border-primary); }
  .spark { display: block; overflow: visible; max-width: 100%; height: auto; }
  .spark-peak { font-size: 12px; font-weight: 700; fill: var(--text-secondary); }
  .spark-label { font-size: 12px; fill: var(--text-dim); }
  .bars { display: grid; gap: 6px; }
  .bar-row { display: grid; grid-template-columns: minmax(0, 46%) minmax(0, 1fr) auto; align-items: center; gap: 8px; font-size: 12px; }
  .bar-label { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { height: 10px; }
  .bar { display: block; height: 100%; min-width: 2px; border-radius: 2px; background: var(--accent); opacity: 0.9; }
  .has-mark .bar { opacity: 0.35; }
  .has-mark .is-mark .bar { opacity: 0.9; }
  .bar-value { font-weight: 700; color: var(--text-secondary); font-variant-numeric: tabular-nums; text-align: right; }
  .is-mark .bar-label { color: var(--text-primary); font-weight: 700; }
  details { margin-top: 40px; border-radius: 16px; padding: 16px; background: var(--bg-panel); border: 1px solid var(--border-primary); }
  summary { cursor: pointer; font-size: 16px; font-weight: 900; }
  .table-title { font-size: 14px; font-weight: 900; margin: 24px 0 2px; }
  .note { color: var(--text-dim); font-size: 12px; margin: 0; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 8px 0; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border-primary); vertical-align: top; }
  th { font-size: 12px; color: var(--text-muted); font-weight: 700; }
  td .spark { margin-top: 2px; max-width: none; }
  .rules-full { font-size: 13px; color: var(--text-secondary); padding-left: 20px; }
</style></head><body><main>
<h1>What changes your trip times</h1>
<p class="summary">${esc(span)} · ${fmtInt(onRegular)} of ${fmtInt(r.timed)} timed trips are on ${r.regular.length} regular trips · private trip data</p>
<div class="grid">${topCards}</div>
<details><summary>More findings, every comparison and rules</summary>
${moreCards ? `<div class="grid more">${moreCards}</div>` : ''}
<h3 class="table-title">Rules for this report</h3><ul class="rules-full">
  <li>A regular trip is the same route (510A and 510B count as 510), direction, start and end stop, with at least ${MIN_ROUTE_TRIPS} timed trips. Stops resolve the app's way, and platforms count as their station.</li>
  <li>Each side of a comparison needs at least ${MIN_GROUP_TRIPS} trips. Time of day: morning peak 6 to 10, midday 10 to 15, afternoon peak 15 to 19, evening and night otherwise; each group is compared with the rest of the day.</li>
  <li>A real difference is ${MIN_DIFF_MINUTES} min or more between medians, with a bootstrap 95% range (${fmtInt(BOOT_REPS)} resamples) that excludes zero.</li>
  <li>Trip times skip trips marked FORGOT or incomplete, discarded trips, zero-length trips and trips over ${MAX_TRIP_MINUTES / 60} hours.</li>
  <li>Vehicle type comes from TTC route numbers (Lines 1 to 4 subway, 500s streetcar, others bus). Subway and streetcar are compared on regular trips of ${COMPARABLE_RANGE[0]} to ${COMPARABLE_RANGE[1]} min.</li>
</ul>
${details}
</details>
</main></body></html>
`;
}

async function main() {
  const { trips, stops } = await loadData();
  const resolver = await makeResolver(stops);
  const result = analyze(trips, resolver);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, render(result));
  const tested = result.tests.filter(t => !t.skipped);
  console.log(`Read ${trips.length} trips and ${stops.length} stops. ${result.regular.length} regular trips (${MIN_ROUTE_TRIPS}+ timed trips).`);
  console.log(`${tested.length} comparisons tested, ${tested.filter(t => t.real).length} real differences, ${result.tests.length - tested.length} skipped for too few trips.`);
  console.log(`Report: ${OUT_PATH}`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
