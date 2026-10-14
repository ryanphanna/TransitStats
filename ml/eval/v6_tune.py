#!/usr/bin/env python3
"""Tune V6 backoff (level order, min support, recency half-life) and the rerank's C on eval rows
BEFORE the last 90 days only, then print last-90-day checks the harness table does not show:
candidate recall (rerank ceiling) and paired diffs vs "V3, else B3 full".

Aggregates only. Usage:
  python3 ml/eval/v6_tune.py --trips <snap>/trips_full.jsonl --stops <snap>/stops.json --replay <snap>/replay_UTC.jsonl
"""
import argparse
import importlib.util
import json
import os
import sys
from datetime import timedelta

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)
import harness as h  # noqa: E402

spec = importlib.util.spec_from_file_location("v6mod", os.path.join(HERE, "predictors", "v6.py"))
v6mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v6mod)

R, S, D = ("route", "start"), ("route", "start", "dir"), ("route", "start", "dir")
END_ORDERS = {
    "original": v6mod.END_LEVELS_ORIGINAL,
    "original, no gap": [lv for lv in v6mod.END_LEVELS_ORIGINAL if "gap" not in lv],
    "B3 parity (route+start x 3h x day -> route+start -> agency)": [R + ("hb", "day"), R, ()],
    "dir x time -> dir -> route+start": [D + ("hb", "day"), D, R + ("hb", "day"), R, ("start",), ("route",), ()],
    "prev_end first": [D + ("prev_end", "hb", "day"), D + ("prev_end",), D + ("hb", "day"), D, R, ("start", "prev_route"), ("route",), ()],
    "prev_end, no dir": [R + ("prev_end", "hb", "day"), R + ("prev_end",), R + ("hb", "day"), R, ("route",), ()],
    "time then prev_end": [D + ("hb", "day"), D + ("prev_end",), D, R + ("hb", "day"), R, ("route",), ()],
}
ROUTE_ORDERS = {
    "original": v6mod.ROUTE_LEVELS_ORIGINAL,
    "start x time -> start": [("start", "hb", "day"), ("start",), ("prev_route",), ()],
    "start x prev_end x time": [("start", "prev_end", "hb", "day"), ("start", "prev_end"), ("start", "hb", "day"), ("start",), ()],
    "start x prev_route x time": [("start", "prev_route", "hb", "day"), ("start", "prev_route"), ("start", "hb", "day"), ("start",), ()],
}
SUPPORTS = (1, 2, 3, 5)
HALFLIVES = (25, 50, 100, 200, None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trips", required=True)
    ap.add_argument("--stops", required=True)
    ap.add_argument("--replay", required=True)
    ap.add_argument("--compare-only", action="store_true", help="skip the grid; print last-90d paired checks")
    args = ap.parse_args()
    h.load_policies()
    data = h.Data(args.trips, args.stops)
    data.clean_rows = [t for t in data.trips if h.is_clean(t) and t["_start"]]
    replay = {r["id"]: r for r in map(json.loads, open(args.replay))}
    rows = sorted([t for t in data.trips if t.get("source") in h.EVAL_SOURCES and t["_start"]
                   and h.EVAL_START <= t["_start"] < h.EVAL_END and t["_end"] and h.is_clean(t)
                   and t["_id"] in replay], key=lambda t: t["_start"])
    cut90 = h.EVAL_END - timedelta(days=90)
    tune = [t for t in rows if t["_start"] < cut90]
    last = [t for t in rows if t["_start"] >= cut90]
    print(f"rows={len(rows)} tune={len(tune)} last90={len(last)}")
    v6 = v6mod.V6(h, data)
    c = data.canon

    def hit(kind, t, ranked, k=1):
        if kind == "end":
            a = c.v3(h.end_stop_of(t))
            return any(c.v3(p) == a for p, _ in ranked[:k])
        return any(h.grade_route(p, t.get("route"), t.get("agency")) for p, _ in ranked[:k])

    if args.compare_only:
        return compare(v6, replay, rows, last, hit)
    best = {}
    for kind, orders in (("end", END_ORDERS), ("route", ROUTE_ORDERS)):
        for view in ("full", "serve"):
            res = []
            for oname, levels in orders.items():
                for ms in SUPPORTS:
                    for hl in HALFLIVES:
                        cfg = {"levels": levels, "min_support": ms, "halflife": hl}
                        k1 = sum(hit(kind, t, v6.backoff(t, view, cfg, label=kind, depth=3)[0]) for t in tune)
                        res.append((k1 / len(tune), oname, ms, hl))
            res.sort(key=lambda r: -r[0])
            print(f"\n[{kind} / {view} history] top-1 on tune rows (n={len(tune)}), best 8:")
            for r in res[:8]:
                print(f"  {r[0]:.1%}  order={r[1]!r} min_support={r[2]} halflife={r[3]}")
            par = [r for r in res if r[1].startswith("B3 parity") and r[2] == 1 and r[3] == 100]
            if par:
                print(f"  parity config (support 1, half-life 100): {par[0][0]:.1%}")
            best[(kind, view)] = res[0]

    # Rerank C, walk-forward on tune folds only.
    folds, s = [], h.EVAL_START
    while s < h.EVAL_END:
        folds.append((s, min(s + timedelta(days=h.FOLD_DAYS), h.EVAL_END)))
        s += timedelta(days=h.FOLD_DAYS)
    rr = v6mod.Reranker(v6, replay)
    print("\n[rerank] C on tune rows (walk-forward):")
    for C in (0.1, 0.3, 1.0, 3.0, 10.0):
        k = 0
        for fs, fe in folds:
            fr = [t for t in tune if fs <= t["_start"] < fe]
            if not fr:
                continue
            m = rr.fit(fs, C=C)
            k += sum(hit("end", t, rr.predict(m, t)) for t in fr)
        print(f"  C={C}: {k / len(tune):.1%}")

    # Ceiling: candidate recall on last 90d.
    def recall(ts_):
        return sum(any(key == c.v3(h.end_stop_of(t)) for key, _, _ in rr.cands(t)) for t in ts_) / len(ts_)
    sizes = [len(rr.cands(t)) for t in last]
    print(f"\n[rerank] candidate recall: tune {recall(tune):.1%}, last90 {recall(last):.1%}; "
          f"mean candidates {sum(sizes) / len(sizes):.1f}")



def compare(v6, replay, rows, last, hit):
    """Paired last-90d top-1 diffs vs "V3, else B3 full" (the harness only diffs vs V3 and B3 full)."""
    folds, s = [], h.EVAL_START
    while s < h.EVAL_END:
        folds.append((s, min(s + timedelta(days=h.FOLD_DAYS), h.EVAL_END)))
        s += timedelta(days=h.FOLD_DAYS)
    rr = v6mod.Reranker(v6, replay)
    preds = {"V6 rerank": {}, "V6 backoff, tuned (full)": {}, "V3, else B3 full": {}, "B3 full": {}}
    for fs, fe in folds:
        fr = [t for t in last if fs <= t["_start"] < fe]
        if not fr:
            continue
        m = rr.fit(fs)
        for t in fr:
            full = h._full_history(v6.data, t)
            b3 = h.baseline_predict(v6.data, t, "end", "local", full)["B3 stop x time, decayed"]
            v3 = [(p["stop"], p["confidence"]) for p in replay[t["_id"]]["v3EndTop"]]
            preds["V6 rerank"][t["_id"]] = rr.predict(m, t)
            preds["V6 backoff, tuned (full)"][t["_id"]] = v6.backoff(t, "full", v6mod.CONFIG[("end", "full")], depth=3)[0]
            preds["V3, else B3 full"][t["_id"]] = v3 if v3 else b3
            preds["B3 full"][t["_id"]] = b3
    hits = {n: [int(hit("end", t, p[t["_id"]])) for t in last] for n, p in preds.items()}
    for n in ("V6 rerank", "V6 backoff, tuned (full)"):
        for ref in ("V3, else B3 full", "B3 full"):
            d, lo, hi = h.paired_diff(hits[n], hits[ref])
            print(f"last90 n={len(last)}  {n} vs {ref}: {d * 100:+.1f} [{lo * 100:+.1f}, {hi * 100:+.1f}]  "
                  f"({sum(hits[n]) / len(last):.1%} vs {sum(hits[ref]) / len(last):.1%})")


if __name__ == "__main__":
    main()
