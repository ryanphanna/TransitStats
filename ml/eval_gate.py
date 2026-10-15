"""
TransitStats — retrain gate for the END-STOP models (V4 + V5). EVAL.md, "Retrain gate v1".

Runs in the weekly retrain after training and before upload. It scores the training pipeline
(train_endstop.py's own clean / apply_count_filters / build_features / train_v4 / train_v5) with
walk-forward folds on a fixed calendar, so the same trip gets the same fold, and the same training
rows, every week. It then compares the candidate with the published model set row by row.

  python3 ml/eval_gate.py --csv ml/trips.csv --stops-json stops.json --out ml/eval_rows.json \
      --version <model version> [--published eval_rows.json | --fetch-published] [--candidate-dir ml]

Exit codes: 0 pass, 1 rejected, 2 internal error. Anything but 0 must stop the upload.

Privacy: the repo and its Actions logs are public. This script prints aggregates only, and on an
error it prints the exception type and file:line, never the message (pandas messages can contain
stop names). eval_rows.json holds a salted hash of each trip id, never the id; it is uploaded only
to the private models/<version>/ path.
"""

import argparse
import hashlib
import hmac
import importlib.util
import json
import math
import os
import re
import sys
import traceback
from datetime import datetime, timedelta, timezone

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

GATE_VERSION = 1
FOLD_ANCHOR = datetime(2026, 5, 1, tzinfo=timezone.utc)  # same anchor as ml/eval/harness.py
FOLD_DAYS = 14
WINDOW_DAYS = 90
MODELS = ("v4", "v5")

# Rules (EVAL.md "Retrain gate v1" has the reasoning).
MAX_POINT_DROP = 0.05          # paired top-1 drop, applied when the overlap is at least:
MIN_OVERLAP_FOR_DROP = 100
MIN_OVERLAP_PAIRED = 50        # below this the paired comparison is meaningless: use the floors
MAX_COVERAGE_DROP = 0.05
MAX_ROW_DROP = 0.20            # eval rows vs published: a bigger fall means a broken export
MIN_CLASSES = 3
FIRST_RUN_MARGIN = 0.05        # first run: top-1 >= baseline top-1 - 5 points
MIN_ROWS = 50
BOOTSTRAP = 2000
SEED = 20260501

EVAL_ROWS_FILE = "eval_rows.json"


class GateError(Exception):
    """A gate failure whose message is safe to print (no trip data)."""


# ---------------------------------------------------------------------------
# Fold calendar
# ---------------------------------------------------------------------------

def fold_index(ts):
    """Fixed 14-day folds anchored at 2026-05-01 UTC. Stable across exports."""
    return math.floor((ts - FOLD_ANCHOR) / timedelta(days=FOLD_DAYS))


def fold_start(k):
    return FOLD_ANCHOR + timedelta(days=FOLD_DAYS * k)


def fold_id(k):
    return fold_start(k).date().isoformat()


def window_start(newest):
    return newest - timedelta(days=WINDOW_DAYS)


# ---------------------------------------------------------------------------
# Row keys
# ---------------------------------------------------------------------------

def resolve_salt(env=os.environ):
    """A secret that stays the same week to week, or no rows overlap. EVAL_ROW_SALT if set, else an
    HMAC of the TRAIN_USER_IDS secret (already present in CI). Fails closed without either."""
    if env.get("EVAL_ROW_SALT"):
        return env["EVAL_ROW_SALT"].encode("utf-8")
    ids = sorted(u.strip() for u in env.get("TRAIN_USER_IDS", "").split(",") if u.strip())
    if ids:
        return hmac.new(b"transitstats-eval-rows-v1", ",".join(ids).encode("utf-8"), hashlib.sha256).digest()
    raise GateError("no salt: set EVAL_ROW_SALT or TRAIN_USER_IDS")


def row_key(salt, trip_id):
    return hmac.new(salt, str(trip_id).encode("utf-8"), hashlib.sha256).hexdigest()[:20]


# ---------------------------------------------------------------------------
# Grading (owned by the gate, so every pipeline is graded the same way)
# ---------------------------------------------------------------------------

def _norm_stop(s):
    """ml_utils.canonicalizeStop's string steps, pinned here for gate v1."""
    s = str(s).strip().lower()
    s = re.sub(r"\s+and\s+", "/", s)
    s = re.sub(r"\s*[/&@]\s*", "/", s)
    s = re.sub(r"\s+at\s+", "/", s)
    return s


