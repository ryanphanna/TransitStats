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
| Grading | end stop: V3's `_stopMatch` canonicalization, as `finalization.js` grades. Route: `normalizeRouteForGrading`, route only for every predictor (live `predictionStats` checked direction for V3 until route grading was removed, so historical live V3 route numbers differ) |
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
7. **The habit engine never fires,** live or in replay, because of two independent blockers (fixed: see "Habit engine: fix and retune (v2)" below):
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
- **Stale rule:** a habit seen in the last 30 days is never marked stale. With weekday-wide slots, two routes ridden from the same stop marked each other stale. Coverage rose from 11.7% to 12.5%; the Served row is unchanged.
- History window unchanged (200 trips at rebuild).
- **Serving (`handlers-trip.js`):** the habit reply keeps the standard END/FORGOT line, which it used to drop, and the stored version is `habit_v2`.
- **Serving, follow-up:** when a habit fires, V3/V4/V5 end-stop guesses still run and are stored and graded as on any other trip, so live `predictionStats` stay complete. Admin "END 1" on a habit trip maps to the habit's end stop; V3's stored list is untouched, and a non-admin END 1 never resolves.
- **Admin-only (Ryan's decision):** "Usual trip to X." is shown to admins only, gated like V3's list. Non-admin replies are byte-for-byte unchanged. The habit still runs, and is stored and graded, for everyone.

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
| Habit engine, after | 10.5% | 10.5% | 12.5% | -15.0 [-23.1, -6.2] | -33.8 |
| Served to user (habit, else V3 top-3), before | 27.9% [23.7–32.4] | 29.6% | 42.5% | 0 | -18.8 [-26.2, -11.2] |
| **Served to user (habit, else V3 top-3), after** | **32.3% [27.9–37.0]** | 34.0% | 46.0% | **+7.5 [+3.8, +11.9]** | -11.2 [-18.1, -4.4] |
| Served: habit first, then V3 list (UX option) | 32.3% | 34.5% | 46.0% | +7.5 [+3.8, +11.9] | -11.2 |
| Served: habit only when V3 abstains (UX option) | 30.8% | 32.5% | 46.0% | +6.9 [+3.1, +11.2] | -11.9 |

When the habit fires (51 rows, 29 in the last 90 days) it is right 84% of the time (90% in the last 90 days); V3 is right 66% of the time when it answers.
- **V3 had no answer (14 rows):** the habit is right on 12.
- **V3 answered (37 rows):** the habit is right on 31. V3's top-1 is right on 25, and its top-3 on the same 25, so hiding V3's list costs nothing here.

Segments for the served row: weekday 34.1%, weekend 20.4% (unchanged; no weekend habit fired), last 90 days 38.8%.

Decision: ship it as a correctness fix with a gain. The served row beats V3 on the last 90 days with the CI above 0. It does not beat B3 on full history (-11.2), so it fails the full promotion bar. Bigger gains still need longer history and better coverage than any habit gives.

UX (proposal, not implemented):
- Keep the habit replacing V3's list. On the rows where both answer, the habit is more precise, and V3's list adds no extra top-3 hits.
- Showing the habit first with V3's list after it is equivalent (+0.5 top-3) and could be adopted cheaply.
- End-stop suggestions are admin-only. Admins see "Usual trip to X." in place of V3's list; non-admins see no end-stop hint. The "Served" row is the admin view.
- Habit trips store V3's `endStopPrediction`/`endStopPredictions` too, so the web Atlas stop resolver keeps its end-stop hints.
- `finalization.js` grades `habitPrediction.endStop` as `habit-endstop`, which is correct. V3/V4/V5 are graded separately; they also run on habit trips.

## V3: 3.5.0 coverage (history window, valid library stops, backoff tiers)

Same eval definition v1 (snapshot `78a4265b1519`, 409 rows, last 90 days n=160). Replays: `TZ=UTC node ml/eval/replay_js.js ... --limit 500`, scored with `V3_VARIANTS` (`ml/eval/predictors/v3_variants.py`) while `--replay` stays the 3.4.1 snapshot, so "vs V3" is against V3 as served. Choices were made on the 249 rows before the last 90 days (`ml/eval/pre90.py`), then frozen and read on the last 90 days once.

What changed in V3:
1. **Library stops with a direction word count as valid trips.** `_isValidTrip` rejected any stop name containing "northbound" etc. as a bad sentence parse, which also dropped every trip from a real library stop with that word in its name (21 trips in the export). It's a correctness fix: it also helps the route guess.
2. **500-trip window** (was 100). On the selection slice, 500 (34.1%) ≥ all history (33.7%) > 300 > 200 for V3 alone. The window also caps reads as history grows.
3. **End-stop backoff** when no topology-legal past trip matches route + boarding stop, in this order:
   - same route family from any boarding stop (direction-preferred)
   - same boarding stop on any route
   - the whole agency

   Every tier excludes the boarding stop itself and goes through the same topology filter. Confidence is scaled ×0.6, ×0.5 and ×0.3 respectively, and predictions carry a `tier` field. Route→stop→agency beat stop→route→agency on selection (41.0% vs 39.8%). Exact-tier output is unchanged: on all 602 replay rows where the exact tier answered, the output is identical with and without backoff.
4. **CONFIG unchanged.** On selection, a grid of TIME_SIGMA_HOURS {1, 1.5, 2.5, 4} × DECAY_HALFLIFE_RIDES {50, 100, 200, 400} spans 39.0–41.8%. That's ≤4 rows of difference, i.e. noise. SEQUENCE_BOOST multiplies every candidate equally (it's per context, not per trip), so it can't change rankings or shares and wasn't tuned.

