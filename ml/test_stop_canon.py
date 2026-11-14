"""Agency-first stop canonicalization in the training pipeline (GitHub #405, CIV-1460).

Run: python3 -m unittest ml/test_stop_canon.py
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import pandas as pd  # noqa: E402

import train_endstop  # noqa: E402
from stop_canon import AGENCY_ALIASES, canonical_agency  # noqa: E402

LIB = [
    {"name": "Union Station Patsaouras Bus Plaza", "agency": "LA Metro", "aliases": ["Union Station"]},
    {"name": "Union Station", "agency": "TTC", "agencies": ["GO Transit"], "aliases": ["Union Stn"]},
    {"name": "Kipling Station", "agency": "TTC", "aliases": ["Kipling"]},
]


class StopCanonTest(unittest.TestCase):
    def test_agency_aliases_come_from_the_shared_list(self):
        self.assertEqual(AGENCY_ALIASES["toronto transit commission"], "TTC")
        self.assertEqual(canonical_agency(" go "), "GO Transit")
        self.assertEqual(canonical_agency("Some New Agency"), "Some New Agency")

    def test_trip_agency_wins(self):
        c = train_endstop.canonicalize_stop
        self.assertEqual(c("Union Station", LIB, "TTC"), "union station")
        self.assertEqual(c("Union Station", LIB, "ttc"), "union station")
        self.assertEqual(c("Union Station", LIB, "Toronto Transit Commission"), "union station")
        self.assertEqual(c("Union Station", LIB, "GO Transit"), "union station")
        self.assertEqual(c("Union Station", LIB, "LA Metro"), "union station patsaouras bus plaza")

    def test_falls_back_to_the_first_entry(self):
        c = train_endstop.canonicalize_stop
        self.assertEqual(c("Union Station", LIB), "union station patsaouras bus plaza")
        self.assertEqual(c("Union Station", LIB, float("nan")), "union station patsaouras bus plaza")
        self.assertEqual(c("Kipling", LIB, "MiWay"), "kipling station")
        self.assertEqual(c("Nowhere Rd", LIB, "TTC"), "nowhere rd")
        self.assertEqual(c("", LIB, "TTC"), "unknown")

    def test_clean_uses_each_row_agency(self):
        df = pd.DataFrame([
            {"route": "1", "agency": "TTC", "start_stop": "Kipling", "end_stop": "Union Station",
             "serve_prev_route": "", "serve_last_end_stop": "Union Station", "serve_minutes_since_last_trip": "",
             "local_hour": 8, "local_day_of_week": 1, "direction": "E", "user_id": "u", "start_time": "2026-10-01T12:00:00+00:00"},
            {"route": "J", "agency": "LA Metro", "start_stop": "Union Station", "end_stop": "Union Station",
             "serve_prev_route": "", "serve_last_end_stop": "", "serve_minutes_since_last_trip": "",
             "local_hour": 9, "local_day_of_week": 2, "direction": "N", "user_id": "u", "start_time": "2026-10-02T12:00:00+00:00"},
        ])
        out = train_endstop.clean(df, LIB, apply_filters=False).set_index("agency")
        self.assertEqual(out.loc["TTC", "end_stop"], "union station")
        self.assertEqual(out.loc["TTC", "last_end_stop"], "union station")
        self.assertEqual(out.loc["TTC", "end_stop_key"], "ttc::union station")
        self.assertEqual(out.loc["LA Metro", "start_stop"], "union station patsaouras bus plaza")


if __name__ == "__main__":
    unittest.main()
