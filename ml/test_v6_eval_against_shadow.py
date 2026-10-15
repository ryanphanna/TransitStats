import argparse
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import v6_eval_against_shadow as evaluator
from route_normalization import configure_from_dict, reset_policies


# Synthetic topology with the same shape as functions/lib/topology.json (no real stop names):
# a plain line, a line with "Station"-suffix aliases, and a surface route with directional platforms.
SYNTH_TOPOLOGY = {
    "lines": {
        "1": {
            "name": "Line One", "network": "TTC",
            "direction_order": {"forward": "Southbound", "reverse": "Northbound"},
            "stops": ["Kilo", "Bravo", "Charlie"],
        },
        "2": {
            "name": "Line Two", "network": "TTC",
            "direction_order": {"forward": "Eastbound", "reverse": "Westbound"},
            "stops": ["Echo", "Delta"],
        },
        "510": {
            "name": "Surface Line", "network": "TTC",
            "route_aliases": ["510A", "510B"],
            "direction_order": {"forward": "Southbound", "reverse": "Northbound"},
            "stops": ["Bravo Station", "First Ave at Main St", "Harbour Rd at Pier Ave"],
            "directional_stops": {
                "First Ave at Main St": [
                    {"name": "First Ave at Main St", "aliases": ["First / Main", "Main / First"], "directions": ["Northbound"]},
                    {"name": "First Ave at Main St South Side", "aliases": ["First / Main", "Main / First"], "directions": ["Southbound"]},
                ],
                "Harbour Rd at Pier Ave": [
                    {"name": "Pier Ave at Harbour Rd North Side", "aliases": ["Harbour Rd at Pier Ave", "Pier / Harbour"], "directions": ["Northbound"]},
                    {"name": "Harbour Rd at Pier Ave East Side", "aliases": ["Harbour Rd at Pier Ave", "Pier / Harbour"], "directions": ["Southbound"]},
                ],
            },
        },
    },
}


def trip(trip_id, route, start_stop, end_stop, minute, direction="Southbound", user_id="u1"):
    return evaluator.TripRow(
        trip_id=trip_id,
        user_id=user_id,
        route=route,
        agency="TTC",
        direction=direction,
        start_stop=start_stop,
        end_stop=end_stop,
        start_time=datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc) + timedelta(minutes=minute),
        raw={},
    )


def args(min_bucket=2):
    return argparse.Namespace(agency="TTC", min_bucket=min_bucket)