### End stop

| Predictor | Top-1 [95% CI] | Top-3 | Coverage | Last 90d | vs V3 (90d) | vs B3 full (90d) | Conf ≥50 cov / prec | Conf ≥75 cov / prec |
|---|---|---|---|---|---|---|---|---|
| V3 3.4.1 as served (100) | 27.9% [23.7–32.4] | 29.6% | 42.5% | 31.2% | 0 | -18.8 [-26.2, -11.2] | 43% / 66% | 41% / 66% |
| V3 3.4.1, 500 window | 35.9% | 41.6% | 62.1% | 38.8% | +7.5 [+2.5, +12.5] | -11.2 | | |
| V3 validity fix only, 100 | 31.3% | 33.0% | 46.2% | 40.0% | +8.8 [+4.4, +13.1] | -10.0 | | |
| V3 validity fix only, 500 | 39.4% | 45.0% | 66.0% | 47.5% | +16.2 [+10.0, +23.1] | -2.5 [-8.1, +3.1] | | |
| **V3 3.5.0** (500 + fix + backoff) | **46.0% [41.2–50.8]** | 53.5% | 98.0% | **53.8%** | **+22.5 [+15.6, +29.4]** | +3.8 [-3.1, +10.6] | 79% / 55% | 61% / 62% |
| B3 on full history | 45.2% [40.5–50.1] | 51.6% | 99.3% | 50.0% | +18.8 [+11.2, +26.2] | 0 | 70% / 60% | 51% / 64% |
| V3 3.4.1, else B3 full | 44.3% | 49.1% | 99.3% | 52.5% | +21.2 [+15.0, +27.5] | +2.5 [-1.9, +6.9] | 73% / 58% | 62% / 60% |

Segments (end-stop top-1), V3 3.5.0 vs 3.4.1:
- Weekday: 48% vs 29%
- Weekend: 31% vs 20%
- May–Jul: 42% vs 26%
- Aug–Oct: 56% vs 32%
- TTC: 49% vs 29%
- Other agency: 18% vs 12%

### Route (V3 `guess()`, changed only by the validity fix and the window)

