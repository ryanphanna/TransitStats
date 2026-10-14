"""Score extra V3 replays (history window / CONFIG / version experiments) side by side.

Set V3_VARIANTS="label=path/to/replay.jsonl;label2=path2" (replays from replay_js.js).
Each label yields "V3 <label>" and "V3 <label>, else B3 on full history" for route and end.
No-op when V3_VARIANTS is unset.
"""
import json
import os

_VARIANTS = []
for spec in filter(None, os.environ.get("V3_VARIANTS", "").split(";")):
    label, path = spec.split("=", 1)
    _VARIANTS.append((label, {r["id"]: r for r in map(json.loads, open(path))}))


def _predict(h):
    def predict(env):
        tid = env["trip"]["_id"]
        out = []
        for label, rows in _VARIANTS:
            rr = rows.get(tid)
            if rr is None:
                continue
            r3 = rr["v3Route"]
            ranked = {"route": [(r3["route"], r3["confidence"])] if r3 else [],
                      "end": [(p["stop"], p["confidence"]) for p in rr["v3EndTop"]]}
            for kind in env["tasks"]:
                name = f"V3 {label}"
                out.append(h.Pred(kind, name, ranked[kind]))
                b3 = env["so_far"].get((kind, "B3 on full history"))
                if b3 is not None:
                    out.append(h.Pred(kind, name + ", else B3 full", ranked[kind] or b3))
        return out
    return predict


def register(h):
    if _VARIANTS:
        h.register(h.Family("v3var", {"route", "end"}, _predict(h)))
