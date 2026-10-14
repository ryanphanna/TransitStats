"""Habit engine serving variants (UX options), scored from the same replay row.

- "Served: habit only when V3 abstains": the habit fills V3's gaps but never replaces V3's list.
- "Served: habit first, then V3 list": the habit is shown alongside V3's list (deduped), as top-3.
"""


def _variants(env):
    rp = env["replay"]
    h = rp["habit"]
    v3 = [(p["stop"], p["confidence"]) for p in rp["v3EndTop"]]
    hs = (h["endStop"], 100) if h and h.get("endStop") else None
    canon = env["data"].canon.v3
    only_gap = v3 if v3 else ([hs] if hs else [])
    if hs:
        alongside = [hs] + [p for p in v3 if canon(p[0]) != canon(hs[0])]
    else:
        alongside = v3
    return [
        env["h"].Pred("end", "Served: habit only when V3 abstains", only_gap),
        env["h"].Pred("end", "Served: habit first, then V3 list", alongside[:3]),
    ]


def register(h):
    def predict(env):
        env["h"] = h
        return _variants(env)
    h.register(h.Family("habit_variants", {"end"}, predict))
