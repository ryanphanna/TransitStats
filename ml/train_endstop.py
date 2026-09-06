"""
TransitStats — End Stop Prediction Training Script
Trains V4 (logistic regression) and V5 (XGBoost) end stop classifiers.

Features: route (one-hot), prev_route (one-hot), start_stop (one-hot), hour (sin/cos),
day (sin/cos), last_end_stop (one-hot), minutes_since_last_trip (numeric)
Target: end_stop (canonical name)

Outputs:
  ml/model_v4_endstop.json  — logistic regression weights
  ml/model_v5_endstop.onnx  — XGBoost ONNX model
  ml/model_v5_endstop_meta.json — feature names + class labels

Usage:
  GRPC_DNS_RESOLVER=native python3 ml/train_endstop.py
"""

import json
import math
import os
import sys
import re

import numpy as np
import pandas as pd
import firebase_admin
from firebase_admin import credentials, firestore
from route_normalization import normalize_route_for_ml, load_policies


def compute_primary_agency_map(df):
    """
    For each user_id, determine their primary agency in this dataset
    (most frequent agency). Used so PRIMARY collapse policy is applied
    correctly during feature generation.
    """
    if 'user_id' not in df.columns or 'agency' not in df.columns:
        return {}

    primary_map = {}
    for user, group in df.groupby('user_id'):
        if len(group) > 0:
            primary = group['agency'].value_counts().index[0]
            if pd.notna(primary):
                primary_map[user] = str(primary).strip()

    if not primary_map and len(df) > 0:
        overall_primary = df['agency'].value_counts().index[0]
        if pd.notna(overall_primary):
            for uid in df['user_id'].dropna().unique():
                primary_map[uid] = str(overall_primary).strip()

    return primary_map

KEY_PATH = os.path.expanduser("~/Desktop/Dev/Credentials/Firebase for Transit Stats.json")
CSV_PATH = os.path.join(os.path.dirname(__file__), "trips.csv")
OUT_DIR  = os.path.dirname(__file__)


# ---------------------------------------------------------------------------
# 1. Data Prep
# ---------------------------------------------------------------------------

def load_data():
    if not os.path.exists(CSV_PATH):
        print("trips.csv not found — running export first...")
        os.system(f"GRPC_DNS_RESOLVER=native python3 {os.path.join(OUT_DIR, 'export_trips.py')}")
    df = pd.read_csv(CSV_PATH)
    print(f"Loaded {len(df)} trips from CSV")
    return df

def load_stops_library():
    if not firebase_admin._apps:
        cred = credentials.Certificate(KEY_PATH)
        firebase_admin.initialize_app(cred)
    db = firestore.client()
    docs = db.collection("stops").stream()
    lib = []
    for doc in docs:
        d = doc.to_dict()
        lib.append({"name": d.get("name"), "aliases": d.get("aliases", [])})
    return lib

_DIRECTION_MAP = {
    "n": "northbound", "nb": "northbound", "north": "northbound",
    "s": "southbound", "sb": "southbound", "south": "southbound",
    "e": "eastbound",  "eb": "eastbound",  "east": "eastbound", "eastward": "eastbound",
    "w": "westbound",  "wb": "westbound",  "west": "westbound",
}

def normalize_direction(d):
    if not d or (isinstance(d, float) and math.isnan(d)): return None
    s = str(d).strip().lower()
    s = re.sub(r"bound$", "", s).strip()
    return _DIRECTION_MAP.get(s, s or None)

def _normalize_stop_str(s):
    s = str(s).strip().lower()
    s = re.sub(r"\s+and\s+", "/", s)
    s = s.replace(" & ", "/").replace(" @ ", "/")
    s = re.sub(r"\s+at\s+", "/", s)
    s = re.sub(r"\s*/\s*", "/", s)
    return s

