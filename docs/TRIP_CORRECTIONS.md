# Trip Corrections

Design notes and open questions for post-trip edits such as `NOTES ...` and a possible future `CORRECT ...` command.

## Why This Exists

Editing a trip after it ends is not just a UI concern. A corrected trip may already have been used for:

- prediction grading
- journey linking
- NetworkEngine observation
- TransferEngine-derived learning
- HabitEngine rebuild inputs
- training/export analysis

That means a post-hoc correction can make some derived data stale even if the trip document itself is now right.

## Guiding Philosophy

When correcting trips, we prioritize recording the user's actual intent over immediately forcing perfectly normalized canonical data.

This approach has two goals:
- Preserve realistic examples of imperfect user input so future models (especially V6) can learn to handle real-world phrasing and mistakes.
- Still maintain strong data hygiene for training and accuracy by applying proper correction metadata and exclusion flags.

In practice, normal stop verification does not rewrite raw trip text. A user-approved typo correction may correct the raw input (e.g. "College" instead of "Collegea"), but it must preserve the original value in metadata, ensure the canonical stop linkage is correct, and flag the trip properly.

## Current Practical Rule

For now, the simplest safe model is:

- trips process immediately at `END`
- low-risk edits like `notes` are fine
- high-impact edits mark the trip as corrected/stale rather than trying to fully unwind every downstream effect

Current high-impact fields:

- `route`
- `direction`
- `agency`
- `startStop`
- `startStopCode`
- `startStopName`
- `endStop`
- `endStopCode`
- `endStopName`

Current correction metadata / guardrails:

- `correctedAt`
- `correctedFields`
- `correctionSource`
- `originalValues` for changed fields when available
- `needs_reprocess`
- `exclude_from_accuracy`
- `exclude_from_training`

After any correction to the stop, agency, route or direction fields of an ended trip, `onTripFinalized` re-checks `stop_matched` (`refreshStopMatchAfterCorrection`) and updates it, in either direction.

When a trip's `agency` changes (active or ended), `onTripFinalized` also sets `timezone` to the new agency's zone from `AGENCY_TIMEZONE` (`functions/lib/constants.js`), or removes it when the new agency isn't in that table (`timezoneUpdateAfterAgencyChange`).

Background finalization (via `onTripFinalized` trigger + `runPostEndFinalization`) only runs on first `endTime`. Corrections set the exclusion flags and are skipped by the idempotency guard even if `needs_reprocess` is true; only explicit `triggerManualFinalization` (force) re-runs learning/grading.

## Recording User Intent in Corrections

When correcting a trip, prefer recording **what the user actually meant to enter** over immediately forcing the fully normalized canonical name.

### Why
- Future models (especially V6) benefit from seeing realistic imperfect inputs + the context (route, direction, time, etc.) that should have resolved them.
- It forces the matching logic to get stronger at handling real user phrasing instead of relying on perfect data.
- It creates better training signal about common failure modes.

### Practical Pattern
For a high-impact stop name correction (e.g. fixing a typo like "collegea"), follow this explicit checklist:

1. **Raw user input**  
   - `startStop` → Set to exactly what the user meant to text (e.g. `"College"`).  
   - Do **not** skip this even if `startStopName` will hold the canonical form.

2. **Canonical / Normalized name**  
   - `startStopName` → Set (or leave) as the correct canonical name from the stops library (e.g. `"College St at Spadina Ave"`).

3. **Matching flag**  
   - `stop_matched` → Set to `true` once the corrected raw intent + route/direction/time context should allow the system to resolve cleanly to the canonical stop.

4. **Correction metadata** (always required for high-impact changes)  
   - `correctedFields` → Use `ArrayUnion` to add the changed fields (e.g. `["startStop", "startStopName"]`).  
   - `correctedAt` → Set to the current timestamp.  
   - `originalValues` → Record the previous bad values for the fields being corrected (e.g. `{ "startStopName": "Collegea", "startStop": "collegea" }`).

5. **Exclusion / Reprocessing flags** (for high-impact corrections)  
   - `needs_reprocess` → `true`  
   - `exclude_from_training` → `true`  
   - `exclude_from_accuracy` → `true`

6. **Do not touch** (unless also intentionally correcting them)  
   - `journeyId`, `endStop*` fields, `route`, `direction`, etc.

**Example (real trip, May 2026, 506 Westbound):**

Before correction:
- `startStop`: null
- `startStopName`: "Collegea"
- `stop_matched`: false
- No correction metadata

After correction:
- `startStop`: "College" (what the user meant to text)
- `startStopName`: "College St at Spadina Ave" (canonical)
- `stop_matched`: true
- `correctedFields`: ["startStop", "startStopName"]
- `correctedAt`: <timestamp>
- `originalValues`: { "startStopName": "Collegea", "startStop": "collegea" }
- `needs_reprocess`: true
- `exclude_from_training`: true
- `exclude_from_accuracy`: true

This approach records the user's actual intent while still giving the trip a proper canonical name and protecting training/accuracy data.

