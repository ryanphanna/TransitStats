"""V6 candidates for the shared eval harness (eval definition v1).

1. V6 backoff: hierarchical frequency backoff (the ml/v6_eval_against_shadow.py idea), ported
   onto harness rows. For the end stop it walks from the richest context
   (route + start + direction + previous route/end + gap + 3h local bucket + day type)
   down to the agency-wide distribution and answers from the first bucket with enough support.
   Two history views: the serve window (env ctx hist, 100 newest) and full clean history.
   Sequence context (previous route, previous end stop, gap, previous start stop) always comes
   from serving's history[0], exactly as handlers-trip.js derives it.
2. V6 rerank: candidates = V3 top-3 + V6 backoff top-5 + B3-full top-3 + the last end stop and
   the last start stop; each candidate is scored by a small logistic model that is refit at each
   fold start on clean replayed trips that ended before the fold. Every training row's
   candidates and features are computed from history before that row's own start.

Config chosen by ml/eval/v6_tune.py on rows before the last 90 days (see EVAL.md).
Labels are keyed by V3 canonicalization (the grading key) and emitted as raw display names.
"""

import math
from collections import Counter, defaultdict

# ---------------------------------------------------------------------------
# Backoff level orders and configs (CONFIG is tuned by ml/eval/v6_tune.py on rows before the last 90 days)
# ---------------------------------------------------------------------------
END_LEVELS_ORIGINAL = [  # order from ml/v6_eval_against_shadow.py
    ("route", "start", "dir", "prev_route", "prev_end", "gap", "hb", "day"),
    ("route", "start", "dir", "prev_route", "prev_end", "hb", "day"),
    ("route", "start", "dir", "prev_route", "prev_end", "gap"),
    ("route", "start", "dir", "prev_route", "prev_end"),
    ("route", "start", "dir", "prev_route"),
    ("route", "start", "dir"),
    ("route", "start"),
    ("start", "prev_route"),
    ("route",),
    (),
]
ROUTE_LEVELS_ORIGINAL = [
    ("start", "prev_route", "prev_end", "hb", "day"),
    ("start", "prev_route", "prev_end"),
    ("start", "prev_route"),
    ("start",),
    ("prev_route",),
    (),
]
_D, _R = ("route", "start", "dir"), ("route", "start")
CONFIG = {  # (task, view) -> config; argmax top-1 on the 249 tune rows (ties: first listed / shared value)
    ("end", "full"): {"levels": [_D + ("prev_end", "hb", "day"), _D + ("prev_end",), _D + ("hb", "day"), _D, _R,
                                 ("start", "prev_route"), ("route",), ()], "min_support": 2, "halflife": 25},
    ("end", "serve"): {"levels": END_LEVELS_ORIGINAL, "min_support": 1, "halflife": 100},
    ("route", "full"): {"levels": [("start", "prev_route", "hb", "day"), ("start", "prev_route"), ("start", "hb", "day"),
                                   ("start",), ()], "min_support": 1, "halflife": 100},
    ("route", "serve"): {"levels": [("start", "prev_route", "hb", "day"), ("start", "prev_route"), ("start", "hb", "day"),
                                    ("start",), ()], "min_support": 1, "halflife": 100},
}
# The rerank was specified and first scored before tuning; it keeps the pre-tuning backoff
# (original order, support 2, half-life 100) for its candidates and decayed shares.
RERANK_BACKOFF = {"levels": END_LEVELS_ORIGINAL, "min_support": 2, "halflife": 100}
ORIGINAL_CONFIG = {"end": {"levels": END_LEVELS_ORIGINAL, "min_support": 2, "halflife": None},
                   "route": {"levels": ROUTE_LEVELS_ORIGINAL, "min_support": 2, "halflife": None}}

GAP_BUCKETS = ("transfer", "stopover", "separate", "none")


def gap_bucket(gap):
    if gap is None:
        return "none"
    if gap <= 30:
        return "transfer"
    if gap <= 120:
        return "stopover"
    return "separate"