class Grader:
    """Truth = the exported end stop, prediction = the model's class label without its agency
    prefix; both go through the same stops-library canonicalization. A pipeline that changes its
    own labels (or collapses them) cannot grade itself better."""

    def __init__(self, lib):
        self.alias = {}
        for item in lib:
            name = item.get("name")
            if not name:
                continue
            for c in [name] + list(item.get("aliases") or []):
                self.alias.setdefault(_norm_stop(c), _norm_stop(name))

    def canon(self, stop):
        n = _norm_stop(stop)
        return self.alias.get(n, n)

    def label(self, cls):
        return self.canon(str(cls).split("::", 1)[-1])


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def load_pipeline(path=None):
    """train_endstop.py from ml/ (default), or another copy (the local 'published' simulation)."""
    path = path or os.path.join(HERE, "train_endstop.py")
    sys.path.insert(0, os.path.dirname(os.path.abspath(path)))
    sys.path.insert(1, HERE)  # route_normalization etc.
    name = "endstop_pipeline_" + hashlib.sha1(os.path.abspath(path).encode()).hexdigest()[:8]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _apply_filters(P, df):
    if hasattr(P, "apply_count_filters"):
        out = P.apply_count_filters(df)
    else:  # pragma: no cover - older pipelines filter inside clean()
        raise GateError("pipeline has no apply_count_filters")
    return out


def _ranked(model, le, X):
    proba = model.predict_proba(X)
    labels = np.asarray(le.inverse_transform(model.classes_))
    order = np.argsort(-proba, axis=1)[:, :3]
    return labels[order]


def walk_forward(P, raw, lib, salt, log=print):
    """raw: the export DataFrame (export_trips.py columns). Returns (rows, info).
    rows: one dict per eval row: key, fold, and [top1, top3, covered] for v4, v5 and the baseline
    (most-frequent end stop at route + start stop in the fold's training rows)."""
    import pandas as pd
    import warnings
    warnings.filterwarnings("ignore")

    if raw.empty:
        raise GateError("export is empty")
    grader = Grader(lib)
    raw = raw.copy()
    raw["_truth"] = raw["end_stop"].map(grader.canon)
    df = P.clean(raw, lib, apply_filters=False).reset_index(drop=True)
    df["_start"] = pd.to_datetime(df["start_time"], utc=True, format="ISO8601")
    df = df[df["_start"].notna()].reset_index(drop=True)
    if df.empty:
        raise GateError("no rows with a start time")
    newest = df["_start"].max().to_pydatetime()
    w0 = window_start(newest)
    df["_fold"] = df["_start"].map(lambda t: fold_index(t.to_pydatetime()))
    in_window = df["_start"] >= w0
    folds = sorted(int(k) for k in df.loc[in_window, "_fold"].unique())

    rows, info = [], {"folds": [], "newest_fold": None, "classes_last_fold": {}}
    for k in folds:
        fs = fold_start(k)
        test = df[in_window & (df["_fold"] == k)]
        train = _apply_filters(P, df[df["_start"] < fs].copy()).reset_index(drop=True)
        unfiltered = df[df["_start"] < fs]
        ok = len(train) >= 20 and train["end_stop_key"].nunique() >= 2
        preds = {}
        if ok:
            Xtr = P.build_features(train).astype(float)
            Xte = P.build_features(test).reindex(columns=Xtr.columns, fill_value=0).astype(float)
            ytr = train["end_stop_key"]
            classes = sorted(ytr.unique())
            w = P.compute_ride_count_weights(train)
            m4, le4 = P.train_v4(Xtr, ytr, classes, weights_train=w)
            preds["v4"] = _ranked(m4, le4, Xte)
            m5, le5 = P.train_v5(Xtr, ytr, classes, weights_train=w)
            preds["v5"] = _ranked(m5, le5, Xte.values)
            agencies = set(train["agency_id"].dropna())
            info["classes_last_fold"] = {"v4": len(classes), "v5": len(classes)}
        # Baseline: most frequent end stop at (route, start stop) over all training rows.
        base = (unfiltered.groupby(["route_key", "start_stop"])["_truth"]
                .agg(lambda s: s.value_counts().index.tolist()[:3]).to_dict()) if len(unfiltered) else {}
        for i, (_, r) in enumerate(test.iterrows()):
            y = r["_truth"]
            row = {"k": row_key(salt, r["trip_id"]), "fold": fold_id(k)}
            for m in MODELS:
                if ok and r["agency_id"] in agencies:
                    top = [grader.label(c) for c in preds[m][i]]
                    row[m] = [int(top[0] == y), int(y in top[:3]), 1]
                else:
                    row[m] = [0, 0, 0]
            b = base.get((r["route_key"], r["start_stop"]))
            row["base"] = [int(b[0] == y), int(y in b[:3]), 1] if b else [0, 0, 0]
            rows.append(row)
        info["folds"].append({"fold": fold_id(k), "rows": int(len(test)), "train_rows": int(len(train)), "fit": bool(ok)})
        info["newest_fold"] = fold_id(k)
    return rows, info


