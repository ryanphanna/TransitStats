# Technical Roadmap

Open technical backlog organized by area. Items within each section are roughly
ordered by impact vs. effort. Shipped work belongs in the changelog and engine
docs, not here. Deferred feature ideas that need heavier rationale belong in
focused design notes, not as vague backlog entries.

---

## Messaging System (RCS / SMS)

The messaging layer is the primary trip logging interface. Core commands work; these are
quality and coverage improvements.

- [ ] **`STATS` command improvements** — extend the structured stats reply with weekly
  and monthly comparisons, not just all-time totals.
- [ ] **Multi-leg journey via SMS** — journey linking is automatic, but the SMS flow
  still has no explicit user-facing way to review or confirm multi-leg grouping before
  it lands in history. Improve how linked journeys are surfaced and corrected without
  relying on hidden/internal commands.
- [ ] **International number support** — phone number normalization currently assumes
  North American format. Standardize to E.164 throughout.
- [ ] **RCS suggested reply buttons** — attach tappable quick-reply chips to key responses for Android RCS users. Priority targets: `STATUS` reply (END TRIP / DISCARD / STATS) and trip-start confirmation (predicted end stops as tappable buttons, replacing the `END 1/2/3` shortcut system). SMS users receive the plain-text version unchanged via Twilio's automatic fallback.
- [ ] **Dynamic stale-trip handling** — stop treating trips older than a fixed age as nonexistent. Keep any `endTime == null` trip actionable, but mark unusually old trips as stale and tailor the UX (`END`, `FORGOT`, `DISCARD`) based on route context, agency, and observed duration patterns rather than a hard 6-hour cutoff.
- [ ] **Last-trip correction window + delayed finalization** — consider allowing `CORRECT ...` / `NOTES ...` style follow-up edits on only the most recent completed trip, with learning-side finalization delayed until the next trip start or a timeout job rather than happening immediately at `END`. This would reduce rollback complexity for prediction grading, journey linking, NetworkEngine, TransferEngine, and HabitEngine, but requires explicit `ended` vs `finalized` semantics so user-facing completion and downstream learning do not drift apart. See [Trip Corrections](../TRIP_CORRECTIONS.md).

---

## Dashboard & UI

- [x] **Transit Wrapped (monthly)** — shareable month card from trip history (trips,
  hours, streak, top route, favorite stop, busiest day) with PNG download at `/wrapped`.
  Year-in-review / multi-month recap still open.
- [ ] **Transit Wrapped (year)** — full calendar-year recap once yearly cohort data is ready.
- [ ] **Custom Goal Tracker** — users set a monthly trip target with a progress bar
  and streak visualization on the dashboard.
- [ ] **Route usage bubble scatterplot** — plot routes by recency and riding frequency,
  with bubble size representing lifetime rides and agency colour providing context.
  Finalize the axes and interaction model before replacing the current route-frequency view.
- [ ] **Route Heatmaps** — geographic heat layer showing most-frequent corridors,
  not just stop markers.
- [ ] **Suggested Routes** — proactive dashboard cards surfacing predicted next trip
  once prediction accuracy clears 90%. Feeds from the engine's confidence score.
- [ ] **Journey view** — a dedicated view for multi-leg journeys, showing transfer
  gaps, total trip time, and per-leg breakdown.

---

## Stop & Route Data

- [x] **Broader GTFS stop import** — done via Atlas. Route lists and stop metadata
  now come from Atlas's weekly R2-hosted GTFS refresh (`functions/lib/atlas-enrich.js`),
  so name resolution works for new stops without manual admin GTFS uploads.
- [ ] **Stop alias coverage** — expand the stops library to cover more agencies and
  surface more alias variants. Current coverage is TTC-heavy.
