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
  { key: 'morning', name: 'morning peak', short: 'Morning peak', from: 6, to: 10 },
  { key: 'midday', name: 'midday', short: 'Midday', from: 10, to: 15 },
  { key: 'afternoon', name: 'afternoon peak', short: 'Afternoon peak', from: 15, to: 19 },
  { key: 'evening', name: 'evening and night', short: 'Evening and night', from: 19, to: 6 },
];

// ---- Small helpers ----
const toDate = v => (v == null ? null : v.toDate ? v.toDate() : new Date(v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = n => Number(n).toLocaleString('en-CA');
const mins = m => `${Math.round(m)} min`;
const pct = (a, b) => `${Math.round((a / b) * 100)}%`;
const plural = (n, word) => `${fmtInt(n)} ${n === 1 ? word : word.endsWith('cy') ? `${word.slice(0, -1)}ies` : `${word}s`}`;

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

// ---- Sparklines ----
// Copies the look of Atlas's sparkline bars (src/components/charts/HourSpark.tsx and sparkParts.tsx): one narrow
// rounded bar per column (60% of the column, 3 to 12 px wide, 2 px corners, 1 px gap), 90% opacity, at least 2 px tall,
// empty columns left empty rather than drawn as zero, the tallest bar's value written above it in small bold text, a
// dashed reference line in the dim text colour, and small dim labels under the first and last columns, hung from the edges.
const SPARK_COL = { min: 5, max: 20 };
/**
 * values: one per column, oldest first; null leaves the column empty. Options: height (bar area, px), width (target
 * px; columns stay 5 to 20 px), scaleMax (shared top for small multiples), ref (dashed line value), format, labels
 * ([first, last] under the edges), titles (hover text per column), ariaLabel.
 */
function sparkline(values, { height = 64, width = 240, scaleMax, ref = null, format = v => String(v), labels = null, titles = [], ariaLabel = '' } = {}) {
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
    return `<rect x="${x.toFixed(1)}" y="${(top + height - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="var(--accent)" opacity="0.9">${tip}</rect>`;
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
const shortDay = dayKey => new Date(`${dayKey}T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', dateStyle: 'medium' });
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

  // Trips per month: every month from the first trip to the last, overall and for each route that passes the threshold.
  const monthKeys = Object.keys(byDate.byMonth).sort();
  const months = [];
  if (monthKeys.length) {
    let [y, m] = monthKeys[0].split('-').map(Number);
    const [ly, lm] = monthKeys[monthKeys.length - 1].split('-').map(Number);
    while (y < ly || (y === ly && m <= lm)) { months.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  }
  const routeMonths = routeLengths.map(x => {
    const byMonth = TS.tripsByDate(counted.filter(t => (TS.tripAgency(t) || '') === x.agency && routeFamily(t.route) === x.route)).byMonth;
    return { agency: x.agency, route: x.route, n: Object.values(byMonth).reduce((a, b) => a + b, 0), byMonth };
  }).sort((a, b) => b.n - a.n);

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
    all: allTrips.length, counted: counted.length, timed: timed.length, hours, homeZone, timedMedian: stats(timed.map(t => t._min)).median,
    first: dated[0], last: dated[dated.length - 1], daysRidden: byDate.daysRidden,
    agencies, routes, topRoutes, topStops, countries, best, busiestDay, busiestMonth, weekdays, hourCounts, peakHour,
    agencyFirsts, regular, steadiest, leastSteady, timeOfDay, routeLengths, awayRows,
    months, byMonth: byDate.byMonth, routeMonths,
  };
}

// ---- HTML ----
function render(r) {
  const routeName = p => `${esc(p.agency)} ${esc(p.route)}`;
  const pairName = p => `${routeName(p)}, ${esc(p.from)} to ${esc(p.to)}`;
  const empty = '<p class="note">Nothing meets the threshold yet.</p>';
  const table = (head, rows) => (rows.length
    ? `<div class="scroll"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : empty);
  const range = s => `${mins(s.p25)} to ${mins(s.p75)}`;
  const hourLabel = h => new Date(Date.UTC(2000, 0, 1, h)).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric' }).toLowerCase();
  const monthName = (k, style = 'short') => new Date(`${k.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', month: style, year: 'numeric' });
  const span = (from, to) => (!from ? '' : monthName(from) === monthName(to) ? monthName(from) : `${monthName(from)} to ${monthName(to)}`);
  const spanOf = trips => { const ds = trips.filter(t => t._day).map(t => t._day.dayKey).sort(); return span(ds[0], ds[ds.length - 1]); };
  const firstDay = r.first?._day?.dayKey; const lastDay = r.last?._day?.dayKey;
  const allSpan = span(firstDay, lastDay);
  const foot = (...parts) => parts.filter(Boolean).join(' · ');
  const CHART_W = 268;

  // One finding per card: eyebrow (what it's about), heading (the finding), big numbers, one chart, sample line.
  const stat = (value, label) => ({ value, label });
  const card = ({ eyebrow = '', heading, stats: nums = [], chart = '', note }) => `<article class="card">
    ${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}
    <h3>${heading}</h3>
    ${nums.length ? `<div class="stats">${nums.map(s => `<div class="stat"><div class="stat-value">${s.value}</div><div class="stat-label">${s.label}</div></div>`).join('')}</div>` : ''}
    ${chart ? `<div class="chart">${chart}</div>` : '<div class="chart"></div>'}
    <div class="card-note">${note}</div>
  </article>`;
  const group = (title, cards) => (cards.filter(Boolean).length ? `<section><h2>${title}</h2><div class="grid">${cards.filter(Boolean).join('')}</div></section>` : '');

  /** Simple bar comparison in the sparkline's bar style: one row per item, longest bar = largest value. */
  const bars = (rows, { format = fmtInt, mark = -1 } = {}) => {
    const max = Math.max(...rows.map(x => x.value), 0) || 1;
    return `<div class="bars${mark >= 0 ? ' has-mark' : ''}">${rows.map((x, i) => `<div class="bar-row${i === mark ? ' is-mark' : ''}"><span class="bar-label" title="${esc(x.label)}">${esc(x.label)}</span><span class="bar-track"><span class="bar" style="width:${Math.max(1, (x.value / max) * 100).toFixed(1)}%"></span></span><span class="bar-value">${esc(format(x.value))}</span></div>`).join('')}</div>`;
  };
  const tripSpark = (p, height = 56) => {
    const inOrder = [...p.trips].sort((a, b) => toDate(a.startTime) - toDate(b.startTime));
    return sparkline(inOrder.map(t => t._min), {
      height, width: CHART_W, ref: p.s.median, format: mins,
      labels: [inOrder[0], inOrder[inOrder.length - 1]].map(t => (t._day ? shortDay(t._day.dayKey) : '')),
      titles: inOrder.map(t => `${localDateTime(t)}: ${mins(t._min)}`),
      ariaLabel: `Trip times for ${p.agency} ${p.route}, ${p.from} to ${p.to}, oldest first; dashed line is the typical time`,
    });
  };

  const monthEdges = r.months.length ? [monthName(r.months[0]), monthName(r.months[r.months.length - 1])] : null;
  const monthSpark = (byMonth, opts) => sparkline(r.months.map(k => byMonth[k] || null), {
    format: fmtInt, labels: monthEdges, titles: r.months.map(k => `${monthName(k, 'long')}: ${plural(byMonth[k] || 0, 'trip')}`), ...opts,
  });

  // ---- Overall ----
  const weekOrder = [...TS.DAY_NAMES.slice(1), TS.DAY_NAMES[0]];
  const weekdayCounts = Object.fromEntries(r.weekdays);
  const busiestDayName = r.weekdays[0][0];
  const countries = Object.entries(r.countries).sort((a, b) => b[1] - a[1]);
  const overall = [
    card({
      heading: `${fmtInt(r.counted)} trips on ${plural(r.daysRidden, 'day')}`,
      stats: [stat(fmtInt(r.counted), 'trips'), stat(fmtInt(r.daysRidden), 'days with a trip')],
      chart: monthSpark(r.byMonth, { height: 56, width: CHART_W, ariaLabel: 'Trips per month' }),
      note: foot('Trips per month', allSpan),
    }),
    card({
      heading: `${fmtInt(Math.round(r.hours))} hours on transit`,
      stats: [stat(fmtInt(Math.round(r.hours)), 'hours'), stat(mins(r.timedMedian), 'typical trip')],
      note: foot(`${fmtInt(r.timed)} trips with a usable time`, allSpan),
    }),
    card({
      heading: `${r.routes.length} routes, ${r.agencies.length} agencies, ${countries.length} ${countries.length === 1 ? 'country' : 'countries'}`,
      stats: [stat(fmtInt(r.routes.length), 'routes'), stat(fmtInt(r.agencies.length), 'agencies'), stat(fmtInt(countries.length), countries.length === 1 ? 'country' : 'countries')],
      chart: countries.length > 1 ? bars(countries.slice(0, 5).map(([c, n]) => ({ label: c, value: n }))) : '',
      note: foot(`${fmtInt(r.counted)} trips`, countries.length > 1 ? 'trips by country' : '', allSpan),
    }),
    card({
      heading: `Most trips start in the ${hourLabel(r.peakHour)} hour`,
      stats: [stat(fmtInt(r.hourCounts[r.peakHour]), `trips start ${hourLabel(r.peakHour)} to ${hourLabel((r.peakHour + 1) % 24)}`)],
      chart: sparkline(r.hourCounts.map(n => n || null), { height: 56, width: CHART_W, format: fmtInt, labels: ['12 am', '11 pm'], titles: r.hourCounts.map((n, h) => `${hourLabel(h)}: ${plural(n, 'trip')}`), ariaLabel: 'Trips by starting hour' }),
      note: foot(`${fmtInt(r.hourCounts.reduce((a, b) => a + b, 0))} trips by starting hour`, allSpan),
    }),
    card({
      heading: `${busiestDayName} is the busiest day of the week`,
      stats: [stat(fmtInt(r.weekdays[0][1]), `trips on ${busiestDayName}s`), stat(fmtInt(r.weekdays[6][1]), `on ${r.weekdays[6][0]}s`)],
      chart: bars(weekOrder.map(d => ({ label: d, value: weekdayCounts[d] || 0 })), { mark: weekOrder.indexOf(busiestDayName) }),
      note: foot(`${fmtInt(r.counted)} trips`, allSpan),
    }),
    r.best.len > 1 && card({
      heading: `Longest streak: ${plural(r.best.len, 'day')} in a row with a trip`,
      stats: [stat(fmtInt(r.best.len), 'days in a row'), stat(fmtInt(r.best.trips), 'trips')],
      note: `${esc(prettyDay(r.best.from))} to ${esc(prettyDay(r.best.to))}`,
    }),
    r.busiestDay && card({
      heading: `Most trips in one day: ${fmtInt(r.busiestDay[1])}`,
      stats: [stat(fmtInt(r.busiestDay[1]), 'trips')],
      note: esc(prettyDay(r.busiestDay[0])),
    }),
    r.busiestMonth && card({
      heading: `Busiest month: ${monthName(r.busiestMonth[0], 'long')}`,
      stats: [stat(fmtInt(r.busiestMonth[1]), 'trips'), stat(fmtInt(Math.round(r.counted / Math.max(1, r.months.length))), 'average month')],
      note: foot(`${plural(r.months.length, 'month')} with data`, allSpan),
    }),
  ];

  // ---- Where ----
  const where = [
    r.topRoutes.length && card({
      heading: `Most-ridden route: ${esc(r.topRoutes[0][0])}`,
      stats: [stat(fmtInt(r.topRoutes[0][1]), 'trips'), stat(pct(r.topRoutes[0][1], r.counted), 'of all trips')],
      chart: bars(r.topRoutes.slice(0, 5).map(([label, value]) => ({ label, value })), { mark: 0 }),
      note: foot(`${fmtInt(r.counted)} trips`, allSpan),
    }),
    r.topStops.length && card({
      heading: `Most-used stop: ${esc(r.topStops[0][0])}`,
      stats: [stat(fmtInt(r.topStops[0][1]), 'times boarded or left')],
      chart: bars(r.topStops.slice(0, 5).map(([label, value]) => ({ label, value })), { mark: 0 }),
      note: foot(`${fmtInt(r.counted)} trips`, allSpan),
    }),
    r.agencies.length > 1 && card({
      heading: `${esc(r.agencies[0][0])} carries ${pct(r.agencies[0][1], r.counted)} of trips`,
      stats: [stat(fmtInt(r.agencies[0][1]), 'trips'), stat(pct(r.agencies[0][1], r.counted), 'share')],
      chart: bars(r.agencies.slice(0, 5).map(([label, value]) => ({ label, value })), { mark: 0 }),
      note: foot(`${fmtInt(r.counted)} trips`, allSpan),
    }),
    r.routeLengths.length && card({
      heading: `Longest typical ride: ${mins(r.routeLengths[0].s.median)} on ${routeName(r.routeLengths[0])}`,
      stats: [stat(mins(r.routeLengths[0].s.median), 'typical ride')],
      chart: bars(r.routeLengths.slice(0, 5).map(x => ({ label: `${x.agency} ${x.route}`, value: x.s.median })), { format: mins, mark: 0 }),
      note: foot(`Routes with ${MIN_ROUTE_TRIPS}+ timed trips`, `${fmtInt(r.routeLengths[0].s.n)} trips on the top route`, spanOf(r.routeLengths[0].trips)),
    }),
  ];

  // ---- Regular trips ----
  const regularCard = (p, kind) => card({
    eyebrow: pairName(p),
    heading: kind === 'most'
      ? `Most-repeated trip: ${plural(p.s.n, 'timed trip')}`
      : kind === 'steady'
        ? `Steady: usually ${mins(p.s.median)}, half of trips within a ${Math.round(p.spread)}-minute window`
        : `Varies most: usually ${mins(p.s.median)}, half of trips take ${range(p.s)}`,
    stats: kind === 'most'
      ? [stat(fmtInt(p.s.n), 'trips'), stat(mins(p.s.median), 'typical')]
      : [stat(mins(p.s.median), 'typical'), stat(mins(p.s.min), 'fastest'), stat(mins(p.s.max), 'slowest')],
    chart: tripSpark(p),
    note: foot(`${plural(p.s.n, 'trip')}, oldest first; dashed line is typical`, spanOf(p.trips)),
  });
  const shown = new Set();
  const pick = (list, n) => list.filter(p => !shown.has(p)).slice(0, n).map(p => (shown.add(p), p));
  const regular = [
    ...pick(r.regular, 1).map(p => regularCard(p, 'most')),
    ...pick(r.steadiest, 2).map(p => regularCard(p, 'steady')),
    ...pick(r.leastSteady, 1).map(p => regularCard(p, 'unsteady')),
  ];

  // ---- Time of day ----
  const timeOfDay = r.timeOfDay.slice(0, 6).map(p => card({
    eyebrow: pairName(p),
    heading: `${Math.round(p.diff)} min slower ${p.slow.key === 'midday' ? 'at' : 'in the'} ${esc(p.slow.name)} than ${p.fast.key === 'midday' ? 'at' : 'in the'} ${esc(p.fast.name)}`,
    stats: [stat(mins(p.slow.median), esc(p.slow.name)), stat(mins(p.fast.median), esc(p.fast.name))],
    chart: bars(TIME_OF_DAY.map(b => p.buckets.find(x => x.key === b.key)).filter(Boolean).map(b => ({ label: `${b.short} (${b.n})`, value: b.median })), { format: mins }),
    note: foot(`Typical time by time of day, ${MIN_BUCKET_TRIPS}+ trips each`, `${plural(p.s.n, 'trip')}`, spanOf(p.trips)),
  }));

  // ---- Travel ----
  const awayTotal = r.awayRows.reduce((s, x) => s + x.n, 0);
  const travel = [
    r.awayRows.length > 1 && card({
      heading: `${fmtInt(awayTotal)} trips with ${plural(r.awayRows.length, 'agency')} away from home`,
      stats: [stat(fmtInt(awayTotal), 'trips'), stat(fmtInt(r.awayRows.length), 'agencies')],
      chart: bars(r.awayRows.slice(0, 5).map(x => ({ label: x.agency, value: x.n }))),
      note: foot(`Agencies with ${MIN_FINDING_TRIPS}+ trips outside ${esc(r.homeZone)}`, span(r.awayRows.map(x => x.from).sort()[0], r.awayRows.map(x => x.to).sort().pop())),
    }),
    ...r.awayRows.slice(0, 4).map(x => card({
      eyebrow: esc(x.country || x.zone),
      heading: `${plural(x.n, 'trip')} with ${esc(x.agency)} over ${plural(x.days, 'day')}`,
      stats: [stat(fmtInt(x.n), 'trips'), stat(fmtInt(x.routes), x.routes === 1 ? 'route' : 'routes'), ...(x.s ? [stat(mins(x.s.median), 'typical ride')] : [])],
      note: foot(x.s ? `${fmtInt(x.timed)} timed trips` : '', x.from === x.to ? esc(prettyDay(x.from)) : `${esc(prettyDay(x.from))} to ${esc(prettyDay(x.to))}`),
    })),
    r.agencyFirsts.length > 1 && card({
      heading: `Rode ${plural(r.agencyFirsts.length, 'agency')} at least ${MIN_FINDING_TRIPS} times`,
      stats: [stat(fmtInt(r.agencyFirsts.length), 'agencies')],
      chart: bars(r.agencyFirsts.slice(-5).reverse().map(x => ({ label: x.first._day ? `${x.agency}, since ${monthName(x.first._day.dayKey)}` : x.agency, value: x.n }))),
      note: foot('Five newest, with trips since the first one', allSpan),
    }),
  ];

  // ---- Full tables (collapsed) ----
  const routeScale = Math.max(0, ...r.routeMonths.flatMap(x => Object.values(x.byMonth)));
  const details = [
    ['Most-ridden routes', 'Branches like 510A and 510B are listed separately here.', table(['Route', 'Trips'], r.topRoutes.map(([n, c]) => [esc(n), fmtInt(c)]))],
    ['Most-used stops and stations', '', table(['Stop or station', 'Times boarded or left'], r.topStops.map(([n, c]) => [esc(n), fmtInt(c)]))],
    ['Agencies', '', table(['Agency', 'Trips', 'Share'], r.agencies.slice(0, 12).map(([a, n]) => [esc(a), fmtInt(n), pct(n, r.counted)]))],
    ['Trips per month by route', `Each route with at least ${MIN_ROUTE_TRIPS} timed trips, on one shared scale.`, table(['Route', 'Trips', 'Trips per month'], r.routeMonths.map(x => [routeName(x), fmtInt(x.n), monthSpark(x.byMonth, { height: 38, width: 240, scaleMax: routeScale, ariaLabel: `Trips per month on ${x.agency} ${x.route}` })]))],
    ['Firsts with each agency', `Agencies with at least ${MIN_FINDING_TRIPS} trips, oldest first.`, table(['Agency', 'First trip', 'Route', 'Trips since'], r.agencyFirsts.map(x => [esc(x.agency), esc(localDateTime(x.first)), esc(x.first.route || ''), fmtInt(x.n)]))],
    ['Fastest and slowest on regular trips', 'The 15 most-repeated trips between two stops.', table(['Trip', 'Trips', 'Typical', 'Fastest', 'Slowest'], r.regular.slice(0, 15).map(p => [
      pairName(p), fmtInt(p.s.n), mins(p.s.median),
      `${mins(p.fastest._min)}<br><span class="note">${esc(localDateTime(p.fastest))}</span>`,
      `${mins(p.slowest._min)}<br><span class="note">${esc(localDateTime(p.slowest))}</span>`,
    ]))],
    ['Trip times over time', `Every regular trip between two stops, one bar per trip in date order. The dashed line is the typical time.`, table(['Trip', 'Typical', 'Each trip, oldest first'], r.regular.map(p => [pairName(p), `${mins(p.s.median)}<br><span class="note">${p.s.n} trips</span>`, tripSpark(p, 38)]))],
    ['Time-of-day differences', 'Every regular trip with two or more time groups.', table(['Trip', 'Slower', 'Faster', 'Difference'], r.timeOfDay.map(p => [pairName(p), `${mins(p.slow.median)} ${esc(p.slow.name)} (${p.slow.n})`, `${mins(p.fast.median)} ${esc(p.fast.name)} (${p.fast.n})`, mins(p.diff)]))],
    ['Typical rides by route', 'Any start and end stop on that route.', table(['Route', 'Timed trips', 'Typical ride', 'Middle half'], r.routeLengths.slice(0, 15).map(x => [routeName(x), fmtInt(x.s.n), mins(x.s.median), range(x.s)]))],
    ['Trips away from home', `Trips logged in a time zone other than ${esc(r.homeZone)}, by agency. The app doesn't store a city, so agency and country stand in for it.`, table(['Agency', 'Country or time zone', 'Trips', 'Days', 'Routes', 'When', 'Typical ride'], r.awayRows.map(x => [
      esc(x.agency), esc(x.country || x.zone), fmtInt(x.n), fmtInt(x.days), fmtInt(x.routes),
      x.from === x.to ? esc(prettyDay(x.from)) : `${esc(prettyDay(x.from))} to ${esc(prettyDay(x.to))}`,
      x.s ? `${mins(x.s.median)} <span class="note">(${x.s.n} timed)</span>` : '<span class="note">too few timed trips</span>',
    ]))],
  ].map(([title, note, body]) => `<h3 class="table-title">${title}</h3>${note ? `<p class="note">${note}</p>` : ''}${body}`).join('');

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
  .rules { margin: 12px 0 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
  .rules li { font-size: 12px; font-weight: 700; color: var(--text-secondary); background: var(--bg-btn); border: 1px solid var(--border-primary); border-radius: 9999px; padding: 3px 10px; }
  h2 { font-size: 20px; font-weight: 900; letter-spacing: -0.025em; margin: 36px 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); grid-auto-rows: 1fr; gap: 16px; }
  .card { min-width: 0; min-height: 320px; display: flex; flex-direction: column; border-radius: 16px; padding: 16px; background: var(--bg-panel); border: 1px solid var(--border-primary); }
  .eyebrow { font-size: 12px; font-weight: 700; color: var(--text-muted); line-height: 1.25; margin-bottom: 2px; overflow-wrap: anywhere; }
  .card h3 { font-size: 16px; font-weight: 900; line-height: 1.3; letter-spacing: -0.01em; margin: 0; overflow-wrap: anywhere; }
  .stats { display: flex; flex-wrap: wrap; gap: 4px 24px; margin-top: 12px; }
  .stat { min-width: 0; }
  @media (max-width: 420px) { .stats { gap: 4px 16px; } .stat-value { font-size: 26px; } }
  .stat-value { font-size: 30px; font-weight: 900; letter-spacing: -0.025em; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .stat-label { font-size: 12px; font-weight: 700; color: var(--text-muted); margin-top: 2px; }
  .chart { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; margin-top: 16px; min-width: 0; }
  .card-note { font-size: 12px; font-weight: 700; color: var(--text-dim); margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--border-primary); }
  .spark { display: block; overflow: visible; max-width: 100%; height: auto; }
  .spark-peak { font-size: 12px; font-weight: 700; fill: var(--text-secondary); }
  .spark-label { font-size: 12px; fill: var(--text-dim); }
  .bars { display: grid; gap: 6px; }
  .bar-row { display: grid; grid-template-columns: minmax(0, 42%) minmax(0, 1fr) auto; align-items: center; gap: 8px; font-size: 12px; }
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
<h1>Trip insights</h1>
<p class="summary">${fmtInt(r.counted)} logged trips, ${esc(allSpan)} · generated ${esc(new Date().toLocaleString('en-CA', { timeZone: r.homeZone, dateStyle: 'long', timeStyle: 'short' }))} · private trip data</p>
<ul class="rules">
  <li>Routes and stop-to-stop trips: ${MIN_ROUTE_TRIPS}+ timed trips</li>
  <li>Time-of-day groups: ${MIN_BUCKET_TRIPS}+ trips each</li>
  <li>Agencies and places: ${MIN_FINDING_TRIPS}+ trips</li>
  <li>Trip times skip trips over ${MAX_TRIP_MINUTES / 60} hours</li>
  <li>Typical = median</li>
