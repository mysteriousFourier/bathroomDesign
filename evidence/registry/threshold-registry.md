# Threshold Registry

Stable baseline for Week 1 acceptance thresholds. Every row is either sourced from the W1D1 frozen contract or explicitly marked `pending_business_confirmation`.

## Domain Categories

| Category | Prefix | Description |
|---|---|---|
| Geometry | `THR-GEOM` | 2D recovery tolerances: wall length, angle, closure, collinearity |
| Topology | `THR-TOPO` | Topology graph validity: opening placement, fixture containment, drainage alignment, door clearance |
| 3D Empty-Room | `THR-3D` | 3D empty-room acceptance: heights, extrusion, dimensional verification |
| Annotation | `THR-ANN` | Annotation correctness: label placement, dimension accuracy, confidence thresholds |

## Threshold Table

| thresholdId | category | parameter | value | unit | source | status | appliesTo |
|---|---|---|---|---|---|---|---|
| `THR-GEOM-001` | Geometry | Geometric coordinate tolerance | ±1 | mm | CONTRACT-BASELINE.md coordinate system, frozen W1D1 | confirmed | All Point2D coordinate fields |
| `THR-GEOM-002` | Geometry | Angular tolerance | ±0.5 | degrees | CONTRACT-BASELINE.md coordinate system, frozen W1D1 | confirmed | Wall segment orientation, opening facing, fixture orientation.rotationZ |
| `THR-GEOM-003` | Geometry | Polygon winding direction | Counterclockwise | — | CONTRACT-BASELINE.md coordinate system, frozen W1D1 | confirmed | Room boundary, pipe enclosure boundary, fixture footprint vertices |
| `THR-GEOM-004` | Geometry | Minimum boundary vertices | 4 | points | measurement.schema.json boundary.minItems, frozen W1D1 | confirmed | Room boundary polygon |
| `THR-GEOM-005` | Geometry | Wall length tolerance | pending_business_confirmation | mm | pending_business_confirmation | pending_business_confirmation | Wall segment length deviation from boundary edge |
| `THR-GEOM-006` | Geometry | Boundary closure tolerance | pending_business_confirmation | mm | pending_business_confirmation | pending_business_confirmation | Distance between boundary polygon endpoint and start point |
| `THR-GEOM-007` | Geometry | Near-collinearity angle threshold | pending_business_confirmation | degrees | pending_business_confirmation | pending_business_confirmation | Adjacent wall segments; affects W1D3 topology |
| `THR-GEOM-008` | Geometry | Wall thickness tolerance | pending_business_confirmation | mm | pending_business_confirmation | pending_business_confirmation | Wall thickness match to measured value |
| `THR-TOPO-001` | Topology | Opening wall placement tolerance | pending_business_confirmation | mm | pending_business_confirmation | pending_business_confirmation | Opening center must lie on correct wall segment |
| `THR-TOPO-002` | Topology | Fixture containment tolerance | pending_business_confirmation | mm | pending_business_confirmation | pending_business_confirmation | Fixture footprint must not exceed room boundary |
| `THR-TOPO-003` | Topology | Drainage alignment tolerance | pending_business_confirmation | mm | pending_business_confirmation | pending_business_confirmation | Fixture position relative to target drainage point |
| `THR-TOPO-004` | Topology | Door clearance minimum | pending_business_confirmation | mm | pending_business_confirmation | pending_business_confirmation | Minimum front clearance for door-mounted fixtures |
| `THR-TOPO-005` | Topology | Fixture-fixture minimum clearance | pending_business_confirmation | mm | pending_business_confirmation | pending_business_confirmation | Minimum separation between adjacent fixtures |
| `THR-3D-001` | 3D Empty-Room | Default roomHeight (provisional) | 2800 | mm | pending_business_confirmation | pending_business_confirmation | Provisional value; blocks W1D4 final 3D when unconfirmed |
| `THR-3D-002` | 3D Empty-Room | Default wallHeight (provisional) | 2400 | mm | pending_business_confirmation | pending_business_confirmation | Provisional value; blocks W1D4 final 3D when unconfirmed |
| `THR-3D-003` | 3D Empty-Room | Default doorOpeningHeight (provisional) | 2100 | mm | pending_business_confirmation | pending_business_confirmation | Provisional value; blocks W1D4 final 3D when unconfirmed |
| `THR-3D-004` | 3D Empty-Room | 3D extrusion deviation tolerance | pending_business_confirmation | mm | pending_business_confirmation | pending_business_confirmation | 2D-boundary-to-3D-extrusion match |
| `THR-3D-005` | 3D Empty-Room | Opening extrusion accuracy | pending_business_confirmation | mm | pending_business_confirmation | pending_business_confirmation | 3D opening dimensions match 2D opening specs |
| `THR-3D-006` | 3D Empty-Room | Screenshot resolution minimum | pending_business_confirmation | px | pending_business_confirmation | pending_business_confirmation | Minimum screenshot resolution for visual review |
| `THR-3D-007` | 3D Empty-Room | Camera view requirements | pending_business_confirmation | — | pending_business_confirmation | pending_business_confirmation | Required camera angles for review screenshot |
| `THR-ANN-001` | Annotation | Dimension label accuracy tolerance | pending_business_confirmation | mm | pending_business_confirmation | pending_business_confirmation | Annotated dimension vs actual geometry |
| `THR-ANN-002` | Annotation | Label placement proximity | pending_business_confirmation | mm | pending_business_confirmation | pending_business_confirmation | Label position relative to annotated feature |
| `THR-ANN-003` | Annotation | Confidence score minimum threshold | pending_business_confirmation | float | pending_business_confirmation | pending_business_confirmation | Minimum confidence for auto-generated annotations |
| `THR-ANN-004` | Annotation | Fixture ID label correctness | 100 | % | pending_business_confirmation | pending_business_confirmation | Percentage of fixture IDs correctly labeled; target is 100% but business must confirm acceptability of lower rates |
| `THR-ANN-005` | Annotation | Evidence ID cross-reference accuracy | 100 | % | pending_business_confirmation | pending_business_confirmation | All evidence IDs appearing in annotation output must reference existing evidence rows in the registry |
| `THR-ANN-006` | Annotation | Label vocabulary compliance | pending_business_confirmation | — | pending_business_confirmation | pending_business_confirmation | Customer-facing label vocabulary must be confirmed before annotation acceptance |
| `THR-ANN-007` | Annotation | Product library ID accuracy | pending_business_confirmation | — | pending_business_confirmation | pending_business_confirmation | Any product-bearing annotation must reference a confirmed product library ID |

## Summary

| Status | Count |
|---|---|
| confirmed (frozen from W1D1 contract) | 4 |
| pending_business_confirmation | 20 |

Total: 24 threshold rows. No threshold is fabricated — every numeric value either comes directly from the W1D1 frozen contract or is tracked as `pending_business_confirmation`.
