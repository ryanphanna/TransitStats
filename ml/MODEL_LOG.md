# Model Log

Accuracy history for each trained TransitStats prediction model generation.
One entry per trained version. See `docs/INTELLIGENCE.md` for full engineering notes.

---

## Auto-retrain — 2026-09-07

### End-Stop Models

| Model | Top-1 | Top-3 | Classes | Trips |
|---|---|---|---|---|
| V5 XGBoost | 75.8% | 95.2% | 9 | 311 |
| V4 LogReg  | 77.4% | 95.2% | 9 | 311 |

### Route Models

| Model | Top-1 | Top-3 | Classes | Trips |
|---|---|---|---|---|
| V5 XGBoost | 60.9% | 82.6% | 21 | 690 |
| V4 LogReg  | 59.4% | 84.1% | 21 | 690 |

---

## Agency-scoped rebuild — 2026-09-05

The route and end-stop artifacts now use `agency::label` classes, explicit agency features, semantic directions, and chronological holdouts. Legacy artifacts are no longer accepted by runtime eligibility checks.

| Model | Top-1 | Top-3 | Classes | Trips | Agencies |
|---|---:|---:|---:|---:|---|
| V5 route | 57.0% | 81.5% | 21 | 676 | 5 |
| V4 route | 55.6% | 83.7% | 21 | 676 | 5 |
| V5 end-stop | 73.3% | 96.7% | 9 | 304 | 1 |
| V4 end-stop | 78.3% | 98.3% | 9 | 304 | 1 |

These chronological metrics replace the earlier random-split numbers for promotion decisions.

---

## Auto-retrain — 2026-08-10

### End-Stop Models

| Model | Top-1 | Top-3 | Classes | Trips |
|---|---|---|---|---|
| V5 XGBoost | 86.7% | 96.7% | 8 | 299 |
| V4 LogReg  | 85.0% | 98.3% | 8 | 299 |

### Route Models

| Model | Top-1 | Top-3 | Classes | Trips |
|---|---|---|---|---|
| V5 XGBoost | 84.0% | 89.6% | 20 | 625 |
| V4 LogReg  | 71.2% | 88.8% | 20 | 625 |

---

## Auto-retrain — 2026-08-03

### End-Stop Models

| Model | Top-1 | Top-3 | Classes | Trips |
|---|---|---|---|---|
| V5 XGBoost | 89.8% | 93.2% | 8 | 293 |
| V4 LogReg  | 89.8% | 98.3% | 8 | 293 |

### Route Models

| Model | Top-1 | Top-3 | Classes | Trips |
|---|---|---|---|---|
| V5 XGBoost | 82.1% | 89.4% | 20 | 614 |
| V4 LogReg  | 67.5% | 89.4% | 20 | 614 |

---

## Auto-retrain — 2026-07-27

### End-Stop Models

| Model | Top-1 | Top-3 | Classes | Trips |
|---|---|---|---|---|
| V5 XGBoost | 84.8% | 93.2% | 8 | 291 |
| V4 LogReg  | 78.0% | 98.3% | 8 | 291 |

### Route Models

| Model | Top-1 | Top-3 | Classes | Trips |
|---|---|---|---|---|
| V5 XGBoost | 84.3% | 88.4% | 20 | 604 |
| V4 LogReg  | 74.4% | 89.3% | 20 | 604 |

---

## Auto-retrain — 2026-07-20

### End-Stop Models

| Model | Top-1 | Top-3 | Classes | Trips |
|---|---|---|---|---|
| V5 XGBoost | 84.2% | 98.2% | 8 | 283 |
| V4 LogReg  | 86.0% | 98.2% | 8 | 283 |

### Route Models

| Model | Top-1 | Top-3 | Classes | Trips |
|---|---|---|---|---|
| V5 XGBoost | 84.8% | 89.8% | 20 | 588 |
| V4 LogReg  | 72.0% | 88.1% | 20 | 588 |

---

## Auto-retrain — 2026-07-13

### End-Stop Models

| Model | Top-1 | Top-3 | Classes | Trips |
|---|---|---|---|---|
| V5 XGBoost | 94.2% | 98.1% | 7 | 256 |
| V4 LogReg  | 92.3% | 98.1% | 7 | 256 |

### Route Models

| Model | Top-1 | Top-3 | Classes | Trips |
|---|---|---|---|---|
| V5 XGBoost | 77.4% | 85.2% | 20 | 571 |
| V4 LogReg  | 69.6% | 87.0% | 20 | 571 |