</ul>
${group('Overall', overall)}
${group('Routes, stops and agencies', where)}
${group('Regular trips', regular)}
${group('Time of day', timeOfDay)}
${group('Travel', travel)}
<details><summary>Full tables and rules</summary>
<h3 class="table-title">Rules for this report</h3><ul class="rules-full">
  <li>A route, or a route between two stops, is only reported with at least ${MIN_ROUTE_TRIPS} timed trips.</li>
  <li>A time-of-day comparison only uses time groups with at least ${MIN_BUCKET_TRIPS} trips each.</li>
  <li>Other findings (agencies, trips away from home) need at least ${MIN_FINDING_TRIPS} trips. Totals count everything.</li>
  <li>Trip times skip trips marked FORGOT or incomplete, discarded trips, zero-length trips and trips over ${MAX_TRIP_MINUTES / 60} hours.</li>
  <li>"Typical" is the median. "Middle half" is the range the middle 50% of trips fall in. Route variants ride together (510A and 510B count as 510), and platforms count as their station. A trip between two stops counts one direction only.</li>
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
  console.log(`Read ${trips.length} trips and ${stops.length} stops. ${result.regular.length} regular trips between two stops (${MIN_ROUTE_TRIPS}+ timed trips).`);
  console.log(`Report: ${OUT_PATH}`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
