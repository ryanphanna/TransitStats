"""
TransitStats — Route Prediction Training Script
Trains V4 (logistic regression) and V5 (XGBoost) route classifiers.
Replaces the manual notebook workflow for V4/V5 route models.

Features: agency/start_stop/last_stop/previous_route (one-hot), hour (sin/cos), day (sin/cos)
Target: route_base (agency-aware normalized route family)

Outputs:
  ml/model_v4.json          — logistic regression weights (loaded by predict_v4.js)
  ml/model_v5.onnx          — XGBoost ONNX model (loaded by predict_v5.js)
  ml/model_v5_meta.json     — feature names + class labels for ONNX inference

Usage:
  python3 ml/train_routes.py
"""

import json
import math
import os
import re
import sys

import numpy as np
import pandas as pd
from route_normalization import normalize_route_for_ml, load_policies

KEY_PATH = os.path.expanduser("~/Desktop/Dev/Credentials/Firebase for Transit Stats.json")
CSV_PATH = os.path.join(os.path.dirname(__file__), "trips.csv")
OUT_DIR  = os.path.dirname(__file__)
LIB_DIR  = os.path.join(os.path.dirname(__file__), "..", "functions", "lib")


def load_data():
    if not os.path.exists(CSV_PATH):
        print("trips.csv not found — run export_trips.py first")
        sys.exit(1)
    df = pd.read_csv(CSV_PATH)
    print(f"Loaded {len(df)} trips")
    return df


def compute_primary_agency_map(df):
    """
    For each user_id, determine their primary agency in this dataset
    (most frequent agency). This is used so that normalize_route_for_ml
    can apply the 'PRIMARY' collapse policy to the right agency per user,
    matching the dynamic 'default agency based on recent trips' behavior.
    """
    if 'user_id' not in df.columns or 'agency' not in df.columns:
        return {}

    primary_map = {}
    for user, group in df.groupby('user_id'):
        if len(group) > 0:
            primary = group['agency'].value_counts().index[0]
            if pd.notna(primary):
                primary_map[user] = str(primary).strip()

    # Fallback: most common agency overall (useful for small/single-user CSVs)
    if not primary_map and len(df) > 0:
        overall_primary = df['agency'].value_counts().index[0]
        if pd.notna(overall_primary):
            for uid in df['user_id'].dropna().unique():
                primary_map[uid] = str(overall_primary).strip()

    return primary_map


import firebase_admin
from firebase_admin import credentials, firestore

# ... (rest of imports)

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

def clean(df, lib):
    df = df.copy()

    primary_map = compute_primary_agency_map(df)

    def _normalize_route(row):
        agency = row.get('agency')
        user_id = row.get('user_id')
        primary = primary_map.get(user_id) if user_id else None
        return normalize_route_for_ml(agency=agency, route=row.get('route'), primary_agency=primary)

    df['route_base'] = df.apply(_normalize_route, axis=1)
    df['start_time'] = pd.to_datetime(df['start_time'], format='ISO8601', utc=True)
    
    # Canonicalize stops
    df["start_stop"] = df["start_stop"].apply(lambda x: canonicalize_stop(x, lib))
    df["end_stop"] = df["end_stop"].apply(lambda x: canonicalize_stop(x, lib))

    # Add sequence features: last_end_stop and prev_route
    df = df.sort_values(["user_id", "start_time"])
    df["last_end_stop"] = df.groupby("user_id")["end_stop"].shift(1).fillna("none")
    
    # Normalize prev_route for consistent feature encoding
    def _normalize_prev_route(row):
        if pd.isna(row['prev_route']) or not row['prev_route']:
            return "none"
        agency = row.get('agency')
        user_id = row.get('user_id')
        primary = primary_map.get(user_id) if user_id else None
        normalized = normalize_route_for_ml(agency=agency, route=row['prev_route'], primary_agency=primary)
        return normalized if normalized else "none"
    
    df["prev_route_base"] = df.apply(_normalize_prev_route, axis=1)

    df = df.dropna(subset=['route_base', 'start_stop', 'hour_of_day', 'day_of_week'])
    
    # Filter to routes with >= 3 trips
    counts = df['route_base'].value_counts()
    df = df[df['route_base'].isin(counts[counts >= 3].index)]
    
    print(f"{len(df)} trips kept after cleaning")
    return df