The same pattern applies to other high-impact fields (route, direction, agency, etc.): record the intended raw/corrected value, ensure the canonical form is correct, set `stop_matched` / equivalent where applicable, apply full metadata + exclusion flags.

### Scenarios

**Scenario 1: Stop name typo on a transfer-heavy route**  
User rode the 506 Westbound and typed "collegea" instead of "College".  
- Set `startStop = "College"`.  
- Set `startStopName = "College St at Spadina Ave"` (canonical).  
- Set `stop_matched = true` (route + direction context supports clean resolution).  
- `correctedFields`, `originalValues`, `correctedAt`, and all three exclusion flags (`needs_reprocess`, `exclude_from_training`, `exclude_from_accuracy`) are applied.  
Result: The trip records the user's actual intent while remaining properly matched and excluded from training/accuracy.

**Scenario 2: Route mistyped (high-impact route correction)**  
User meant to log a trip on the 510 but typed "51".  
- Set `route = "510"`.  
- `correctedFields` includes "route".  
- `originalValues.route = "51"`.  
- Apply full exclusion flags.  
- No `stop_matched` change unless the stop was also affected.  
This prevents the bad route from polluting NetworkEngine observations and training data.

**Scenario 3: Ambiguous input with low confidence**  
User typed a vague stop name on a complex corridor. Even after correction to the intended text, route + direction context is not strong enough for automatic matching.  
- Record the intended raw value in `startStop`.  
- Set the best available `startStopName`.  
- Leave `stop_matched = false`.  
- Still apply all correction metadata + exclusion flags.  
This flags the trip for later review or manual reprocessing.

These scenarios show how the same core principles (record intent + proper metadata + exclusions) adapt to different situations while protecting long-term model quality.

### What to Do If...

- **The trip has already been processed by background finalization**  
  The learning/grading side-effects have already run. Apply the correction using the pattern above (record intent + canonical name + `stop_matched` + full metadata + exclusion flags). Do **not** expect automatic re-finalization — only an explicit `triggerManualFinalization(tripId)` will re-run the background work.

- **You later decide you *do* want the corrected trip to be reprocessed**  
  Call `triggerManualFinalization(tripId)` (this uses `force: true` internally). This bypasses the normal idempotency guard and exclusion logic for that one run. The trip will then contribute to NetworkEngine, HabitEngine, grading, etc.

- **Multiple fields need correction on the same trip** (e.g. both route and start stop)  
  Include all changed fields in `correctedFields`. Record each in `originalValues`. Apply the full set of exclusion flags. One correction record can cover multiple high-impact fields.

- **The corrected raw input still doesn't resolve cleanly** (even with route + direction)  
  Set `startStop` / `startStopName` to the best available value based on user intent. Leave `stop_matched = false`. The trip will remain flagged for potential later review or manual intervention. Still apply all exclusion flags.

- **A trip was corrected before the new "record intent" philosophy was adopted**  
  You can re-correct it. Update `startStop` to the intended raw value, refresh `originalValues` if desired, ensure the exclusion flags are present, and update `correctedAt`. This brings old corrections in line with the current approach.

- **You want to understand the impact of corrections on future V6 training**  
  Corrections that follow this pattern (intent preserved + exclusions applied) are exactly what we want for V6. They give the model realistic imperfect examples while preventing bad data from polluting accuracy or learning until the correction is resolved.

## Why Not Full Delayed Finalization Yet

The cleaner architecture would be to separate:

- **ended**: the trip is complete for the user
- **finalized**: the trip is safe for learning/grading

That would allow a correction window before the system commits the trip to downstream intelligence. But it adds real complexity:

- new lifecycle state for completed trips
- scheduled or opportunistic finalization rules
- new edge cases for transfer detection and habit rebuilding
- more bookkeeping around when a trip is visible vs trusted

For now, that complexity is likely disproportionate to the need.

## Candidate `CORRECT` Scope

If a correction command is added, the safest v1 is:

- admin-only
- only the most recent completed trip
- one field per message
- explicit deterministic grammar, not freeform AI-first parsing

Recommended command shape:

- `CORRECT ROUTE <value>`
- `CORRECT DIRECTION <value>`
- `CORRECT START <value>`
- `CORRECT END <value>`
- `CORRECT NOTES <value>`

Anything outside that should be rejected with a help message rather than guessed.

## Accuracy and Training Policy

Per-trip prediction grading can still happen immediately and be logged in `predictionStats`.

But aggregate model accuracy like "V3 is correct 75% of the time" should be treated as an on-demand calculation from raw `predictionStats`, not as fragile canonical counters.

Practical rule:

- `predictionStats` is the source of truth
- corrected high-impact trips are excluded from accuracy and training paths until explicitly reprocessed
- any incremental `predictionAccuracy` summaries are convenience telemetry only, not authoritative evaluation

## If Delayed Finalization Is Revisited Later

The likely design would be:

- `END` completes the trip for the user
- the most recent completed trip stays editable for some bounded rule
- downstream learning/grading finalizes later

Possible finalization triggers:

- next trip start
- timeout job
- explicit admin repair/reprocess flow

This remains a future architecture option, not a current implementation commitment.
