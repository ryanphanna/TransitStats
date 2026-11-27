#!/usr/bin/env python3
"""Compare V5 end-stop XGBoost settings on the retrain gate's walk-forward folds (RYN-828).

Uses ml/eval_gate.py's walk_forward() unchanged: fixed 14-day folds, each fold trained only on trips
before it, count filters applied to the training rows only, and every test trip kept (a trip to an
end stop the model has never seen counts as a miss). The only change is the window: the gate scores
the last 90 days; this scores every fold that has enough training rows, unless --window-days is set.

Aggregates only (the repo is public): overall and per-fold top-1/top-3, and a paired bootstrap of
each candidate against the first setting. Usage, from the repo root:

  ml/.venv/bin/python ml/eval/v5_params_check.py --csv ml/trips.csv --stops-json ml/lab/data/colab/stops.json
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import eval_gate as g  # noqa: E402

# First entry is the reference (the live V5 settings). RYN-826's best single-split candidates follow.
SETTINGS = [
    ("live V5", None),
    ("lr 0.03", dict(n_estimators=200, max_depth=4, learning_rate=0.03)),
    ("lr 0.03, depth 3, subsample 0.8", dict(n_estimators=200, max_depth=3, learning_rate=0.03, subsample=0.8)),
]


def run(P, raw, lib, params):
    original = dict(P.V5_PARAMS)
    if params is not None:
        P.V5_PARAMS.clear()
        P.V5_PARAMS.update(params)
    try:
        rows, info = g.walk_forward(P, raw, lib, salt=b"local-check", log=lambda *a: None)
    finally:
        P.V5_PARAMS.clear()
        P.V5_PARAMS.update(original)
    fitted = {f["fold"] for f in info["folds"] if f["fit"]}
    return [r for r in rows if r["fold"] in fitted], info


def paired_boot(a, b, n=2000, seed=7):
    rng = np.random.default_rng(seed)
    d = np.asarray(a, float) - np.asarray(b, float)
    idx = rng.integers(0, len(d), size=(n, len(d)))
    boots = d[idx].mean(axis=1)
    return d.mean(), np.percentile(boots, 2.5), np.percentile(boots, 97.5)


def main():
    import pandas as pd
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="ml/trips.csv")
    ap.add_argument("--stops-json", required=True)
    ap.add_argument("--window-days", type=int, default=100000, help="default: all history")
    ap.add_argument("--out", help="optional JSON of the aggregates")
    args = ap.parse_args()

    g.WINDOW_DAYS = args.window_days
    P = g.load_pipeline()
    P.load_policies() if hasattr(P, "load_policies") else None
    raw = pd.read_csv(args.csv)
    lib = json.load(open(args.stops_json))

    results = {}
    for name, params in SETTINGS:
        rows, info = run(P, raw, lib, params)
        results[name] = rows
        print(f"{name}: {len(rows)} test trips in {len({r['fold'] for r in rows})} folds")

    ref_name = SETTINGS[0][0]
    ref = results[ref_name]
    folds = sorted({r["fold"] for r in ref})
    out = {"n_rows": len(ref), "folds": len(folds), "settings": {}}
    print(f"\n{'setting':34} {'top-1':>7} {'top-3':>7}  top-1 vs {ref_name} (95% CI)   folds better/same/worse")
    for name, _ in SETTINGS:
        rows = results[name]
        assert [(r["k"], r["fold"]) for r in rows] == [(r["k"], r["fold"]) for r in ref], "rows differ"
        t1 = np.array([r["v5"][0] for r in rows]); t3 = np.array([r["v5"][1] for r in rows])
        r1 = np.array([r["v5"][0] for r in ref])
        diff, lo, hi = paired_boot(t1, r1)
        per_fold = []
        for f in folds:
            m = np.array([r["fold"] == f for r in rows])
            per_fold.append(float(t1[m].mean() - r1[m].mean()))
        b = sum(x > 0 for x in per_fold); s = sum(x == 0 for x in per_fold); w = sum(x < 0 for x in per_fold)
        cmp = "" if name == ref_name else f"{diff*100:+5.1f} pts ({lo*100:+.1f} to {hi*100:+.1f})   {b}/{s}/{w}"
        print(f"{name:34} {t1.mean():7.1%} {t3.mean():7.1%}  {cmp}")
        out["settings"][name] = {"top1": float(t1.mean()), "top3": float(t3.mean()),
                                 "top1_diff": float(diff), "ci": [float(lo), float(hi)],
                                 "folds_better_same_worse": [b, s, w]}
    if args.out:
        json.dump(out, open(args.out, "w"), indent=1)


if __name__ == "__main__":
    main()