class V6:
    """Feature cache + backoff + rerank, shared by the harness module and the tuning script."""

    def __init__(self, h, data):
        self.h, self.data = h, data
        self._feat = {}
        self._ctx = {}
        self._match_cache = {}

    # -- per-trip features --------------------------------------------------
    def seq(self, t):
        """Sequence context from serving's history[0] (handlers-trip.js)."""
        if t["_id"] not in self._ctx:
            h, c = self.h, self.data.canon
            hist = h.serve_context(self.data, t)["hist"]
            last = hist[0] if hist else None
            gap = None
            if last and last.get("_start"):
                gap = max(0, round((t["_start"] - last["_start"]).total_seconds() / 60))
            self._ctx[t["_id"]] = {
                "prev_route": h.route_base_for_grading(last.get("route")) if last and last.get("route") else None,
                "prev_end": c.v3(h.end_stop_of(last)) if last and h.end_stop_of(last) else None,
                "prev_start": c.v3(h.start_stop_of(last)) if last and h.start_stop_of(last) else None,
                "gap": gap_bucket(gap),
                "gap_min": gap,
            }
        return self._ctx[t["_id"]]

    def feat(self, t):
        if t["_id"] not in self._feat:
            h, c = self.h, self.data.canon
            lt = h.local_time(t["_start"], t, "local")
            s = self.seq(t)
            end = h.end_stop_of(t)
            self._feat[t["_id"]] = {
                "agency": (t.get("agency") or "").lower(),
                "route": h.route_base_for_grading(t.get("route")) if t.get("route") else None,
                "route_disp": t.get("route"),
                "start": c.v3(h.start_stop_of(t)) if h.start_stop_of(t) else None,
                "dir": h.norm_dir(t.get("direction")),
                "hb": lt.hour // 3,
                "hour": lt.hour,
                "day": "weekend" if lt.weekday() >= 5 else "weekday",
                "end": c.v3(end) if end else None,
                "end_disp": end,
                **{k: s[k] for k in ("prev_route", "prev_end", "prev_start", "gap")},
            }
        return self._feat[t["_id"]]

    # -- history views -------------------------------------------------------
    def pool(self, trip, view, env_hist=None):
        """Same-agency clean rows, newest first by end time."""
        ag = (trip.get("agency") or "").lower()
        if view == "serve":
            hist = env_hist if env_hist is not None else self.h.serve_context(self.data, trip)["hist"]
            hist = [x for x in hist if self.h.is_clean(x) and x.get("_start")]
        else:
            hist = self.h._full_history(self.data, trip)
        return [x for x in hist if (x.get("agency") or "").lower() == ag]

    def matches(self, trip, view, level, label, pool):
        """Labels (newest first) of pool rows that agree with the trip on every level feature.
        Returns None when the trip lacks one of the level's values (level skipped)."""
        key = (trip["_id"], view, level, label)
        if key not in self._match_cache:
            f = self.feat(trip)
            if any(f[k] is None for k in level):
                self._match_cache[key] = None
            else:
                want = tuple(f[k] for k in level)
                out = []
                for x in pool:
                    fx = self.feat(x)
                    if tuple(fx[k] for k in level) == want:
                        out.append((fx[label], fx[label + "_disp"]))
                self._match_cache[key] = out
        return self._match_cache[key]

    @staticmethod
    def rank(labels, halflife):
        lam = math.log(2) / halflife if halflife else 0.0
        tot, disp = defaultdict(float), defaultdict(Counter)
        for i, (k, d) in enumerate(labels):
            w = math.exp(-lam * i)
            tot[k] += w
            disp[k][d] += w
        s = sum(tot.values()) or 1.0
        return [(k, disp[k].most_common(1)[0][0], v / s) for k, v in sorted(tot.items(), key=lambda kv: -kv[1])]

    def backoff(self, trip, view, cfg, label="end", env_hist=None, depth=5):
        """Ranked [(display, conf_0_100)], keys, level index used. Fills top-k from broader levels."""
        pool = self.pool(trip, view, env_hist)
        ranked, seen, used = [], set(), None
        for li, level in enumerate(cfg["levels"]):
            m = self.matches(trip, view, level, label, pool)
            if not m:
                continue
            if used is None and len(m) < cfg["min_support"] and li < len(cfg["levels"]) - 1:
                continue
            r = self.rank(m, cfg["halflife"])
            for k, d, share in r:
                if k not in seen:
                    seen.add(k)
                    ranked.append((d, round(100 * share), k))
            if used is None:
                used = li
            if len(ranked) >= depth:
                break
        return [(d, c) for d, c, _ in ranked[:depth]], [k for _, _, k in ranked[:depth]], used

    # -- rerank ---------------------------------------------------------------
    def candidates(self, trip, replay_row, view="full"):
        """Candidate keys -> display + per-candidate features (all from history before the trip)."""
        h, c = self.h, self.data.canon
        f = self.feat(trip)
        full = h._full_history(self.data, trip) if view == "full" else \
            [x for x in h.serve_context(self.data, trip)["hist"] if h.is_clean(x) and x.get("_start")]
        pool = [x for x in full if (x.get("agency") or "").lower() == f["agency"]]
        v3 = [(p["stop"], p["confidence"]) for p in (replay_row or {}).get("v3EndTop") or []]
        b3 = h.baseline_predict(self.data, trip, "end", "local", full)["B3 stop x time, decayed"][:3]
        bo, bo_keys, _ = self.backoff(trip, view, RERANK_BACKOFF, depth=5)
        disp = {}
        for d, _ in v3 + b3 + bo:
            disp.setdefault(c.v3(d), d)
        last_disp = {}
        hist = h.serve_context(self.data, trip)["hist"]
        if hist:
            for name in (h.end_stop_of(hist[0]), h.start_stop_of(hist[0])):
                if name:
                    last_disp.setdefault(c.v3(name), name)
        for k, d in last_disp.items():
            disp.setdefault(k, d)
        disp.pop(None, None)

        hl = RERANK_BACKOFF["halflife"]

        def shares(level):
            m = self.matches(trip, view, level, "end", pool) or []
            return {k: s for k, _, s in self.rank(m, hl)}, len(m)

        s_rsd, n_rsd = shares(("route", "start", "dir"))
        s_rs, n_rs = shares(("route", "start"))
        s_rsh, n_rsh = shares(("route", "start", "hb", "day"))
        s_s, _ = shares(("start",))
        s_r, _ = shares(("route",))
        s_prev, n_prev = shares(("route", "start", "prev_end"))
        # same local hour +-1 at route+start, any day
        if f["route"] and f["start"]:
            m = [(self.feat(x)["end"], None) for x in pool
                 if self.feat(x)["route"] == f["route"] and self.feat(x)["start"] == f["start"]
                 and min(abs(self.feat(x)["hour"] - f["hour"]), 24 - abs(self.feat(x)["hour"] - f["hour"])) <= 1]
            lam = math.log(2) / hl if hl else 0.0
            tot = Counter()
            for i, (k, _) in enumerate(m):
                tot[k] += math.exp(-lam * i)
            sm = sum(tot.values()) or 1.0
            s_h1 = {k: v / sm for k, v in tot.items()}
        else:
            s_h1 = {}
        v3_rank = {c.v3(d): (i, conf) for i, (d, conf) in enumerate(v3)}
        b3_rank = {c.v3(d): i for i, (d, _) in enumerate(b3)}
        bo_rank = {k: i for i, k in enumerate(bo_keys)}
        gap = f["gap"]
        out = []
        for k, d in disp.items():
            is_last = float(k == f["prev_end"])
            is_ret = float(k == f["prev_start"])
            vr = v3_rank.get(k)
            x = [
                s_rsd.get(k, 0.0), s_rs.get(k, 0.0), s_rsh.get(k, 0.0), s_h1.get(k, 0.0),
                s_s.get(k, 0.0), s_r.get(k, 0.0), s_prev.get(k, 0.0),
                s_rs.get(k, 0.0) * math.log1p(n_rs), s_rsh.get(k, 0.0) * math.log1p(n_rsh),
                float(n_rs == 0),
                is_last, is_ret,
                *[is_last * (gap == g) for g in GAP_BUCKETS],
                *[is_ret * (gap == g) for g in GAP_BUCKETS],
                float(vr is not None and vr[0] == 0), (vr[1] / 100.0 if vr is not None and vr[0] == 0 else 0.0),
                float(vr is not None), (vr[1] / 100.0 if vr is not None else 0.0),
                float(b3_rank.get(k) == 0), float(k in b3_rank),
                float(bo_rank.get(k) == 0), float(k in bo_rank),
                float(k == f["start"]),
            ]
            out.append((k, d, x))
        return out


