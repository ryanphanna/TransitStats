/**
 * Route typo check for texted trips (RYN-42).
 *
 * The rider texts the route, so a typo ("51" for "510") would otherwise be saved silently.
 * This looks at the rider's own clean history at the boarding stop with the eval harness's
 * B3 rule (ml/EVAL.md: stop x 3h local bucket x weekday/weekend, ride-count recency decay,
 * 66.5% route top-1 on full history) and suggests a route only when all of these hold:
 *   - the texted route has never been ridden from this stop, and GTFS (when known) doesn't list it there;
 *   - the rider has enough rides from this stop, and one route clearly leads them;
 *   - the texted route is one keystroke away from that route (one digit added, dropped,
 *     changed, or two neighbours swapped), so a genuinely new route is never questioned.
 * B3's agency-wide fallback is never used: a suggestion must come from rides at this stop.
 */

const { getHourAndDay } = require('./ml_utils');

const MIN_STOP_RIDES = 5;        // rides from this stop before any suggestion
const MIN_TOP_ROUTE_RIDES = 3;   // rides on the suggested route from this stop
const MIN_TOP_ROUTE_SHARE = 0.6; // decayed share the suggested route needs at this stop
const DECAY = Math.log(2) / 100; // B3: weight halves every 100 rides back

function baseRoute(route) {
  if (route == null) return '';
  const s = route.toString().trim().toUpperCase();
  const m = s.match(/^\d+/);
  return m ? m[0] : s;
}

/** True when a and b differ by one insertion, deletion, substitution, or adjacent swap. */
function isOneEditApart(a, b) {
  if (!a || !b || a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diffs = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs.push(i);
    if (diffs.length === 1) return true;
    return diffs.length === 2 && diffs[1] === diffs[0] + 1 &&
      a[diffs[0]] === b[diffs[1]] && a[diffs[1]] === b[diffs[0]];
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i++) {
    if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  }
  return false;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function timeKey(date, agency) {
  const { hour, pyDay } = getHourAndDay(date, agency, 'local');
  return `${Math.floor(hour / 3)}|${pyDay >= 5 ? 'we' : 'wd'}`;
}

/**
 * @param {object} args
 * @param {object} args.engine      V3 engine (for _stopMatch / _isValidTrip, the app's stop rules)
 * @param {Array}  args.history     clean completed trips, newest first (getRecentCompletedTrips)
 * @param {string} args.startStopName
 * @param {string} args.agency
 * @param {string} args.route       route as texted
 * @param {Date}   [args.now]
 * @param {Array}  [args.routesAtStop] GTFS routes at the stop, when known
 * @returns {{ route: string, rides: number, share: number } | null}
 */
function suggestRouteCorrection({ engine, history, startStopName, agency, route, now = new Date(), routesAtStop = null }) {
  if (!engine || !Array.isArray(history) || !startStopName || !agency || !route) return null;
  const texted = baseRoute(route);
  if (!/^\d+$/.test(texted)) return null; // named routes ("Lakeshore West") aren't keystroke typos

  if (Array.isArray(routesAtStop) && routesAtStop.some(r => baseRoute(r) === texted)) return null;

  const agencyKey = agency.toString().trim().toLowerCase();
  const sameStop = history.filter(t =>
    t && t.route && (t.agency || '').toString().trim().toLowerCase() === agencyKey &&
    (!engine._isValidTrip || engine._isValidTrip(t)) &&
    engine._stopMatch(t.startStopName || t.startStop, startStopName, t.agency, agency)
  );
  if (sameStop.length < MIN_STOP_RIDES) return null;
  if (sameStop.some(t => baseRoute(t.route) === texted)) return null;

  const nowKey = timeKey(now, agency);
  const narrow = sameStop.filter(t => {
    const d = toDate(t.startTime);
    return d && timeKey(d, agency) === nowKey;
  });
  const pool = narrow.length > 0 ? narrow : sameStop;

  const weights = new Map();
  const counts = new Map();
  const display = new Map();
  pool.forEach((t, i) => {
    const key = baseRoute(t.route);
    weights.set(key, (weights.get(key) || 0) + Math.exp(-DECAY * i));
    if (!display.has(key)) display.set(key, key);
  });
  sameStop.forEach(t => {
    const key = baseRoute(t.route);
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  const [topKey, topWeight] = [...weights.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (!topKey || total <= 0) return null;
  const share = topWeight / total;
  const rides = counts.get(topKey) || 0;
  if (share < MIN_TOP_ROUTE_SHARE || rides < MIN_TOP_ROUTE_RIDES) return null;
  if (!isOneEditApart(texted, topKey)) return null;

  return { route: display.get(topKey), rides, share: Math.round(share * 100) / 100 };
}

module.exports = {
  suggestRouteCorrection,
  isOneEditApart,
  MIN_STOP_RIDES,
  MIN_TOP_ROUTE_RIDES,
  MIN_TOP_ROUTE_SHARE,
};
