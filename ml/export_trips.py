"""
TransitStats — Trip Export Script
Pulls completed trip history from Firestore and writes a CSV for ML training.

Usage:
    pip install firebase-admin pandas
    python ml/export_trips.py

Output: ml/trips.csv
"""

import bisect
import csv
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

try:  # not needed for build_rows(), which the offline eval and tests import
    import firebase_admin
    from firebase_admin import credentials, firestore
except ImportError:  # pragma: no cover
    firebase_admin = credentials = firestore = None

# --- Config ---
PROJECT_ID = os.environ.get("TRANSITSTATS_PROJECT_ID", "transitstats-21ba4")
KEY_PATH = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or os.path.expanduser(
    "~/Desktop/Dev/Credentials/Firebase for Transit Stats.json"
)
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "trips.csv")
LOCAL_TZ = ZoneInfo("America/Toronto")
HISTORY_LIMIT = 100  # handlers-trip.js: getRecentCompletedTrips(userId, 100)

# Comma-separated Firebase user IDs whose trips may be used for training. Required (set it from
# a secret, never in the repo): the trained models contain real stop and route names, so they
# must only ever learn from the people who agreed to it.
TRAIN_USER_IDS = [u.strip() for u in os.environ.get("TRAIN_USER_IDS", "").split(",") if u.strip()]

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
    "day_of_week",      # 0 = Monday … 6 = Sunday (UTC; route models only)
    "hour_of_day",      # 0–23 (UTC; route models only)
    "minute_of_hour",   # 0–59
    "minutes_since_last_trip",
    "journey_id",       # for multi-leg trips
    # End-stop models: built exactly as serving sees them at trip start (serve_context below).
    "serve_prev_route",
    "serve_last_end_stop",
    "serve_minutes_since_last_trip",
    "local_day_of_week",  # agency's local time, DST-aware
    "local_hour",
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
        d = datetime.fromisoformat(str(val))
    except Exception:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


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


def serves_as_history(trip):
    """Mirrors db/trips.js getRecentCompletedTrips(): what serving may use as `history`."""
    if trip.get("incomplete") or trip.get("discarded") or trip.get("needs_review"):
        return False
    if has_blocking_correction(trip):
        return False
    return is_stop_matched(trip)


def is_training_trip(d):
    """Completed, trusted trips with a route, start stop and end stop."""
    has_end_stop = d.get("endStopName") or d.get("endStop") or d.get("endStopCode")
    if not d.get("endTime") or not has_end_stop or not serves_as_history(d):
        return False
    if not d.get("route") or not (d.get("startStop") or d.get("startStopName") or d.get("startStopCode")):
        return False
    return parse_timestamp(d.get("startTime")) is not None


def local_start(start_dt, trip):
    """Local wall-clock start. Trips store their agency's IANA zone (db/trips.js); a missing or
    'UTC' zone means the agency isn't mapped, and serving then falls back to America/Toronto."""
    tz = trip.get("timezone")
    try:
        zone = ZoneInfo(tz) if tz and tz != "UTC" else LOCAL_TZ
    except Exception:
        zone = LOCAL_TZ
    return start_dt.astimezone(zone)


def serve_context(trip, start_dt, completed_by_end):
    """Sequence context exactly as serving builds it at trip start (handlers-trip.js):
    history = the newest HISTORY_LIMIT trips that ended before the trip started, filtered by
    serves_as_history(); the context comes from history[0]. The gap is measured from that trip's
    START, rounded to whole minutes. completed_by_end: [(end_dt, trip)] for the user, ascending."""
    ends = [e for e, _ in completed_by_end]
    i = bisect.bisect_left(ends, start_dt)
    for j in range(i - 1, max(-1, i - 1 - HISTORY_LIMIT), -1):
        last = completed_by_end[j][1]
        if last is trip or not serves_as_history(last):
            continue
        last_start = parse_timestamp(last.get("startTime"))
        gap = max(0, round((start_dt - last_start).total_seconds() / 60)) if last_start else ""
        return {
            "last_end_stop": (last.get("endStopName") or last.get("endStop") or "").strip(),
            "prev_route": str(last.get("route") or "").strip(),
            "prev_agency": (last.get("agency") or "").strip(),
            "minutes_since_last_trip": gap,
        }
    return {"last_end_stop": "", "prev_route": "", "prev_agency": "", "minutes_since_last_trip": ""}


