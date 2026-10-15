"""Tests for the end-stop retrain gate (ml/eval_gate.py). Synthetic data only.

Run: python3 -m unittest ml/test_eval_gate.py
"""
import contextlib
import io
import json
import os
import random
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import eval_gate as g  # noqa: E402
import export_trips  # noqa: E402

UTC = timezone.utc
STOPS = [{"name": f"Stop {c}", "aliases": [f"Stop {c} Stn"]} for c in "ABCDEFGH"]


def synthetic_csv(path, n=360, newest=datetime(2026, 9, 30, 12, tzinfo=UTC), seed=1):
    """A commuter: route R at a start stop mostly goes to one end stop."""
    rng = random.Random(seed)
    rows = []
    start0 = newest - timedelta(days=200)
    for i in range(n):
        t = start0 + timedelta(days=200 * i / (n - 1))
        route = rng.choice(["10", "20", "30"])
        start = {"10": "Stop A", "20": "Stop B", "30": "Stop C"}[route]
        end = {"10": "Stop D", "20": "Stop E", "30": "Stop F"}[route] if rng.random() < 0.95 else rng.choice(["Stop G", "Stop H", "Stop D Stn"])
        row = {c: "" for c in export_trips.COLUMNS}
        row.update({
            "trip_id": f"RAWTRIPID{i:05d}", "user_id": "USERX", "route": route, "start_stop": start,
            "end_stop": end, "direction": "", "agency": "TTC", "manually_verified": False,
            "start_time": t.isoformat(), "end_time": (t + timedelta(minutes=20)).isoformat(),
            "duration_min": 20, "day_of_week": t.weekday(), "hour_of_day": t.hour, "minute_of_hour": t.minute,
            "local_day_of_week": t.weekday(), "local_hour": t.hour,
        })
        rows.append(row)
    import csv
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=export_trips.COLUMNS)
        w.writeheader()
        w.writerows(rows)


def doc(rows, n_classes=None):
    return {"rows": rows, "summary": {"n_rows": len(rows)}, "n_classes": n_classes or {"v4": 10, "v5": 10}}


def rows_with(hits, cov=None, base=None, prefix="k"):
    cov = cov if cov is not None else [1] * len(hits)
    base = base if base is not None else [0] * len(hits)
    return [{"k": f"{prefix}{i}", "fold": "2026-09-25", "v4": [h, h, c], "v5": [h, h, c], "base": [b, b, 1]}
            for i, (h, c, b) in enumerate(zip(hits, cov, base))]


class FoldCalendarTest(unittest.TestCase):
    def test_anchor_and_length(self):
        self.assertEqual(g.fold_index(datetime(2026, 5, 1, tzinfo=UTC)), 0)
        self.assertEqual(g.fold_index(datetime(2026, 5, 14, 23, 59, tzinfo=UTC)), 0)
        self.assertEqual(g.fold_index(datetime(2026, 5, 15, tzinfo=UTC)), 1)
        self.assertEqual(g.fold_index(datetime(2026, 4, 30, tzinfo=UTC)), -1)
        self.assertEqual(g.fold_id(g.fold_index(datetime(2026, 10, 14, tzinfo=UTC))), "2026-10-02")

    def test_fold_does_not_depend_on_export_date(self):
        t = datetime(2026, 9, 3, 8, tzinfo=UTC)
        k = g.fold_index(t)
        # The window moves with the export; the fold a trip falls in does not.
        for newest in (datetime(2026, 9, 20, tzinfo=UTC), datetime(2026, 10, 30, tzinfo=UTC)):
            self.assertLess(g.window_start(newest), t)
            self.assertEqual(g.fold_index(t), k)


