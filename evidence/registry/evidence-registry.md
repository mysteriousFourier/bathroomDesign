# Evidence Registry

Status: W1D2 baseline. Maps every Week 1 locked item from the 最小实现计划书 line 222 to an evidence row. `evidence-registry.json` is the validation source; this Markdown file is display-only.

Rows for W1D1 items reference already-produced artifacts. Rows for W1D2 items reference this day's outputs. Rows for W1D3–W1D5 have planned evidence shape but status is `pending_implementation` — they document what the downstream day MUST produce but do not create that content.

## Evidence Table

| evidenceId | lockedItem | sourceType | contractFields | acceptanceMethod | expectedArtifact | owner | day | status | thresholdRef | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `EV-001` | Data dictionary | contract_document | All measurement fields; HeightParams; coordinate system; entity IDs | Review CONTRACT-BASELINE.md completeness check; validate all 4 schemas compile with `npm run validate` exit 0 | `CONTRACT-BASELINE.md`, `schemas/*.schema.json` | Data | W1D1 | unverified | — | Technical fields are present; business names and product-bearing IDs remain `pending_business_confirmation` |
| `EV-002` | Backend contract | contract_document | Adapter boundary rule; contract change rule; provider-neutral constraint | Review that no vendor-specific API shape appears in any contract doc or schema; confirm contract change rule documented | `contracts/COORDINATE-SYSTEM.md`, `contracts/SCHEMA-VERSIONING.md` | Data | W1D1 | confirmed | — | Model provider details intentionally excluded per adapter boundary |
| `EV-003` | Scheduling baseline | contract_document | Daily dependency chain W1D1→W1D5 | Review that each day has one primary result, input/output list, acceptance evidence, and predecessor | `W1-DAILY-PLAN.md`, nested sub-issues AGEN-6.1–6.5 | Data | W1D1 | confirmed | — | Confirmed by issue scope |
| `EV-004` | Evidence table structure | schema_validation | evidence-table.schema.json | `npm run validate` passes on evidence schema; evidence rows cover all locked items | `evidence/schema/evidence-table.schema.json`, `evidence/registry/evidence-registry.json` | Data | W1D2 | confirmed | — | Real evidence sources for W1D3–W1D5 are `pending_implementation` |
| `EV-005` | Sample baseline | synthetic_fixture | measurement.schema.json: boundary, walls, openings, drainagePoints, pipeEnclosures, waterSupplyPoints, heights | `npm run validate` validates 5 synthetic fixture JSON files and 5 golden JSON files | `evidence/samples/synthetic/*.json`, `evidence/samples/golden/*.json` | Data | W1D2 | confirmed | `THR-GEOM-001` | Week 1 real sample target fixed at 2 |
| `EV-006` | Threshold baseline | schema_validation | coordinate tolerance, angular tolerance, threshold status policy | `npm run validate` validates threshold JSON and rejects pending-business thresholds with confirmable values | `evidence/registry/threshold-registry.json` | Data | W1D2 | unverified | `THR-TOPO-001` | Pending business thresholds can only produce `unverified` evidence |
| `EV-007` | 2D geometry | geometry_output | measurement.schema.json: boundary, walls, wall.type, thickness; coordinate origin; CCW winding | 2D recovery produces closed CCW polygon matching input boundary within tolerance; wall segments match boundary edges 1:1; `npm run validate` on geometry outputs | `contracts/geometry/` (planned), test: `geometry-valid-*` pass, `geometry-invalid-*` correctly rejected | Geometry | W1D3 | pending_implementation | `THR-GEOM-002` | Tolerances: `pending_business_confirmation` |
| `EV-008` | Topology | topology_graph | measurement.schema.json: openings[].wallIndex, drainagePoints, pipeEnclosures; fixture-placement.schema.json: position, targetDrainagePoint | Topology graph verifies door-opening wall assignment, fixture containment within room, drainage alignment to target drain; closure check passes | `contracts/topology/` (planned), test: `topology-valid-*` pass | Topology | W1D3 | pending_implementation | `THR-TOPO-001` through `THR-TOPO-005` | Tolerances: `pending_business_confirmation` |
| `EV-009` | Empty-room 3D | 3d_model | measurement.schema.json: heights (roomHeight, wallHeight, groundElevation, netHeight); boundary→floor; walls→3D walls; openings→openings in 3D | 3D empty-room model matches 2D boundary extrusion with confirmed height params; visual inspection report generated | `contracts/3d/` (planned), screenshot/report artifact (planned) | 3D | W1D4 | pending_implementation | `THR-3D-001` through `THR-3D-007` | Default heights/views: `pending_business_confirmation` |
| `EV-010` | Automatic annotation | annotation_output | All 4 schemas: field labels, dimension annotations, evidence ID references | Annotation output labels dimensions and entities correctly; confidence markers present; no unmapped annotations | `contracts/annotation/` (planned) | Annotation | W1D5 | pending_implementation | `THR-ANN-001` through `THR-ANN-005` | Vocabulary and confidence thresholds: `pending_business_confirmation` |
| `EV-011` | Week 1 final roll-up | rollup_table | All evidence rows EV-001 through EV-010 | Roll-up links every locked item to day, artifact, and status; open confirmations listed; no Week 2 scope | `evidence/registry/week1-rollup.json` (planned) | Data | W1D5 | pending_implementation | — | Real-case authorization: `pending_business_confirmation` |

## Status Summary

| Status | Count |
|---|---|
| confirmed | 4 |
| unverified | 2 (EV-001, EV-006) |
| pending_implementation | 5 (EV-007 through EV-011) |
| pending_business_confirmation | 0 primary rows; pending business thresholds force `unverified` evidence |

## Coverage

- **11 evidence rows** for 11 locked items (full coverage, no gaps).
- Rows EV-007 through EV-011 are **placeholders** documenting what W1D3–W1D5 must produce; they do not create implementation.
- Every row references specific contract fields and a concrete expected artifact.
- Threshold-dependent rows reference threshold registry IDs.