| Predictor | Top-1 [95% CI] | Coverage | Last 90d | vs V3 (90d) | vs B3 full (90d) |
|---|---|---|---|---|---|
| V3 3.4.1 as served | 45.5% [40.7–50.3] | 57.0% | 44.4% | 0 | -28.7 [-36.9, -20.6] |
| V3 3.5.0 | 60.6% [55.8–65.3] | 78.0% | 63.7% | +19.4 [+13.1, +26.2] | -9.4 [-15.0, -4.4] |
| B3 on full history | 66.5% | 99.3% | 73.1% | +28.7 | 0 |

### Findings

- **Topology vetoes the actual stop in 8 rows.** Of the rows where the topology filter empties V3's exact candidates (20 at all-history), the actual end stop is outside the legal set in 8. That points to direction or topology data errors, not prediction errors. Backoff doesn't paper over them: every tier stays topology-filtered.
- **Cost of the window:** each trip start reads up to 500 trip docs instead of 100, about 1.1 KB each, so about 550 KB and 400 extra Firestore reads per start. V4/V5 eligibility still counts only the newest 100. `detectProvisionalTransfer` and finalization keep 100.
- **CPU cost:** at 500 trips, unindexed stop canonicalization took up to 1.3 s per start (it scanned the whole stops library on each call). 3.5.0 builds a name index once per library, so V3 now takes ≤3 ms per start, compared with ≤138 ms for 3.4.1 at 100 trips. The replay is unchanged: 0 diffs.
- **Precision when shown falls from 66% to 47%** (46.0/98.0), because backoff guesses are weaker. Gating the SMS display at confidence ≥75 (in practice, exact tier only) keeps 62% precision at 61% coverage. Applied (see below).

- **Admin display gate (applied):** the admin SMS list and END 1/2/3 only use guesses with confidence ≥75. All guesses are still stored and graded. Per the harness, a shown guess appears on 61.1% of the 409 rows and is right 62.0% of the time, vs 40.8% / 66.5% for 3.4.1 at the same gate.

**Decision:** V3 3.5.0 beats V3 as served by +22.5 points (CI above 0), so it ships on this branch. It does **not** meet the promotion rule against B3 on full history: +3.8, CI [-3.1, +10.6]. It's at parity with B3 or slightly ahead, but not significantly. Merging is for the manager to decide. The validity fix (item 1) stands alone as a correctness fix that doesn't regress (+8.8 at the 100 window).

## V4/V5 end stop: fresh fit, relaxed filters, serve-parity features

Scored by `ml/eval/predictors/v45.py` (`--only v45`). "Weekly" rows refit at each Monday 04:00 UTC retrain, as `retrain.yml` does. The shipped row is the exact config the training script now uses. End stop, n=409; deltas are paired top-1 on the last 90 days (n=160), with 95% CIs.

