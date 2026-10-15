#!/usr/bin/env python3
"""Print top-1 on rows before the last 90 days (selection slice) and on the last 90 days, from a harness --out JSON."""
import json, sys
s = json.load(open(sys.argv[1]))
task = sys.argv[2] if len(sys.argv) > 2 else "end"
rows = []
for name, m in s["tasks"][task].items():
    a = m["segments"].get("last90:False", {}); b = m["segments"].get("last90:True", {})
    rows.append((a.get("top1", 0), b.get("top1", 0), m["coverage"], name))
for a, b, c, n in sorted(rows, reverse=True):
    print(f"{n:55s} pre90 {a:6.1%}  last90 {b:6.1%}  cover {c:6.1%}")
