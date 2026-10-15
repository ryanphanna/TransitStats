#!/usr/bin/env python3
"""
TransitStats — shared offline evaluation harness (eval definition v1).

Scores every route and end-stop predictor on the SAME rows with a walk-forward
(rolling-origin) holdout. History-based predictors (V3, habit, baselines) see,
for each test trip, exactly the history serving would have loaded at its start
time (see ml/eval/replay_js.js). V4/V5 are retrained per fold on trips that
ended before the fold starts, with every count threshold computed on the
training rows only.

Inputs (private, keep under ml/artifacts/):
  --trips    trips JSONL export (one Firestore trip document per line, `_id` = doc id)
  --stops    stops library JSON [{name, aliases, agency}]
  --replay   replay JSONL from replay_js.js (TZ=UTC is serve-faithful)
  --replay-local  optional replay under TZ=America/Toronto (local-time V3 variant)

Output: aggregate metrics only (JSON to --out, table to stdout). No stop names,
trip ids or per-stop counts are printed.

Usage:
  python3 ml/eval/harness.py --trips ml/artifacts/trips_full.jsonl --stops ml/artifacts/stops.json \
      --replay ml/artifacts/replay_UTC.jsonl --replay-local ml/artifacts/replay_America_Toronto.jsonl \
      --out ml/artifacts/eval_results.json
"""

import argparse
import json
import math
import os
import random
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from route_normalization import load_policies, normalize_route_for_ml, scoped_route_key  # noqa: E402

# ---------------------------------------------------------------------------
# Eval definition v1 (versioned: change => bump EVAL_VERSION)
# ---------------------------------------------------------------------------
EVAL_VERSION = "1"
EVAL_START = datetime(2026, 5, 1, tzinfo=timezone.utc)
EVAL_END = datetime(2026, 10, 15, tzinfo=timezone.utc)   # pinned: folds never move with new exports
EVAL_SNAPSHOT = "78a4265b1519"                               # sha256[:12] of the trips export v1 was scored on
FOLD_DAYS = 14
EVAL_SOURCES = {"sms", "sms_fallback", "mms"}
LOCAL_TZ = ZoneInfo("America/Toronto")
HISTORY_LIMIT = 100           # getRecentCompletedTrips(userId, 100)
ROUTE_MIN_CLEAN = 10          # intelligence-eligibility DEFAULT_THRESHOLDS
ENDSTOP_MIN_CLEAN = 15
ROUTE_CONF_FLOOR = 25         # floor of the former correctPredictionByGtfs (route models removed from serving)
HABIT_THRESHOLD = 0.75
HIGH_IMPACT = {"route", "direction", "agency", "startStop", "startStopCode", "startStopName",
               "endStop", "endStopCode", "endStopName"}


def ts(v):
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def stop_matched(t):
    v = t.get("stop_matched")
    return bool(v) if v is not None else bool(t.get("verified"))


def serves_as_history(t):
    """Mirrors db/trips.js getRecentCompletedTrips() filter."""
    if t.get("incomplete") or t.get("discarded") or t.get("needs_review"):
        return False
    if t.get("exclude_from_training") or t.get("exclude_from_accuracy") or t.get("needs_reprocess"):
        return False
    if any(f in HIGH_IMPACT for f in (t.get("correctedFields") or [])):
        return False
    return stop_matched(t)


def end_stop_of(t):
    return (t.get("endStopName") or t.get("endStop") or t.get("endStopCode") or "").strip()


def start_stop_of(t):
    return (t.get("startStopName") or t.get("startStop") or t.get("startStopCode") or "").strip()


def is_clean(t):
    return bool(t.get("endTime") and end_stop_of(t) and t.get("route") and start_stop_of(t)
                and serves_as_history(t))