def summarize(rows):
    n = len(rows)
    out = {"n_rows": n}
    for m in MODELS + ("base",):
        if n:
            a = np.array([r[m] for r in rows])
            out[m] = {"top1": float(a[:, 0].mean()), "top3": float(a[:, 1].mean()), "coverage": float(a[:, 2].mean())}
        else:
            out[m] = {"top1": 0.0, "top3": 0.0, "coverage": 0.0}
    return out


# ---------------------------------------------------------------------------
# Decision
# ---------------------------------------------------------------------------

def paired(cand_rows, pub_rows, model, seed=SEED, n_boot=BOOTSTRAP):
    """Paired top-1 / coverage difference on rows present in both (same key and fold)."""
    pub = {(r["k"], r["fold"]): r for r in pub_rows if model in r}
    c, p = [], []
    for r in cand_rows:
        q = pub.get((r["k"], r["fold"]))
        if q is not None:
            c.append(r[model])
            p.append(q[model])
    n = len(c)
    if n == 0:
        return {"n": 0, "diff": 0.0, "lo": 0.0, "hi": 0.0, "cov_diff": 0.0}
    c, p = np.array(c, dtype=float), np.array(p, dtype=float)
    d = c[:, 0] - p[:, 0]
    rng = np.random.default_rng(seed)
    boots = d[rng.integers(0, n, size=(n_boot, n))].mean(axis=1)
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return {"n": n, "diff": float(d.mean()), "lo": float(lo), "hi": float(hi),
            "cov_diff": float((c[:, 2] - p[:, 2]).mean()),
            "discordant": int((d != 0).sum())}


def decide(cand, published=None, n_classes=None):
    """cand / published: eval_rows documents. Returns (failures, report)."""
    failures, report = [], {"path": None}
    rows = cand["rows"]
    n = len(rows)
    classes = n_classes if n_classes is not None else cand.get("n_classes", {})
    for m in MODELS:
        if classes.get(m) is not None and classes[m] < MIN_CLASSES:
            failures.append(f"{m}: only {classes[m]} end-stop classes (minimum {MIN_CLASSES})")

    pub_rows = published.get("rows", []) if published else []
    overlap = paired(rows, pub_rows, MODELS[0])["n"] if published else 0
    if published:
        pub_n = int(published.get("summary", {}).get("n_rows", len(pub_rows)))
        if pub_n and n < (1 - MAX_ROW_DROP) * pub_n:
            failures.append(f"eval rows fell from {pub_n} to {n} (more than {MAX_ROW_DROP:.0%}): broken export?")

    if published and overlap >= MIN_OVERLAP_PAIRED:
        report["path"] = "paired"
        for m in MODELS:
            pr = paired(rows, pub_rows, m)
            report[m] = pr
            if pr["hi"] < 0:
                failures.append(f"{m}: paired top-1 {pr['diff']:+.1%}, 95% CI upper bound {pr['hi']:+.1%} < 0")
            if pr["n"] >= MIN_OVERLAP_FOR_DROP and pr["diff"] < -MAX_POINT_DROP:
                failures.append(f"{m}: paired top-1 dropped {-pr['diff']:.1%} on {pr['n']} rows (limit {MAX_POINT_DROP:.0%})")
            if pr["cov_diff"] < -MAX_COVERAGE_DROP:
                failures.append(f"{m}: coverage dropped {-pr['cov_diff']:.1%} (limit {MAX_COVERAGE_DROP:.0%})")
    else:
        report["path"] = "first-run" if not published else f"floors (overlap {overlap} < {MIN_OVERLAP_PAIRED})"
        s = summarize(rows)
        if n < MIN_ROWS:
            failures.append(f"only {n} eval rows (minimum {MIN_ROWS})")
        for m in MODELS:
            floor = s["base"]["top1"] - FIRST_RUN_MARGIN
            report[m] = {"top1": s[m]["top1"], "floor": floor}
            if s[m]["top1"] < floor:
                failures.append(f"{m}: walk-forward top-1 {s[m]['top1']:.1%} below floor {floor:.1%} "
                                f"(baseline {s['base']['top1']:.1%} - {FIRST_RUN_MARGIN:.0%})")
    return failures, report


# ---------------------------------------------------------------------------
# Published eval rows
# ---------------------------------------------------------------------------

def fetch_published(bucket):
    """The published set's eval_rows.json via models/latest.json, or None when there is none yet.
    Missing pointer or missing file -> None (first run). Any other error propagates (exit 2)."""
    pointer = bucket.blob("models/latest.json")
    if not pointer.exists():
        return None
    version = json.loads(pointer.download_as_bytes())["version"]
    blob = bucket.blob(f"models/{version}/{EVAL_ROWS_FILE}")
    if not blob.exists():
        return None
    doc = json.loads(blob.download_as_bytes())
    doc.setdefault("model_version", version)
    return doc


