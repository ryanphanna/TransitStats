# Intelligence

Engineering record for the TransitStats inference, decision, and learning systems. Tracks what changed, why, and what signals are currently active.

This document complements the [roadmap](./roadmap/NEXTGEN.md) and the [feature changelog](../CHANGELOG.md). It is the internal notebook for the app's intelligence systems.

---

## How To Read This

- Start with **Intelligence Families** to understand the major moving parts.
- Read **Prediction Models** if you care about route and end-stop inference.
- Use the dedicated docs for deeper details on:
  - [Network Engine](./NETWORK_ENGINE.md)
  - [Transfer Engine](./TRANSFER_ENGINE.md)

---

## Intelligence Families

### 1. Prediction Models

This family handles route and end-stop inference at trip start.

- **V3** — `functions/lib/predict_v3.js`
  Live heuristic weighted-voting model for route and end-stop guesses. (See [detailed history subpage](./intelligence/V3.md) for the v1–v3.3 archive.)
- **V4** — `functions/lib/predict_v4.js`
  Candidate logistic-regression end-stop model trained from trip history (the route model was removed). Graded weekly, not run live (see [Weekly shadow grading](#weekly-shadow-grading-v4v5)).
- **V5** — `functions/lib/predict_v5.js`
  Candidate XGBoost end-stop model exported to ONNX (the route model was removed). Graded weekly, not run live.
- **V6** — (in design)
  Next-generation model focused on journey/sequence context. See the [V6 design spike](./V6_DESIGN_SPIKE.md).

**Retraining:** V4 and V5 retrain from the Python pipeline in `ml/export_trips.py` and `ml/train_endstop.py`. See `ml/CLAUDE.md` for the retrain workflow.

### 2. Habit Intelligence

This family handles recurring trip patterns that are strong enough to beat generic inference.

- **HabitEngine** — `functions/lib/habit.js`
  Learns recurring trip patterns from completed history and can short-circuit the full prediction stack when a high-confidence habit matches.

### 3. Network Intelligence

This family learns the structure of the transit network from observed trips.

- **NetworkEngine** — `functions/lib/network.js`
  Builds a stop-connection graph from completed trips only, learns route-stop service and transfer connections, and provides observational reachability signals inside authoritative topology/GTFS constraints. GTFS/topology can constrain predictions outside the engine, but must not be fed into the graph.

### 4. Journey Intelligence

This family reasons about whether multiple trips belong to the same journey.

- **TransferEngine** — `functions/lib/transfer.js`
  Scores whether two consecutive trips are a real transfer using stop pairs, route pairs, gap time, and time-of-day patterns.

---

## Prediction Models

### V3

**Role:** Live route and end-stop inference.

**What it does:** Predicts the next route and likely end stop at trip start using heuristic weighted voting over trip history, plus route, topology/GTFS, and learned network constraints.

**Current version / history:** See [detailed version history (v1–v3.3)](./intelligence/V3.md). The signals and config below are the currently active ones.

### Active Signals

| Signal | Where used | What it does |
|---|---|---|
| **Stop match** | `guess`, `guessEndStop` | Hard filters candidates to trips that started at the current stop (canonicalized). No match = no vote. |
| **GTFS route filter** | `guess` | Hard filters candidates to routes known to serve the boarding stop. Sourced from GTFS stop→route mapping. Falls back to unfiltered if no candidates survive (guards against stale data). |
| **Recency weight** | Both | Exponential decay by same-agency ride count. A trip 100 same-agency rides ago votes at half weight. Being in another city does not decay home network predictions. |
| **Time similarity** | Both | Gaussian centered on current time (σ = 1.5h). Trips at the same time of day score higher. |
| **Day similarity** | Both | Weekday/weekend boundary is a hard penalty (0.1×). Within weekdays, adjacent days score higher than distant ones. Within weekend, Sat/Sun score 0.7. |
| **Sequence boost** | `guess` | 1.5× multiplier applied when the last completed trip ended at the current boarding stop (i.e. this looks like a transfer). Window: 3 hours. |
| **Route family grouping** | `guess` | Variant suffixes stripped (510a, 510b → 510) so route variants pool votes rather than splitting signal. Returns most-voted specific variant within the winning family. |
| **Topology/GTFS physical constraint** | `guessEndStop` | Authoritative downstream-stop and platform legality guardrail for covered routes. Eliminates impossible destinations before voting. |
| **Network reachability constraint** | `guessEndStop` | Learned graph can narrow candidates inside the physical constraint, or provide a fallback constraint when topology has no route coverage. |
| **Duration similarity** | `guessEndStop` | Gaussian on trip duration (σ = 5 min). Used to weight end-stop candidates when current trip duration is known mid-trip. |
| **Trip validity filter** | Both | Excludes malformed trips from the candidate pool — stop names that look like sentence fragments from bad SMS parses, routes with no digits that are probably partial words. |
| **Stop canonicalization** | Both | Aliases and spelling variants collapse to one canonical stop name via the stops library. Prevents the same stop from being treated as multiple distinct stops. |

### Config

```js
TIME_SIGMA_HOURS: 1.5        // Width of time-of-day Gaussian
DECAY_HALFLIFE_RIDES: 100    // Recency decay: a trip 100 same-agency rides ago votes at half weight
SEQUENCE_WINDOW_HOURS: 3     // How recent a prior trip must be to trigger sequence boost
SEQUENCE_BOOST: 1.5          // Multiplier applied at transfer points
SAMPLE_PRIOR_TRIPS: 2        // End-stop confidence × n/(n+2) for n voting trips (3.6.0); one trip = 33, not 100
```

### Version History

Detailed history (v1–v3.3) lives in the archive sub-page: [docs/intelligence/V3.md](./intelligence/V3.md).

Current active signals, config, strengths, and data notes are documented above. Only high-level status and the pointer are kept in this file so the main notebook stays scannable as V6 work expands.

---

### V4

**Role:** Candidate route and end-stop model family.

**What it does:** Uses trained logistic-regression models to predict routes and end stops from trip history instead of relying on hand-tuned weights.

**Status:** Candidate. Not run live since CIV-425 (October 2026); graded weekly against V3 on the past week's real trips (see [Weekly shadow grading](#weekly-shadow-grading-v4v5)).

Detailed version history, benchmarks, and per-iteration notes: [docs/intelligence/V4.md](./intelligence/V4.md).

---

### V5

**Role:** Candidate route and end-stop model family.

**What it does:** Uses XGBoost models exported to ONNX for richer feature interactions and stronger learned route/end-stop inference than V4.

**Status:** Candidate. Not run live since CIV-425; graded weekly with V4.

Detailed version history, benchmarks, and per-iteration notes: [docs/intelligence/V5.md](./intelligence/V5.md).

---

### Weekly shadow grading (V4/V5)

Until October 2026, V4 and V5 ran on every trip start for allowlisted users (`allowedUsers/{email}.experimentalIntelligence`) and were stored as `endStopPredictionV4/V5` and graded into `predictionStats` at finalization. No reply or page used them. They cost a model download, the ONNX runtime (about 50 MB of function memory) and some latency on each trip text.

**Now (CIV-425):** `ML_ENDSTOP_LIVE = false` in `functions/lib/constants.js`. With it off:
- The sms function never loads `predict_v4.js`, `predict_v5.js`, `model-store.js` or `onnxruntime-node`.
- New trips store `endStopPredictionV4/V5: null`, so no new `v4-endstop`/`v5-endstop` rows. Grading and readers already skip missing guesses.
- `fillPredictions` (after stop disambiguation) does nothing.

**Weekly grading:** `functions/scripts/weekly-shadow-grade.js` runs in `retrain.yml` every Monday, before the retrain. It replays the past 7 days of `TRAIN_USER_IDS` trips through V3, V4 and V5.
- **Models:** the published set (`models/latest.json`), i.e. the models that would have served that week, so they never trained on those trips.
- **Trips:** texted only (`sms`, `sms_fallback`, `mms`; no `outage-recovery` or imports), finished, and clean (no `needs_review`, no blocking correction, stop matched).
- **Inputs:** each trip gets the live trip-start inputs. That's the 500-trip serving history before it, the same V4/V5 eligibility gate, and the same context builder (`functions/lib/endstop-context.js`, shared with `handlers-trip.js`). Hits are scored with V3's `_stopMatch`, as finalization does.
- **Network graph:** the learned graph can't be rewound, so all three engines run without it. V3's numbers here can differ slightly from live.
- Read-only on trips.

Results:
- Firestore `mlShadowGrades/{YYYY-MM-DD}__{userId}`: written every week, even when the retrain gate rejects.
- A "Shadow grading" table in that week's `ml/MODEL_LOG.md` entry, when the retrain publishes.

Each records per engine top-1 over all graded trips, coverage, top-1 when answered (what `predictionStats` measured), and top-1 on the paired slice where all three answered. Compare engines on the paired slice.

**Switching back on:** if V4 or V5 pulls ahead of V3 on the paired slice for several weeks, set `ML_ENDSTOP_LIVE = true` and deploy functions. Trip starts then run and store them again, and finalization grades them as before. A one-off check: `TZ=UTC GOOGLE_APPLICATION_CREDENTIALS=<admin key> TRAIN_USER_IDS=<uid> node functions/scripts/weekly-shadow-grade.js --dry-run [--days 14]`.

## Shared Prediction Files

| File | Module format | Use |
|---|---|---|
| `functions/lib/predict_v3.js` | CommonJS | Live V3 implementation for Cloud Functions |
| `functions/lib/predict.js` | CommonJS | Compatibility wrapper exporting V3 as `PredictionEngine` |
| `js/predict.js` | ESM | Browser helper mirroring the V3 topology constraint surface |

The CJS V3 implementation is the reference. Browser changes should be mirrored only for the subset exposed client-side; shared legality logic belongs in `functions/lib/topology-constraints.js`.

---

## Other Families

### Habit Intelligence

- **HabitEngine** short-circuits generic inference when a recurring trip pattern is strong enough to trust directly.
- Lives in `functions/lib/habit.js`.
- Best thought of as memorized recurring behavior, not a general-purpose prediction model.

### Network Intelligence

- **NetworkEngine** learns stop sequences, travel times, route-stop service, and transfer connections from completed trips only. It is observational; it should not ingest GTFS/topology as graph data or overrule topology/GTFS physical legality when those constraints exist.
- Lives in `functions/lib/network.js`.
- See [NETWORK_ENGINE.md](./NETWORK_ENGINE.md) for the detailed notebook.

### Journey Intelligence

- **TransferEngine** decides whether consecutive trips belong to one journey or two separate outings.
- Lives in `functions/lib/transfer.js`.
- See [TRANSFER_ENGINE.md](./TRANSFER_ENGINE.md) for the detailed notebook.

---

### V6

**Role:** Next-generation route and end-stop model family (not yet built).

**What it does:** Early concept phase. Primary goal is to move from single-trip prediction to explicit journey/sequence context. See the dedicated spike document for current thinking.

**Status:** Concept / spike phase. See [V6 Design Spike](./V6_DESIGN_SPIKE.md) for direction and [V6 Experiments Log](./V6_EXPERIMENTS.md) for actual experiments/results. See also [Trip Corrections](./TRIP_CORRECTIONS.md) for the evolving philosophy on preserving realistic user intent (which directly affects future V6 training data quality).

**Core idea (current thinking):** V6 should be the first model generation that treats trips as connected journey state rather than isolated starts. The main step up from V5 is not "more trees" or "more random features." It is sequence and transfer context.

**Primary signal families:**
- **Previous trip context** — previous route, previous end stop, and time since last trip
- **Transfer likelihood** — whether the current boarding stop and timing look like a real connection versus a deliberate stopover
- **Journey continuity** — whether this looks like a continuation of the same outing or a new trip altogether
- **Service-level context** — route frequency, route availability, and directional plausibility when those signals are reliable

**Role of GTFS:**
- GTFS is a likely **supporting input**, not the default core of V6.
- Good uses:
  - service-frequency features
  - route availability by stop/time
  - downstream-stop plausibility filters
- Less desirable first step:
  - feeding raw GTFS tables directly into the model without proving they help

**Candidate external/context signals:**
- **GTFS service frequencies** — helps interpret trip gaps and transfer plausibility
- **Service alerts** — disruptions can suppress otherwise likely routes/stops
- **Weather** — rain/snow can shift boarding behavior and route choice
- **Calendar/events** — holidays or special events can distort normal travel patterns

**Why it's a new version and not just "V5 with more features":**
- V5 still fundamentally treats each trip start like one row in a spreadsheet.
- V6 should reason about what stage of a journey the user is currently in.
- That likely changes both the feature schema and the evaluation logic.

**Data Quality Note:**

High-quality training data is critical for V6. We are evolving our correction practices (see [Trip Corrections](./TRIP_CORRECTIONS.md#recording-user-intent-in-corrections)) to record the user's actual intent during fixes rather than immediately sanitizing everything to perfect canonical names. This preserves realistic imperfect examples for future models to learn from, while still applying proper exclusion flags so bad data does not pollute training or accuracy.

**Status:** Concept only. The practical path is to prove V6-style signals incrementally inside V5 experiments first, then promote the successful pattern into a distinct V6 generation.
