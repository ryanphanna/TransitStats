# Tools

Operational scripts and small utilities for TransitStats.

Keep reusable scripts here. Do not create a second top-level scripts folder unless the repo develops a clear split between product/admin utilities and build/dev automation.

## Most Used

- `inspect-trip-context.js` — inspect one trip with nearby context for the same user
- `list-needs-review.js` — list recent trips still marked `needs_review`
- `find-duplicate-review-candidates.js` — surface likely duplicate trips for manual review
- `clear-route-review-flags.js` — clear route-review flags after confirmation
- `bulk-mark-duplicate-groups.js` — mark duplicate groups in bulk
- `audit-prediction-shadow.js` — summarize shadow prediction accuracy
- `audit-transfer-pair-candidates.js` — review repeated transfer-pair evidence before promoting it

## Review Ops

- `list-needs-review.js`
- `find-duplicate-review-candidates.js`
- `bulk-mark-duplicate-groups.js`
- `clear-route-review-flags.js`
- `retro-verify.js`
- `audit-unresolved.js`

## Prediction and Intelligence

- `audit-prediction-shadow.js`
- `inspect-trip-context.js`
- `audit-transfer-pair-candidates.js`

## Network and Stops

- `inspect-network-graph.js`
- `backfill-network-graph.js`
- `topup-network-graph.js`
- `diagnose-naming-drift.js`
- `create-normalized-stops.js`
- `gtfs-import-prep.py`

## Stop Metadata & Hubs

- `backfill-stop-metadata.js` — legacy/manual repair script for applying direction/routes/alias backfill to TTC stops from TTC GTFS. Idempotent and additive-only (never overwrites curated values). Routine enrichment now happens through Atlas `stops-meta` artifacts via `onStopCreated` (`functions/lib/atlas-enrich.js`). See TransitStats#152.
- `backfill-stop-metadata-dryrun.js` — dry-run version of the above, writes nothing
- `enrich-stops-from-trips.js` — backfill the normalized stops library from trip GPS coordinates
- `backfill-trip-hubs.js` — assign startHubId/endHubId on trips from the stops library
- `migrate-hubs-to-firestore.js` — migrate hardcoded CONNECTION_GROUPS into Firestore stop `hubId` fields
- `rollback-trip-hubs.js` — remove denormalized hubId fields from trip records

## Account Admin

- `set-admin.js` — grant or revoke admin in one command across both places it's checked (`allowedUsers/{email}` and `profiles/{userId}`), instead of two manual Firestore edits that are easy to get out of sync

## Standalone Utility


## Placement Rule

- If you expect to run it again, keep it in `Tools/`.
- If it is a local-only throwaway script, put it in `Tools/scratch/` so it stays out of git.
- If it is a one-off migration or temporary backfill worth keeping, name it clearly as such or remove/archive it after use.
- If a category grows large enough to be annoying, split inside `Tools/` by purpose rather than adding a new repo-root folder.
