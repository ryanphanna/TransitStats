# ML Status

Current state of TransitStats prediction systems. Historical metrics and dated findings belong in [MODEL_LOG.md](./MODEL_LOG.md), [ACCURACY_LOG.md](./ACCURACY_LOG.md), or a dated report under `evaluations/`.

## Production

- V3 remains the live user-facing route and end-stop predictor.
- Topology and GTFS-derived legality constraints remain authoritative where available.
- NetworkEngine contributes observed-trip evidence only; it does not become a substitute for physical network data.

## Candidates

- V4 and V5 are candidates, not run live: they're graded weekly against V3 on the past week's real trips (`docs/INTELLIGENCE.md`, Weekly shadow grading). They are not promoted by holdout accuracy alone.
- V6 remains an R&D candidate. Promotion requires a fresh, scoped, no-leakage comparison against the live path.

## Before changing production behaviour

1. Record the exact data scope, model versions, and evaluation script in a dated report under `evaluations/`.
2. Record limitations and whether the result is a backtest, replay, shadow result, or live result.
3. Put the promotion decision in `docs/decisions/` if it changes the live model or evaluation contract.
4. Update this file only after the change is actually deployed and verified.

## Canonical references

- Training/version history: [MODEL_LOG.md](./MODEL_LOG.md)
- Production accuracy snapshots: [ACCURACY_LOG.md](./ACCURACY_LOG.md)
- Architecture: [Intelligence](../docs/INTELLIGENCE.md) and [NextGen](../docs/roadmap/NEXTGEN.md)