---

## V5.5 — XGBoost End Stop

| Field | Value |
|---|---|
| **Date trained** | 2026-06-09 |
| **Algorithm** | XGBoost (`n_estimators=200`, `max_depth=4`, `learning_rate=0.1`) |
| **Trip count** | 288 (after cleaning) |
| **Top-1 accuracy** | 84.5% |
| **Top-3 accuracy** | 91.4% |
| **Classes** | 19 end stops |
| **Features** | hour_sin/cos, day_sin/cos, start_stop (one-hot), route (one-hot), prev_route (one-hot), last_end_stop (one-hot), trip gap, direction (one-hot) |
| **Status** | Shadow mode |

**Notes:** +7.9pp over V5.3 (76.6% → 84.5%). Major improvements this session: (1) added direction as a one-hot feature — root cause of V4/V5 production accuracy gap was Route 1 northbound/southbound trips being indistinguishable; (2) fixed training/inference feature name skew — `stop_*` and `last_stop_*` features were silently zero in all prior inference because Python exported `stop_bay station` (spaces) but JS generated `stop_bay_station` (underscores); (3) fixed `last_stop_none` vs `last_stop_unknown` mismatch on first trip of day; (4) fixed `" and "` separator not handled in JS canonicalization; (5) fixed V4 `transfer_rarity` never set in route inference; (6) stop library backfill added 35 trips (stops 845, 815, 2040, 161, 162). New 19th end-stop class. Dataset grew 234 → 288 cleaned trips.

---

## V4.5 — Logistic Regression End Stop

| Field | Value |
|---|---|
| **Date trained** | 2026-06-09 |
| **Algorithm** | Logistic Regression (scikit-learn, `class_weight='balanced'`, `max_iter=1000`) |
| **Trip count** | 288 (same dataset as V5.4) |
| **Top-1 accuracy** | 75.9% |
| **Top-3 accuracy** | 91.4% |
| **Classes** | 19 end stops |
| **Features** | Same as V5.4 |
| **Status** | Shadow mode |

**Notes:** +7.8pp over V4.3 (68.1% → 75.9%). Same fixes as V5.4. Direction + stop signal now both working for the first time in inference.

---

## V5.5 — XGBoost Route

| Field | Value |
|---|---|
| **Date trained** | 2026-06-09 |
| **Algorithm** | XGBoost (`n_estimators=200`, `max_depth=4`, `learning_rate=0.1`) |
| **Trip count** | 522 (after cleaning) |
| **Top-1 accuracy** | 81.9% |
| **Top-3 accuracy** | 87.6% |
| **Classes** | 20 routes |
| **Features** | hour_sin/cos, day_sin/cos, start_stop (one-hot), last_end_stop (one-hot), prev_route (one-hot), transfer_rarity |
| **Status** | Shadow mode |

**Notes:** +14.9pp over V5.3 (67.0% → 81.9%). Stop feature name fix now applies here too — start_stop and last_stop were also zeroed in route inference. transfer_rarity now averaged across classes rather than taking first match.

---

## V4.5 — Logistic Regression Route

| Field | Value |
|---|---|
| **Date trained** | 2026-06-09 |
| **Algorithm** | Logistic Regression (scikit-learn, `class_weight='balanced'`, `max_iter=1000`) |
| **Trip count** | 522 (same dataset as V5.4) |
| **Top-1 accuracy** | 63.8% |
| **Top-3 accuracy** | 83.8% |
| **Classes** | 20 routes |
| **Features** | Same as V5.4 |
| **Status** | Shadow mode |

**Notes:** +3.6pp over V4.3 (60.2% → 63.8%). transfer_rarity now set correctly in inference (was always 0 before).

---

## V5.3 — XGBoost End Stop

| Field | Value |
|---|---|
| **Date trained** | 2026-05-11 |
| **Algorithm** | XGBoost (`n_estimators=200`, `max_depth=4`, `learning_rate=0.1`) |
| **Trip count** | 234 (after cleaning — routes+stops with ≥5 trips, end stops with ≥3 occurrences) |
| **Top-1 accuracy** | 76.6% |
| **Top-3 accuracy** | 89.4% |
| **Classes** | 15 end stops |
| **Features** | hour_sin/cos, day_sin/cos, start_stop (one-hot), route (one-hot), prev_route (one-hot), last_end_stop (one-hot), trip gap (`gap_log`, `gap_missing`) |
| **Status** | Shadow mode |