| Predictor | Top-1 [95% CI] | Top-3 | Coverage | vs V3 (90d) | vs B3 full (90d) |
|---|---|---|---|---|---|
| V4 as deployed (80% fit, weekly; before) | 28.6% | 34.5% | 88.0% | +10.6 | -8.1 |
| V5 as deployed (80% fit, weekly; before) | 27.9% | 34.5% | 88.0% | +8.1 | -10.6 |
| H1 V4 weekly, 100% fit, shipped features | 34.5% | 41.1% | 88.0% | +12.5 | -6.2 |
| H1 V5 weekly, 100% fit, shipped features | 35.5% | 41.3% | 88.0% | +13.8 | -5.0 |
| V4 per fold, skew fixed + local, balanced (ref) | 34.0% | 40.8% | 88.0% | +13.8 | -5.0 |
| H2 V4 ref, no class weight | 35.5% | 40.6% | 88.0% | +17.5 | -1.2 |
| H2 V5 ref, regularized XGB (depth 3, 150 trees) | 34.0% (ref 34.2%) | 40.6% | 88.0% | +13.1 | -5.6 |
| V4 no class weight + relaxed filters | 40.1% | 50.1% | 88.0% | +16.2 | -2.5 |
| V5 relaxed filters | 37.4% | 47.9% | 88.0% | +14.4 | -4.4 |
| H4 V4 relaxed + unseen-stop augmentation | 41.3% | 50.4% | 88.0% | +18.8 | 0.0 [-6.9, +6.9] |
| H4 V5 relaxed + unseen-stop augmentation | 38.4% | 47.7% | 88.0% | +16.9 | -1.9 |
| **V4 shipped (after): weekly, 100% fit, serve-parity + local time, no class weight, relaxed** | **40.8% [36.2–45.7]** | 49.4% | 88.0% | **+18.1 [+10.0, +26.2]** | -0.6 [-7.5, +6.2] |
| **V5 shipped (after)** | **38.1% [33.6–42.9]** | 48.9% | 88.0% | **+15.6 [+8.8, +23.1]** | -3.1 [-10.0, +4.4] |
| V4 shipped, topology-masked | 40.6% | 46.5% | 82.9% | +22.5 | +3.8 [-3.1, +10.6] |
| V5 shipped, topology-masked | 39.4% | 46.5% | 82.9% | +21.2 | +2.5 [-4.4, +10.0] |

"Relaxed filters" drops the route+start-stop ≥ 5 rule and lowers the end-stop class minimum from 10 to 5. Minimums of 3 and 2 scored within a point of 5. Shipped V4 thresholds:
- Confidence ≥ 50: coverage 46%, precision 72%.
- Confidence ≥ 75: coverage 21%, precision 87%.

V3 has 43% coverage at 66% precision.

1. **Freshness (H1) is real:** +6 to +8 points from fitting on 100% instead of holding back the newest 20%. The training script still measures top-1/top-3 on an 80/20 split for the regression gate, then refits on 100% for the shipped model.
2. **The count filters were the biggest lever:** +5 points. They threw away most rare route+stop rows.
3. **Class weights (H2):** dropping `balanced` gives V4 +1.5. A regularized XGB is neutral (not shipped).
4. **Skews and local time (H3)** are shipped as correctness fixes; their accuracy effect stays within noise, as in v1.
   - `export_trips.py` now builds `serve_prev_route`, `serve_last_end_stop` and `serve_minutes_since_last_trip` from serving's `history[0]`: the newest 100 completed trips by end time, with the serving filter.
   - It also adds `local_hour` / `local_day_of_week` in the trip's agency zone (DST-aware).
   - `train_endstop.py` scopes the route and the previous route with the current agency and the primary agency.
   - Stop canonicalization now uses the same regex steps as `ml_utils.canonicalizeStop`.
   - **Parity:** on the v1 snapshot, the training features equal the harness's serve-faithful features on 876/876 clean trips. `ml/test_feature_parity.py` and `functions/test_ml_feature_parity.js` check both sides against one synthetic fixture, which includes a DST fall-back, a late-evening weekday shift, LA and unmapped agencies, and unclean history.
5. **Unseen start stops (H4):** training copies of each row without the stop one-hot gave +1 for both models. That is within noise and not shipped.
6. **Promotion:** both models beat V3 as served with a CI above 0. Neither beats B3 on full history: V4 is -0.6, CI [-7.5, +6.2]. Serving them to users therefore isn't justified by this eval.
   - **Decision:** ship the training and serving changes as freshness and correctness fixes for the shadow models, not as a user-facing switch.
7. **The current regression gate will reject the first retrain.** It isn't a real regression.
   - The gate compares each run's own 80/20 top-1, which drops from about 79% to 61% on the same export once the filters are relaxed, because the holdout now keeps the rare-stop rows the old filters hid. The gate's limit is a 5-point drop.
   - **Needs** either a one-time baseline reset or the harness-based gate proposed above.
   - **Deploy order:** functions must deploy before the first retrain with this script. Old serving ignores `time_basis` and would feed UTC hours to a local-time model.