def build_features(df):
    df = df.copy()
    df['hour_sin'] = np.sin(2 * np.pi * df['hour_of_day'] / 24)
    df['hour_cos'] = np.cos(2 * np.pi * df['hour_of_day'] / 24)
    df['day_sin']  = np.sin(2 * np.pi * df['day_of_week'] / 7)
    df['day_cos']  = np.cos(2 * np.pi * df['day_of_week'] / 7)
    
    def _sanitize(s):
        return re.sub(r'[^a-z0-9]', '_', str(s).lower().strip())

    stop_dummies = pd.get_dummies(df['start_stop'].apply(_sanitize), prefix='stop')
    last_stop_dummies = pd.get_dummies(df['last_end_stop'].apply(_sanitize), prefix='last_stop')
    prev_route_dummies = pd.get_dummies(df['prev_route_base'].str.lower().str.strip(), prefix='prev_route')
    agency_dummies = pd.get_dummies(df['agency'].fillna('unknown').map(_sanitize), prefix='agency')
    
    features = pd.concat([df[['hour_sin', 'hour_cos', 'day_sin', 'day_cos']],
                          agency_dummies, stop_dummies, last_stop_dummies, prev_route_dummies], axis=1)
    return features, stop_dummies.columns.tolist()


def train_v4(X_train, y_train):
    from sklearn.linear_model import LogisticRegression
    model = LogisticRegression(max_iter=1000, class_weight='balanced')
    model.fit(X_train, y_train)
    return model


def train_v5(X_train, y_train):
    from xgboost import XGBClassifier
    from sklearn.preprocessing import LabelEncoder
    le = LabelEncoder()
    le.fit(y_train)
    y_enc = le.transform(y_train)
    model = XGBClassifier(
        n_estimators=200, max_depth=4, learning_rate=0.1,
        eval_metric='mlogloss', random_state=42, verbosity=0,
    )
    # Train on numpy array so XGBoost doesn't embed named features —
    # onnxmltools requires features named f0/f1/... not human-readable names.
    # Feature order is preserved; names are tracked separately in meta.json.
    model.fit(X_train.to_numpy(), y_enc)
    return model, le


def evaluate(v4_model, v5_model, v5_le, X_test, y_test):
    from sklearn.metrics import top_k_accuracy_score
    from sklearn.preprocessing import LabelEncoder

    y_pred_v4   = v4_model.predict(X_test)
    y_proba_v4  = v4_model.predict_proba(X_test)
    top1_v4 = (y_pred_v4 == y_test.values).mean()
    top3_v4 = top_k_accuracy_score(y_test, y_proba_v4, k=3, labels=v4_model.classes_)

    y_test_enc  = v5_le.transform(y_test)
    y_proba_v5  = v5_model.predict_proba(X_test)
    y_pred_v5   = v5_le.inverse_transform(v5_model.predict(X_test))
    top1_v5 = (y_pred_v5 == y_test.values).mean()
    top3_v5 = top_k_accuracy_score(y_test_enc, y_proba_v5, k=3,
                                    labels=list(range(len(v5_le.classes_))))

    print(f"\n=== Route Model Results ===")
    print(f"V4 Logistic Regression — Top-1: {top1_v4:.1%}   Top-3: {top3_v4:.1%}")
    print(f"V5 XGBoost            — Top-1: {top1_v5:.1%}   Top-3: {top3_v5:.1%}")
    print(f"Delta                 — Top-1: {(top1_v5-top1_v4)*100:+.1f}pp   Top-3: {(top3_v5-top3_v4)*100:+.1f}pp")
    return top1_v4, top3_v4, top1_v5, top3_v5