**Notes:** Marginal dip vs V5.2 (78.7% → 76.6%) on the same 234-trip cleaning slice despite 54 more raw trips exported (483 vs 429). Likely test split variance — the cleaned end stop dataset didn't grow. Route classes expanded from 18 to 20 with new Yonge arm trips starting today, which may shift the feature distribution slightly over time.

---

## V4.3 — Logistic Regression End Stop

| Field | Value |
|---|---|
| **Date trained** | 2026-05-11 |
| **Algorithm** | Logistic Regression (scikit-learn, `class_weight='balanced'`, `max_iter=1000`) |
| **Trip count** | 234 (same dataset as V5.3) |
| **Top-1 accuracy** | 68.1% |
| **Top-3 accuracy** | 93.6% |
| **Classes** | 15 end stops |
| **Features** | Same as V5.3 |
| **Status** | Shadow mode |

**Notes:** Identical to V4.2 — end stop dataset unchanged.

---

## V5.3 — XGBoost Route

| Field | Value |
|---|---|
| **Date trained** | 2026-05-11 |
| **Algorithm** | XGBoost (`n_estimators=200`, `max_depth=4`, `learning_rate=0.1`) |
| **Trip count** | 438 (after cleaning) |
| **Top-1 accuracy** | 67.0% |
| **Top-3 accuracy** | 81.8% |
| **Classes** | 20 routes |
| **Features** | hour_sin/cos, day_sin/cos, start_stop (one-hot), last_end_stop (one-hot) |
| **Status** | Shadow mode |

**Notes:** Slight dip vs V5.2 (70.9% → 67.0%) with 2 new route classes from the Yonge arm commute starting today. More classes + same dataset size = harder classification problem. Expect accuracy to recover as Yonge arm trips accumulate.

---

## V4.3 — Logistic Regression Route

| Field | Value |
|---|---|
| **Date trained** | 2026-05-11 |
| **Algorithm** | Logistic Regression (scikit-learn, `class_weight='balanced'`, `max_iter=1000`) |
| **Trip count** | 438 (same dataset as V5.3) |
| **Top-1 accuracy** | 60.2% |
| **Top-3 accuracy** | 80.7% |
| **Classes** | 20 routes |
| **Features** | Same as V5.3 |
| **Status** | Shadow mode |

---

## V5.2 — XGBoost End Stop

| Field | Value |
|---|---|
| **Date trained** | 2026-05-09 |
| **Algorithm** | XGBoost (`n_estimators=200`, `max_depth=4`, `learning_rate=0.1`) |
| **Trip count** | 234 (after cleaning — routes+stops with ≥5 trips, end stops with ≥3 occurrences) |
| **Top-1 accuracy** | 78.7% |
| **Top-3 accuracy** | 89.4% |
| **Classes** | 15 end stops |
| **Features** | hour_sin/cos, day_sin/cos, start_stop (one-hot), route (one-hot), prev_route (one-hot), last_end_stop (one-hot), trip gap (`gap_log`, `gap_missing`) |
| **Status** | Shadow mode |

**Notes:** Large top-1 gain versus the 2026-04-14 end-stop model after a much bigger reviewed dataset export. Adding `prev_route` and trip-gap features did not move V5 on this split, which suggests the current XGBoost setup is not yet extracting extra value from the new sequence signals at this dataset size.

---

## V4.2 — Logistic Regression End Stop

| Field | Value |
|---|---|
| **Date trained** | 2026-05-09 |
| **Algorithm** | Logistic Regression (scikit-learn, `class_weight='balanced'`, `max_iter=1000`) |
| **Trip count** | 234 (same dataset as V5.2) |
| **Top-1 accuracy** | 68.1% |
| **Top-3 accuracy** | 93.6% |
| **Classes** | 15 end stops |
| **Features** | hour_sin/cos, day_sin/cos, start_stop (one-hot), route (one-hot), prev_route (one-hot), last_end_stop (one-hot), trip gap (`gap_log`, `gap_missing`) |
| **Status** | Shadow mode |

**Notes:** The same `prev_route` and trip-gap experiment helped V4 materially, improving both top-1 and top-3 accuracy on the held-out split. This suggests the new sequence features are directionally useful, even though V5 did not benefit yet.

---

## V5.2 — XGBoost Route

