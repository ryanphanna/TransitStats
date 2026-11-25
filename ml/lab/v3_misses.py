"""
Why does V3 miss on trips whose start->end pair was ridden before?

Uses the eval harness's rows, canonicalization and history (same definitions as ml/EVAL.md) and the
serving replay. Prints aggregate counts only; record findings in Linear, not in the repo.

Usage (from the repo root, after the harness inputs exist under ml/artifacts/):
    ml/.venv/bin/python ml/lab/v3_misses.py --trips ml/artifacts/trips_full.jsonl \
        --stops ml/artifacts/stops.json --replay ml/artifacts/replay_UTC.jsonl
"""

import argparse
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "eval"))
import harness as h  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trips", required=True)
    ap.add_argument("--stops", required=True)
    ap.add_argument("--replay", required=True)
    args = ap.parse_args()

    h.load_policies()
    data = h.Data(args.trips, args.stops)
    data.clean_rows = [t for t in data.trips if h.is_clean(t) and t["_start"]]
    replay = {r["id"]: r for r in map(json.loads, open(args.replay))}
    rows = [t for t in data.trips if t.get("source") in h.EVAL_SOURCES and t["_start"] and t["_end"]
            and h.EVAL_START <= t["_start"] < h.EVAL_END and h.is_clean(t) and t["_id"] in replay]

    canon = lambda name, t: data.canon.v3(name, t.get("agency"))
    bucket = lambda t: (h.local_time(t["_start"], t, "local").hour // 3, h.local_time(t["_start"], t, "local").weekday() >= 5)
    c = Counter()
    for t in rows:
        start, actual = canon(h.start_stop_of(t), t), canon(h.end_stop_of(t), t)
        past = [x for x in h._full_history(data, t) if canon(h.start_stop_of(x), x) == start]
        dests = Counter(canon(h.end_stop_of(x), x) for x in past)
        if actual not in dests:
            continue
        c["repeat"] += 1
        top = [canon(p["stop"], t) for p in replay[t["_id"]]["v3EndTop"]]
        if top[:1] == [actual]:
            c["hit"] += 1
            continue
        c["miss"] += 1
        if not top:
            c["miss: V3 gave no guess"] += 1
            continue
        if actual in top[:3]:
            c["miss: right answer was V3's #2 or #3"] += 1
        c["miss: V3's pick " + ("was another past destination from this stop" if top[0] in dests
                                else "was never reached from this stop")] += 1
        c[f"miss: stop had {'1' if len(dests) == 1 else '2-3' if len(dests) <= 3 else '4+'} past destinations"] += 1
        if dests.most_common(1)[0][0] == actual:
            c["miss: right answer was this stop's most frequent destination"] += 1
        def came_from(x):
            ctx = h.serve_context(data, x)
            prev = ctx["hist"][0] if ctx["hist"] else None
            if not prev or ctx["gap"] is None or ctx["gap"] > 180:
                return None
            return canon(h.start_stop_of(prev), prev)
        cf = came_from(t)
        same_from = Counter(canon(h.end_stop_of(x), x) for x in past if cf and came_from(x) == cf)
        if same_from and same_from.most_common(1)[0][0] == actual:
            c["miss: right answer was most frequent at this stop after coming from the same place (<3h)"] += 1
        route = h.route_base_for_grading(t.get("route"))
        same_route = Counter(canon(h.end_stop_of(x), x) for x in past if h.route_base_for_grading(x.get("route")) == route)
        if same_route and same_route.most_common(1)[0][0] == actual:
            c["miss: right answer was most frequent at this stop on this route"] += 1
        same_time = Counter(canon(h.end_stop_of(x), x) for x in past if bucket(x) == bucket(t))
        if same_time and same_time.most_common(1)[0][0] == actual:
            c["miss: right answer was most frequent at this stop in this 3h slot (weekday/weekend)"] += 1

    print(f"repeat trips: {c['repeat']}, V3 top-1 hits: {c['hit']}, misses: {c['miss']}")
    for k, v in sorted(c.items()):
        if k.startswith("miss:"):
            print(f"  {v:4d}  ({v / c['miss']:.0%})  {k[6:]}")


if __name__ == "__main__":
    main()
