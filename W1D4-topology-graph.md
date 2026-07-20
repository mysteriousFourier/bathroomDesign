# W1D4 Topology Graph Plan

Source plan: `W1-DAILY-PLAN.md` revision v3.

Scope: Week 1 only. This file is the child-task attachment for W1D4 and mirrors the parent plan after the 2026-07-20 user review. It does not replace implementation artifacts.

## Primary Result

`W1D4-topology-graph` - serializable topology JSON built from W1D3 recovery output plus `FixturePlacement`, product, and drain references, with EV-008 evidence mapping ready for independent review.

## Inputs

- W1D3 2D room boundary, wall segments, openings, drainage points, and pipe enclosures.
- W1D1 `fixture-placement.schema.json` and `product.schema.json`.
- `FixturePlacement.roomId`, `FixturePlacement.productId`, `FixturePlacement.targetDrainagePoint`, `orientation.rotationZ`, and `footprint` fields.
- W1D2 evidence table and threshold registry.

## Outputs

- Topology graph JSON with nodes for room boundary, walls, openings, fixtures, drainage points, and pipe enclosures, plus edges for adjacency, hosting, containment, and alignment.
- Closure and ownership checks for closed/non-self-intersecting room boundary and opening-to-wall assignment.
- Fixture containment checks that apply `orientation.rotationZ` and cover rectangular, circular, and polygonal footprints.
- Drain alignment output with measured distance and status. Shared drainage points are not failed without an explicit rule; if threshold or sharing rule is pending, status remains `unverified`.
- Failure samples for invalid references, fixture outside room, footprint containment failure, malformed topology, and drain reference/alignment issues.
- EV-008 update with actual topology artifact paths, command, and unresolved threshold markers.

## Acceptance Evidence

- `npm run validate:w1d4` or the W1D4 portion of `npm run validate` exits 0 against topology golden output and failure samples.
- Topology JSON is serializable and can be consumed by W1D5.
- Every topology rule maps to W1D1 contract fields and EV-008.
- Threshold-dependent decisions remain `unverified` while THR-TOPO rows are `pending_business_confirmation`.

## Dependencies

Predecessors: W1D1, W1D2, W1D3.

## Responsible Roles

- Geometry: implementation.
- Data: contract/evidence mapping only.

## Pending Business Confirmation

- `pending_business_confirmation`: THR-TOPO-001 through THR-TOPO-005, including drain distance and clearance rules.

## Blocking Condition

If W1D3 output is unavailable, W1D4 can only validate topology schema shape and cannot claim closure or containment evidence.