| Field | Value |
|---|---|
| **Date trained** | 2026-05-09 |
| **Algorithm** | XGBoost (`n_estimators=200`, `max_depth=4`, `learning_rate=0.1`) |
| **Trip count** | 429 (after cleaning) |
| **Top-1 accuracy** | 70.9% |
| **Top-3 accuracy** | 82.6% |
| **Classes** | 18 routes |
| **Features** | hour_sin/cos, day_sin/cos, start_stop (one-hot), last_end_stop (one-hot) |
| **Status** | Shadow mode |

**Notes:** Big improvement over the 2026-04-13 route benchmark. The key fix was agency-aware route normalization: TTC branch/shuttle/short-turn labels now collapse into their base route family, while non-TTC labels like `Red`, `K`, and `N` keep their identity. Remaining misses still cluster around overlapping TTC corridors, especially `1`, `2`, `510`, and `506`, where the same stations or nearby aliases appear across multiple route families.

---

## V4.2 — Logistic Regression Route

| Field | Value |
|---|---|
| **Date trained** | 2026-05-09 |
| **Algorithm** | Logistic Regression (scikit-learn, `class_weight='balanced'`, `max_iter=1000`) |
| **Trip count** | 429 (same dataset as V5.2) |
| **Top-1 accuracy** | 62.8% |
| **Top-3 accuracy** | 84.9% |
| **Classes** | 18 routes |
| **Features** | hour_sin/cos, day_sin/cos, start_stop (one-hot), last_end_stop (one-hot) |
| **Status** | Shadow mode |

---

## V5.1 — XGBoost End Stop

| Field | Value |
|---|---|
| **Date trained** | 2026-04-14 |
| **Algorithm** | XGBoost (`n_estimators=200`, `max_depth=4`, `learning_rate=0.1`) |
| **Trip count** | 114 (after cleaning — routes+stops with ≥5 trips, end stops with ≥3 occurrences) |
| **Top-1 accuracy** | 47.8% |
| **Top-3 accuracy** | 95.7% |
| **Classes** | 11 end stops |
| **Features** | hour_sin/cos, day_sin/cos, start_stop (one-hot), route (one-hot) |
| **Topology filter** | Pre-filter before probability read — impossible stops zeroed, renormalized |
| **Status** | Shadow mode |

---

## V4.1 — Logistic Regression End Stop

| Field | Value |
|---|---|
| **Date trained** | 2026-04-14 |
| **Algorithm** | Logistic Regression (scikit-learn, `class_weight='balanced'`, `max_iter=1000`) |
| **Trip count** | 114 (same dataset as V5.1) |
| **Top-1 accuracy** | 39.1% |
| **Top-3 accuracy** | 87.0% |
| **Classes** | 11 end stops |
| **Features** | hour_sin/cos, day_sin/cos, start_stop (one-hot), route (one-hot) |
| **Topology filter** | Pre-filter before softmax — impossible stops set to -Infinity |
| **Status** | Shadow mode |

---

## V4 — Logistic Regression

| Field | Value |
|---|---|
| **Date trained** | 2026-04-13 |
| **Algorithm** | Logistic Regression (scikit-learn, `class_weight='balanced'`, `max_iter=1000`) |
| **Trip count** | 385 (Jan–Apr 2026) |
| **Top-1 accuracy** | 52.1% |
| **Top-3 accuracy** | 74.6% |
| **Classes** | 14 routes |
| **Features** | hour_sin/cos, day_sin/cos, start_stop (one-hot, 127 stops) |
| **Status** | Shadow mode (live alongside V3) |

**Notes:** Strong on dominant routes (1, 2, 510). Weak on rare routes with < 5 trips. Correctly inferred stop→route geography from trip history alone (no GTFS given).

---

## V5 — XGBoost

| Field | Value |
|---|---|
| **Date benchmarked** | 2026-04-13 |
| **Algorithm** | XGBoost (`n_estimators=200`, `max_depth=4`, `learning_rate=0.1`) |
| **Trip count** | 385 (same dataset as V4) |
| **Top-1 accuracy** | 60.6% (+8.5pp vs V4) |
| **Top-3 accuracy** | 80.3% (+5.6pp vs V4) |
| **Classes** | 14 routes |
| **Features** | Same as V4 (hour_sin/cos, day_sin/cos, start_stop one-hot) |
| **Status** | Shadow mode (live alongside V3 and V4) |

**Notes:** Beats V4 on identical features — gain comes entirely from XGBoost discovering stop × time-of-day interactions the linear model can't express. Tested adding `minutes_since_last_trip` and `prev_route` — both hurt accuracy at this dataset size (385 trips). Revisit at ~1000 trips.
