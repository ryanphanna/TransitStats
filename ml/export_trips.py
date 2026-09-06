"""
TransitStats — Trip Export Script
Pulls completed trip history from Firestore and writes a CSV for ML training.

Usage:
    pip install firebase-admin pandas
    python ml/export_trips.py

Output: ml/trips.csv
"""

import csv
import os
import sys
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import credentials, firestore

# --- Config ---
PROJECT_ID = os.environ.get("TRANSITSTATS_PROJECT_ID", "transitstats-21ba4")
KEY_PATH = os.path.expanduser(
    "~/Desktop/Dev/Credentials/Firebase for Transit Stats.json"
)
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "trips.csv")

COLUMNS = [
    "trip_id",
    "user_id",
    "route",
    "prev_route",
    "prev_agency",
    "start_stop",
    "end_stop",
    "direction",
    "agency",
    "manually_verified",
    "start_time",       # ISO 8601
    "end_time",         # ISO 8601
    "duration_min",     # minutes
    "day_of_week",      # 0 = Monday … 6 = Sunday
    "hour_of_day",      # 0–23
    "minute_of_hour",   # 0–59
    "minutes_since_last_trip",
    "journey_id",       # for multi-leg trips
]


def parse_timestamp(val):
    """Handle Firestore Timestamps, datetime objects, and ISO strings."""
    if val is None:
        return None
    if hasattr(val, "tzinfo"):      # already a datetime
        return val.replace(tzinfo=timezone.utc) if val.tzinfo is None else val
    if hasattr(val, "seconds"):     # Firestore Timestamp object
        return datetime.fromtimestamp(val.seconds, tz=timezone.utc)
    try:
        return datetime.fromisoformat(str(val))
    except Exception:
        return None


def is_stop_matched(trip):
    """Backward-compatible stop-match check during the verified→stop_matched rename."""
    if trip.get("stop_matched") is not None:
        return bool(trip.get("stop_matched"))
    return bool(trip.get("verified"))


def has_blocking_correction(trip):
    """Exclude high-impact corrected trips until they are explicitly reprocessed."""
    if trip.get("exclude_from_training") or trip.get("exclude_from_accuracy") or trip.get("needs_reprocess"):
        return True
    corrected_fields = trip.get("correctedFields") or []
    high_impact = {
        "route",
        "direction",
        "agency",
        "startStop",
        "startStopCode",
        "startStopName",
        "endStop",
        "endStopCode",
        "endStopName",
    }
    return any(field in high_impact for field in corrected_fields)


def main():
    if not os.path.exists(KEY_PATH):
        print(f"ERROR: Service account key not found at {KEY_PATH}")
        sys.exit(1)

    cred = credentials.Certificate(KEY_PATH)
    app = firebase_admin.initialize_app(cred, {"projectId": PROJECT_ID})
    db = firestore.client(app=app)

    print("Fetching trips from Firestore...")
    docs = db.collection("trips").stream()

    rows = []
    skipped = 0

    for doc in docs:
        d = doc.to_dict()

        # Only use completed, trusted trips for training.
        has_end_stop = d.get("endStopName") or d.get("endStop")
        if (
            not d.get("endTime")
            or not has_end_stop
            or d.get("discarded")
            or d.get("incomplete")
            or d.get("needs_review")
            or has_blocking_correction(d)
            or not is_stop_matched(d)
        ):
            skipped += 1
            continue

        # Need at minimum route + start stop to be useful for training
        if not d.get("route") or not (d.get("startStop") or d.get("startStopName")):
            skipped += 1
            continue

        start_dt = parse_timestamp(d.get("startTime"))
        end_dt   = parse_timestamp(d.get("endTime"))

        if start_dt is None:
            skipped += 1
            continue

        duration = d.get("duration")
        if duration is None and end_dt is not None:
            duration = round((end_dt - start_dt).total_seconds() / 60, 1)

        rows.append({
            "trip_id":       doc.id,
            "user_id":       d.get("userId", ""),
            "route":         str(d.get("route", "")).strip(),
            "prev_route":    "",
            "prev_agency":   "",
            "start_stop":    (d.get("startStopName") or d.get("startStop") or "").strip(),
            "end_stop":      (d.get("endStopName")   or d.get("endStop")   or "").strip(),
            "direction":     (d.get("direction") or "").strip(),
            "agency":        (d.get("agency") or "").strip(),
            "manually_verified": bool(d.get("manually_verified")),
            "start_time":    start_dt.isoformat() if start_dt else "",
            "end_time":      end_dt.isoformat()   if end_dt   else "",
            "duration_min":  duration,
            "day_of_week":   start_dt.weekday() if start_dt else "",   # 0=Mon, 6=Sun
            "hour_of_day":   start_dt.hour      if start_dt else "",
            "minute_of_hour":start_dt.minute    if start_dt else "",
            "minutes_since_last_trip": "",
            "journey_id":    d.get("journeyId", ""),
        })

    rows.sort(key=lambda r: (r["user_id"], r["start_time"]))
    last_by_user = {}
    for row in rows:
        prev = last_by_user.get(row["user_id"])
        if prev:
            row["prev_route"] = prev["route"]
            row["prev_agency"] = prev["agency"]
            try:
                prev_start = datetime.fromisoformat(prev["start_time"])
                curr_start = datetime.fromisoformat(row["start_time"])
                delta_min = round((curr_start - prev_start).total_seconds() / 60, 1)
                row["minutes_since_last_trip"] = max(delta_min, 0)
            except Exception:
                row["minutes_since_last_trip"] = ""
        last_by_user[row["user_id"]] = row

    print(
        f"Exported {len(rows)} trips  "
        f"({skipped} skipped — incomplete, discarded, review-needed, or unmatched)"
    )

    with open(OUTPUT_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Saved to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