FEATURE_NAMES = ["share_route_start_dir", "share_route_start", "share_route_start_3h_day", "share_route_start_hour_pm1",
                 "share_start", "share_route", "share_route_start_prev_end", "share_rs_x_logn", "share_rsh_x_logn",
                 "no_route_start_history", "is_last_end", "is_return",
                 *[f"is_last_end_x_gap_{g}" for g in GAP_BUCKETS], *[f"is_return_x_gap_{g}" for g in GAP_BUCKETS],
                 "is_v3_top1", "v3_top1_conf", "in_v3_top3", "v3_conf", "is_b3_top1", "in_b3_top3",
                 "is_v6_top1", "in_v6_top5", "is_start_stop"]


class Reranker:
    def __init__(self, v6, replay, view="full"):
        self.v6, self.replay, self.view = v6, replay, view
        self._cands = {}
        h, data = v6.h, v6.data
        self.train_trips = sorted([t for t in data.clean_rows if t["_id"] in replay], key=lambda t: t["_start"])

    def cands(self, t):
        if t["_id"] not in self._cands:
            self._cands[t["_id"]] = self.v6.candidates(t, self.replay.get(t["_id"]), self.view)
        return self._cands[t["_id"]]

    def fit(self, cutoff, C=1.0):
        import numpy as np
        from sklearn.linear_model import LogisticRegression
        X, y = [], []
        for t in self.train_trips:
            if t["_end"] >= cutoff:
                continue
            actual = self.v6.feat(t)["end"]
            for k, _, x in self.cands(t):
                X.append(x)
                y.append(int(k == actual))
        if len(set(y)) < 2:
            return None
        m = LogisticRegression(C=C, max_iter=2000)
        m.fit(np.array(X), np.array(y))
        return m

    def predict(self, model, t):
        import numpy as np
        cs = self.cands(t)
        if not cs or model is None:
            return []
        p = model.predict_proba(np.array([x for _, _, x in cs]))[:, 1]
        s = p.sum() or 1.0
        order = np.argsort(-p)
        return [(cs[i][1], round(100 * p[i] / s)) for i in order[:3]]


