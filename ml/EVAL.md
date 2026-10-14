# Prediction Evaluation

One shared offline harness scores every predictor on the same trips. Aggregates only: this file never lists stop names, trip IDs or per-stop counts.

- Harness: `ml/eval/harness.py`. Serving replay: `ml/eval/replay_js.js`. Tests: `python3 -m unittest ml/eval/test_harness.py`.
- To add a predictor, put a module in `ml/eval/predictors/` that exposes `register(harness)`. It is auto-imported, so parallel branches never edit the harness itself.
- Quick runs: `--task end --only <family>` takes about 10 s. A full run, which retrains V4/V5 per fold, takes about 15 min.

## Eval definition v1

| Item | Value |
|---|---|
| Data snapshot | trips export of 2026-10-14, sha256 prefix `78a4265b1519` (`EVAL_SNAPSHOT`); 1 allowlisted account |
| Eval rows | clean SMS trips (`sms`, `sms_fallback`, `mms`) starting 2026-05-01 to 2026-10-15: **409** rows out of 548 completed SMS trips in the window |
| Clean | the same filter as `getRecentCompletedTrips` (not incomplete/discarded/needs_review, no blocking correction, stop matched), plus route, start stop and end stop present |
| Folds | 12 walk-forward folds of 14 days. V4/V5 are refit at each fold start on clean trips that ended before it. Count filters (≥3 per route, ≥5 per route+stop, ≥10 per end-stop class) use training rows only |
| History-based predictors | each trip sees exactly what serving loads at its start: the newest 100 completed trips by end time, then the clean filter. Sequence features (last end stop, last route, gap) come from `history[0]` |
| Grading | end stop: V3's `_stopMatch` canonicalization, as `finalization.js` grades. Route: `normalizeRouteForGrading`, route only for every predictor (live `predictionStats` also checks direction for V3, so live V3 route numbers differ) |
| Abstentions | count as misses; coverage is reported separately |
| Promotion rule | beat both V3 (as served) and the best baseline on the paired last-90-day slice (160 rows), with the 95% bootstrap CI of the difference above 0 |

Pinned: `EVAL_START`, `EVAL_END`, `FOLD_DAYS` and the snapshot hash. Re-exports print a warning and are not comparable. Any change to the definition bumps `EVAL_VERSION`.

## Baseline results (v1)

Top-1 is over all 409 rows. "vs V3" and "vs B3" are paired top-1 differences on the last 90 days (n=160), in points, with 95% CIs.

### End stop (the prediction users actually see)

| Predictor | Top-1 [95% CI] | Top-3 | Coverage | vs V3 (90d) | vs B3 full (90d) |
|---|---|---|---|---|---|
| V3 (as served), and what users are shown | 27.9% [23.7–32.4] | 29.6% | 42.5% | 0 | -18.8 [-26.2, -11.2] |
| Habit engine | 0.0% | 0.0% | 0.0% | -31.2 | -50.0 |
| B1 most-frequent end stop at agency | 12.0% | 35.7% | 98.0% | -16.9 | -35.6 |
| B2 most-frequent at route+stop | 35.2% | 38.4% | 53.5% | +8.8 [+2.5, +14.4] | -10.0 |
| B3 stop × 3h × weekday/weekend, decayed (serve history) | 37.2% | 45.7% | 98.0% | +11.2 [+5.0, +17.5] | -7.5 |
| **B3 on full history** | **45.2% [40.5–50.1]** | 51.6% | 99.3% | +18.8 [+11.2, +26.2] | 0 |
| **V3, else B3 on full history** | 44.3% [39.5–49.1] | 49.1% | 99.3% | **+21.2 [+15.0, +27.5]** | +2.5 [-1.9, +6.9] |
| V4 as deployed (80% fit, weekly) | 28.6% | 34.5% | 88.0% | +10.6 [+1.9, +18.8] | -8.1 |
| V5 as deployed (80% fit, weekly) | 27.9% | 34.5% | 88.0% | +8.1 [0.0, +16.2] | -10.6 |
| V4 refit per fold, shipped features | 33.7% | 40.3% | 88.0% | +12.5 | -6.2 |
| V5 refit per fold, shipped features | 34.7% | 41.1% | 88.0% | +13.8 | -5.0 |
| V5 refit, skew fixed | 35.0% | 41.3% | 88.0% | +16.2 | -2.5 [-8.8, +4.4] |
| V5 refit, skew fixed + local time | 34.2% | 40.3% | 88.0% | +16.2 | -2.5 |
| V5 refit, skew fixed, topology mask | 34.2% | 39.4% | 76.0% | +18.1 | -0.6 |

### Route (graded, but never shown to users: the route comes in the text)

