# W1D3 2D Room Recovery Plan

Source plan: `W1-DAILY-PLAN.md` revision v3.

Scope: Week 1 only. This file is the child-task attachment for W1D3 and mirrors the parent plan after the 2026-07-20 user review. It does not replace implementation artifacts.

## Primary Result

`W1D3-2d-room-recovery` - deterministic 2D room geometry recovered from measurement JSON for standard rectangular/near-rectangular bathrooms, with golden output, failure samples, and EV-007 evidence mapping ready for independent review.

## Inputs

- W1D1 `measurement.schema.json` fields for `boundary`, `walls`, optional `openings`, optional `drainagePoints`, optional `pipeEnclosures`, optional `waterSupplyPoints`, and required `heights.roomHeight`, `heights.groundElevation`, `heights.wallHeight`.
- W1D2 threshold registry and synthetic fixtures. Unconfirmed business thresholds remain `pending_business_confirmation`.
- Provider-neutral model adapter boundary as an architecture rule only. W1D3 2D recovery itself is deterministic code and does not require a real model service adapter.

## Outputs

- 2D recovery module that reads `heights.*` only; missing required height fields fail contract validation.
- Golden recovery output for deterministic closed CCW boundary, wall segments, opening placement when openings exist, drainage point coordinates when drains exist, and pipe enclosure geometry when pipe enclosures exist.
- Legal empty-room/no-feature samples: missing `openings`, `drainagePoints`, or `pipeEnclosures` is not a failure.
- Failure samples for malformed or invalid geometry, such as non-closed/self-intersecting boundary, invalid opening reference or opening outside its wall, drainage point outside boundary, pipe enclosure outside boundary, clockwise pipe enclosure, or missing required `heights.*`.
- EV-007 update with actual module, golden artifact, failure artifact, command, and unresolved threshold markers.

## Acceptance Evidence

- `npm run validate:w1d3` or the W1D3 portion of `npm run validate` exits 0 against golden output and failure samples.
- Every 2D primitive carries stable source linkage to measurement fields and EV-007.
- All pass/fail criteria reference confirmed calculation thresholds or remain `unverified` where business thresholds are pending.
- No concrete model-service provider or vendor API shape is introduced.

## Dependencies

Predecessors: W1D1, W1D2.

## Responsible Roles

- Geometry: implementation.
- Data: contract/evidence mapping only.

## Pending Business Confirmation

- `pending_business_confirmation`: tolerances THR-GEOM-005 through THR-GEOM-008.
- `pending_business_confirmation`: any business default used when optional fields are absent.

## Blocking Condition

W1D3 can implement deterministic recovery with synthetic fixtures while thresholds remain pending, but EV-007 must stay `unverified` until those thresholds are confirmed.