def canonicalize_stop(name, lib):
    if not name: return "unknown"
    lower = _normalize_stop_str(name)
    for item in lib:
        candidates = [item["name"]] + item.get("aliases", [])
        for c in candidates:
            if _normalize_stop_str(c) == lower:
                return _normalize_stop_str(item["name"])
    return lower

def compute_ride_count_weights(df, halflife_rides=100):
    df = df.copy()
    df["_dt"] = pd.to_datetime(df["start_time"], utc=True, errors="coerce")
    df_sorted = df.sort_values("_dt").reset_index(drop=False)

    lambda_val = math.log(2) / halflife_rides
    agency_count = {}
    rides_after = [0] * len(df_sorted)

    for i in range(len(df_sorted) - 1, -1, -1):
        agency = str(df_sorted.at[i, "agency"] or "unknown")
        rides_after[i] = agency_count.get(agency, 0)
        agency_count[agency] = agency_count.get(agency, 0) + 1

    df_sorted["_rides_after"] = rides_after
    df_sorted["_weight"] = df_sorted["_rides_after"].apply(
        lambda r: math.exp(-lambda_val * r)
    )

    weight_series = df_sorted.set_index("index")["_weight"]
    return df.index.map(weight_series).values

def clean(df, lib):
    df = df.copy()
    df["route"]      = df["route"].astype(str).str.strip()
    df["prev_route"] = df["prev_route"].fillna("").astype(str).str.strip()
    df["start_stop"] = df["start_stop"].str.strip()
    df["end_stop"]   = df["end_stop"].str.strip()
    df["hour"]       = df["hour_of_day"].astype(int)
    df["day"]        = df["day_of_week"].astype(int)
    df["minutes_since_last_trip"] = pd.to_numeric(
        df.get("minutes_since_last_trip"), errors="coerce"
    )

    primary_map = compute_primary_agency_map(df)

    def _normalize_route(row, col):
        agency = row.get(col)
        user_id = row.get('user_id')
        primary = primary_map.get(user_id) if user_id else None
        return normalize_route_for_ml(route=row.get(col), agency=agency, primary_agency=primary)

    df["route_base"] = df.apply(lambda row: _normalize_route(row, "route"), axis=1)
    df["prev_route_base"] = df.apply(lambda row: _normalize_route(row, "prev_route"), axis=1)
    df["start_stop"] = df["start_stop"].apply(lambda x: canonicalize_stop(x, lib))
    df["end_stop"] = df["end_stop"].apply(lambda x: canonicalize_stop(x, lib))
    df["direction_norm"] = df["direction"].apply(normalize_direction)

    # Add sequence feature: last_end_stop
    df = df.sort_values(["user_id", "start_time"])
    df["last_end_stop"] = df.groupby("user_id")["end_stop"].shift(1).fillna("none")
    df["prev_route_base"] = df["prev_route_base"].replace("", "none").fillna("none")
    df["minutes_since_last_trip"] = df["minutes_since_last_trip"].fillna(-1)
    df["gap_missing"] = (df["minutes_since_last_trip"] < 0).astype(int)
    df["gap_minutes_capped"] = df["minutes_since_last_trip"].clip(lower=0, upper=720)
    df["gap_log"] = np.log1p(df["gap_minutes_capped"]) / math.log1p(720)

    # Filter to combos with >= 5 trips
    counts = df.groupby(["route_base", "start_stop"])["end_stop"].count()
    valid  = counts[counts >= 5].reset_index()[["route_base", "start_stop"]]
    df = df.merge(valid, on=["route_base", "start_stop"], how="inner")

    # Filter to end_stop classes with >= 10 occurrences
    end_counts = df["end_stop"].value_counts()
    df = df[df["end_stop"].isin(end_counts[end_counts >= 10].index)]

    print(f"After cleaning: {len(df)} trips, {df['end_stop'].nunique()} end stop classes")
    return df

def _sanitize(s):
    """Mirrors getStopFeature() in ml_utils.js: replace non-alphanumeric with '_'."""
    return re.sub(r'[^a-z0-9]', '_', str(s).lower().strip())