# ---------------------------------------------------------------------------
# Stop canonicalization. Grading uses V3's _canonicalizeStop (as finalization.js
# grades with PredictionEngine._stopMatch); ML features use ml_utils.canonicalizeStop.
# ---------------------------------------------------------------------------
class Canon:
    def __init__(self, stops):
        self.v3_index = {}
        self.ml_index = {}
        for s in stops:
            name = s.get("name")
            if not name:
                continue
            for c in [name] + list(s.get("aliases") or []):
                if not c:
                    continue
                self.v3_index.setdefault(self._v3norm(c), self._v3norm(name))
                self.ml_index.setdefault(self._mlnorm(c), self._mlnorm(name))
        self._cache = {}

    @staticmethod
    def _v3norm(s):
        s = str(s).strip().lower()
        s = re.sub(r"\s*[/&@]\s*", "/", s)
        return re.sub(r"\s+at\s+", "/", s)

    @staticmethod
    def _mlnorm(s):
        s = str(s).strip().lower()
        s = re.sub(r"\s+and\s+", "/", s)
        s = re.sub(r"\s*[/&@]\s*", "/", s)
        return re.sub(r"\s+at\s+", "/", s)

    def v3(self, name):
        if not name:
            return None
        key = ("v3", name)
        if key not in self._cache:
            n = self._v3norm(name)
            self._cache[key] = self.v3_index.get(n, n)
        return self._cache[key]

    def ml(self, name):
        if not name:
            return "unknown"
        key = ("ml", name)
        if key not in self._cache:
            n = self._mlnorm(name)
            self._cache[key] = self.ml_index.get(n, n)
        return self._cache[key]


def sanitize(s):
    return re.sub(r"[^a-z0-9]", "_", str(s).lower().strip())


def norm_dir(d):
    if not d:
        return None
    s = re.sub(r"bound$", "", str(d).strip().lower()).strip()
    m = {"n": "northbound", "nb": "northbound", "north": "northbound",
         "s": "southbound", "sb": "southbound", "south": "southbound",
         "e": "eastbound", "eb": "eastbound", "east": "eastbound", "eastward": "eastbound",
         "w": "westbound", "wb": "westbound", "west": "westbound"}
    return m.get(s, s or None)


def grade_route(pred, actual, agency):
    """utils.normalizeRouteForGrading."""
    def n(r):
        r = str(r).strip()
        if agency == "TTC":
            m = re.match(r"^(\d+)", r)
            return m.group(1) if m else r
        m = re.match(r"^(\d+)([a-zA-Z]+)$", r)
        if m:
            return m.group(1) + m.group(2).upper()
        return r.upper() if re.match(r"^[a-zA-Z]$", r) else r
    return n(pred) == n(actual)


def route_base_for_grading(r):
    return re.sub(r"[a-zA-Z]+$", "", str(r)).strip()


def local_time(dt, trip, mode):
    """mode 'utc' mirrors serving (Cloud Functions run in UTC); 'local' is the fix."""
    if mode == "utc":
        return dt.astimezone(timezone.utc)
    tz = trip.get("timezone")
    try:
        zone = ZoneInfo(tz) if tz and tz != "UTC" else LOCAL_TZ
    except Exception:
        zone = LOCAL_TZ
    return dt.astimezone(zone)


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------
class Data:
    def __init__(self, trips_path, stops_path):
        self.trips = [json.loads(line) for line in open(trips_path) if line.strip()]
        self.by_id = {t["_id"]: t for t in self.trips}
        self.canon = Canon(json.load(open(stops_path)))
        for t in self.trips:
            t["_start"] = ts(t.get("startTime"))
            t["_end"] = ts(t.get("endTime"))
        self.completed = sorted([t for t in self.trips if t["_end"]], key=lambda t: t["_end"], reverse=True)
        agencies = Counter(t.get("agency") for t in self.trips if is_clean(t))
        self.primary_agency = agencies.most_common(1)[0][0] if agencies else None

    def serve_history(self, trip, limit=HISTORY_LIMIT):
        start = trip["_start"]
        before = [t for t in self.completed if t["_end"] < start and t["_id"] != trip["_id"]]
        return [t for t in before[:limit] if serves_as_history(t)]

    def clean_before(self, cutoff):
        return [t for t in self.trips if is_clean(t) and t["_end"] < cutoff and t["_start"]]


# ---------------------------------------------------------------------------
# ML features (mirror ml_utils.js + predict_v4/v5 feature construction)
# ---------------------------------------------------------------------------
_CTX_CACHE = {}


def serve_context(data, trip):
    """Sequence context exactly as handlers-trip.js derives it from history[0]."""
    if trip["_id"] in _CTX_CACHE:
        return _CTX_CACHE[trip["_id"]]
    hist = data.serve_history(trip)
    last = hist[0] if hist else None
    gap = None
    if last and last["_start"]:
        gap = max(0, round((trip["_start"] - last["_start"]).total_seconds() / 60))
    ctx = {
        "last_end_stop": (last.get("endStopName") or last.get("endStop")) if last else None,
        "last_route": last.get("route") if last else None,
        "last_agency": last.get("agency") if last else None,
        "gap": gap,
        "hist": hist,
    }
    _CTX_CACHE[trip["_id"]] = ctx
    return ctx