class PairedRulesTest(unittest.TestCase):
    def test_identical_runs_pass_with_zero_diff(self):
        r = rows_with([1, 0] * 80)
        failures, rep = g.decide(doc(r), doc(r))
        self.assertEqual(failures, [])
        self.assertEqual(rep["path"], "paired")
        self.assertEqual(rep["v4"]["diff"], 0.0)
        self.assertEqual((rep["v4"]["lo"], rep["v4"]["hi"]), (0.0, 0.0))

    def test_ci_upper_below_zero_rejects(self):
        pub = rows_with([1] * 60)
        cand = rows_with([1] * 50 + [0] * 10)  # -16.7 points on 60 rows: under 100, so only the CI rule
        failures, _ = g.decide(doc(cand), doc(pub))
        self.assertTrue(any("CI upper bound" in f for f in failures), failures)
        self.assertFalse(any("dropped" in f and "top-1" in f for f in failures), failures)

    def test_point_drop_over_5_with_100_rows_rejects(self):
        # 6-point net drop with offsetting flips, so the CI still crosses 0 on its own.
        pub = rows_with([1] * 30 + [0] * 30 + [1] * 140)
        cand = rows_with([0] * 30 + [1] * 18 + [0] * 12 + [1] * 140)
        failures, rep = g.decide(doc(cand), doc(pub))
        self.assertAlmostEqual(rep["v4"]["diff"], -0.06)
        self.assertTrue(any("dropped 6.0% on 200 rows" in f for f in failures), failures)

    def test_small_drop_passes(self):
        pub = rows_with([1] * 20 + [0] * 20 + [1] * 160)
        cand = rows_with([0] * 20 + [1] * 16 + [0] * 4 + [1] * 160)  # -2 points
        failures, _ = g.decide(doc(cand), doc(pub))
        self.assertEqual(failures, [])

    def test_coverage_drop_rejects(self):
        pub = rows_with([0] * 200)
        cand = rows_with([0] * 200, cov=[0] * 12 + [1] * 188)
        failures, _ = g.decide(doc(cand), doc(pub))
        self.assertTrue(any("coverage dropped 6.0%" in f for f in failures), failures)

    def test_row_count_collapse_rejects(self):
        pub = rows_with([1] * 200)
        cand = rows_with([1] * 150)  # -25%
        failures, _ = g.decide(doc(cand), doc(pub))
        self.assertTrue(any("eval rows fell from 200 to 150" in f for f in failures), failures)

    def test_class_collapse_rejects(self):
        r = rows_with([1] * 200)
        failures, _ = g.decide(doc(r), doc(r), {"v4": 2, "v5": 10})
        self.assertTrue(any("v4: only 2 end-stop classes" in f for f in failures), failures)

    def test_rows_must_match_on_key_and_fold(self):
        pub = rows_with([1] * 200)
        cand = rows_with([0] * 200)
        for r in cand:
            r["fold"] = "2026-10-09"
        pr = g.paired(cand, pub, "v4")
        self.assertEqual(pr["n"], 0)

    def test_low_overlap_falls_back_to_floors(self):
        pub = rows_with([1] * 200, prefix="old")
        cand = rows_with([1] * 200, base=[1] * 200, prefix="new")
        failures, rep = g.decide(doc(cand), doc(pub))
        self.assertTrue(rep["path"].startswith("floors"), rep["path"])
        self.assertEqual(failures, [])

    def test_other_gate_version_falls_back_to_floors(self):
        r = rows_with([1] * 200, base=[1] * 200)
        pub = dict(doc(rows_with([0] * 200)), gate_version=0)
        failures, rep = g.decide(dict(doc(r), gate_version=1), pub)
        self.assertIn("published gate v0", rep["path"])
        self.assertEqual(failures, [])

    def test_ci_rule_boundary_at_150_rows(self):
        pub = rows_with([1] * 150)
        three = rows_with([0] * 3 + [1] * 147)
        four = rows_with([0] * 4 + [1] * 146)
        self.assertEqual(g.decide(doc(three), doc(pub))[0], [])
        self.assertTrue(g.decide(doc(four), doc(pub))[0])

    def test_bootstrap_is_reproducible(self):
        pub = rows_with([random.Random(i).randint(0, 1) for i in range(150)])
        cand = rows_with([random.Random(i + 7).randint(0, 1) for i in range(150)])
        self.assertEqual(g.paired(cand, pub, "v4"), g.paired(cand, pub, "v4"))


class FirstRunFloorsTest(unittest.TestCase):
    def test_passes_within_5_points_of_baseline(self):
        r = rows_with([1] * 46 + [0] * 54, base=[1] * 50 + [0] * 50)  # 46 vs floor 45
        failures, rep = g.decide(doc(r))
        self.assertEqual(rep["path"], "first-run")
        self.assertEqual(failures, [])

    def test_rejects_below_baseline_floor(self):
        r = rows_with([1] * 44 + [0] * 56, base=[1] * 50 + [0] * 50)  # 44 vs floor 45
        failures, _ = g.decide(doc(r))
        self.assertTrue(any("below floor" in f for f in failures), failures)

    def test_rejects_too_few_rows(self):
        r = rows_with([1] * 49)
        failures, _ = g.decide(doc(r))
        self.assertTrue(any("only 49 eval rows" in f for f in failures), failures)

    def test_rejects_class_collapse(self):
        r = rows_with([1] * 100)
        failures, _ = g.decide(doc(r), None, {"v4": 2, "v5": 2})
        self.assertEqual(sum("end-stop classes" in f for f in failures), 2)


class SaltTest(unittest.TestCase):
    def test_fails_closed_without_a_salt(self):
        with self.assertRaises(g.GateError):
            g.resolve_salt({})

    def test_salt_sources_and_keys(self):
        a = g.resolve_salt({"TRAIN_USER_IDS": "u2, u1"})
        self.assertEqual(a, g.resolve_salt({"TRAIN_USER_IDS": "u1,u2"}))
        self.assertNotIn(b"u1", a)
        self.assertEqual(g.resolve_salt({"EVAL_ROW_SALT": "s", "TRAIN_USER_IDS": "u1"}), b"s")
        k = g.row_key(a, "RAWTRIPID00001")
        self.assertNotIn("RAWTRIPID", k)
        self.assertNotEqual(k, g.row_key(b"other", "RAWTRIPID00001"))
        self.assertEqual(k, g.row_key(a, "RAWTRIPID00001"))