def build_features(df):
    hour_sin = np.sin(2 * math.pi * df["hour"] / 24)
    hour_cos = np.cos(2 * math.pi * df["hour"] / 24)
    day_sin  = np.sin(2 * math.pi * df["day"] / 7)
    day_cos  = np.cos(2 * math.pi * df["day"] / 7)

    time_features = pd.DataFrame({
        "hour_sin": hour_sin,
        "hour_cos": hour_cos,
        "day_sin":  day_sin,
        "day_cos":  day_cos,
        "gap_log":  df["gap_log"],
        "gap_missing": df["gap_missing"],
    }, index=df.index)

    route_dummies = pd.get_dummies(df["route_base"].str.lower().str.strip(), prefix="route")
    prev_route_dummies = pd.get_dummies(df["prev_route_base"].str.lower().str.strip(), prefix="prev_route")
    stop_dummies  = pd.get_dummies(df["start_stop"].apply(_sanitize), prefix="stop")
    last_stop_dummies = pd.get_dummies(df["last_end_stop"].apply(_sanitize), prefix="last_stop")
    dir_dummies = pd.get_dummies(df["direction_norm"], prefix="dir")

    agency_dummies = pd.get_dummies(df["agency"].fillna("unknown").map(_sanitize), prefix="agency")
    X = pd.concat([time_features, agency_dummies, route_dummies, prev_route_dummies, stop_dummies, last_stop_dummies, dir_dummies], axis=1)
    return X


# ---------------------------------------------------------------------------
# 2. Train & Evaluate
# ---------------------------------------------------------------------------

def train_v4(X_train, y_train, classes, weights_train=None):
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import LabelEncoder
    le = LabelEncoder()
    le.fit(classes)
    y_enc = le.transform(y_train)
    model = LogisticRegression(max_iter=1000, class_weight="balanced")
    model.fit(X_train, y_enc, sample_weight=weights_train)
    return model, le

def train_v5(X_train, y_train, classes, weights_train=None):
    from sklearn.preprocessing import LabelEncoder
    from xgboost import XGBClassifier
    le = LabelEncoder()
    le.fit(classes)
    y_enc = le.transform(y_train)
    model = XGBClassifier(
        n_estimators=200, max_depth=4, learning_rate=0.1,
        use_label_encoder=False, eval_metric="mlogloss", verbosity=0,
    )
    model.fit(X_train.values, y_enc, sample_weight=weights_train)
    return model, le

def evaluate(model, X_test, y_test, le, label):
    import numpy as np
    from sklearn.metrics import top_k_accuracy_score
    proba = model.predict_proba(X_test if not hasattr(X_test, 'values') else X_test.values)
    y_enc = le.transform(y_test)
    # model.classes_ may be a subset of le.classes_ if some classes had no training samples
    model_classes = set(model.classes_)
    mask = np.isin(y_enc, list(model_classes))
    if not mask.all():
        print(f"  [warn] {(~mask).sum()} test trips with unseen end-stop class dropped from eval")
        y_enc = y_enc[mask]
        proba = proba[mask]
    labels = list(model.classes_)
    top1 = top_k_accuracy_score(y_enc, proba, k=1, labels=labels)
    top3 = top_k_accuracy_score(y_enc, proba, k=min(3, len(labels)), labels=labels)
    print(f"{label}: top-1 {top1:.1%}  top-3 {top3:.1%}  ({len(y_enc)} test trips)")
    return top1, top3


# ---------------------------------------------------------------------------
# 3. Export
# ---------------------------------------------------------------------------