def trained_context(prev):
    """Sequence context as the training scripts build it (previous clean exported trip by start)."""
    return prev


def gap_features(gap):
    if gap is None or gap < 0:
        return 0.0, 1.0
    capped = min(max(gap, 0), 720)
    return math.log1p(capped) / math.log1p(720), 0.0


def feature_dict(data, trip, ctx, kind, time_mode, primary_scope):
    """Build named sparse features. primary_scope=True mirrors serving (primaryAgency passed)."""
    agency = trip.get("agency")
    primary = data.primary_agency if primary_scope else None
    t = local_time(trip["_start"], trip, time_mode)
    hour, day = t.hour, t.weekday()
    f = {
        "hour_sin": math.sin(2 * math.pi * hour / 24), "hour_cos": math.cos(2 * math.pi * hour / 24),
        "day_sin": math.sin(2 * math.pi * day / 7), "day_cos": math.cos(2 * math.pi * day / 7),
        f"agency_{sanitize(agency or 'unknown')}": 1.0,
        f"stop_{sanitize(data.canon.ml(start_stop_of(trip)))}": 1.0,
    }
    last_stop = sanitize(data.canon.ml(ctx["last_end_stop"])) if ctx["last_end_stop"] else "none"
    f[f"last_stop_{last_stop}"] = 1.0
    # Serving scopes the previous route with the CURRENT trip's agency (predict_v4/5.js).
    prev = scoped_route_key(ctx["last_route"], agency, primary) if ctx["last_route"] else None
    f[f"prev_route_{(prev or 'none').lower()}"] = 1.0
    if kind == "end":
        g, miss = gap_features(ctx["gap"])
        f["gap_log"], f["gap_missing"] = g, miss
        rk = scoped_route_key(trip.get("route"), agency, primary)
        f[f"route_{str(rk).lower()}"] = 1.0
        d = norm_dir(trip.get("direction"))
        if d:
            f[f"dir_{d}"] = 1.0
    return f


def route_label(data, trip):
    return scoped_route_key(trip.get("route"), trip.get("agency"), data.primary_agency)


def end_label(data, trip, primary_scope):
    from route_normalization import agency_id
    return f"{agency_id(trip.get('agency'))}::{data.canon.ml(end_stop_of(trip))}"


def build_training_rows(data, cutoff, kind, time_mode, skew_fixed):
    """Training rows for a fold: clean trips that ended before the cutoff.

    skew_fixed=False reproduces the shipped training scripts (sequence context from the
    previous clean exported trip by start time; end-stop route key scoped WITHOUT primary
    agency). skew_fixed=True builds features exactly as serving does.
    """
    train = sorted(data.clean_before(cutoff), key=lambda t: t["_start"])
    rows = []
    prev = None
    for t in train:
        if skew_fixed:
            ctx = serve_context(data, t)
            primary_scope = True
        else:
            ctx = {
                "last_end_stop": end_stop_of(prev) if prev else None,
                "last_route": prev.get("route") if prev else None,
                "gap": max(0.0, (t["_start"] - prev["_start"]).total_seconds() / 60) if prev else None,
            }
            primary_scope = kind == "route"  # the removed train_routes passed primary; train_endstop does not
        x = feature_dict(data, t, ctx, kind, time_mode, primary_scope)
        if not skew_fixed and kind == "end" and ctx["last_route"]:
            # train_endstop scopes prev_route with the previous trip's agency and no primary.
            x = {k: v for k, v in x.items() if not k.startswith("prev_route_")}
            pk = scoped_route_key(ctx["last_route"], prev.get("agency") or t.get("agency"))
            x[f"prev_route_{(pk or 'none').lower()}"] = 1.0
        if not skew_fixed and kind == "end":
            # Training route key has no primary agency => variants like 510B stay distinct.
            x = {k: v for k, v in x.items() if not k.startswith("route_")}
            x[f"route_{str(scoped_route_key(t.get('route'), t.get('agency'))).lower()}"] = 1.0
        y = route_label(data, t) if kind == "route" else end_label(data, t, primary_scope)
        rows.append((t, x, y))
        prev = t
    return rows


