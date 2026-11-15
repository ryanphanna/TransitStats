#!/usr/bin/env python3
"""
Compare V3/V4/V5 production shadow accuracy against a lightweight V6 route
baseline on the same scoped trip slice.

Usage:
    python3 ml/v6_eval_against_shadow.py <userId> --agency=TTC --source=sms --since=2026-05-01

What this does:
    - Reads Firestore `predictionStats` and `trips`.
    - Filters out review-needed, discarded, incomplete, and correction-blocked trips.
    - Reports route and end-stop paired slices where V3/V4/V5 all produced results.
    - Builds simple V6 route and end-stop baselines from prior trip history without leakage.
    - Prints a promotion ladder: V4 should beat V3, V5 should beat V4, V6 should beat V5.

The script intentionally separates:
    - Capability ladder: whether each generation is structurally smarter than the last.
    - Promotion ladder: whether that extra capability actually wins on production data.

V6 route baseline:
    Predicts the current route from historical frequencies in this order:
    1. (start_stop + previous_route + previous_end_stop + hour_bucket + day_type)
    2. (start_stop + previous_route + previous_end_stop)
    3. (start_stop + previous_route)
    4. start_stop
    5. previous_route
    6. global route fallback

V6 end-stop baseline:
    Predicts the current destination from historical frequencies in this order:
    1. (route + start_stop + direction + previous_route + previous_end_stop + gap + hour_bucket + day_type)
    2. (route + start_stop + direction + previous_route + previous_end_stop + hour_bucket + day_type)
    3. (route + start_stop + direction + previous_route + previous_end_stop + gap)
    4. (route + start_stop + direction + previous_route + previous_end_stop)
    5. (route + start_stop + direction + previous_route)
    6. (route + start_stop + direction)
    7. (route + start_stop)
    8. (start_stop + previous_route)
    9. route
    10. global end-stop fallback

    When topology covers the route/start/direction, each bucket is filtered to
    physically legal downstream stops before V6 can choose from it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import firebase_admin
from firebase_admin import credentials, firestore

SCRIPT_DIR = os.path.dirname(__file__)
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
KEY_PATH = os.path.expanduser("~/Desktop/Dev/Credentials/Firebase for Transit Stats.json")
TOPOLOGY_PATH = os.path.join(REPO_ROOT, "functions", "lib", "topology.json")

sys.path.insert(0, SCRIPT_DIR)
from route_normalization import load_policies, normalize_route_for_ml  # noqa: E402
from stop_canon import ml_norm  # noqa: E402

HIGH_IMPACT_FIELDS = {
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


@dataclass
class StatRow:
    trip_id: str
    family: str
    kind: str
    hit: bool
    version: str
    route: str | None
    timestamp: datetime | None


@dataclass
class TripRow:
    trip_id: str
    user_id: str
    route: str
    agency: str | None
    direction: str | None
    start_stop: str
    end_stop: str | None
    start_time: datetime
    raw: dict[str, Any]
    prev_route: str | None = None


@dataclass
class V6Prediction:
    trip_id: str
    predicted: str | None
    actual: str
    hit: bool
    confidence: float
    strategy: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate V3/V4/V5 shadow predictions against lightweight V6 route and end-stop baselines."
    )
    parser.add_argument("user_id", help="Firestore userId to evaluate")
    parser.add_argument("--agency", default=None, help="Agency filter, e.g. TTC")
    parser.add_argument("--source", default="sms", help="predictionStats source filter (default: sms)")
    parser.add_argument("--since", default=None, help="Only evaluate trips/stat rows on or after YYYY-MM-DD")
    parser.add_argument("--recent", type=int, default=None, help="Limit paired trip windows to the most recent N")
    parser.add_argument("--min-bucket", type=int, default=2, help="Minimum historical observations before V6 trusts a bucket")
    parser.add_argument("--json-out", default=None, help="Optional path to write machine-readable results")
    return parser.parse_args()


def parse_timestamp(value: Any) -> datetime | None:
    if value is None:
        return None
    if hasattr(value, "to_datetime"):
        dt = value.to_datetime()
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    if hasattr(value, "seconds"):
        return datetime.fromtimestamp(value.seconds, tz=timezone.utc)
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def parse_since(value: str | None) -> datetime | None:
    if not value:
        return None
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def normalize_stop(name: Any) -> str:
    if not name:
        return ""
    # The shared stop-name rule (RYN-541), plus collapsed inner spaces.
    return re.sub(r"\s+", " ", ml_norm(name))


def normalize_route(route: Any, agency: str | None, primary_agency: str | None) -> str:
    return str(normalize_route_for_ml(route, agency=agency, primary_agency=primary_agency) or "").strip()


def base_route(route: Any) -> str:
    value = str(route or "").strip()
    match = re.match(r"^(\d+)", value)
    return match.group(1) if match else value


def load_topology() -> dict[str, Any] | None:
    if not os.path.exists(TOPOLOGY_PATH):
        return None
    with open(TOPOLOGY_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def topology_line(topology: dict[str, Any] | None, route: Any, agency: str | None = None) -> dict[str, Any] | None:
    if not topology or not route:
        return None
    route_value = base_route(route)
    lines = topology.get("lines") or {}
    exact = lines.get(route_value)
    if exact and (not agency or exact.get("network") == agency):
        return exact

    route_lower = route_value.lower()
    for line in lines.values():
        if agency and line.get("network") != agency:
            continue
        aliases = [str(alias).lower() for alias in line.get("route_aliases") or []]
        if route_lower in aliases:
            return line
    return None


def topology_stop_index(line: dict[str, Any] | None, stop_name: Any) -> int:
    if not line or not stop_name:
        return -1
    target = normalize_stop(stop_name)
    for index, canon in enumerate(line.get("stops") or []):
        labels = [canon, *(((line.get("aliases") or {}).get(canon)) or [])]
        for variant in ((line.get("directional_stops") or {}).get(canon)) or []:
            labels.extend([variant.get("name"), *((variant.get("aliases") or []))])
        if target in {normalize_stop(label) for label in labels if label}:
            return index
    return -1


def stop_label_forms(name: Any) -> set[str]:
    value = normalize_stop(name)
    if not value:
        return set()
    forms = {value}
    if value.endswith(" station"):
        forms.add(value[:-8].strip())
    else:
        forms.add(f"{value} station")
    return {form for form in forms if form}


def stop_labels_match(a: Any, b: Any) -> bool:
    return bool(stop_label_forms(a) & stop_label_forms(b))


def topology_canonical_stop(
    topology: dict[str, Any] | None,
    route: Any,
    stop_name: Any,
    direction: Any,
    agency: str | None,
) -> str:
    normalized = normalize_stop(stop_name)
    line = topology_line(topology, route, agency)
    if not line or not normalized:
        return normalized

    norm_dir = normalize_direction(direction)
    for canon in line.get("stops") or []:
        variants = ((line.get("directional_stops") or {}).get(canon)) or []
        if variants:
            matched_variant: str | None = None
            for variant in variants:
                labels = [variant.get("name"), *((variant.get("aliases") or []))]
                if not any(stop_labels_match(stop_name, label) for label in labels if label):
                    continue
                variant_name = normalize_stop(variant.get("name"))
                variant_dirs = {normalize_direction(value) for value in variant.get("directions") or []}
                if norm_dir and (not variant_dirs or norm_dir in variant_dirs):
                    return variant_name
                matched_variant = matched_variant or variant_name
            if matched_variant:
                return matched_variant

        labels = [canon, *(((line.get("aliases") or {}).get(canon)) or [])]
        if any(stop_labels_match(stop_name, label) for label in labels if label):
            return normalize_stop(canon)

    return normalized


def topology_going_higher(line: dict[str, Any], boarding_idx: int, direction: Any) -> bool | None:
    norm_dir = normalize_direction(direction)
    if boarding_idx < 0 or not norm_dir:
        return None

    if line.get("name") == "Yonge-University":
        union_idx = topology_stop_index(line, "Union")
        if union_idx == -1 or boarding_idx == union_idx:
            return None
        return norm_dir == "southbound" if boarding_idx <= union_idx else norm_dir == "northbound"

    direction_order = line.get("direction_order") or {}
    if direction_order:
        if norm_dir == normalize_direction(direction_order.get("forward")):
            return True
        if norm_dir == normalize_direction(direction_order.get("reverse")):
            return False
        return None

    return norm_dir in {"eastbound", "northbound"}


def topology_stop_labels(line: dict[str, Any], canon: str, direction: Any) -> set[str]:
    norm_dir = normalize_direction(direction)
    variants = ((line.get("directional_stops") or {}).get(canon)) or []
    if variants:
        labels: set[str] = set()
        for variant in variants:
            variant_dirs = {normalize_direction(value) for value in variant.get("directions") or []}
            if variant_dirs and norm_dir not in variant_dirs:
                continue
            variant_name = normalize_stop(variant.get("name"))
            if variant_name:
                labels.add(variant_name)
        return {label for label in labels if label}

    canon_label = normalize_stop(canon)
    return {canon_label} if canon_label else set()


def topology_legal_endstops(
    topology: dict[str, Any] | None,
    route: Any,
    start_stop: Any,
    direction: Any,
    agency: str | None,
) -> set[str] | None:
    line = topology_line(topology, route, agency)
    if not line:
        return None
    boarding_idx = topology_stop_index(line, start_stop)
    going_higher = topology_going_higher(line, boarding_idx, direction)
    if boarding_idx == -1 or going_higher is None:
        return None

    legal: set[str] = set()
    for index, canon in enumerate(line.get("stops") or []):
        if (going_higher and index > boarding_idx) or (not going_higher and index < boarding_idx):
            legal.update(topology_stop_labels(line, canon, direction))
    return legal or None


def trip_has_blocking_correction(trip: dict[str, Any] | None) -> bool:
    if not trip:
        return False
    if trip.get("exclude_from_training") or trip.get("exclude_from_accuracy") or trip.get("needs_reprocess"):
        return True
    corrected_fields = trip.get("correctedFields") or []
    return any(field in HIGH_IMPACT_FIELDS for field in corrected_fields)


def is_stop_matched(trip: dict[str, Any]) -> bool:
    if trip.get("stop_matched") is not None:
        return bool(trip.get("stop_matched"))
    return bool(trip.get("verified"))


def clean_trip(doc_id: str, data: dict[str, Any], args: argparse.Namespace, since: datetime | None) -> TripRow | None:
    if data.get("userId") != args.user_id:
        return None
    if args.agency and data.get("agency") != args.agency:
        return None
    if data.get("discarded") or data.get("incomplete") or data.get("needs_review"):
        return None
    if trip_has_blocking_correction(data):
        return None
    if not data.get("endTime"):
        return None
    if not is_stop_matched(data):
        return None
    route = str(data.get("route") or "").strip()
    start_stop = str(data.get("startStopName") or data.get("startStop") or "").strip()
    if not route or not start_stop:
        return None
    start_time = parse_timestamp(data.get("startTime"))
    if not start_time:
        return None
    if since and start_time < since:
        # Keep older trips in the broader clean trip lookup for training elsewhere.
        # The caller applies evaluation filtering separately.
        pass
    return TripRow(
        trip_id=doc_id,
        user_id=str(data.get("userId")),
        route=route,
        agency=data.get("agency"),
        direction=data.get("direction"),
        start_stop=start_stop,
        end_stop=data.get("endStopName") or data.get("endStop"),
        start_time=start_time,
        raw=data,
    )


def family_from_version(version: Any, kind: str) -> str | None:
    v = str(version or "")
    if kind == "endstop":
        if v == "v3-endstop":
            return "V3"
        if v == "v4-endstop":
            return "V4"
        if v == "v5-endstop":
            return "V5"
        return None
    if v.startswith("3"):
        return "V3"
    if v.startswith("4"):
        return "V4"
    if v.startswith("5"):
        return "V5"
    return None


def load_firestore() -> firestore.Client:
    if not os.path.exists(KEY_PATH):
        print(f"ERROR: Service account key not found at {KEY_PATH}", file=sys.stderr)
        sys.exit(1)
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(KEY_PATH))
    return firestore.client()


def fetch_trips(db: firestore.Client, args: argparse.Namespace) -> dict[str, TripRow]:
    docs = db.collection("trips").stream()
    trips: dict[str, TripRow] = {}
    for doc in docs:
        row = clean_trip(doc.id, doc.to_dict(), args, since=None)
        if row:
            trips[row.trip_id] = row
    return trips


def fetch_stats(
    db: firestore.Client,
    args: argparse.Namespace,
    trips: dict[str, TripRow],
    since: datetime | None,
) -> list[StatRow]:
    rows: list[StatRow] = []
    for doc in db.collection("predictionStats").stream():
        data = doc.to_dict()
        if data.get("userId") != args.user_id:
            continue
        if args.source and data.get("source") != args.source:
            continue
        if args.agency and data.get("agency") != args.agency:
            continue
        trip_id = data.get("tripId")
        if not trip_id or trip_id not in trips:
            continue
        trip = trips[trip_id]
        if since and trip.start_time < since:
            continue

        ts = parse_timestamp(data.get("timestamp"))
        if isinstance(data.get("isHit"), bool):
            family = family_from_version(data.get("version"), "route")
            if family:
                rows.append(StatRow(
                    trip_id=trip_id,
                    family=family,
                    kind="route",
                    hit=bool(data.get("isHit")),
                    version=str(data.get("version") or ""),
                    route=data.get("route"),
                    timestamp=ts,
                ))
        if isinstance(data.get("endStopHit"), bool):
            family = family_from_version(data.get("version"), "endstop")
            if family:
                rows.append(StatRow(
                    trip_id=trip_id,
                    family=family,
                    kind="endstop",
                    hit=bool(data.get("endStopHit")),
                    version=str(data.get("version") or ""),
                    route=data.get("route"),
                    timestamp=ts,
                ))
    return rows


def latest_by_family(rows: list[StatRow], kind: str) -> dict[str, dict[str, StatRow]]:
    grouped: dict[str, dict[str, StatRow]] = defaultdict(dict)
    for row in sorted(rows, key=lambda r: r.timestamp or datetime.min.replace(tzinfo=timezone.utc)):
        if row.kind != kind:
            continue
        grouped[row.trip_id][row.family] = row
    return grouped


def paired_trip_ids(
    by_trip: dict[str, dict[str, StatRow]],
    trips: dict[str, TripRow],
    families: tuple[str, ...] = ("V3", "V4", "V5"),
    recent: int | None = None,
) -> list[str]:
    ids = [
        trip_id for trip_id, family_rows in by_trip.items()
        if all(family in family_rows for family in families)
    ]
    ids.sort(key=lambda trip_id: trips[trip_id].start_time, reverse=True)
    if recent:
        ids = ids[:recent]
    return ids


def summarize_stat_rows(by_trip: dict[str, dict[str, StatRow]], trip_ids: list[str], families: list[str]) -> dict[str, dict[str, Any]]:
    summary: dict[str, dict[str, Any]] = {}
    for family in families:
        values = [by_trip[trip_id][family].hit for trip_id in trip_ids if family in by_trip[trip_id]]
        hits = sum(1 for value in values if value)
        total = len(values)
        summary[family] = {
            "hits": hits,
            "total": total,
            "accuracy": hits / total if total else None,
        }
    return summary


def update_counter(counter_map: dict[tuple[str, ...], Counter], key: tuple[str, ...], route: str) -> None:
    if all(part for part in key):
        counter_map[key][route] += 1


def choose_from_counter(
    counter: Counter | None,
    min_bucket: int,
    strategy: str,
    legal: set[str] | None = None,
) -> tuple[str | None, float, str] | None:
    if not counter:
        return None
    if legal is not None:
        counter = Counter({key: count for key, count in counter.items() if key in legal})
        if not counter:
            return None
    total = sum(counter.values())
    if total < min_bucket:
        return None
    predicted, count = counter.most_common(1)[0]
    return predicted, count / total, strategy


def rich_min_bucket(args: argparse.Namespace) -> int:
    # Rich context includes hour/day/previous-end-stop and is more sparse. Require
    # a little more support before letting it beat broader, more stable buckets.
    return max(args.min_bucket + 1, 3)


def evaluate_v6_route(
    trips: dict[str, TripRow],
    eval_trip_ids: list[str],
    args: argparse.Namespace,
) -> dict[str, V6Prediction]:
    eval_set = set(eval_trip_ids)
    exact_rich: dict[tuple[str, str, str, str, str], Counter] = defaultdict(Counter)
    exact_prev_end: dict[tuple[str, str, str], Counter] = defaultdict(Counter)
    exact: dict[tuple[str, str], Counter] = defaultdict(Counter)
    by_start: dict[tuple[str], Counter] = defaultdict(Counter)
    by_prev: dict[tuple[str], Counter] = defaultdict(Counter)
    global_routes: Counter = Counter()
    predictions: dict[str, V6Prediction] = {}
    primary_agency = args.agency

    sorted_trips = sorted(trips.values(), key=lambda t: t.start_time)
    last_route_by_user: dict[str, str] = {}
    last_end_by_user: dict[str, str] = {}

    for trip in sorted_trips:
        current_route = normalize_route(trip.route, trip.agency, primary_agency)
        current_start = normalize_stop(trip.start_stop)
        prev_route = last_route_by_user.get(trip.user_id)
        prev_end = last_end_by_user.get(trip.user_id)
        trip.prev_route = prev_route
        hb = hour_bucket(trip.start_time)
        dt = day_type(trip.start_time)

        if trip.trip_id in eval_set:
            choice = (
                choose_from_counter(exact_rich.get((current_start, prev_route or "", prev_end or "", hb, dt)), rich_min_bucket(args), "start_stop+prev_route+prev_end+hour+day")
                or choose_from_counter(exact_prev_end.get((current_start, prev_route or "", prev_end or "")), args.min_bucket, "start_stop+prev_route+prev_end")
                or choose_from_counter(exact.get((current_start, prev_route or "")), args.min_bucket, "start_stop+prev_route")
                or choose_from_counter(by_start.get((current_start,)), args.min_bucket, "start_stop")
                or choose_from_counter(by_prev.get((prev_route or "",)), args.min_bucket, "prev_route")
                or choose_from_counter(global_routes, 1, "global")
            )

            if choice:
                predicted, confidence, strategy = choice
                predictions[trip.trip_id] = V6Prediction(
                    trip_id=trip.trip_id,
                    predicted=predicted,
                    actual=current_route,
                    hit=predicted == current_route,
                    confidence=confidence,
                    strategy=strategy,
                )

        update_counter(exact_rich, (current_start, prev_route or "", prev_end or "", hb, dt), current_route)
        update_counter(exact_prev_end, (current_start, prev_route or "", prev_end or ""), current_route)
        update_counter(exact, (current_start, prev_route or ""), current_route)
        update_counter(by_start, (current_start,), current_route)
        update_counter(by_prev, (prev_route or "",), current_route)
        global_routes[current_route] += 1
        last_route_by_user[trip.user_id] = current_route
        last_end_by_user[trip.user_id] = normalize_stop(trip.end_stop)

    return predictions


def normalize_direction(direction: Any) -> str:
    if not direction:
        return ""
    value = str(direction).strip().lower().replace("bound", "")
    if value in {"n", "nb", "north"}:
        return "northbound"
    if value in {"s", "sb", "south"}:
        return "southbound"
    if value in {"e", "eb", "east", "eastward"}:
        return "eastbound"
    if value in {"w", "wb", "west"}:
        return "westbound"
    return str(direction).strip().lower()


def hour_bucket(dt: datetime) -> str:
    return str((dt.hour // 3) * 3)


def day_type(dt: datetime) -> str:
    return "weekend" if dt.weekday() >= 5 else "weekday"


def gap_bucket(previous_start: datetime | None, current_start: datetime) -> str:
    if not previous_start:
        return "none"
    minutes = max(0, round((current_start - previous_start).total_seconds() / 60))
    if minutes <= 30:
        return "transfer"
    if minutes <= 120:
        return "stopover"
    return "separate"


def evaluate_v6_endstop(
    trips: dict[str, TripRow],
    eval_trip_ids: list[str],
    args: argparse.Namespace,
) -> dict[str, V6Prediction]:
    eval_set = set(eval_trip_ids)
    route_start_dir_prev_gap_rich: dict[tuple[str, str, str, str, str, str, str, str], Counter] = defaultdict(Counter)
    route_start_dir_prev_rich: dict[tuple[str, str, str, str, str, str, str], Counter] = defaultdict(Counter)
    route_start_dir_prev_gap: dict[tuple[str, str, str, str, str, str], Counter] = defaultdict(Counter)
    route_start_dir_prev_end: dict[tuple[str, str, str, str, str], Counter] = defaultdict(Counter)
    route_start_dir_prev: dict[tuple[str, str, str, str], Counter] = defaultdict(Counter)
    route_start_dir: dict[tuple[str, str, str], Counter] = defaultdict(Counter)
    route_start: dict[tuple[str, str], Counter] = defaultdict(Counter)
    start_prev: dict[tuple[str, str], Counter] = defaultdict(Counter)
    by_route: dict[tuple[str], Counter] = defaultdict(Counter)
    global_endstops: Counter = Counter()
    predictions: dict[str, V6Prediction] = {}
    primary_agency = args.agency
    topology = load_topology()

    sorted_trips = sorted(trips.values(), key=lambda t: t.start_time)
    last_route_by_user: dict[str, str] = {}
    last_end_by_user: dict[str, str] = {}
    last_start_by_user: dict[str, datetime] = {}

    for trip in sorted_trips:
        current_route = normalize_route(trip.route, trip.agency, primary_agency)
        current_direction = normalize_direction(trip.direction)
        current_start = topology_canonical_stop(topology, current_route, trip.start_stop, current_direction, trip.agency or primary_agency)
        current_end = topology_canonical_stop(topology, current_route, trip.end_stop, current_direction, trip.agency or primary_agency)
        prev_route = last_route_by_user.get(trip.user_id) or ""
        prev_end = last_end_by_user.get(trip.user_id) or ""
        gap = gap_bucket(last_start_by_user.get(trip.user_id), trip.start_time)
        hb = hour_bucket(trip.start_time)
        dt = day_type(trip.start_time)

        if trip.trip_id in eval_set and current_end:
            legal = topology_legal_endstops(topology, current_route, current_start, current_direction, trip.agency or primary_agency)
            choice = (
                choose_from_counter(route_start_dir_prev_gap_rich.get((current_route, current_start, current_direction, prev_route, prev_end, gap, hb, dt)), rich_min_bucket(args), "route+start_stop+direction+prev_route+prev_end+gap+hour+day", legal)
                or choose_from_counter(route_start_dir_prev_rich.get((current_route, current_start, current_direction, prev_route, prev_end, hb, dt)), rich_min_bucket(args), "route+start_stop+direction+prev_route+prev_end+hour+day", legal)
                or choose_from_counter(route_start_dir_prev_gap.get((current_route, current_start, current_direction, prev_route, prev_end, gap)), args.min_bucket, "route+start_stop+direction+prev_route+prev_end+gap", legal)
                or choose_from_counter(route_start_dir_prev_end.get((current_route, current_start, current_direction, prev_route, prev_end)), args.min_bucket, "route+start_stop+direction+prev_route+prev_end", legal)
                or choose_from_counter(route_start_dir_prev.get((current_route, current_start, current_direction, prev_route)), args.min_bucket, "route+start_stop+direction+prev_route", legal)
                or choose_from_counter(route_start_dir.get((current_route, current_start, current_direction)), args.min_bucket, "route+start_stop+direction", legal)
                or choose_from_counter(route_start.get((current_route, current_start)), args.min_bucket, "route+start_stop", legal)
                or choose_from_counter(start_prev.get((current_start, prev_route)), args.min_bucket, "start_stop+prev_route", legal)
                or choose_from_counter(by_route.get((current_route,)), args.min_bucket, "route", legal)
                or choose_from_counter(global_endstops, 1, "global", legal)
            )

            if choice:
                predicted, confidence, strategy = choice
                predictions[trip.trip_id] = V6Prediction(
                    trip_id=trip.trip_id,
                    predicted=predicted,
                    actual=current_end,
                    hit=predicted == current_end,
                    confidence=confidence,
                    strategy=strategy,
                )

        if current_end:
            update_counter(route_start_dir_prev_gap_rich, (current_route, current_start, current_direction, prev_route, prev_end, gap, hb, dt), current_end)
            update_counter(route_start_dir_prev_rich, (current_route, current_start, current_direction, prev_route, prev_end, hb, dt), current_end)
            update_counter(route_start_dir_prev_gap, (current_route, current_start, current_direction, prev_route, prev_end, gap), current_end)
            update_counter(route_start_dir_prev_end, (current_route, current_start, current_direction, prev_route, prev_end), current_end)
            update_counter(route_start_dir_prev, (current_route, current_start, current_direction, prev_route), current_end)
            update_counter(route_start_dir, (current_route, current_start, current_direction), current_end)
            update_counter(route_start, (current_route, current_start), current_end)
            update_counter(start_prev, (current_start, prev_route), current_end)
            update_counter(by_route, (current_route,), current_end)
            global_endstops[current_end] += 1
        last_route_by_user[trip.user_id] = current_route
        last_end_by_user[trip.user_id] = current_end
        last_start_by_user[trip.user_id] = trip.start_time

    return predictions


def summarize_v6(predictions: dict[str, V6Prediction], trip_ids: list[str]) -> dict[str, Any]:
    values = [predictions[trip_id] for trip_id in trip_ids if trip_id in predictions]
    hits = sum(1 for pred in values if pred.hit)
    total = len(values)
    strategies = Counter(pred.strategy for pred in values)
    return {
        "hits": hits,
        "total": total,
        "accuracy": hits / total if total else None,
        "strategies": dict(strategies),
    }


def fmt_accuracy(metric: dict[str, Any]) -> str:
    if not metric["total"]:
        return "n/a"
    return f"{metric['hits']}/{metric['total']} ({metric['accuracy'] * 100:.1f}%)"


def print_summary_table(title: str, summary: dict[str, dict[str, Any]], families: list[str]) -> None:
    print(f"\n{title}")
    for family in families:
        print(f"  {family}: {fmt_accuracy(summary[family])}")


def ladder(summary: dict[str, dict[str, Any]], families: list[str]) -> list[dict[str, Any]]:
    out = []
    for prev, curr in zip(families, families[1:]):
        prev_acc = summary[prev]["accuracy"]
        curr_acc = summary[curr]["accuracy"]
        if prev_acc is None or curr_acc is None:
            status = "NO DATA"
            delta = None
        else:
            delta = curr_acc - prev_acc
            status = "PASS" if delta > 0 else "FAIL"
        out.append({"from": prev, "to": curr, "status": status, "delta": delta})
    return out


def print_ladder(title: str, summary: dict[str, dict[str, Any]], families: list[str]) -> None:
    print(f"\n{title}")
    for item in ladder(summary, families):
        delta = "n/a" if item["delta"] is None else f"{item['delta'] * 100:+.1f}pp"
        print(f"  {item['from']} → {item['to']}: {item['status']} ({delta})")


def print_capability_ladder() -> None:
    print("\nCapability Ladder")
    print("  V3: heuristic weighted voting over reviewed trip history + physical constraints")
    print("  V4: learned logistic-regression weights over route/stop/time/sequence features")
    print("  V5: XGBoost feature interactions + ONNX inference over the same shared feature pipeline")
    print("  V6: journey/sequence-aware route and end-stop baselines using prior-trip context without leakage")
    print("  Rule: a newer V can be architecturally smarter but still fail promotion until it beats the older V on scoped production slices.")


def main() -> None:
    args = parse_args()
    since = parse_since(args.since)
    load_policies()

    db = load_firestore()
    print("Fetching clean trips...")
    trips = fetch_trips(db, args)
    print(f"Clean trips available for user/scope: {len(trips)}")

    print("Fetching predictionStats...")
    rows = fetch_stats(db, args, trips, since)
    route_by_trip = latest_by_family(rows, "route")
    end_by_trip = latest_by_family(rows, "endstop")

    route_paired_ids = paired_trip_ids(route_by_trip, trips, recent=args.recent)
    end_paired_ids = paired_trip_ids(end_by_trip, trips, recent=args.recent)

    print("\nScope")
    print(f"  userId: {args.user_id}")
    print(f"  agency: {args.agency or '*'}")
    print(f"  source: {args.source or '*'}")
    print(f"  since: {args.since or '*'}")
    print(f"  recent paired windows: {args.recent or '*'}")
    print(f"  min V6 bucket: {args.min_bucket}")
    print(f"  route paired windows (V3+V4+V5): {len(route_paired_ids)}")
    print(f"  end-stop paired windows (V3+V4+V5): {len(end_paired_ids)}")

    print_capability_ladder()

    route_summary = summarize_stat_rows(route_by_trip, route_paired_ids, ["V3", "V4", "V5"])
    print_summary_table("Route Accuracy: Production Shadow Paired Slice", route_summary, ["V3", "V4", "V5"])
    print_ladder("Route Promotion Ladder: Production Shadow Only", route_summary, ["V3", "V4", "V5"])

    v6_route_predictions = evaluate_v6_route(trips, route_paired_ids, args)
    route_ladder_ids = [trip_id for trip_id in route_paired_ids if trip_id in v6_route_predictions]
    route_ladder_summary = summarize_stat_rows(route_by_trip, route_ladder_ids, ["V3", "V4", "V5"])
    route_ladder_summary["V6"] = summarize_v6(v6_route_predictions, route_ladder_ids)
    print_summary_table("Route Accuracy: Same Trip IDs Including Offline V6", route_ladder_summary, ["V3", "V4", "V5", "V6"])
    print_ladder("Route Promotion Ladder: V3 → V4 → V5 → V6", route_ladder_summary, ["V3", "V4", "V5", "V6"])
    print(f"  V6 strategy mix: {route_ladder_summary['V6'].get('strategies', {})}")

    end_summary = summarize_stat_rows(end_by_trip, end_paired_ids, ["V3", "V4", "V5"])
    print_summary_table("End-Stop Accuracy: Production Shadow Paired Slice", end_summary, ["V3", "V4", "V5"])
    print_ladder("End-Stop Promotion Ladder: V3 → V4 → V5", end_summary, ["V3", "V4", "V5"])

    v6_end_predictions = evaluate_v6_endstop(trips, end_paired_ids, args)
    end_ladder_ids = [trip_id for trip_id in end_paired_ids if trip_id in v6_end_predictions]
    end_ladder_summary = summarize_stat_rows(end_by_trip, end_ladder_ids, ["V3", "V4", "V5"])
    end_ladder_summary["V6"] = summarize_v6(v6_end_predictions, end_ladder_ids)
    print_summary_table("End-Stop Accuracy: Same Trip IDs Including Offline V6", end_ladder_summary, ["V3", "V4", "V5", "V6"])
    print_ladder("End-Stop Promotion Ladder: V3 → V4 → V5 → V6", end_ladder_summary, ["V3", "V4", "V5", "V6"])
    print(f"  V6 end-stop strategy mix: {end_ladder_summary['V6'].get('strategies', {})}")

    result = {
        "scope": {
            "userId": args.user_id,
            "agency": args.agency,
            "source": args.source,
            "since": args.since,
            "recent": args.recent,
            "minBucket": args.min_bucket,
        },
        "routePairedTripCount": len(route_paired_ids),
        "endStopPairedTripCount": len(end_paired_ids),
        "routeProduction": route_summary,
        "routeWithV6": route_ladder_summary,
        "routeLadder": ladder(route_ladder_summary, ["V3", "V4", "V5", "V6"]),
        "endStopProduction": end_summary,
        "endStopWithV6": end_ladder_summary,
        "endStopLadder": ladder(end_ladder_summary, ["V3", "V4", "V5", "V6"]),
        "v6Predictions": {
            trip_id: {
                "predicted": pred.predicted,
                "actual": pred.actual,
                "hit": pred.hit,
                "confidence": pred.confidence,
                "strategy": pred.strategy,
            }
            for trip_id, pred in v6_route_predictions.items()
        },
        "v6EndStopPredictions": {
            trip_id: {
                "predicted": pred.predicted,
                "actual": pred.actual,
                "hit": pred.hit,
                "confidence": pred.confidence,
                "strategy": pred.strategy,
            }
            for trip_id, pred in v6_end_predictions.items()
        },
    }

    if args.json_out:
        out_path = args.json_out
        if not os.path.isabs(out_path):
            out_path = os.path.join(REPO_ROOT, out_path)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, default=str)
        print(f"\nWrote JSON results to {out_path}")


if __name__ == "__main__":
    main()