def export_v4(model, le, feature_names, top1, top3, n_trips, agencies):
    out = {
        "type": "logistic_regression_endstop",
        "version": "4",
        "classes": le.classes_.tolist(),
        "feature_names": feature_names,
        "intercept": model.intercept_.tolist(),
        "coef": model.coef_.tolist(),
        "feature_schema_version": 2,
        "agencies": sorted(agencies),
    }
    path = os.path.join(OUT_DIR, "model_v4_endstop.json")
    with open(path, "w") as f: json.dump(out, f)
    print(f"V4 end stop model → {path}")

    meta = {
        "type": "logistic_regression_endstop", "version": "4",
        "classes": le.classes_.tolist(), "feature_names": feature_names,
        "top1_accuracy": round(top1, 4), "top3_accuracy": round(top3, 4), "n_trips": n_trips,
        "feature_schema_version": 2, "agencies": sorted(agencies),
    }
    with open(os.path.join(OUT_DIR, "model_v4_endstop_meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

def export_v5(model, le, feature_names, top1, top3, n_trips, agencies):
    import onnxmltools
    from onnxmltools.convert.common.data_types import FloatTensorType
    path_onnx = os.path.join(OUT_DIR, "model_v5_endstop.onnx")
    try:
        initial_type = [("float_input", FloatTensorType([None, len(feature_names)]))]
        onx = onnxmltools.convert_xgboost(model, initial_types=initial_type, target_opset=12)
        with open(path_onnx, "wb") as f: f.write(onx.SerializeToString())
    except Exception as e:
        print(f"onnx failed ({e}), saving XGB JSON...")
        model.save_model(path_onnx.replace(".onnx", ".json"))

    meta = {
        "type": "xgboost_endstop", "version": "5", "classes": le.classes_.tolist(),
        "feature_names": feature_names, "top1_accuracy": round(top1, 4),
        "top3_accuracy": round(top3, 4), "n_trips": n_trips,
        "feature_schema_version": 2, "agencies": sorted(agencies),
    }
    with open(os.path.join(OUT_DIR, "model_v5_endstop_meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

def mirror_to_lib():
    import shutil
    lib_dir = os.path.join(OUT_DIR, "..", "functions", "lib")
    for fname in ["model_v4_endstop.json", "model_v4_endstop_meta.json", "model_v5_endstop.onnx", "model_v5_endstop_meta.json"]:
        src = os.path.join(OUT_DIR, fname)
        dst = os.path.join(lib_dir, fname)
        if os.path.exists(src):
            shutil.copy2(src, dst)
            print(f"  {fname} → functions/lib/")

def main():
    load_policies()

    df = load_data()
    lib = load_stops_library()
    df = clean(df, lib)
    if len(df) < 20: sys.exit(1)
    weights = compute_ride_count_weights(df)
    X = build_features(df)
    y = df["end_stop"]
    classes = sorted(y.unique())
    feature_names = list(X.columns)
    split = max(1, int(len(df) * 0.2))
    ordered = df.sort_values('start_time').index
    test_index = ordered[-split:]
    train_index = ordered[:-split]
    X_train, X_test = X.loc[train_index], X.loc[test_index]
    y_train, y_test = y.loc[train_index], y.loc[test_index]
    weight_series = pd.Series(weights, index=df.index)
    w_train, w_test = weight_series.loc[train_index].values, weight_series.loc[test_index].values
    agencies = df['agency'].fillna('unknown').astype(str).str.strip().unique().tolist()
    v4_m, v4_le = train_v4(X_train, y_train, classes, weights_train=w_train)
    v4_t1, v4_t3 = evaluate(v4_m, X_test, y_test, v4_le, "V4")
    export_v4(v4_m, v4_le, feature_names, v4_t1, v4_t3, len(df), agencies)
    v5_m, v5_le = train_v5(X_train, y_train, classes, weights_train=w_train)
    v5_t1, v5_t3 = evaluate(v5_m, X_test, y_test, v5_le, "V5")
    export_v5(v5_m, v5_le, feature_names, v5_t1, v5_t3, len(df), agencies)
    mirror_to_lib()
    print("\nDone. Models copied to functions/lib/.")

if __name__ == "__main__":
    main()