## Retrain gate v1

`ml/eval_gate.py` replaces `check_model_regression.py` (retired with its test) in `retrain.yml`. It gates the END-STOP models (V4, V5) only. Route models still train and upload as before, ungated, since they are being removed. Tests: `python3 -m unittest ml/test_eval_gate.py`.

**What it scores.** It runs on the CI export (`export_trips.py`, `TRAIN_USER_IDS` allowlist), never a local CSV, and calls `train_endstop.py`'s own `clean` / `apply_count_filters` / `build_features` / `train_v4` / `train_v5`.
- Folds: fixed 14-day calendar anchored at 2026-05-01 (the harness anchor). A trip's fold never depends on the export date.
- Window: the last 90 days before the export's newest trip.
- Per fold: fit on rows that started before the fold, with count filters, ride-count weights, feature columns and classes from those training rows only. The fold's rows are reindexed to the training columns, as serving does.
- Grading is owned by the gate: the exported end stop and the model's label (agency prefix dropped) both go through the stops library with `ml_utils` canonicalization, so a pipeline can't grade itself better by changing its own labels.
- An unseen class is a miss. Covered = the fold model fit and the trip's agency is in its training agencies. Top-1, top-3 and coverage are over all rows.
- Baseline, same rows: most frequent end stop at (route, start stop) in the fold's training rows.
- Known drift sources: retroactive trip corrections, and `compute_primary_agency_map`, which runs over the whole export.

**Week to week.** On a pass it writes `eval_rows.json`: per row, an HMAC of the trip id (salt `EVAL_ROW_SALT`, else an HMAC of the `TRAIN_USER_IDS` secret; no salt fails closed), the fold, and [top-1, top-3, covered] for V4, V5 and the baseline. It goes only to private `models/<version>/` with the models, never to git or logs (`ml/eval_rows.json` is gitignored). The next run fetches the published one via `models/latest.json` and pairs rows on (key, fold).

**Rule.** Reject (exit 1) if, for V4 or V5:
- Paired top-1 difference has a 95% bootstrap CI (2,000 resamples, fixed seed) upper bound below 0.
- Paired top-1 drops more than 5 points with at least 100 overlapping rows.
- Paired coverage drops more than 5 points.
- Eval rows fall more than 20% vs the published run (a broken export).
- The shipped model has fewer than 3 end-stop classes.

First run (no published `eval_rows.json`, including sets published before this gate), or fewer than 50 overlapping rows (the salt or allowlist changed):
- Walk-forward top-1 must be at least the baseline's top-1 minus 5 points.
- At least 50 eval rows and at least 3 classes.

A published `eval_rows.json` from another `GATE_VERSION` is not paired, so the floors apply instead; bump it whenever grading or folds change. Any exception exits 2 and prints only the exception type and file:line, because the Actions logs are public. Any non-zero exit fails the job before upload, so `models/latest.json` is untouched.