# ---------------------------------------------------------------------------
# Harness registration
# ---------------------------------------------------------------------------
_STATE = {}


def register(h):
    def get_v6(data):
        if "v6" not in _STATE or _STATE["v6"].data is not data:
            _STATE["v6"] = V6(h, data)
        return _STATE["v6"]

    def predict(env):
        data, t = env["data"], env["trip"]
        v6 = get_v6(data)
        out = []
        for kind in env["tasks"]:
            for view, vname in (("serve", "serve history"), ("full", "full history")):
                ranked, _, _ = v6.backoff(t, view, CONFIG[(kind, view)], label=kind, env_hist=env["ctx"]["hist"] if view == "serve" else None, depth=3)
                out.append(h.Pred(kind, f"V6 backoff, tuned ({vname})", ranked))
            ranked, _, _ = v6.backoff(t, "full", ORIGINAL_CONFIG[kind], label=kind, depth=3)
            out.append(h.Pred(kind, "V6 backoff, original order (full history)", ranked))
            v3 = env["so_far"].get((kind, "V3 (as served)"))
            if v3 is not None:
                full_ranked = [p for p in out if p.task == kind and p.name == "V6 backoff, tuned (full history)"][0].ranked
                out.append(h.Pred(kind, "V3, else V6 backoff full", v3 if v3 else full_ranked))
        if "end" in env["tasks"]:
            rr = env["state"]
            out.append(h.Pred("end", "V6 rerank (walk-forward logistic)", rr["rr"].predict(rr["model"], t)))
            out.append(h.Pred("end", "V6 rerank, serve history only (exploratory)", rr["rr_s"].predict(rr["model_s"], t)))
        return out

    def setup(data, fold_start, tasks):
        if "end" not in tasks:
            return {}
        v6 = get_v6(data)
        if "rr" not in _STATE:
            replay = {}
            import json
            import sys
            path = None
            for i, a in enumerate(sys.argv):
                if a == "--replay":
                    path = sys.argv[i + 1]
            replay = {r["id"]: r for r in map(json.loads, open(path))} if path else {}
            _STATE["rr"] = Reranker(v6, replay)
            _STATE["rr_s"] = Reranker(v6, replay, view="serve")
        rr, rr_s = _STATE["rr"], _STATE["rr_s"]
        return {"rr": rr, "model": rr.fit(fold_start), "rr_s": rr_s, "model_s": rr_s.fit(fold_start)}

    h.register(h.Family("v6", {"route", "end"}, predict, setup=setup))