def export_v4(model, feature_names, stop_columns, top1, top3, n_trips, agencies):
    export = {
        'classes': model.classes_.tolist(),
        'coef': model.coef_.tolist(),
        'intercept': model.intercept_.tolist(),
        'feature_names': feature_names,
        'stop_columns': stop_columns,
        'feature_schema_version': 2,
        'agencies': sorted(agencies),
    }
    path = os.path.join(OUT_DIR, 'model_v4.json')
    with open(path, 'w') as f:
        json.dump(export, f)
    print(f"V4 route model → {path}")

    lib_path = os.path.join(LIB_DIR, 'model_v4.json')
    with open(lib_path, 'w') as f:
        json.dump(export, f)
    print(f"V4 route model → {lib_path}")

    meta = {
        'type': 'logistic_regression_route', 'version': '4',
        'classes': model.classes_.tolist(), 'feature_names': feature_names,
        'top1_accuracy': round(top1, 4), 'top3_accuracy': round(top3, 4), 'n_trips': n_trips,
        'feature_schema_version': 2, 'agencies': sorted(agencies),
    }
    for dest in [os.path.join(OUT_DIR, 'model_v4_meta.json'),
                 os.path.join(LIB_DIR, 'model_v4_meta.json')]:
        with open(dest, 'w') as f:
            json.dump(meta, f, indent=2)
        print(f"V4 meta → {dest}")


def export_v5(model, le, feature_names, top1, top3, n_trips, agencies):
    # Export via XGBoost's native ONNX support (XGBoost 1.7+)
    import onnxmltools
    from onnxmltools.convert.common.data_types import FloatTensorType

    path_onnx = os.path.join(OUT_DIR, 'model_v5.onnx')
    try:
        initial_type = [('float_input', FloatTensorType([None, len(feature_names)]))]
        onx = onnxmltools.convert_xgboost(
            model.get_booster(), initial_types=initial_type, target_opset=12
        )
        onnx_bytes = onx.SerializeToString()
    except Exception as e:
        print(f"onnxmltools failed: {e}")
        sys.exit(1)

    for dest in [path_onnx, os.path.join(LIB_DIR, 'model_v5.onnx')]:
        with open(dest, 'wb') as f:
            f.write(onnx_bytes)
        print(f"V5 route model → {dest}")

    meta = {
        'type': 'xgboost_route',
        'version': '5',
        'classes': le.classes_.tolist(),
        'feature_names': feature_names,
        'top1_accuracy': round(top1, 4),
        'top3_accuracy': round(top3, 4),
        'n_trips': n_trips,
        'feature_schema_version': 2,
        'agencies': sorted(agencies),
    }
    for dest in [os.path.join(OUT_DIR, 'model_v5_meta.json'),
                 os.path.join(LIB_DIR, 'model_v5_meta.json')]:
        with open(dest, 'w') as f:
            json.dump(meta, f, indent=2)
        print(f"V5 meta → {dest}")


def main():
    load_policies()

    df = load_data()
    lib = load_stops_library()
    df = clean(df, lib)
    features, stop_columns = build_features(df)
    feature_names = features.columns.tolist()
    labels = df['route_base']

    split = max(1, int(len(df) * 0.2))
    ordered = df.sort_values('start_time').index
    test_index = ordered[-split:]
    train_index = ordered[:-split]
    X_train, X_test = features.loc[train_index], features.loc[test_index]
    y_train, y_test = labels.loc[train_index], labels.loc[test_index]
    print(f"\nTrain: {len(X_train)}  Test: {len(X_test)}")
    print(f"Features: {len(feature_names)}  |  Route classes: {labels.nunique()}\n")

    print("Training V4 (logistic regression)...")
    v4_model = train_v4(X_train, y_train)

    print("Training V5 (XGBoost)...")
    v5_model, v5_le = train_v5(X_train, y_train)

    top1_v4, top3_v4, top1_v5, top3_v5 = evaluate(v4_model, v5_model, v5_le, X_test, y_test)

    print("\nExporting models...")
    agencies = df['agency'].fillna('unknown').astype(str).str.strip().unique().tolist()
    export_v4(v4_model, feature_names, stop_columns, top1_v4, top3_v4, len(df), agencies)
    export_v5(v5_model, v5_le, feature_names, top1_v5, top3_v5, len(df), agencies)

    print("\nDone. Models copied to functions/lib/.")
    return top1_v4, top3_v4, top1_v5, top3_v5


if __name__ == "__main__":
    main()
