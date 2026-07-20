# Failure Example Catalog

Status: W1D2. Named and scoped failure examples for Week 1 geometry, topology, 3D, and annotation acceptance. No implementation fixtures are provided in this planning task — this catalog names the failure mode, related contract field, expected behavior, and the domain where the test will be implemented.

## Naming Convention

`<domain>-fail-<seq>-<failure-mode>`

Domains: `geom` (2D geometry), `topo` (topology), `3d` (3D empty-room), `annot` (annotation), `contract` (contract/schema)

## W1D1-Era Failures (Already Covered)

These 8 failures are already implemented as contract-test negative examples in `examples/invalid/`:

1. `contract-fail-001-missing-roomId` — missing required `roomId` field
2. `contract-fail-002-too-few-boundary` — boundary array with < 4 points
3. `contract-fail-003-banned-floor-height` — banned `floorHeight` field present
4. `contract-fail-004-window-without-sill` — window opening without required `sillHeight`
5. `contract-fail-005-string-coordinate` — coordinate value is string instead of integer
6. `contract-fail-006-bad-product-id` — `productId` doesn't match `PROD-*` or `PLACEHOLDER-*` pattern
7. `contract-fail-007-bad-severity` — rule `severity` is not one of `error|warning|info`
8. `contract-fail-008-missing-orientation` — fixture placement missing required `orientation`

## W1D3 2D Geometry Failures

| ID | Failure Mode | Contract Field | Expected Behavior | Implemented In |
|---|---|---|---|---|
| `geom-fail-001-non-closed-polygon` | Boundary end point ≠ start point | measurement.schema.json → boundary | Validation or recovery must detect gap and report; cannot silently close | W1D3 geometry tests |
| `geom-fail-002-cw-winding` | Boundary vertices are clockwise, not CCW | CONTRACT-BASELINE.md → polygon winding | Validation must detect wrong winding order; geometry must use CCW only | W1D3 geometry tests |
| `geom-fail-003-wall-boundary-mismatch` | walls array length ≠ boundary array length | measurement.schema.json → walls ↔ boundary | Schema enforces minItems=4 on both arrays; 1:1 mapping expectation must be tested | W1D3 geometry tests |
| `geom-fail-004-zero-coordinate` | Coordinate of zero that should be non-zero | measurement.schema.json → Point2D | Integer zero is valid but may indicate data-capture bug; logged as warning | W1D3 geometry tests |
| `geom-fail-005-self-intersecting-boundary` | Boundary polygon edges cross each other | measurement.schema.json → boundary | Geometry recovery or validation must detect self-intersection and reject | W1D3 geometry tests |
| `geom-fail-006-opening-off-wall` | Opening position is not on the wall segment it references | measurement.schema.json → openings[].position ↔ wallIndex | Validation must detect opening-to-wall deviation; cannot accept misattributed openings | W1D3 geometry tests |
| `geom-fail-007-negative-thickness` | Wall thickness ≤ 0 | measurement.schema.json → WallSegment.thickness | Schema enforces minimum:1; test confirms rejection | W1D3 geometry tests |
| `geom-fail-008-duplicate-room-id` | Two measurements with same roomId | measurement.schema.json → roomId | No enforcement at schema level; topology layer must detect duplicate | W1D3 geometry tests |
| `geom-fail-009-opening-exceeds-wall` | Opening width + position exceeds wall segment length | measurement.schema.json → openings[].position, openings[].width | Opening must fit within wall segment; tolerance check needed | W1D3 geometry tests |
| `geom-fail-010-collinear-wall-segments` | Two adjacent walls are collinear (0°/180° angle) | measurement.schema.json → walls[] | Degenerate geometry — three consecutive points on a line; should detect and warn | W1D3 geometry tests |

## W1D3 Topology Failures

| ID | Failure Mode | Contract Field | Expected Behavior | Implemented In |
|---|---|---|---|---|
| `topo-fail-001-door-overlaps-wall-edge` | Door opening overlaps with the wall corner/edge | measurement.schema.json → openings[].position | Door must not overlap wall corners; clearance check needed | W1D3 topology tests |
| `topo-fail-002-opening-not-on-wall` | Opening wallIndex refers to wall that doesn't exist | measurement.schema.json → openings[].wallIndex | Schema doesn't validate by-reference; topology layer must check index is valid | W1D3 topology tests |
| `topo-fail-003-window-no-sill-on-ground` | Window with sillHeight=0 (at ground level) | measurement.schema.json → Opening.sillHeight | Schema allows sillHeight≥0; topology should flag windows at ground level as suspicious | W1D3 topology tests |
| `topo-fail-004-door-swing-into-wall` | Door swingDirection conflicts with adjacent wall | measurement.schema.json → Opening.swingDirection | Topology must check swingOpening does not intersect adjacent walls | W1D3 topology tests |
| `topo-fail-005-drain-outputs-fixture` | Fixture drain position is outside room boundary | fixture-placement.schema.json → targetDrainagePoint | Must detect and reject | W1D3 topology tests |
| `topo-fail-006-fixture-partially-outside` | Fixture footprint extends beyond room boundary | fixture-placement.schema.json → Footprint | Containment check; must detect partial overlap | W1D3 topology tests |
| `topo-fail-007-two-fixtures-same-space` | Two fixture placements occupy overlapping area | fixture-placement.schema.json → position + footprint | Overlap detection must reject | W1D4 topology tests |
| `topo-fail-008-drain-in-pipe-enclosure` | Drainage point located inside pipe enclosure | measurement.schema.json → drainagePoints[].position ↔ pipeEnclosures[].boundary | Must detect containment conflict (drain inside non-accessible enclosure) | W1D4 topology tests |
| `topo-fail-009-missing-drain-for-fixture` | Fixture requires drain but targetDrainagePoint is absent | product.schema.json → installRequirements.requiresDrain; fixture-placement.schema.json → targetDrainagePoint | Must detect missing required drainage connection | W1D4 topology tests |
| `topo-fail-010-door-swing-blocked` | Door swing path intersects another fixture | measurement.schema.json → Opening.swingOpening; fixture-placement.schema.json → position + footprint | Door clearance zone overlap with fixture must be detected | W1D4 topology tests |