def filter_training_rows(data, rows, kind, skew_fixed):
    """Apply the training scripts' count filters — on training rows only."""
    if kind == "route":
        counts = Counter(y for _, _, y in rows)
        return [r for r in rows if counts[r[2]] >= 3]
    combo = Counter()
    for t, _, _ in rows:
        rk = scoped_route_key(t.get("route"), t.get("agency"), data.primary_agency if skew_fixed else None)
        combo[(rk, data.canon.ml(start_stop_of(t)))] += 1
    keep = []
    for t, x, y in rows:
        rk = scoped_route_key(t.get("route"), t.get("agency"), data.primary_agency if skew_fixed else None)
        if combo[(rk, data.canon.ml(start_stop_of(t)))] >= 5:
            keep.append((t, x, y))
    ends = Counter(y for _, _, y in keep)
    return [r for r in keep if ends[r[2]] >= 10]


def ride_count_weights(rows, halflife=100):
    lam = math.log(2) / halflife
    order = sorted(range(len(rows)), key=lambda i: rows[i][0]["_start"])
    counts, w = defaultdict(int), [0.0] * len(rows)
    for i in reversed(order):
        a = rows[i][0].get("agency") or "unknown"
        w[i] = math.exp(-lam * counts[a])
        counts[a] += 1
    return np.array(w)


class FoldModels:
    def __init__(self, data, cutoff, kind, time_mode, skew_fixed):
        from sklearn.linear_model import LogisticRegression
        from xgboost import XGBClassifier
        rows = filter_training_rows(data, build_training_rows(data, cutoff, kind, time_mode, skew_fixed), kind, skew_fixed)
        self.ok = len(rows) >= 20 and len({y for _, _, y in rows}) >= 2
        if not self.ok:
            return
        names = sorted({k for _, x, _ in rows for k in x})
        self.names, self.index = names, {n: i for i, n in enumerate(names)}
        X = np.zeros((len(rows), len(names)), dtype=np.float32)
        for i, (_, x, _) in enumerate(rows):
            for k, v in x.items():
                X[i, self.index[k]] = v
        self.classes = sorted({y for _, _, y in rows})
        cidx = {c: i for i, c in enumerate(self.classes)}
        y = np.array([cidx[r[2]] for r in rows])
        w = ride_count_weights(rows) if kind == "end" else None
        self.agencies = {(t.get("agency") or "").lower() for t, _, _ in rows}
        self.v4 = LogisticRegression(max_iter=1000, class_weight="balanced")
        self.v4.fit(X, y, sample_weight=w)
        self.v5 = XGBClassifier(n_estimators=200, max_depth=4, learning_rate=0.1,
                                eval_metric="mlogloss", verbosity=0, random_state=42)
        # XGBoost needs contiguous labels; the class list is already contiguous over train rows.
        self.v5.fit(X, y, sample_weight=w)
        self.n_train = len(rows)

    def vector(self, x):
        v = np.zeros((1, len(self.names)), dtype=np.float32)
        for k, val in x.items():  # unseen categories => all zeros, as at serving time
            i = self.index.get(k)
            if i is not None:
                v[0, i] = val
        return v

    def predict(self, x, which):
        m = self.v4 if which == "v4" else self.v5
        p = m.predict_proba(self.vector(x))[0]
        full = np.zeros(len(self.classes))
        full[m.classes_] = p
        return full