class EndToEndTest(unittest.TestCase):
    """Runs the real pipeline (train_endstop.py) on a synthetic export."""

    def run_gate(self, csv_path, out, extra=(), env=None):
        err, outp = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"EVAL_ROW_SALT": "test-salt"} if env is None else env, clear=False), \
                contextlib.redirect_stderr(err), contextlib.redirect_stdout(outp):
            code = g.main(["--csv", csv_path, "--stops-json", self.stops, "--out", out, "--version", "t", *extra])
        return code, outp.getvalue(), err.getvalue()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.stops = os.path.join(self.dir, "stops.json")
        json.dump(STOPS, open(self.stops, "w"))
        self.csv = os.path.join(self.dir, "trips.csv")
        synthetic_csv(self.csv)

    def tearDown(self):
        self.tmp.cleanup()

    def test_first_run_then_paired_and_no_raw_ids(self):
        out1 = os.path.join(self.dir, "a.json")
        code, stdout, _ = self.run_gate(self.csv, out1)
        self.assertEqual(code, 0, stdout)
        self.assertIn("Path: first-run", stdout)
        text = open(out1).read()
        self.assertNotIn("RAWTRIPID", text)
        self.assertNotIn("USERX", text)
        self.assertNotIn("RAWTRIPID", stdout)
        d = json.loads(text)
        self.assertGreater(len(d["rows"]), 50)
        self.assertTrue(all(set(r) == {"k", "fold", "v4", "v5", "base"} for r in d["rows"]))
        # Same pipeline, same data: every overlapping row agrees.
        out2 = os.path.join(self.dir, "b.json")
        code, stdout, _ = self.run_gate(self.csv, out2, ["--published", out1])
        self.assertEqual(code, 0, stdout)
        self.assertIn("Path: paired", stdout)
        self.assertIn("+0.0% [+0.0%, +0.0%]", stdout)
        # A different salt shares no keys with last week, so the gate falls back to the floors.
        out3 = os.path.join(self.dir, "c.json")
        code, stdout, _ = self.run_gate(self.csv, out3, ["--published", out1], env={"EVAL_ROW_SALT": "rotated"})
        self.assertEqual(code, 0, stdout)
        self.assertIn("Path: floors", stdout)

    def test_rejection_exits_1_and_writes_nothing(self):
        out1 = os.path.join(self.dir, "a.json")
        self.assertEqual(self.run_gate(self.csv, out1)[0], 0)
        pub = json.load(open(out1))
        for r in pub["rows"]:
            r["v4"] = [1, 1, 1]  # published was perfect: the candidate is clearly worse
        json.dump(pub, open(out1, "w"))
        out2 = os.path.join(self.dir, "b.json")
        open(out2, "w").write("stale")
        code, _, err = self.run_gate(self.csv, out2, ["--published", out1])
        self.assertEqual(code, 1)
        self.assertIn("FAILED", err)
        self.assertFalse(os.path.exists(out2))

    def test_internal_error_exits_2_without_leaking_the_message(self):
        out = os.path.join(self.dir, "a.json")
        with mock.patch.object(g, "walk_forward", side_effect=ValueError("Secret Stop Name")):
            code, _, err = self.run_gate(self.csv, out)
        self.assertEqual(code, 2)
        self.assertIn("ValueError", err)
        self.assertNotIn("Secret Stop Name", err)
        self.assertFalse(os.path.exists(out))

    def test_missing_salt_and_bad_input_exit_2(self):
        out = os.path.join(self.dir, "a.json")
        with mock.patch.dict(os.environ, {}, clear=True):
            code, _, err = self.run_gate(self.csv, out, env={})
        self.assertEqual(code, 2)
        self.assertIn("no salt", err)
        code, _, _ = self.run_gate(os.path.join(self.dir, "missing.csv"), out)
        self.assertEqual(code, 2)
        code, _, _ = self.run_gate(self.csv, out, ["--candidate-dir", self.dir])  # no meta files
        self.assertEqual(code, 2)


class FetchPublishedTest(unittest.TestCase):
    class Blob:
        def __init__(self, store, name):
            self.store, self.name = store, name

        def exists(self):
            return self.name in self.store

        def download_as_bytes(self):
            return self.store[self.name]

    class Bucket:
        def __init__(self, store):
            self.store = store

        def blob(self, name):
            return FetchPublishedTest.Blob(self.store, name)

    def test_no_pointer_or_no_rows_is_first_run(self):
        self.assertIsNone(g.fetch_published(self.Bucket({})))
        self.assertIsNone(g.fetch_published(self.Bucket({"models/latest.json": b'{"version": "v1"}'})))

    def test_reads_rows_of_the_pointed_version(self):
        store = {"models/latest.json": b'{"version": "v2"}',
                 "models/v1/eval_rows.json": b'{"rows": [1]}',
                 "models/v2/eval_rows.json": b'{"rows": [2]}'}
        d = g.fetch_published(self.Bucket(store))
        self.assertEqual(d["rows"], [2])
        self.assertEqual(d["model_version"], "v2")


if __name__ == "__main__":
    unittest.main()