| Predictor | Top-1 [95% CI] | Top-3 | Coverage | vs V3 (90d) | vs B3 full (90d) |
|---|---|---|---|---|---|
| V3 (as served) | 45.5% [40.7–50.3] | 45.5% | 57.0% | 0 | -28.7 |
| B3 on full history | **66.5% [61.8–70.9]** | 73.8% | 99.3% | +28.7 [+20.6, +36.9] | 0 |
| V3, else B3 on full history | 66.3% | 69.4% | 99.3% | +26.9 | -1.9 |
| V5 as deployed (with the 25% floor) | 49.6% | 68.5% | 91.0% | +18.1 | -10.6 |
| V5 refit, skew fixed (with the floor) | 57.9% | 70.4% | 90.2% | +23.1 | -5.6 [-11.9, 0.0] |
| V4 refit, shipped features (with the floor) | 46.9% | 58.9% | 65.0% | +11.9 | -16.9 |

### Segments (end-stop top-1)

| Predictor | Weekday (355) | Weekend (54) | May–Jul (288) | Aug–Oct (121) | TTC (375) | Other agency (34) | Last 90d (160) | Conf ≥50: coverage / precision | Conf ≥75: coverage / precision |
|---|---|---|---|---|---|---|---|---|---|
| V3 (as served) | 29% | 20% | 26% | 32% | 29% | 12% | 31% | 43% / 66% | 41% / 66% |
| B3 on full history | 47% | 31% | 44% | 48% | 48% | 15% | 50% | 70% / 60% | 51% / 64% |
| V3, else B3 full | 46% | 31% | 41% | 52% | 47% | 15% | 52% | 73% / 58% | 62% / 60% |
| V5 refit, skew fixed | 36% | 26% | 28% | 51% | 38% | 0% | 48% | 76% / 44% | 56% / 51% |
| V5 as deployed | 29% | 22% | 22% | 43% | 30% | 0% | 39% | 78% / 34% | 61% / 37% |

There is no SMS vs PRESTO split: this account has no PRESTO imports. The legacy Notion import (1,826 trips, 2024–25) has no end stops or end times, so it can't be eval rows.

## Findings