# ---------------------------------------------------------------------------
# Baselines (online: each test trip sees only trips that ended before it)
# ---------------------------------------------------------------------------
def baseline_predict(data, trip, kind, time_mode, hist):
    """Return dict name -> ranked list of labels (display form for grading)."""
    ag = (trip.get("agency") or "").lower()
    pool = [t for t in hist if (t.get("agency") or "").lower() == ag]
    out = {}

    def label(t):
        return t.get("route") if kind == "route" else end_stop_of(t)

    def rank(trips, weights=None):
        c = defaultdict(float)
        for i, t in enumerate(trips):
            key = route_base_for_grading(label(t)) if kind == "route" else data.canon.v3(label(t))
            c[(key, label(t))] += weights[i] if weights is not None else 1.0
        best = {}
        for (key, disp), v in c.items():
            b = best.setdefault(key, [0.0, Counter()])
            b[0] += v
            b[1][disp] += v
        ranked = sorted(best.items(), key=lambda kv: -kv[1][0])
        total = sum(v[0] for _, v in ranked) or 1.0
        return [(v[1].most_common(1)[0][0], round(100 * v[0] / total)) for _, v in ranked]

    start = data.canon.v3(start_stop_of(trip))
    out["B1 most-frequent"] = rank(pool)
    if kind == "route":
        same = [t for t in pool if data.canon.v3(start_stop_of(t)) == start]
    else:
        rb = route_base_for_grading(trip.get("route"))
        same = [t for t in pool if data.canon.v3(start_stop_of(t)) == start and route_base_for_grading(t.get("route")) == rb]
    out["B2 per-stop"] = rank(same) if same else []
    # B3: stop x 3h local bucket with ride-count recency decay, backing off to B2 then B1.
    now = local_time(trip["_start"], trip, time_mode)
    bucket = now.hour // 3
    weekend = now.weekday() >= 5
    lam = math.log(2) / 100
    def wts(ts_):
        return [math.exp(-lam * i) for i in range(len(ts_))]  # hist is newest-first
    narrow = [t for t in same
              if local_time(t["_start"], t, time_mode).hour // 3 == bucket
              and (local_time(t["_start"], t, time_mode).weekday() >= 5) == weekend]
    if narrow:
        out["B3 stop x time, decayed"] = rank(narrow, wts(narrow))
    elif same:
        out["B3 stop x time, decayed"] = rank(same, wts(same))
    else:
        out["B3 stop x time, decayed"] = out["B1 most-frequent"]
    return out


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------
def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def paired_diff(a, b, iters=2000, seed=7):
    """Bootstrap 95% CI of mean(a - b) for paired 0/1 hit vectors."""
    rng = random.Random(seed)
    n = len(a)
    if n == 0:
        return (0.0, 0.0, 0.0)
    diffs = [a[i] - b[i] for i in range(n)]
    base = sum(diffs) / n
    boots = []
    for _ in range(iters):
        s = sum(diffs[rng.randrange(n)] for _ in range(n)) / n
        boots.append(s)
    boots.sort()
    return (base, boots[int(0.025 * iters)], boots[int(0.975 * iters)])


# ---------------------------------------------------------------------------
# Predictor registry
#
# A predictor family is registered with:
#   register(Family(name, tasks, setup=fn(data, fold_start) -> state, predict=fn(env) -> [Pred]))
# env carries: data, trip, ctx (serve context), replay row(s), fold state, and `so_far`
# (name -> ranked list already produced for this trip, so combination rows can build on
# earlier families). Families run in registration order. Extra families live in
# ml/eval/predictors/*.py, each exposing register(registry); they are auto-imported so
# parallel branches never edit this file.
# ---------------------------------------------------------------------------
class Pred:
    __slots__ = ("task", "name", "ranked", "abstain")

    def __init__(self, task, name, ranked, abstain=False):
        self.task, self.name, self.ranked, self.abstain = task, name, ranked, abstain


class Family:
    def __init__(self, name, tasks, predict, setup=None):
        self.name, self.tasks, self.predict, self.setup = name, set(tasks), predict, setup


REGISTRY = []


def register(family):
    REGISTRY.append(family)


def _v3_predict(env):
    out = []
    for name, rr in (("V3 (as served)", env["replay"]), ("V3 local time", env["replay_local"])):
        if rr is None:
            continue
        r3 = rr["v3Route"]
        out.append(Pred("route", name, [(r3["route"], r3["confidence"])] if r3 else []))
        out.append(Pred("end", name, [(p["stop"], p["confidence"]) for p in rr["v3EndTop"]]))
    return out


def _habit_predict(env):
    rp = env["replay"]
    h = rp["habit"]
    shown = [(h["endStop"], 100)] if h and h.get("endStop") else [(p["stop"], p["confidence"]) for p in rp["v3EndTop"]]
    return [
        Pred("end", "Habit engine", [(h["endStop"], round(100 * h["confidence"]))] if h and h.get("endStop") else []),
        Pred("end", "Served to user (habit, else V3 top-3)", shown),
    ]


def _full_history(data, trip):
    return sorted([x for x in data.clean_rows if x["_end"] < trip["_start"]], key=lambda x: x["_end"], reverse=True)


def _baseline_predict(env):
    data, t, hist = env["data"], env["trip"], env["ctx"]["hist"]
    out = []
    full = _full_history(data, t)
    for kind in env["tasks"]:
        for name, ranked in baseline_predict(data, t, kind, "local", hist).items():
            out.append(Pred(kind, name, ranked))
        out.append(Pred(kind, "B3 on full history", baseline_predict(data, t, kind, "local", full)["B3 stop x time, decayed"]))
    return out


