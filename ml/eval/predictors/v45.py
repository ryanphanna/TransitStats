"""V4/V5 improvement variants (branch ml/v4v5-fresh).

Rows (all V4 and V5, scored with the harness's serving post-processing in _ml_rows):
  per-fold refit (every 14 days):
    "ref"      skew fixed + local time, class_weight=balanced, depth-4 XGB   (= harness ml row)
    "nobal"    + no class_weight
    "reg"      + regularized XGB (depth 3, 150 trees, min_child_weight 2, lambda 2); routes get recency weights
    "relax"    + training filter relaxed (no route+stop >= 5 filter; end class >= 5)
    "dropout"  + unseen-start-stop augmentation (copy of each row with the stop one-hot removed, weight 0.3)
  round 2 (V45_SET=r2): "r5"/"r3"/"r2" = no class weight, default XGB, no route+stop filter, end class >= 5/3/2;
    "r5 dropout" = r5 + the augmentation
  weekly Monday retrain (the real cadence):
    "weekly 100%, shipped"   shipped features/params, fit on 100% (vs "as deployed" 80%)  -> H1 alone
    "weekly 100%, new"       the config the training scripts now ship
"""
import math
from collections import Counter

import numpy as np

H = None

BASE = dict(balanced=True, depth=4, n_est=200, mcw=1, lam=1.0, route_weights=False,
            relax=0, dropout=0.0)
NOBAL = dict(BASE, balanced=False)
REG = dict(NOBAL, depth=3, n_est=150, mcw=2, lam=2.0, route_weights=True)
RELAX = dict(REG, relax=5)
DROPOUT = dict(RELAX, dropout=0.3)
R5 = dict(NOBAL, relax=5)
R3 = dict(NOBAL, relax=3)
R2 = dict(NOBAL, relax=2)
R5W = dict(R5, route_weights=True)
SHIPPED_CFG = {"end": R5, "route": NOBAL}  # what train_endstop.py ships / what the removed train_routes.py shipped

import os
_SETS = {
    "r1": [("ref", BASE), ("nobal", NOBAL), ("reg", REG), ("relax", RELAX), ("dropout", DROPOUT)],
    "r2": [("r5", R5), ("r3", R3), ("r2", R2), ("r5 dropout", dict(R5, dropout=0.3))],
    "weekly": [],  # only the weekly rows
}
FOLD_VARIANTS = _SETS[os.environ.get("V45_SET", "r2")]


def _filter(data, rows, kind, cfg):
    if not cfg["relax"]:
        return H.filter_training_rows(data, rows, kind, True)
    if kind == "route":
        counts = Counter(y for _, _, y in rows)
        return [r for r in rows if counts[r[2]] >= 3]
    ends = Counter(y for _, _, y in rows)
    return [r for r in rows if ends[r[2]] >= cfg["relax"]]


class Models:
    def __init__(self, data, cutoff, kind, time_mode, skew_fixed, cfg):
        from sklearn.linear_model import LogisticRegression
        from xgboost import XGBClassifier
        rows = H.build_training_rows(data, cutoff, kind, time_mode, skew_fixed)
        rows = _filter(data, rows, kind, cfg) if skew_fixed else H.filter_training_rows(data, rows, kind, False)
        self.ok = len(rows) >= 20 and len({y for _, _, y in rows}) >= 2
        if not self.ok:
            return
        w = H.ride_count_weights(rows) if (kind == "end" or cfg["route_weights"]) else np.ones(len(rows))
        if cfg["dropout"] > 0:
            aug = [(t, {k: v for k, v in x.items() if not k.startswith("stop_")}, y) for t, x, y in rows]
            w = np.concatenate([w, w * cfg["dropout"]])
            rows = rows + aug
        names = sorted({k for _, x, _ in rows for k in x})
        self.names, self.index = names, {n: i for i, n in enumerate(names)}
        X = np.zeros((len(rows), len(names)), dtype=np.float32)
        for i, (_, x, _) in enumerate(rows):
            for k, v in x.items():
                X[i, self.index[k]] = v
        self.classes = sorted({y for _, _, y in rows})
        cidx = {c: i for i, c in enumerate(self.classes)}
        y = np.array([cidx[r[2]] for r in rows])
        self.agencies = {(t.get("agency") or "").lower() for t, _, _ in rows}
        self.v4 = LogisticRegression(max_iter=1000, class_weight="balanced" if cfg["balanced"] else None)
        self.v4.fit(X, y, sample_weight=w)
        self.v5 = XGBClassifier(n_estimators=cfg["n_est"], max_depth=cfg["depth"], learning_rate=0.1,
                                min_child_weight=cfg["mcw"], reg_lambda=cfg["lam"],
                                eval_metric="mlogloss", verbosity=0, random_state=42, n_jobs=2)
        self.v5.fit(X, y, sample_weight=w)


def _setup(data, fold_start, tasks):
    return {(kind, name): Models(data, fold_start, kind, "local", True, cfg)
            for kind in tasks for name, cfg in FOLD_VARIANTS}


def _predict(env):
    out = []
    for kind in env["tasks"]:
        for name, _ in FOLD_VARIANTS:
            out += H._ml_rows(env, env["state"][(kind, name)], kind, f"v45 {name}", ("local",))
        cache = env["state"].setdefault("weekly", {})
        when = H._last_monday_retrain(env["trip"]["_start"])
        for label, tm, sf, cfg in (("v45 weekly 100%, shipped", "utc", False, BASE),
                                   ("v45 weekly 100%, new", "local", True, SHIPPED_CFG[kind])):
            key = (kind, when, label)
            if key not in cache:
                cache[key] = Models(env["data"], when, kind, tm, sf, cfg)
            out += H._ml_rows(env, cache[key], kind, label, (tm,))
    return out


_WEEKLY = {}


def _setup_all(data, fold_start, tasks):
    s = _setup(data, fold_start, tasks)
    s["weekly"] = _WEEKLY  # weekly models persist across folds
    return s


def register(h):
    global H
    H = h
    Models.vector = h.FoldModels.vector
    Models.predict = h.FoldModels.predict
    h.register(h.Family("v45", {"route", "end"}, _predict, setup=_setup_all))