- [ ] **Multi-agency stops (`agencies` array)** — replace the single `agency` field on
  stop documents with an `agencies` array, so shared transit hubs (Union Station, etc.)
  are stored once and matched for any operator that boards there. Requires migrating
  existing stop documents and updating `lookupStop`/`findMatchingStops` to query with
  `array-contains`. Currently worked around by a cross-agency name fallback in `lookupStop`.
- [x] **Scheduled GTFS refresh** — done via Atlas. Atlas re-processes and republishes
  GTFS data on its own weekly schedule; TransitStats reads the current snapshot from
  R2 instead of running its own staleness detection.
- [ ] **Stop merge history** — when stops are merged via the Consolidation Panel,
  log the merge so it can be audited and reverted if needed.
- [ ] **Route completion tracking** — extend the Route Tracker beyond ridden/missing
  to show last-ridden date and estimated completion date at current pace.

---

## Multi-Agency

TransitStats already handles more than one agency, but the normalization,
analytics, and stop-layer assumptions are still uneven.

- [x] **Configurable multi-agency route normalization** — replace TTC-biased ML route heuristics with an explicit per-agency normalization policy layer. Keep raw trip route text unchanged, but derive a separate normalized route label for training and analytics so TTC branch/shuttle variants can collapse appropriately without hardcoding Toronto-specific assumptions into the model pipeline.

  **Done:** Refactored `ml/route_normalization.py` into a policy-based system (`TTCCollapsePolicy`, `DefaultPreservePolicy`, etc.). Added `register_policy()`, `configure_policies()`, `configure_from_dict()`, `load_policies_from_file()` (JSON + YAML), and `load_policies()` for easy startup configuration. The training and calibration scripts now use the new system. A `policies.example.json` with documentation was added.
- [ ] **Per-agency analytics** — dashboard views filterable by agency for users who
  ride multiple systems.
- [ ] **Agency auto-detection** — infer the agency from the stop name at trip start
  rather than requiring the user to specify.
- [ ] **Per-trip timezone semantics audit** — trip documents already store a timezone,
  but cross-city ASK queries still need an explicit audit to ensure every date-bucketing
  path actually respects per-trip timezone data rather than assuming one recent timezone
  for the whole query window.

---

## Infrastructure

- [ ] **Firestore index audit** — review composite indexes against actual query patterns.
  Remove unused indexes; add missing ones surfaced by slow query logs.
- [ ] **Error alerting** — Cloud Function errors currently surface only in logs.
  Add structured alerting for handler failures and Gemini proxy errors.
- [ ] **End-to-end test for SMS flow** — integration test covering the full
  START → END → STATS command sequence against a real (or emulated) Firestore instance.

---

## iOS Companion App

A native iOS companion app to serve as an alternative or supplement to SMS logging and offer rich on-device visualizations.

- [x] **SwiftUI Core App Scaffold** — Initial setup of a SwiftData-backed iOS application targeting iOS 17+.
- [x] **API-Based Logging** — Replicate SMS command flows (`START`, `END`, `DISCARD`) with a high-speed native interface that talks to the Cloud Functions backend, eliminating Twilio costs.
- [ ] **Home & Lock Screen Widgets** — Single-tap widgets to log frequent routes/directions or check active trip status.
- [ ] **Live Activities & GPS Tracking** — Live tracking of active journeys (similar to Rocket) with Dynamic Island integration.
- [ ] **On-Device Offline Cache** — Allow queuing trip logs offline and auto-syncing once internet connectivity is restored.

---

## Rocket Research Instrument

Rocket is a standalone mobile-first web tool for high-precision transit research. It
decomposes journeys into dwell time (doors open), signal delay (at red), and running
time (in motion) with millisecond-accurate state changes and GPS-anchored events.

- [ ] **Stop autocomplete** — resolve start/end stop names against the stops library.
- [ ] **Research map view** — visualize GPS-anchored events on a route map to identify
  where dwell/signal delays cluster spatially.
- [ ] **Aggregate analytics** — cross-trip summaries per route showing average dwell,
  signal, and running time breakdowns.