def _combo_predict(env):
    so = env["so_far"]
    out = []
    for kind in env["tasks"]:
        v3 = so.get((kind, "V3 (as served)"))
        b3 = so.get((kind, "B3 on full history"))
        if v3 is None or b3 is None:
            continue
        out.append(Pred(kind, "V3, else B3 on full history", v3 if v3 else b3))
    return out


ML_VARIANTS = [  # (time_mode, skew_fixed, label)
    ("utc", False, "shipped features"),
    ("utc", True, "skew fixed"),
    ("local", True, "skew fixed + local time"),
]


def _ml_setup(data, fold_start, tasks):
    return {(kind, tm, sf): FoldModels(data, fold_start, kind, tm, sf)
            for kind in tasks for tm, sf, _ in ML_VARIANTS}


def _deployed_setup(data, fold_start, tasks):
    return {"cache": {}}


def _last_monday_retrain(dt):
    """Weekly retrain runs Mondays 04:00 UTC (retrain.yml)."""
    d = dt.astimezone(timezone.utc)
    m = (d - timedelta(days=d.weekday())).replace(hour=4, minute=0, second=0, microsecond=0)
    return m if m <= d else m - timedelta(days=7)


def _ml_rows(env, fm, kind, label, x_mode):
    """Score one FoldModels with the eligibility gate and serving post-processing."""
    data, t, rp, ctx = env["data"], env["trip"], env["replay"], env["ctx"]
    time_mode, = x_mode
    out = []
    clean_same_agency = sum(1 for h in ctx["hist"] if (h.get("agency") or "").lower() == (t.get("agency") or "").lower())
    legal = set(rp["legalStops"]) if rp.get("constraintSource") in ("topology", "topology+network") and rp.get("legalStops") else None
    for which in ("v4", "v5"):
        name = f"{which.upper()} ({label})"
        alt = name + (" masked" if kind == "end" else " (no floor)")
        eligible = fm.ok and (t.get("agency") or "").lower() in fm.agencies and \
            clean_same_agency >= (ROUTE_MIN_CLEAN if kind == "route" else ENDSTOP_MIN_CLEAN)
        if not eligible:
            out += [Pred(kind, name, [], True), Pred(kind, alt, [], True)]
            continue
        p = fm.predict(feature_dict(data, t, ctx, kind, time_mode, True), which)
        order = np.argsort(-p)
        if kind == "route":
            ranked = [(fm.classes[i].split("::", 1)[1], round(100 * p[i])) for i in order[:5]]
            floor_ok = ranked[0][1] >= ROUTE_CONF_FLOOR  # former correctPredictionByGtfs without routesAtStop
            out += [Pred(kind, name, ranked if floor_ok else [], not floor_ok), Pred(kind, alt, ranked)]
        else:
            disp = [fm.classes[i].split("::", 1)[1] for i in range(len(fm.classes))]
            out.append(Pred(kind, name, [(disp[i], round(100 * p[i])) for i in order[:3]]))
            if legal is not None:
                legal_c = {data.canon.v3(s) for s in legal}
                q = np.array([p[i] if data.canon.v3(disp[i]) in legal_c else 0.0 for i in range(len(p))])
                q = q / q.sum() if q.sum() > 0 else q
                out.append(Pred(kind, alt, [(disp[i], round(100 * q[i])) for i in np.argsort(-q) if q[i] > 0][:3]))
            else:
                out.append(Pred(kind, alt, [(disp[i], round(100 * p[i])) for i in order[:3]]))
    return out


def _ml_predict(env):
    out = []
    for kind in env["tasks"]:
        for tm, sf, label in ML_VARIANTS:
            out += _ml_rows(env, env["state"][(kind, tm, sf)], kind, label, (tm,))
    return out


def _deployed_predict(env):
    """What actually ran: fit on the first 80% of clean trips at the last Monday retrain."""
    data, t, cache = env["data"], env["trip"], env["state"]["cache"]
    when = _last_monday_retrain(t["_start"])
    out = []
    for kind in env["tasks"]:
        key = (kind, when)
        if key not in cache:
            train = sorted(data.clean_before(when), key=lambda x: x["_start"])
            cut = train[int(len(train) * 0.8)]["_start"] if len(train) >= 5 else when
            cache[key] = FoldModels(data, cut, kind, "utc", False)
        out += _ml_rows(env, cache[key], kind, "as deployed: 80% fit, weekly", ("utc",))
    return out


