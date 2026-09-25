"""Repair completed trips whose two stops now have unique library matches.

This is intentionally conservative. It never invents a stop, changes trip stop
text or codes, or touches incomplete/flagged trips. It only confirms the
derived stop_matched flag when both endpoints have unique library matches.

Usage:
    python ml/repair_exact_stop_matches.py          # dry run
    python ml/repair_exact_stop_matches.py --apply  # write safe repairs
"""

import argparse
import os
import re

import firebase_admin
from firebase_admin import credentials, firestore


PROJECT_ID = os.environ.get("TRANSITSTATS_PROJECT_ID", "transitstats-21ba4")
KEY_PATH = os.path.expanduser(
    "~/Desktop/Dev/Credentials/Firebase for Transit Stats.json"
)


def normalize(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def stop_matches_trip(stop, trip_agency):
    stop_agency = str(stop.get("agency") or "").strip().lower()
    trip_agency = str(trip_agency or "").strip().lower()
    return not trip_agency or not stop_agency or trip_agency == stop_agency


def index_stops(stops):
    by_name = {}
    by_code = {}
    for stop in stops:
        for name in [stop.get("name"), *(stop.get("aliases") or [])]:
            key = normalize(name)
            if key:
                by_name.setdefault(key, []).append(stop)
        if stop.get("code"):
            by_code.setdefault(str(stop["code"]), []).append(stop)
    return by_name, by_code


def find_unique_stop(trip, role, by_name, by_code):
    name_key = "startStopName" if role == "start" else "endStopName"
    legacy_key = "startStop" if role == "start" else "endStop"
    code_key = "startStopCode" if role == "start" else "endStopCode"
    raw_name = trip.get(name_key) or trip.get(legacy_key)
    raw_code = trip.get(code_key)
    candidates = by_code.get(str(raw_code), []) if raw_code else by_name.get(normalize(raw_name), [])
    candidates = [s for s in candidates if stop_matches_trip(s, trip.get("agency"))]
    return candidates[0] if len(candidates) == 1 else None


def is_completed_candidate(trip):
    if not trip.get("endTime"):
        return False
    if trip.get("stop_matched") is not None:
        return not bool(trip.get("stop_matched")) or not (trip.get("startStopName") or trip.get("startStop")) or not (trip.get("endStopName") or trip.get("endStop"))
    return not bool(trip.get("verified")) or not (trip.get("startStopName") or trip.get("startStop")) or not (trip.get("endStopName") or trip.get("endStop"))


def is_blocked(trip):
    if trip.get("discarded") or trip.get("incomplete") or trip.get("needs_review"):
        return True
    if trip.get("exclude_from_training") or trip.get("exclude_from_accuracy") or trip.get("needs_reprocess"):
        return True
    return bool(set(trip.get("correctedFields") or []) & {
        "route", "direction", "agency", "startStop", "startStopCode",
        "startStopName", "endStop", "endStopCode", "endStopName",
    })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="write repairs to Firestore")
    args = parser.parse_args()

    if not os.path.exists(KEY_PATH):
        raise SystemExit(f"Service account key not found at {KEY_PATH}")

    app = firebase_admin.initialize_app(
        credentials.Certificate(KEY_PATH), {"projectId": PROJECT_ID}
    )
    db = firestore.client(app=app)
    stops = [{**doc.to_dict(), "_id": doc.id} for doc in db.collection("stops").stream()]
    by_name, by_code = index_stops(stops)

    candidates = []
    for doc in db.collection("trips").stream():
        trip = doc.to_dict()
        if not is_completed_candidate(trip) or is_blocked(trip):
            continue
        start = find_unique_stop(trip, "start", by_name, by_code)
        end = find_unique_stop(trip, "end", by_name, by_code)
        missing_start = not (trip.get("startStopName") or trip.get("startStop"))
        missing_end = not (trip.get("endStopName") or trip.get("endStop"))
        if start and end and (missing_start or missing_end or not (trip.get("stop_matched") if trip.get("stop_matched") is not None else trip.get("verified"))):
            candidates.append((doc, trip, start, end))

    print(f"Found {len(candidates)} unambiguous completed trip repairs.")
    if not args.apply:
        for doc, trip, start, end in candidates:
            print(f"  {doc.id}: {trip.get('route', '')} -> {start.get('name')} / {end.get('name')}")
        print("Dry run only. Re-run with --apply to write these repairs.")
        return

    batch = db.batch()
    for doc, _trip, start, end in candidates:
        batch.update(doc.reference, {"stop_matched": True})
    if candidates:
        batch.commit()
    print(f"Applied {len(candidates)} repairs.")


if __name__ == "__main__":
    main()
