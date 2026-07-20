# W1D5 3D Annotation Roll-Up Plan

Source plan: `W1-DAILY-PLAN.md` revision v3.

Scope: Week 1 only. This file is the child-task attachment for W1D5 and mirrors the parent plan after the 2026-07-20 user review. It does not replace implementation artifacts.

## Primary Result

`W1D5-3d-annotation-rollup` - empty-room 3D scene JSON, annotation JSON, screenshot/report evidence, and Week 1 evidence roll-up for EV-009, EV-010, and EV-011.

## Inputs

- W1D3 2D geometry and W1D4 topology JSON.
- W1D1 height fields: `roomHeight`, `wallHeight`, `groundElevation`, optional `netHeight`, optional `doorOpeningHeight`.
- W1D1 annotation standards and W1D2 evidence/threshold registries.
- Optional asset information only. Local furniture model directories are not Week 1 acceptance scope; placeholder geometry or asset registration is sufficient.

## Outputs

- Reproducible scene JSON that extrudes 2D geometry using `roomHeight`, `wallHeight`, and `groundElevation`; `netHeight` and `doorOpeningHeight` are used when available and otherwise documented as provisional/defaulted.
- Empty-room primitives for floor, walls, ceiling/open volume, openings, drainage points, and pipe enclosures. Every primitive has stable ID, source field, evidence ID, and status.
- Annotation JSON for wall lengths, opening dimensions, height labels, drainage/pipe/fixture points, and topology-derived references. Every annotation has stable ID, source field, evidence ID, and status.
- Screenshot/report artifact generated from synthetic or generated empty-room data only.
- EV-009, EV-010, and EV-011 updates. EV-011 roll-up covers all 13 evidence rows and preserves `unverified` or `pending_business_confirmation` states.

## Acceptance Evidence

- Scene JSON, annotation JSON, and screenshot/report are reproducible from repository inputs.
- No `floorHeight` field or default is reintroduced.
- Default dimensions, customer-facing wording, camera/view choices, and unconfirmed thresholds produce only `unverified` or `provisional` statuses.
- The roll-up does not claim the two real cases are validated and does not claim all business thresholds are confirmed.

## Dependencies

Predecessors: W1D1, W1D2, W1D3, W1D4.

## Responsible Roles

- Fronted: 3D/annotation implementation.
- Data: evidence roll-up and mapping only.

## Pending Business Confirmation

- `pending_business_confirmation`: default `roomHeight`, `wallHeight`, `doorOpeningHeight`, view/camera requirements, label vocabulary, confidence thresholds, product library IDs, and real-case authorization.

## Blocking Condition

If scene/annotation artifacts are missing, EV-009 through EV-011 remain `pending_implementation`. If artifacts exist but depend on pending business thresholds, they remain `unverified` rather than confirmed.