register(Family("v3", {"route", "end"}, _v3_predict))
register(Family("habit", {"end"}, _habit_predict))
register(Family("baseline", {"route", "end"}, _baseline_predict))
register(Family("combo", {"route", "end"}, _combo_predict))
register(Family("ml", {"route", "end"}, _ml_predict, setup=_ml_setup))
register(Family("deployed", {"route", "end"}, _deployed_predict, setup=_deployed_setup))


def _load_extra_predictors():
    import importlib.util
    pdir = os.path.join(os.path.dirname(__file__), "predictors")
    if not os.path.isdir(pdir):
        return
    for fn in sorted(os.listdir(pdir)):
        if fn.endswith(".py") and not fn.startswith("_"):
            spec = importlib.util.spec_from_file_location(f"eval_predictor_{fn[:-3]}", os.path.join(pdir, fn))
            mod = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = mod
            spec.loader.exec_module(mod)
            mod.register(sys.modules[__name__])


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def summarize(results, seg_of, n_rows, references):
    out_tasks = {}
    for task, by_name in results.items():
        refs = {ref: {r["id"]: r for r in by_name.get(ref, [])} for ref in references}
        out = {}
        for name, rs in by_name.items():
            n = len(rs)
            k1 = sum(r["top1"] for r in rs)
            k3 = sum(r["top3"] for r in rs)
            m = {"n": n, "top1": k1 / n, "top1_ci": wilson(k1, n), "top3": k3 / n,
                 "coverage": sum(r["covered"] for r in rs) / n, "vs": {}, "thresholds": {}, "segments": {}}
            for ref, rmap in refs.items():
                if rmap and all(r["id"] in rmap for r in rs):
                    m["vs"][ref] = paired_diff([int(r["top1"]) for r in rs], [int(rmap[r["id"]]["top1"]) for r in rs])
                    last = [r for r in rs if seg_of[r["id"]]["last90"]]
                    m["vs"][ref + " (last 90d)"] = paired_diff([int(r["top1"]) for r in last], [int(rmap[r["id"]]["top1"]) for r in last])
            for c in (25, 50, 75):
                sel = [r for r in rs if r["covered"] and r["conf"] is not None and r["conf"] >= c]
                m["thresholds"][c] = {"coverage": len(sel) / n, "precision": (sum(r["top1"] for r in sel) / len(sel)) if sel else None}
            for key in ("day", "age", "agency", "last90"):
                for val in sorted({seg_of[r["id"]][key] for r in rs}):
                    sub = [r for r in rs if seg_of[r["id"]][key] == val]
                    m["segments"][f"{key}:{val}"] = {"n": len(sub), "top1": sum(r["top1"] for r in sub) / len(sub),
                                                     "top3": sum(r["top3"] for r in sub) / len(sub)}
            out[name] = m
        out_tasks[task] = out
    return out_tasks