class V6EvalAgainstShadowTest(unittest.TestCase):
    def setUp(self):
        reset_policies()
        configure_from_dict({"PRIMARY": "collapse", "DEFAULT": "preserve_variant"})
        patcher = mock.patch.object(evaluator, "load_topology", return_value=SYNTH_TOPOLOGY)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_route_baseline_uses_prior_sequence_without_leaking_current_trip(self):
        trips = {
            "a1": trip("a1", "1", "Kilo", "Bravo Station", 1),
            "a2": trip("a2", "510", "Bravo Station", "Harbour Loop", 2),
            "b1": trip("b1", "1", "Kilo", "Bravo Station", 3),
            "b2": trip("b2", "510", "Bravo Station", "Harbour Loop", 4),
            "c1": trip("c1", "1", "Kilo", "Bravo Station", 5),
            "c2": trip("c2", "510", "Bravo Station", "Harbour Loop", 6),
            "d1": trip("d1", "1", "Kilo", "Bravo Station", 7),
            "eval": trip("eval", "510", "Bravo Station", "Harbour Loop", 8),
        }

        predictions = evaluator.evaluate_v6_route(trips, ["eval"], args())

        self.assertEqual(predictions["eval"].predicted, "510")
        self.assertTrue(predictions["eval"].hit)
        self.assertEqual(predictions["eval"].strategy, "start_stop+prev_route+prev_end+hour+day")
        self.assertEqual(predictions["eval"].confidence, 1.0)

    def test_route_baseline_does_not_use_future_trips_to_satisfy_bucket(self):
        trips = {
            "eval": trip("eval", "510", "Bravo Station", "Harbour Loop", 1),
            "future1": trip("future1", "510", "Bravo Station", "Harbour Loop", 2),
            "future2": trip("future2", "510", "Bravo Station", "Harbour Loop", 3),
        }

        predictions = evaluator.evaluate_v6_route(trips, ["eval"], args())

        self.assertNotIn("eval", predictions)

    def test_endstop_baseline_uses_route_start_direction_previous_route_context(self):
        trips = {
            "a1": trip("a1", "1", "Kilo", "Bravo Station", 1),
            "a2": trip("a2", "510", "Bravo Station", "Harbour Rd at Pier Ave East Side", 2),
            "b1": trip("b1", "1", "Kilo", "Bravo Station", 3),
            "b2": trip("b2", "510", "Bravo Station", "Harbour Rd at Pier Ave East Side", 4),
            "c1": trip("c1", "1", "Kilo", "Bravo Station", 5),
            "c2": trip("c2", "510", "Bravo Station", "Harbour Rd at Pier Ave East Side", 6),
            "d1": trip("d1", "1", "Kilo", "Bravo Station", 7),
            "eval": trip("eval", "510", "Bravo Station", "Harbour Rd at Pier Ave East Side", 8),
        }

        predictions = evaluator.evaluate_v6_endstop(trips, ["eval"], args())

        self.assertEqual(predictions["eval"].predicted, "harbour rd/pier ave east side")
        self.assertTrue(predictions["eval"].hit)
        self.assertEqual(predictions["eval"].strategy, "route+start_stop+direction+prev_route+prev_end+gap+hour+day")

    def test_endstop_baseline_filters_candidates_to_topology_legal_stops(self):
        trips = {
            "illegal1": trip("illegal1", "510", "Bravo Station", "Kilo", 1),
            "illegal2": trip("illegal2", "510", "Bravo Station", "Kilo", 2),
            "illegal3": trip("illegal3", "510", "Bravo Station", "Kilo", 3),
            "legal1": trip("legal1", "510", "Bravo Station", "Harbour Rd at Pier Ave East Side", 4),
            "legal2": trip("legal2", "510", "Bravo Station", "Harbour Rd at Pier Ave East Side", 5),
            "eval": trip("eval", "510", "Bravo Station", "Harbour Rd at Pier Ave East Side", 6),
        }

        predictions = evaluator.evaluate_v6_endstop(trips, ["eval"], args())

        self.assertEqual(predictions["eval"].predicted, "harbour rd/pier ave east side")
        self.assertTrue(predictions["eval"].hit)
        self.assertNotEqual(predictions["eval"].predicted, "kilo")

    def test_topology_legal_endstops_uses_directional_510_platform_labels(self):
        topology = SYNTH_TOPOLOGY

        legal = evaluator.topology_legal_endstops(topology, "510", "Bravo Station", "Southbound", "TTC")

        self.assertIn("harbour rd/pier ave east side", legal)
        self.assertNotIn("kilo", legal)

    def test_topology_canonical_stop_collapses_station_suffix_aliases(self):
        topology = SYNTH_TOPOLOGY

        self.assertEqual(
            evaluator.topology_canonical_stop(topology, "1", "Charlie Station", "Southbound", "TTC"),
            "charlie",
        )
        self.assertEqual(
            evaluator.topology_canonical_stop(topology, "2", "Delta Station", "Westbound", "TTC"),
            "delta",
        )

    def test_topology_canonical_stop_keeps_directional_platforms_distinct(self):
        topology = SYNTH_TOPOLOGY

        self.assertEqual(
            evaluator.topology_canonical_stop(topology, "510", "First Ave at Main St", "Southbound", "TTC"),
            "first ave/main st",
        )
        self.assertEqual(
            evaluator.topology_canonical_stop(topology, "510", "First Ave at Main St South Side", "Southbound", "TTC"),
            "first ave/main st south side",
        )

    def test_gap_bucket_separates_transfer_and_separate_patterns(self):
        self.assertEqual(
            evaluator.gap_bucket(
                datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc),
                datetime(2026, 7, 15, 12, 20, tzinfo=timezone.utc),
            ),
            "transfer",
        )
        self.assertEqual(
            evaluator.gap_bucket(
                datetime(2026, 7, 15, 8, 0, tzinfo=timezone.utc),
                datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc),
            ),
            "separate",
        )

    def test_endstop_baseline_uses_gap_context_when_supported(self):
        trips = {
            "transfer_prev1": trip("transfer_prev1", "1", "Kilo", "Bravo Station", 0),
            "transfer_end1": trip("transfer_end1", "510", "Bravo Station", "Harbour Rd at Pier Ave East Side", 10),
            "transfer_prev2": trip("transfer_prev2", "1", "Kilo", "Bravo Station", 20),
            "transfer_end2": trip("transfer_end2", "510", "Bravo Station", "Harbour Rd at Pier Ave East Side", 30),
            "separate_prev1": trip("separate_prev1", "1", "Kilo", "Bravo Station", 40),
            "separate_end1": trip("separate_end1", "510", "Bravo Station", "First Ave at Main St South Side", 180),
            "separate_prev2": trip("separate_prev2", "1", "Kilo", "Bravo Station", 181),
            "separate_end2": trip("separate_end2", "510", "Bravo Station", "First Ave at Main St South Side", 320),
            "eval_prev": trip("eval_prev", "1", "Kilo", "Bravo Station", 321),
            "eval": trip("eval", "510", "Bravo Station", "Harbour Rd at Pier Ave East Side", 330),
        }

        predictions = evaluator.evaluate_v6_endstop(trips, ["eval"], args())

        self.assertEqual(predictions["eval"].predicted, "harbour rd/pier ave east side")
        self.assertTrue(predictions["eval"].hit)
        self.assertIn("+gap", predictions["eval"].strategy)

    def test_ladder_marks_equal_accuracy_as_fail(self):
        summary = {
            "V3": {"hits": 2, "total": 4, "accuracy": 0.5},
            "V4": {"hits": 2, "total": 4, "accuracy": 0.5},
            "V5": {"hits": 3, "total": 4, "accuracy": 0.75},
        }

        rows = evaluator.ladder(summary, ["V3", "V4", "V5"])

        self.assertEqual(rows[0]["status"], "FAIL")
        self.assertEqual(rows[1]["status"], "PASS")

    def test_clean_trip_rejects_correction_blocked_trip(self):
        parsed_args = argparse.Namespace(user_id="u1", agency="TTC")
        row = evaluator.clean_trip("bad", {
            "userId": "u1",
            "agency": "TTC",
            "route": "510",
            "direction": "Southbound",
            "startStopName": "Bravo Station",
            "endStopName": "Harbour Loop",
            "startTime": datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc),
            "endTime": datetime(2026, 7, 15, 12, 10, tzinfo=timezone.utc),
            "stop_matched": True,
            "correctedFields": ["route"],
        }, parsed_args, since=None)

        self.assertIsNone(row)


if __name__ == "__main__":
    unittest.main()