1. **V3 is accurate when it answers, but it rarely answers.** It is right 66% of the time when it predicts (similar to the audit's live 63%), but it predicts only 42.5% of the time. It needs the exact route+stop pair within its 100-trip window. That coverage gap is most of the shortfall.
2. **History length is the biggest lever.** The same B3 rule gains 8 points (37.2% → 45.2%) going from the 100-trip serve window to full history. V3 uses the same window.
3. **Freshness is worth about 6 points for V4/V5.** "As deployed" (fit on the first 80%, weekly) is 28–29%; refit at each fold start it is 34–35%.
4. **The train/serve skews are real but small.** Fixing them adds +0.3 to +0.8 points top-1, inside noise:
   - **S1 hour/day in UTC on both sides:** consistent, but evening trips land on the next weekday.
   - **S2 end-stop route key:** training scopes it without the primary agency, so 510A/510B stay distinct, while serving collapses them to 510.
   - **S3 sequence features:** training takes the previous exported clean trip by start time; serving takes `history[0]` by end time from the last 100.
   - **S4 prev-route scoping:** end-stop training scopes with the previous trip's agency and no primary agency; serving uses the current agency and the primary agency.
   - **S5 canonicalization:** V3 doesn't collapse "and"; ml_utils does.
5. **Local time shows no gain yet:** -0.8 points, within noise. No fold contains a DST switch (next one: 2026-11-01). Keep it as a correctness fix and re-measure after November, not as an accuracy claim.
6. **Topology masking doesn't help V4/V5.** It cuts coverage 88% → 76%, because when the legal set holds none of the model's classes the model abstains, and top-1 is flat.
7. **The habit engine never fires,** live or in replay, because of two independent blockers:
   - `extractHabits` stores habits without an `agency` field, and `match()` drops every habit when serving passes an agency.
   - Even with that fixed, confidence = count/10 × recency × precision, against a 0.75 threshold. Habits are bucketed by exact weekday × 2h within a 200-trip window (about 8 weeks), so the best habit has 3–5 trips, and the measured max confidence is 0.19–0.44.

## Replay parity and limitations

- **Parity:** replayed V3 matches the stored live v3.4.1 predictions on 87% of end stops (110/127) and 89% of routes (161/180).
  - End-stop mismatches are almost all network-graph rows (16/17), since the learned graph can't be replayed.
  - Route mismatches come from GTFS `routesAtStop`, which isn't exported.
  - Parity can't tell UTC from local time, because a constant offset preserves V3's hour differences. "As served = UTC" rests on the code: no TZ is set anywhere in `functions/`.
- **139 of the 548 completed SMS trips in the window aren't eval rows,** mostly unmatched stops, i.e. new or unknown places. These are the hardest cold-start cases, and serving still predicts on them, so the table is optimistic for all predictors.
- **Row flags are as of the snapshot.** Corrections or repairs made after a trip are applied retroactively. The 2026-10-14 repair of 48 stop matches came after the snapshot and isn't in v1.
- **ONNX conversion isn't re-tested;** V5 is scored with XGBoost in Python.
- **The deployed model is approximated:** a Monday fit on the first 80% of trips available then. The real gate sometimes rejected a retrain, and PR merges lagged.

## Proposed regression gate (not yet applied; waits for fix/ml-privacy)

Replace `check_model_regression.py`'s comparison of each run's own random-window metrics with this eval:

1. The retrain job runs `harness.py --only ml --task end` (and route) on a pinned eval definition: a fixed fold calendar and a committed `EVAL_VERSION`.
2. The candidate is the new pipeline, the baseline the currently published one, both refit per fold on the same rows.
3. Reject if the candidate's paired top-1 on the last 90 days is lower with the CI upper bound below 0, or if coverage drops more than 5 points.
4. Bump `EVAL_VERSION` only by a reviewed commit, so the gate always compares like with like.

## Habit engine: fix and retune (v2)

What changed in `functions/lib/habit.js`:
- **Correctness:** habits now store `agency` (serving always passes one, so v1 never matched). Day and hour come from the agency's timezone (`AGENCY_TIMEZONE`, default America/Toronto), not server UTC; the replay gives identical habits under `TZ=UTC` and `TZ=America/Toronto`. Records carry `schema: 2`, and `match()` ignores older records until the next rebuild.
- **Bucketing:** weekday vs weekend × 4h buckets (v1: exact weekday × 2h). Matching still allows ±1 h outside the observed hours.
- **Confidence:** share of the group's trips that ended at its usual end stop, smoothed (`top / (count + 1)`), × recency with a 60-day half-life; threshold 0.6, minimum 3 trips. v1's confidence ignored whether the end stop was consistent at all.
- History window unchanged (200 trips at rebuild).

Tuning: a sweep over the real habit.js (threshold 0) covered day grouping (exact day / weekday-weekend), bucket width (2/3/4 h), history (200/500/2000 trips), minimum trips, smoothing, half-life and threshold. Picked on the 249 rows before the last 90 days only.
- Exact-day buckets stay too sparse at any setting: +1 to +2 points.
- Weekday/weekend buckets help at every width (+4 to +6 on the tuning rows). 4 h was marginally best.
- Longer history (500/2000) didn't help on the tuning rows, so the window stays 200.
- Threshold between 0.5 and 0.7 changes almost nothing, because confidence is dominated by consistency.
- The sweep differed from the final replay by about 2 rows. The sweep used a minimum of 2 trips, which changes stale-slot detection; the numbers below are from the unmodified `replay_js.js` on the committed code.

Results (end stop, n=409; paired diffs on the last 90 days, n=160, from harness output):

| Predictor | Top-1 [95% CI] | Top-3 | Coverage | vs V3 (90d) | vs B3 full (90d) |
|---|---|---|---|---|---|
| Habit engine, before | 0.0% | 0.0% | 0.0% | -31.2 | -50.0 |
| Habit engine, after | 9.8% | 9.8% | 11.7% | -16.9 | -35.6 |
| Served to user (habit, else V3 top-3), before | 27.9% [23.7–32.4] | 29.6% | 42.5% | 0 | -18.8 [-26.2, -11.2] |
| **Served to user (habit, else V3 top-3), after** | **32.3% [27.9–37.0]** | 34.0% | 46.0% | **+7.5 [+3.8, +11.9]** | -11.2 [-18.1, -4.4] |
| Served: habit first, then V3 list (UX option) | 32.3% | 34.5% | 46.0% | +7.5 [+3.8, +11.9] | -11.2 |
| Served: habit only when V3 abstains (UX option) | 30.8% | 32.5% | 46.0% | +6.9 [+3.1, +11.2] | -11.9 |

When the habit fires (48 rows, 26 in the last 90 days) it is right 83% of the time (88% in the last 90 days); V3 is right 66% of the time when it answers.
- **V3 had no answer (14 rows):** the habit is right on 12.
- **V3 answered (34 rows):** the habit is right on 28. V3's top-1 is right on 22, and its top-3 on the same 22, so hiding V3's list costs nothing here.

Segments for the served row: weekday 34.1%, weekend 20.4% (unchanged; no weekend habit fired), last 90 days 38.8%.

Decision: ship it as a correctness fix with a gain. The served row beats V3 on the last 90 days with the CI above 0. It does not beat B3 on full history (-11.2), so it fails the full promotion bar. Bigger gains still need longer history and better coverage than any habit gives.

UX (proposal, not implemented):
- Keep the habit replacing V3's list. On the rows where both answer, the habit is more precise, and V3's list adds no extra top-3 hits.
- Showing the habit first with V3's list after it is equivalent (+0.5 top-3) and could be adopted cheaply.
- Non-admin users never see V3's list (`getPredictionPrompt(null)`). For them the habit is now the only end-stop prediction ever shown, so the "else V3 top-3" row describes the admin view only.
- When the habit fires, serving skips V3/V4/V5, so live `v3-endstop` stats lose those trips. They are graded as `habit-endstop` instead. `finalization.js` grades `habitPrediction.endStop`, which is correct.
