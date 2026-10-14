"""Unit tests for the offline eval harness (synthetic data only).

Run: python3 -m unittest ml/eval/test_harness.py
"""
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
import harness  # noqa: E402


def trip(i, start, end_stop="B", **kw):
    s = datetime(2026, 5, 1, tzinfo=timezone.utc) + timedelta(hours=start)
    t = {"_id": f"t{i}", "route": "510", "agency": "TTC", "startStopName": "A", "endStopName": end_stop,
         "direction": "Northbound", "stop_matched": True, "source": "sms",
         "startTime": s.isoformat(), "endTime": (s + timedelta(minutes=20)).isoformat()}
    t.update(kw)
    return t


class FakeData(harness.Data):
    def __init__(self, trips):
        self.trips = trips
        self.canon = harness.Canon([{"name": "Spadina Station", "aliases": ["Spadina Stn"]}])
        for t in self.trips:
            t["_start"], t["_end"] = harness.ts(t.get("startTime")), harness.ts(t.get("endTime"))
        self.completed = sorted([t for t in trips if t["_end"]], key=lambda t: t["_end"], reverse=True)
        self.primary_agency = "TTC"


class HarnessTests(unittest.TestCase):
    def test_serve_history_excludes_future_and_unclean_trips(self):
        trips = [trip(1, 0), trip(2, 1, needs_review=True), trip(3, 2, stop_matched=False), trip(4, 3), trip(5, 10)]
        data = FakeData(trips)
        hist = data.serve_history(trips[3])
        self.assertEqual([t["_id"] for t in hist], ["t1"])

    def test_serve_history_applies_limit_before_filter(self):
        trips = [trip(i, i) for i in range(5)] + [trip(9, 20)]
        trips[3]["discarded"] = True
        data = FakeData(trips)
        # limit 2 takes t4, t3 (newest by endTime), then drops discarded t3.
        self.assertEqual([t["_id"] for t in data.serve_history(trips[-1], limit=2)], ["t4"])

    def test_route_grading_collapses_ttc_variants_only(self):
        self.assertTrue(harness.grade_route("510A", "510", "TTC"))
        self.assertFalse(harness.grade_route("52A", "52", "HSR"))
        self.assertTrue(harness.grade_route("n", "N", "Muni"))

    def test_canonicalization_uses_library_aliases(self):
        canon = harness.Canon([{"name": "Spadina Station", "aliases": ["Spadina Stn"]}])
        self.assertEqual(canon.v3("spadina stn"), canon.v3("Spadina Station"))
        self.assertEqual(canon.ml("King and Bathurst"), "king/bathurst")

    def test_local_time_handles_dst(self):
        t = {"timezone": "America/Toronto"}
        summer = harness.local_time(datetime(2026, 7, 1, 12, tzinfo=timezone.utc), t, "local")
        winter = harness.local_time(datetime(2026, 12, 1, 12, tzinfo=timezone.utc), t, "local")
        self.assertEqual((summer.hour, winter.hour), (8, 7))
        self.assertEqual(harness.local_time(datetime(2026, 7, 1, 2, tzinfo=timezone.utc), t, "utc").weekday(), 2)

    def test_last_monday_retrain(self):
        wed = datetime(2026, 10, 14, 12, tzinfo=timezone.utc)
        self.assertEqual(harness._last_monday_retrain(wed), datetime(2026, 10, 12, 4, tzinfo=timezone.utc))
        early_monday = datetime(2026, 10, 12, 3, tzinfo=timezone.utc)
        self.assertEqual(harness._last_monday_retrain(early_monday), datetime(2026, 10, 5, 4, tzinfo=timezone.utc))

    def test_wilson_and_paired_diff(self):
        lo, hi = harness.wilson(50, 100)
        self.assertLess(lo, 0.5)
        self.assertGreater(hi, 0.5)
        d, dl, dh = harness.paired_diff([1, 1, 0, 1], [0, 1, 0, 0])
        self.assertAlmostEqual(d, 0.5)
        self.assertLessEqual(dl, d)
        self.assertGreaterEqual(dh, d)

    def test_training_filters_use_training_rows_only(self):
        rows = [(trip(i, i), {}, "ttc::x") for i in range(3)] + [(trip(9, 9), {}, "ttc::y")]
        kept = harness.filter_training_rows(FakeData([r[0] for r in rows]), rows, "route", True)
        self.assertEqual({y for _, _, y in kept}, {"ttc::x"})


if __name__ == "__main__":
    unittest.main()
