# Threshold Registry

Stable baseline for Week 1 acceptance thresholds. `threshold-registry.json` is the validation source; this Markdown file is display-only. Calculation tolerances, provisional implementation thresholds, and pending business thresholds are separate states.

## Domain Categories

| Category | Prefix | Description |
|---|---|---|
| Geometry | `THR-GEOM` | Confirmed W1D1 calculation tolerances and geometry contract constants |
| Topology | `THR-TOPO` | Topology graph validity: opening placement, fixture containment, drainage alignment, door clearance |
| 3D Empty-Room | `THR-3D` | 3D empty-room acceptance: heights, extrusion, dimensional verification |
| Annotation | `THR-ANN` | Annotation correctness: label placement, dimension accuracy, confidence thresholds |
| Validation Harness | `THR-IMPL` | Provisional implementation-only test harness thresholds |

## Threshold Table

| thresholdId | category | parameter | value | unit | source | status | appliesTo |
|---|---|---|---|---|---|---|---|
| `THR-GEOM-001` | Geometry | Geometric coordinate tolerance | ±1 | mm | CONTRACT-BASELINE.md coordinate system, frozen W1D1 | confirmed | All Point2D coordinate fields |
| `THR-GEOM-002` | Geometry | Angular tolerance | ±0.5 | degrees | CONTRACT-BASELINE.md coordinate system, frozen W1D1 | confirmed | Wall segment orientation, opening facing, fixture orientation.rotationZ |
| `THR-GEOM-003` | Geometry | Polygon winding direction | Counterclockwise | — | CONTRACT-BASELINE.md coordinate system, frozen W1D1 | confirmed | Room boundary, pipe enclosure boundary, fixture footprint vertices |
| `THR-GEOM-004` | Geometry | Minimum boundary vertices | 4 | points | measurement.schema.json boundary.minItems, frozen W1D1 | confirmed | Room boundary polygon |
| `THR-IMPL-001` | Validation Harness | Synthetic golden numeric comparison tolerance | 0.01 | mm | W1D2 validation harness only | provisional_implementation | Computed perimeter comparison for synthetic golden JSON |
| `THR-GEOM-005` | Geometry | Wall length tolerance | null | mm | pending_business_confirmation | pending_business_confirmation | Wall segment length deviation from boundary edge |
| `THR-GEOM-006` | Geometry | Boundary closure tolerance | null | mm | pending_business_confirmation | pending_business_confirmation | Distance between boundary polygon endpoint and start point |
| `THR-GEOM-007` | Geometry | Near-collinearity angle threshold | null | degrees | pending_business_confirmation | pending_business_confirmation | Adjacent wall segments; affects W1D3 topology |
| `THR-GEOM-008` | Geometry | Wall thickness tolerance | null | mm | pending_business_confirmation | pending_business_confirmation | Wall thickness match to measured value |
| `THR-TOPO-001` | Topology | Opening wall placement tolerance | null | mm | pending_business_confirmation | pending_business_confirmation | Opening center must lie on correct wall segment |
| `THR-TOPO-002` | Topology | Fixture containment tolerance | null | mm | pending_business_confirmation | pending_business_confirmation | Fixture footprint must not exceed room boundary |
| `THR-TOPO-003` | Topology | Drainage alignment tolerance | null | mm | pending_business_confirmation | pending_business_confirmation | Fixture position relative to target drainage point |
| `THR-TOPO-004` | Topology | Door clearance minimum | null | mm | pending_business_confirmation | pending_business_confirmation | Minimum front clearance for door-mounted fixtures |
| `THR-TOPO-005` | Topology | Fixture-fixture minimum clearance | null | mm | pending_business_confirmation | pending_business_confirmation | Minimum separation between adjacent fixtures |
| `THR-3D-001` | 3D Empty-Room | Default roomHeight | null | mm | pending_business_confirmation | pending_business_confirmation | Pending business threshold; can only produce `unverified` |
| `THR-3D-002` | 3D Empty-Room | Default wallHeight | null | mm | pending_business_confirmation | pending_business_confirmation | Pending business threshold; can only produce `unverified` |
| `THR-3D-003` | 3D Empty-Room | Default doorOpeningHeight | null | mm | pending_business_confirmation | pending_business_confirmation | Pending business threshold; can only produce `unverified` |
| `THR-3D-004` | 3D Empty-Room | 3D extrusion deviation tolerance | null | mm | pending_business_confirmation | pending_business_confirmation | 2D-boundary-to-3D-extrusion match |
| `THR-3D-005` | 3D Empty-Room | Opening extrusion accuracy | null | mm | pending_business_confirmation | pending_business_confirmation | 3D opening dimensions match 2D opening specs |
| `THR-3D-006` | 3D Empty-Room | Screenshot resolution minimum | null | px | pending_business_confirmation | pending_business_confirmation | Minimum screenshot resolution for visual review |
| `THR-3D-007` | 3D Empty-Room | Camera view requirements | null | — | pending_business_confirmation | pending_business_confirmation | Required camera angles for review screenshot |
| `THR-ANN-001` | Annotation | Dimension label accuracy tolerance | null | mm | pending_business_confirmation | pending_business_confirmation | Annotated dimension vs actual geometry |
| `THR-ANN-002` | Annotation | Label placement proximity | null | mm | pending_business_confirmation | pending_business_confirmation | Label position relative to annotated feature |
| `THR-ANN-003` | Annotation | Confidence score minimum threshold | null | float | pending_business_confirmation | pending_business_confirmation | Minimum confidence for auto-generated annotations |
| `THR-ANN-004` | Annotation | Fixture ID label correctness | null | % | pending_business_confirmation | pending_business_confirmation | Customer-facing acceptance rate must be confirmed before use |
| `THR-ANN-005` | Annotation | Evidence ID cross-reference accuracy | null | % | pending_business_confirmation | pending_business_confirmation | Cross-reference acceptance rate must be confirmed before use |
| `THR-ANN-006` | Annotation | Label vocabulary compliance | null | — | pending_business_confirmation | pending_business_confirmation | Customer-facing label vocabulary must be confirmed before annotation acceptance |
| `THR-ANN-007` | Annotation | Product library ID accuracy | null | — | pending_business_confirmation | pending_business_confirmation | Any product-bearing annotation must reference a confirmed product library ID |

## Summary

| Status | Count |
|---|---|
| confirmed calculation tolerance (frozen from W1D1 contract) | 4 |
| provisional_implementation | 1 |
| pending_business_confirmation | 23 |

Total: 28 threshold rows. No business threshold value is fabricated; pending business rows use `null` and `verificationImpact=unverified_only`.
