"""Report prediction accuracy from raw predictionStats rows.

The running predictionAccuracy document is telemetry only. This report is the
authoritative view because it can scope results by agency, model, and cohort.
"""

import argparse
import os
from collections import defaultdict

import firebase_admin
from firebase_admin import credentials, firestore


KEY_PATH = os.path.expanduser("~/Desktop/Dev/Credentials/Firebase for Transit Stats.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agency")
    parser.add_argument("--user-id")
    parser.add_argument("--source", default="sms")
    args = parser.parse_args()

    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(KEY_PATH))
    db = firestore.client()

    rows = []
    for doc in db.collection("predictionStats").stream():
        row = doc.to_dict()
        if args.source and row.get("source", "sms") != args.source:
            continue
        if args.agency and str(row.get("agency", "")).strip().lower() != args.agency.strip().lower():
            continue
        if args.user_id and row.get("userId") != args.user_id:
            continue
        rows.append(row)

    groups = defaultdict(lambda: {"hits": 0, "total": 0})
    for row in rows:
        kind = "endstop" if row.get("endStopHit") is not None else "route"
        version = str(row.get("version") or "unknown")
        agency = str(row.get("agency") or "unknown")
        bucket = groups[(kind, version, agency)]
        hit = row.get("endStopHit") if kind == "endstop" else row.get("isHit")
        if hit is None:
            continue
        bucket["total"] += 1
        bucket["hits"] += int(bool(hit))

    print(f"Rows scanned: {len(rows)}")
    print("kind\tversion\tagency\thits\ttotal\taccuracy")
    for (kind, version, agency), counts in sorted(groups.items()):
        if not counts["total"]:
            continue
        accuracy = counts["hits"] / counts["total"]
        print(f"{kind}\t{version}\t{agency}\t{counts['hits']}\t{counts['total']}\t{accuracy:.1%}")


if __name__ == "__main__":
    main()