def build_rows(docs):
    """docs: iterable of (doc_id, trip dict). Returns (rows, skipped). Pure: no Firestore access,
    so the feature-parity test and the offline eval can run it on exported trips."""
    docs = list(docs)
    completed = defaultdict(list)
    for _, d in docs:
        end_dt = parse_timestamp(d.get("endTime"))
        if end_dt is not None:
            completed[d.get("userId", "")].append((end_dt, d))
    for lst in completed.values():
        lst.sort(key=lambda p: p[0])

    rows, skipped = [], 0
    for doc_id, d in docs:
        if not is_training_trip(d):
            skipped += 1
            continue
        start_dt = parse_timestamp(d.get("startTime"))
        end_dt = parse_timestamp(d.get("endTime"))
        duration = d.get("duration")
        if duration is None and end_dt is not None:
            duration = round((end_dt - start_dt).total_seconds() / 60, 1)
        local = local_start(start_dt, d)
        ctx = serve_context(d, start_dt, completed[d.get("userId", "")])
        rows.append({
            "trip_id":       doc_id,
            "user_id":       d.get("userId", ""),
            "route":         str(d.get("route", "")).strip(),
            "prev_route":    "",
            "prev_agency":   "",
            "start_stop":    (d.get("startStopName") or d.get("startStop") or d.get("startStopCode") or "").strip(),
            "end_stop":      (d.get("endStopName")   or d.get("endStop")   or d.get("endStopCode") or "").strip(),
            "direction":     (d.get("direction") or "").strip(),
            "agency":        (d.get("agency") or "").strip(),
            "manually_verified": bool(d.get("manually_verified")),
            "start_time":    start_dt.isoformat(),
            "end_time":      end_dt.isoformat() if end_dt else "",
            "duration_min":  duration,
            "day_of_week":   start_dt.weekday(),   # 0=Mon, 6=Sun
            "hour_of_day":   start_dt.hour,
            "minute_of_hour": start_dt.minute,
            "minutes_since_last_trip": "",
            "journey_id":    d.get("journeyId", ""),
            "serve_prev_route": ctx["prev_route"],
            "serve_last_end_stop": ctx["last_end_stop"],
            "serve_minutes_since_last_trip": ctx["minutes_since_last_trip"],
            "local_day_of_week": local.weekday(),
            "local_hour":    local.hour,
        })
    rows.sort(key=lambda r: (r["user_id"], r["start_time"]))
    # Route models (unchanged): previous exported trip by start time.
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
    return rows, skipped


def stream_allowed_trips(db):
    """Yield trip docs for allowlisted users only (Firestore 'in' queries take up to 30 values)."""
    for i in range(0, len(TRAIN_USER_IDS), 30):
        chunk = TRAIN_USER_IDS[i:i + 30]
        yield from db.collection("trips").where("userId", "in", chunk).stream()


def main():
    if not os.path.exists(KEY_PATH):
        print(f"ERROR: Service account key not found at {KEY_PATH}")
        sys.exit(1)

    cred = credentials.Certificate(KEY_PATH)
    app = firebase_admin.initialize_app(cred, {"projectId": PROJECT_ID})
    db = firestore.client(app=app)

    if not TRAIN_USER_IDS:
        print("ERROR: TRAIN_USER_IDS is empty. Refusing to export trips for all users.")
        sys.exit(1)

    print(f"Fetching trips from Firestore for {len(TRAIN_USER_IDS)} allowlisted user(s)...")
    # Every trip is needed (not just training ones): the sequence context comes from serving's
    # history, which includes trips without a route or end stop.
    rows, skipped = build_rows((doc.id, doc.to_dict()) for doc in stream_allowed_trips(db))

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