def _storage_bucket():
    import firebase_admin
    from firebase_admin import credentials, storage
    key = os.environ["GOOGLE_APPLICATION_CREDENTIALS"]
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(key), {"projectId": "transitstats-21ba4"})
    return storage.bucket(os.environ.get("ML_MODEL_BUCKET") or "transitstats-21ba4.firebasestorage.app")


def _candidate_classes(candidate_dir):
    out = {}
    for m, name in (("v4", "model_v4_endstop_meta.json"), ("v5", "model_v5_endstop_meta.json")):
        path = os.path.join(candidate_dir, name)
        if not os.path.exists(path):
            raise GateError(f"candidate {name} is missing")
        out[m] = len(json.load(open(path)).get("classes", []))
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run(args):
    import pandas as pd
    if os.path.exists(args.out):
        os.remove(args.out)  # a stale file must never be uploaded as this run's
    P = load_pipeline(args.pipeline)
    if hasattr(P, "load_policies"):
        P.load_policies()
    lib = json.load(open(args.stops_json))
    raw = pd.read_csv(args.csv)
    salt = resolve_salt()

    rows, info = walk_forward(P, raw, lib, salt)
    summary = summarize(rows)
    n_classes = _candidate_classes(args.candidate_dir) if args.candidate_dir else info["classes_last_fold"]
    doc = {"gate_version": GATE_VERSION, "model_version": args.version, "fold_anchor": FOLD_ANCHOR.date().isoformat(),
           "fold_days": FOLD_DAYS, "window_days": WINDOW_DAYS, "n_classes": n_classes,
           "summary": summary, "folds": info["folds"], "rows": rows}

    published = None
    if args.published:
        published = json.load(open(args.published))
    elif args.fetch_published:
        published = fetch_published(_storage_bucket())

    print(f"Eval gate v{GATE_VERSION}: {summary['n_rows']} rows in {len(info['folds'])} folds "
          f"(last {WINDOW_DAYS} days, {FOLD_DAYS}-day folds from {FOLD_ANCHOR.date()})")
    for m in MODELS + ("base",):
        s = summary[m]
        print(f"  {m:4s} top-1 {s['top1']:.1%}  top-3 {s['top3']:.1%}  coverage {s['coverage']:.1%}")
    print(f"  classes: {n_classes}")
    if published:
        print(f"Published {published.get('model_version')}: {published.get('summary', {}).get('n_rows')} rows")

    failures, report = decide(doc, published, n_classes)
    print(f"Path: {report['path']}")
    for m in MODELS:
        r = report.get(m, {})
        if "diff" in r:
            print(f"  {m}: paired top-1 {r['diff']:+.1%} [{r['lo']:+.1%}, {r['hi']:+.1%}] on {r['n']} rows "
                  f"({r['discordant']} discordant), coverage {r['cov_diff']:+.1%}")
        elif "floor" in r:
            print(f"  {m}: top-1 {r['top1']:.1%} vs floor {r['floor']:.1%}")
    doc["decision"] = {"path": report["path"], "failures": failures}

    if failures:
        print("\nEnd-stop retrain gate FAILED; nothing will be uploaded:", file=sys.stderr)
        for f in failures:
            print(f"- {f}", file=sys.stderr)
        return 1
    with open(args.out, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    print("\nEnd-stop retrain gate passed.")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="End-stop retrain gate (EVAL.md, Retrain gate v1)")
    ap.add_argument("--csv", required=True, help="export_trips.py output")
    ap.add_argument("--stops-json", required=True, help="stops library dumped by the export step")
    ap.add_argument("--out", required=True, help="where to write eval_rows.json (only on pass)")
    ap.add_argument("--version", default="", help="model version this run will be uploaded as")
    ap.add_argument("--published", help="published eval_rows.json (local runs)")
    ap.add_argument("--fetch-published", action="store_true", help="download it via models/latest.json")
    ap.add_argument("--candidate-dir", help="folder with the trained candidate meta files (class counts)")
    ap.add_argument("--pipeline", help="train_endstop.py to score (default: ml/train_endstop.py)")
    args = ap.parse_args(argv)
    try:
        return run(args)
    except GateError as e:
        print(f"End-stop retrain gate ERROR: {e}", file=sys.stderr)
        return 2
    except BaseException as e:  # noqa: BLE001 - fail closed on anything, including SystemExit
        if isinstance(e, KeyboardInterrupt):
            raise
        frames = [f"{os.path.basename(fr.filename)}:{fr.lineno}" for fr in traceback.extract_tb(e.__traceback__)]
        shown = frames if len(frames) <= 6 else frames[:3] + ["..."] + frames[-3:]
        print(f"End-stop retrain gate ERROR: {type(e).__name__} at {' > '.join(shown)}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