def main():
    import hashlib
    ap = argparse.ArgumentParser()
    ap.add_argument("--trips", required=True)
    ap.add_argument("--stops", required=True)
    ap.add_argument("--replay", required=True)
    ap.add_argument("--replay-local")
    ap.add_argument("--out")
    ap.add_argument("--only", help="comma-separated predictor families (default: all)")
    ap.add_argument("--task", choices=["route", "end"], help="score one task only")
    args = ap.parse_args()

    load_policies()
    _load_extra_predictors()
    data = Data(args.trips, args.stops)
    data.clean_rows = [t for t in data.trips if is_clean(t) and t["_start"]]
    snapshot = hashlib.sha256(open(args.trips, "rb").read()).hexdigest()[:12]
    if snapshot != EVAL_SNAPSHOT:
        print(f"WARNING: trips snapshot {snapshot} != pinned {EVAL_SNAPSHOT}; numbers are not comparable "
              "with EVAL.md", file=sys.stderr)
    replay = {r["id"]: r for r in map(json.loads, open(args.replay))}
    replay_local = {r["id"]: r for r in map(json.loads, open(args.replay_local))} if args.replay_local else {}
    tasks = {args.task} if args.task else {"route", "end"}
    only = set(args.only.split(",")) if args.only else None
    families = [f for f in REGISTRY if (only is None or f.name in only or f.name in ("v3", "baseline")) and f.tasks & tasks]

    all_sms = [t for t in data.trips if t.get("source") in EVAL_SOURCES and t["_start"]
               and EVAL_START <= t["_start"] < EVAL_END and t["_end"]]
    eval_rows = sorted([t for t in all_sms if is_clean(t) and t["_id"] in replay], key=lambda t: t["_start"])
    folds, s = [], EVAL_START
    while s < EVAL_END:
        folds.append((s, min(s + timedelta(days=FOLD_DAYS), EVAL_END)))
        s += timedelta(days=FOLD_DAYS)

    seg_of = {}
    for t in eval_rows:
        lt = local_time(t["_start"], t, "local")
        seg_of[t["_id"]] = {
            "day": "weekend" if lt.weekday() >= 5 else "weekday",
            "age": "recent (Aug-Oct)" if t["_start"] >= datetime(2026, 8, 1, tzinfo=timezone.utc) else "older (May-Jul)",
            "agency": "TTC" if t.get("agency") == "TTC" else "other agency",
            "last90": t["_start"] >= EVAL_END - timedelta(days=90),
        }

    results = {task: defaultdict(list) for task in tasks}

    def grade(task, t, pred):
        actual = t.get("route") if task == "route" else end_stop_of(t)
        if task == "route":
            hits = [grade_route(p, actual, t.get("agency")) for p, _ in pred.ranked]
        else:
            ca = data.canon.v3(actual)
            hits = [data.canon.v3(p) == ca for p, _ in pred.ranked]
        ok = not pred.abstain
        return {"id": t["_id"], "covered": bool(pred.ranked) and ok, "top1": bool(hits[:1] and hits[0]) and ok,
                "top3": any(hits[:3]) and ok, "conf": pred.ranked[0][1] if pred.ranked else None}

    for fi, (fs, fe) in enumerate(folds):
        rows = [t for t in eval_rows if fs <= t["_start"] < fe]
        if not rows:
            continue
        states = {f.name: (f.setup(data, fs, tasks & f.tasks) if f.setup else None) for f in families}
        print(f"fold {fi + 1}/{len(folds)} {fs.date()}..{fe.date()}  rows={len(rows)}", file=sys.stderr)
        for t in rows:
            env = {"data": data, "trip": t, "ctx": serve_context(data, t), "replay": replay[t["_id"]],
                   "replay_local": replay_local.get(t["_id"]), "so_far": {}}
            for f in families:
                env["state"], env["tasks"] = states[f.name], tasks & f.tasks
                for p in f.predict(env):
                    if p.task in tasks:
                        env["so_far"][(p.task, p.name)] = [] if p.abstain else p.ranked
                        results[p.task][p.name].append(grade(p.task, t, p))

    references = ["V3 (as served)", "B3 on full history"]
    summary = {"eval_version": EVAL_VERSION, "snapshot": snapshot, "eval_start": EVAL_START.isoformat(),
               "eval_end": EVAL_END.isoformat(), "fold_days": FOLD_DAYS, "folds": len(folds),
               "rows": len(eval_rows), "all_completed_sms_in_window": len(all_sms),
               "tasks": summarize(results, seg_of, len(eval_rows), references)}

    for task, out in summary["tasks"].items():
        print(f"\n=== {task} (n={summary['rows']}, snapshot {snapshot}) ===")
        print(f"{'predictor':52s} {'top1':>6s} {'95% CI':>13s} {'top3':>6s} {'cover':>6s} {'d vs V3 last90 [CI]':>22s} {'d vs B3full last90':>20s}")
        for name, m in sorted(out.items(), key=lambda kv: -kv[1]["top1"]):
            lo, hi = m["top1_ci"]
            d1 = m["vs"].get("V3 (as served) (last 90d)", (0, 0, 0))
            d2 = m["vs"].get("B3 on full history (last 90d)", (0, 0, 0))
            print(f"{name:52s} {m['top1']:6.1%} {lo:6.1%}-{hi:5.1%} {m['top3']:6.1%} {m['coverage']:6.1%} "
                  f"{d1[0] * 100:+6.1f} [{d1[1] * 100:+5.1f},{d1[2] * 100:+5.1f}] {d2[0] * 100:+6.1f} [{d2[1] * 100:+5.1f},{d2[2] * 100:+5.1f}]")
    if args.out:
        json.dump(summary, open(args.out, "w"), indent=1)


if __name__ == "__main__":
    main()