**Measured on the v1 snapshot** (the snapshot through `export_trips.build_rows`: 876 export rows; 174 eval rows in 7 folds; "held back" = the newest fold's trips removed before export, as if exported two weeks earlier; 169 rows):

| Run | V4 top-1 / top-3 / cov | V5 top-1 / top-3 / cov | Baseline top-1 | Path, result |
|---|---|---|---|---|
| v4v5-fresh, first run | 47.7% / 60.9% / 98.3% | 45.4% / 61.5% / 98.3% | 48.3% (floor 43.3%) | first-run, pass |
| Pre-v4v5 (origin/main) pipeline, held back ("published") | 43.8% / 53.8% / 97.6% | 43.8% / 56.2% / 97.6% | 44.4% | first-run, pass |
| v4v5-fresh vs that published run | +0.7 [-3.4, +4.7], n=148, 9 discordant | -0.7 [-6.1, +4.7], 15 discordant | | paired, pass |
| Same pipeline, full vs one fold held back (noise) | 0.0 [0.0, 0.0], n=148, 0 discordant | 0.0, 0 discordant | | paired, pass |
| Same pipeline, full vs 7 days held back (noise) | 0.0, n=152, 0 discordant | 0.0, 0 discordant | | paired, pass |

The pre-v4v5 pipeline was loaded from `git show origin/main:ml/train_endstop.py` with one local-only patch: its inline count filters were moved into `apply_count_filters` so the gate can apply them per fold.

**Why these thresholds.**
- **Week-to-week noise of the paired comparison is zero** on this data. With a fixed calendar, an overlapping row has the same training rows every week, and both models are deterministic. Both pipelines gave 0 discordant rows between the full and held-back exports. Any discordance in production therefore comes from a real pipeline change, or from retroactive data changes. Those are not covered by this measurement: a trip repaired or matched later lands in an old fold and changes that fold's training rows. **When the gate rejects, check first for data repairs since the published run.** With zero noise the CI rule is sensitive: at 150 overlapping rows, 4 one-sided losses (-2.7 points) reject and 3 pass (`test_ci_rule_boundary_at_150_rows`).
- **The old gate's metric is noise.** The same unchanged pipeline's 80/20 numbers moved V4 top-1 63.5% → 61.2% and top-3 79.1% → 74.4% between the 7-day held-back and full exports, because the newest 20% is a different set of rows each week. That is within 0.3 points of its 5-point limit. Even the gate's own unpaired top-1 moved +1.5 points between those exports while the paired difference was exactly 0.
- **One-run sampling error is about ±7 points** (95%, n≈170). So the floors and absolute numbers are coarse, and only the paired rules are sharp.
- **5 points at ≥100 rows:** at about 150 overlapping rows, that is a net loss of 8 rows. The whole v4v5 rewrite (filters, features, canonicalization, class weights) moved only 9–15 rows, with a net of ±1. A drop past 5 points is well outside what even a large deliberate change produced, and the CI rule catches smaller consistent losses.
- **Coverage, 5 points:** the coverage difference was 0.0 in every comparison.
- **Rows, 20%:** natural change is a few rows a week (169 → 174 here); 20% is about 35 rows.
- **Classes, 3:** the candidate ships 26 classes, the pre-v4v5 pipeline 9.
- **First-run margin, 5 points:** the baseline is strong on this window. V4 is 0.6 below it and V5 is 2.9 below it, so V5 clears the floor by only 2.1 points (1.5 on the 7-day held-back export). Monday's first run will likely pass, but by a few rows. A first-run reject means "no better than a lookup table", not a regression.

**Runtime:** 42–49 s wall for the gate on a laptop under `nice -n 15` (the pre-v4v5 pipeline takes about 20 s). That adds about a minute to a job that took about 1 minute, far inside the Actions limits.

## V3/V4/V5 route: removed from serving

Route predictions were never shown to users (the route arrives in the texted message), so the V4/V5 route models, V3's route guess at trip start, and all route grading (`predictionStats` route rows, `predictionAccuracy` route counters) were removed. The harness keeps `--task route` and its baselines so a future "did you mean 510?" typo-check can be scored; `PredictionEngineV3.guess` stays in `predict_v3.js` for the replay.

Reference, `--task route --only v3,baseline,combo` on the eval_v1 snapshot (n=409):

| Predictor | Top-1 | Top-3 | Coverage | d vs V3 last90 | d vs B3-full last90 |
|---|---|---|---|---|---|
| B3 on full history | 66.5% | 73.8% | 99.3% | +28.7 [+20.6, +36.9] | 0.0 |
| V3 (as served until now) | 45.5% | 45.5% | 57.0% | 0.0 | -28.7 [-36.9, -20.6] |

Decision: removal, not a model change; no promotion rule applies.
