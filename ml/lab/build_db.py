"""
Build ml/lab/data/transit.duckdb from the lab export (export_all.mjs).

One row per ride, every source kept (legacy Notion history, SMS, MMS, imported PRESTO taps).
`counted` is the app's own definition of a trip (countedRides), so totals match the website. Stops are grouped the way
the app groups them: ml/stop_canon.py (agency-aware, same rule as js/shared/stop-names.js), never
with name cleanup of our own. Times are bucketed in each trip's own timezone.

Usage (from the repo root):
    ml/.venv/bin/python ml/lab/build_db.py

Tables:
    trips  one row per trip (see COLUMNS below)
    stops  the stops library (name, agency, lat, lng)
"""

import json
import os
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import duckdb
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
from export_trips import parse_timestamp, serves_as_history  # noqa: E402
from stop_canon import canonical_agency, ml_index, ml_norm  # noqa: E402

DATA = os.path.join(HERE, "data")
DB_PATH = os.path.join(DATA, "transit.duckdb")
FALLBACK_TZ = "America/Toronto"  # serving's fallback when a trip has no mapped zone


def zone_for(trip):
    tz = trip.get("timezone")
    try:
        return ZoneInfo(tz) if tz and tz != "UTC" else ZoneInfo(FALLBACK_TZ)
    except Exception:
        return ZoneInfo(FALLBACK_TZ)


def stop_name(trip, end):
    p = "end" if end else "start"
    return (trip.get(f"{p}StopName") or trip.get(f"{p}Stop") or trip.get(f"{p}StopCode") or "").strip()


def build(trips_path, stops_path):
    stops = json.load(open(stops_path, encoding="utf-8"))
    index = ml_index(stops)
    coords = {}
    for s in stops:
        if s.get("name") and s.get("lat") is not None and s.get("lng") is not None:
            coords.setdefault(ml_norm(s["name"]), (s["lat"], s["lng"]))

    rows = []
    with open(trips_path, encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            start = parse_timestamp(d.get("startTime"))
            if start is None:
                continue
            end = parse_timestamp(d.get("endTime"))
            zone = zone_for(d)
            local = start.astimezone(zone)
            agency = canonical_agency(d.get("agency")) if d.get("agency") else None
            s_raw, e_raw = stop_name(d, False), stop_name(d, True)
            s_key = index.canon(s_raw, agency) if s_raw else None
            e_key = index.canon(e_raw, agency) if e_raw else None
            s_ll = coords.get(s_key, (None, None))
            e_ll = coords.get(e_key, (None, None))
            duration = d.get("duration")
            if duration is None and end is not None:
                duration = round((end - start).total_seconds() / 60, 1)
            rows.append({
                "trip_id": d["_id"],
                "source": d.get("source"),
                "agency": agency,
                "route": str(d.get("route") or "").strip() or None,
                "direction": (d.get("direction") or "").strip() or None,
                "start_stop": s_key,
                "end_stop": e_key,
                "start_lat": s_ll[0], "start_lng": s_ll[1],
                "end_lat": e_ll[0], "end_lng": e_ll[1],
                "start_utc": start.astimezone(timezone.utc).replace(tzinfo=None),
                "end_utc": end.astimezone(timezone.utc).replace(tzinfo=None) if end else None,
                "tz": zone.key,
                "start_local": local.replace(tzinfo=None),
                "local_date": local.date(),
                "local_hour": local.hour,
                "local_dow": local.weekday(),  # 0 = Monday
                "duration_min": float(duration) if duration is not None else None,
                "journey_id": d.get("journeyId") or None,
                "incomplete": bool(d.get("incomplete")),
                "discarded": bool(d.get("discarded")),
                "needs_review": bool(d.get("needs_review")),
                "clean": serves_as_history(d),
                "counted": bool(d.get("counted")),
                "timing_reliability": d.get("timing_reliability"),
            })
    trips = pd.DataFrame(rows).sort_values("start_utc").reset_index(drop=True)
    stops_df = pd.DataFrame([{k: s.get(k) for k in ("name", "agency", "lat", "lng", "code")} for s in stops])
    return trips, stops_df


def main():
    trips, stops = build(os.path.join(DATA, "rides.jsonl"), os.path.join(DATA, "stops.json"))
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    con = duckdb.connect(DB_PATH)
    con.execute("CREATE TABLE trips AS SELECT * FROM trips")
    con.execute("CREATE TABLE stops AS SELECT * FROM stops")
    n, first, last = con.execute(
        "SELECT count(*), min(local_date), max(local_date) FROM trips WHERE counted"
    ).fetchone()
    print(f"{DB_PATH}: {n} counted trips, {first} to {last}")
    con.close()


if __name__ == "__main__":
    main()