## W1D4 3D Failures

| ID | Failure Mode | Contract Field | Expected Behavior | Implemented In |
|---|---|---|---|---|
| `3d-fail-001-roomHeight-lt-wallHeight` | roomHeight > wallHeight (impossible: ceiling below wall top) | measurement.schema.json → heights.roomHeight, heights.wallHeight | 3D model must detect height inconsistency and flag as error or `pending_business_confirmation` | W1D4 3D tests |
| `3d-fail-002-netHeight-gt-roomHeight` | netHeight > roomHeight (net usable height exceeds ceiling) | measurement.schema.json → heights.netHeight | Must detect and reject if netHeight exceeds roomHeight | W1D4 3D tests |
| `3d-fail-003-opening-height-exceeds-wallHeight` | Opening height > wallHeight (opening taller than wall) | measurement.schema.json → Opening.height ↔ HeightParams.wallHeight | 3D extrusion must detect opening exceeds wall | W1D4 3D tests |
| `3d-fail-004-window-sill-above-wallHeight` | Window sillHeight + height > wallHeight | measurement.schema.json → Opening.sillHeight + height ↔ HeightParams.wallHeight | Window must fit within wall | W1D4 3D tests |
| `3d-fail-005-missing-height-for-3d-extrusion` | wallHeight=0 (height param missing actual value) | measurement.schema.json → HeightParams.wallHeight | Schema requires wallHeight; value of 0 may slip through; 3D must flag zero-wall-height | W1D4 3D tests |
| `3d-fail-006-groundElevation-conflict` | Room groundElevation inconsistent within a building floor | measurement.schema.json → HeightParams.groundElevation | Multi-room 3D must check elevation consistency | W1D4 3D tests |

## W1D5 Annotation Failures

| ID | Failure Mode | Contract Field | Expected Behavior | Implemented In |
|---|---|---|---|---|
| `annot-fail-001-unlabeled-opening` | Opening exists in 2D geometry but no annotation label | measurement.schema.json → openings[] | Annotation must label every opening; missing label is a detection failure | W1D5 annotation tests |
| `annot-fail-002-wrong-dimension-label` | Dimension annotation value ≠ actual geometry length | measurement.schema.json → boundary, walls | Annotation must match geometric truth within tolerance | W1D5 annotation tests |
| `annot-fail-003-invalid-evidence-ref` | Annotation references evidenceId that doesn't exist in registry | evidence-registry.md → evidenceId | Cross-reference must be valid; missing ref is a failure | W1D5 annotation tests |
| `annot-fail-004-unmapped-fixture-id` | Annotation uses a fixture/product ID not defined in schemas | product.schema.json → productId | Product IDs must match registry; unknown IDs are an error | W1D5 annotation tests |
| `annot-fail-005-label-overlap` | Two annotation labels overlap visually | N/A (presentation concern) | Labels must not overlap; may be flagged as warning depending on business confirmation | W1D5 annotation tests |
| `annot-fail-006-unconfirmed-label-vocabulary` | Label uses term not in confirmed vocabulary | CONTRACT-BASELINE.md → pending business confirmation | Annotation must flag unknown labels; cannot silently accept unconfirmed vocabulary | W1D5 annotation tests |

## Summary

| Domain | Failure Examples | Status |
|---|---|---|
| Contract (W1D1) | 8 | Implemented in `examples/invalid/` |
| 2D Geometry (W1D3) | 10 | Named, scoped; to be implemented in W1D3 |
| Topology (W1D3–W1D4) | 10 | Named, scoped; to be implemented in W1D3–W1D4 |
| 3D Empty-Room (W1D4) | 6 | Named, scoped; to be implemented in W1D4 |
| Annotation (W1D5) | 6 | Named, scoped; to be implemented in W1D5 |
| **Total** | **40** | 8 implemented, 32 named/scoped |

All W1D3–W1D5 failure examples reference specific contract fields from W1D1 schemas. No implementation fixture is created in this W1D2 planning task.
