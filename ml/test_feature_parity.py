"""Training-side half of the V4/V5 END-STOP feature-parity check.

export_trips.build_rows -> train_endstop.clean -> build_features must produce exactly the features stored
in feature_parity_fixture.json. functions/test_ml_feature_parity.js checks that serving
(ml_utils.buildEndStopFeatures) produces the same ones from the same trips.

Run:    python3 -m unittest ml/test_feature_parity.py
Regen:  python3 ml/test_feature_parity.py --regen   (only after an intended feature change; the JS
        test must then pass against the new fixture too)
"""
import csv
import io
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import pandas as pd  # noqa: E402

import export_trips  # noqa: E402
import train_endstop  # noqa: E402
from route_normalization import configure_from_dict  # noqa: E402

FIXTURE = os.path.join(HERE, "feature_parity_fixture.json")


def training_features(fx):
    configure_from_dict(fx["policies"])
    rows, _ = export_trips.build_rows((t["_id"], t) for t in fx["trips"])
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=export_trips.COLUMNS)
    w.writeheader()
    w.writerows(rows)
    buf.seek(0)
    df = pd.read_csv(buf)
    out = {}
    c = train_endstop.clean(df, fx["stops"], apply_filters=False)
    X = train_endstop.build_features(c)
    for idx, row in c.iterrows():
        out[row["trip_id"]] = {k: round(float(v), 6) for k, v in X.loc[idx].items() if float(v) != 0.0}
    return out


class FeatureParityTest(unittest.TestCase):
    def test_training_features_match_fixture(self):
        fx = json.load(open(FIXTURE))
        self.assertTrue(fx["expected"], "fixture has no expected features; run with --regen")
        self.assertEqual(training_features(fx), fx["expected"])


if __name__ == "__main__":
    if "--regen" in sys.argv:
        fx = json.load(open(FIXTURE))
        fx["expected"] = training_features(fx)
        json.dump(fx, open(FIXTURE, "w"), indent=1, sort_keys=False)
        print(f"wrote expected features for {len(fx['expected'])} trips")
    else:
        unittest.main()
