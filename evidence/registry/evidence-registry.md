# Evidence Registry

Status: Week 1 rolling evidence baseline. Maps every Week 1 locked item from the 最小实现计划书 line 222 to an evidence row. `evidence-registry.json` is the validation source; this Markdown file is display-only.

Rows for W1D1 and W1D2 items reference already-produced artifacts. EV-007 and EV-008 reference implemented W1D3/W1D4 geometry-topology artifacts and remain `unverified` because business thresholds are still pending. EV-009 through EV-011 remain W1D5 planned evidence rows.

## Evidence Table

| evidenceId | lockedItem | sourceType | contractFields | acceptanceMethod | expectedArtifact | owner | day | status | thresholdRefs | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `EV-001` | Data dictionary | contract_document | All measurement fields; HeightParams; coordinate system; entity IDs | Review CONTRACT-BASELINE.md completeness check; validate all 4 schemas compile with `npm run validate` exit 0 | `CONTRACT-BASELINE.md`, `schemas/*.schema.json` | Data | W1D1 | unverified | — | Technical fields are present; business names and product-bearing IDs remain `pending_business_confirmation` |
| `EV-002` | Backend contract | contract_document | Adapter boundary rule; contract change rule; provider-neutral constraint | Pending review of W1D1 unit, global Y-axis, semantic validation, and annotation baseline corrections | `contracts/COORDINATE-SYSTEM.md`, `contracts/SCHEMA-VERSIONING.md` | Data | W1D1 | pending_review | — | W1D1 backend contract remains unverified until correction review closes |
| `EV-003` | Scheduling baseline | contract_document | Daily dependency chain W1D1→W1D5 | Review that each day has one primary result, input/output list, acceptance evidence, and predecessor | `W1-DAILY-PLAN.md`, nested sub-issues AGEN-6.1–6.5 | Data | W1D1 | confirmed | — | Confirmed by issue scope |
| `EV-004` | Evidence table structure | schema_validation | evidence-table.schema.json | `npm run validate` passes on evidence schema; evidence rows cover all locked items | `evidence/schema/evidence-table.schema.json`, `evidence/registry/evidence-registry.json` | Data | W1D2 | confirmed | — | Real evidence sources for W1D3–W1D5 are `pending_implementation` |
| `EV-005` | Synthetic sample baseline | synthetic_fixture | measurement.schema.json: boundary, walls, openings, drainagePoints, pipeEnclosures, waterSupplyPoints, heights | `npm run validate` validates 5 synthetic fixture JSON files and 5 golden JSON files | `evidence/samples/synthetic/*.json`, `evidence/samples/golden/*.json` | Data | W1D2 | confirmed | `THR-GEOM-001`, `THR-GEOM-003`, `THR-GEOM-004` | Only synthetic fixture baseline is confirmed; real sample authorization remains separate in EV-012 and EV-013 |
| `EV-006` | Threshold baseline | schema_validation | coordinate tolerance, angular tolerance, thresholdRefs, threshold status policy | `npm run validate` validates threshold JSON and rejects pending-business thresholds with confirmable values | `evidence/registry/threshold-registry.json` | Data | W1D2 | unverified | `THR-GEOM-001`, `THR-GEOM-002`, `THR-GEOM-003`, `THR-GEOM-004`, `THR-IMPL-001`, `THR-IMPL-002`, `THR-IMPL-003`, `THR-TOPO-001` | Confirmed, provisional implementation, and pending business thresholds are separated |
| `EV-007` | 2D geometry | geometry_output | measurement.schema.json: boundary, walls, heights.*, optional openings/drainagePoints/pipeEnclosures; CCW winding | `npm run validate:w1d3` validates deterministic 2D recovery; missing required `heights.*` fails, while absent openings/drains/pipes is legal | `lib/recovery2d.js`, `contracts/geometry/w1d3-recovery-golden.json`, `contracts/geometry/w1d3-failure-examples.json`, `scripts/check-w1d3-geometry.js` | Geometry | W1D3 | unverified | `THR-GEOM-001`, `THR-GEOM-002`, `THR-GEOM-003`, `THR-GEOM-004`, `THR-GEOM-005`, `THR-GEOM-006`, `THR-GEOM-007`, `THR-GEOM-008` | Deterministic synthetic recovery is implemented; THR-GEOM-005..008 remain `pending_business_confirmation` |
| `EV-008` | Topology | topology_graph | measurement.schema.json: openings[].wallIndex, drainagePoints, pipeEnclosures; fixture-placement.schema.json: targetDrainagePoint, orientation.rotationZ, footprint | `npm run validate:w1d4` validates serializable topology JSON, opening ownership, FixturePlacement/Product/Drain references, rotated footprint containment, and drain distance/status output | `lib/topology.js`, `contracts/topology/w1d4-topology-golden.json`, `contracts/topology/w1d4-failure-examples.json`, `scripts/check-w1d4-topology.js` | Topology | W1D4 | unverified | `THR-TOPO-001`, `THR-TOPO-002`, `THR-TOPO-003`, `THR-TOPO-004`, `THR-TOPO-005` | Shared drains are not failed without an explicit rule; threshold-dependent alignment remains `unverified` |
| `EV-009` | Empty-room 3D | 3d_model | measurement.schema.json: heights (roomHeight, wallHeight, groundElevation, netHeight, doorOpeningHeight); boundary; openings | W1D5 scene JSON and screenshot/report reproduce empty-room 3D from W1D3/W1D4 outputs; every primitive has stable ID, source, evidence ID, and status | `contracts/3d/scene.json` (planned), screenshot/report (planned) | 3D | W1D5 | pending_implementation | `THR-3D-001`, `THR-3D-002`, `THR-3D-003`, `THR-3D-004`, `THR-3D-005`, `THR-3D-006`, `THR-3D-007` | Use only `roomHeight`, `wallHeight`, `groundElevation`, `netHeight`, and `doorOpeningHeight`; defaults remain provisional/unverified |
| `EV-010` | Automatic annotation | annotation_output | stable annotation IDs, source fields, dimension annotations, point annotations, evidence references, status | W1D5 annotation JSON validates label coverage, source/evidence references, and status markers for dimensions and points | `contracts/annotation/annotation.json` (planned), screenshot/report (planned) | Annotation | W1D5 | pending_implementation | `THR-ANN-001`, `THR-ANN-002`, `THR-ANN-003`, `THR-ANN-004`, `THR-ANN-005`, `THR-ANN-006`, `THR-ANN-007` | Customer-facing vocabulary and confidence thresholds remain `pending_business_confirmation` |
| `EV-011` | Week 1 final roll-up | rollup_table | All evidence rows EV-001 through EV-010 plus EV-012 and EV-013 | W1D5 roll-up links all 13 rows to day, artifact, status, and blocker without claiming real-case validation or business-threshold confirmation | `evidence/registry/week1-rollup.json` (planned) | Data | W1D5 | pending_implementation | — | Roll-up must preserve `unverified` and `pending_business_confirmation` markers until confirmations close |
| `EV-012` | Real sample scope REAL-001 | real_sample | REAL-001, measurement.*, authorization | Business authorization must be received before any real sample artifact is accepted or validated | `evidence/real-sample-scope.md` | Data | W1D2 | pending_business_confirmation | — | Scoped as simple rectangular bathroom; no real source file is confirmed or included |
| `EV-013` | Real sample scope REAL-002 | real_sample | REAL-002, measurement.*, authorization | Business authorization must be received before any real sample artifact is accepted or validated | `evidence/real-sample-scope.md` | Data | W1D2 | pending_business_confirmation | — | Scoped as bathroom with door and window; no real source file is confirmed or included |

## Status Summary

| Status | Count |
|---|---|
| confirmed | 3 |
| unverified | 4 (EV-001, EV-006, EV-007, EV-008) |
| pending_review | 1 (EV-002) |
| pending_implementation | 3 (EV-009 through EV-011) |
| pending_business_confirmation | 2 (EV-012, EV-013) |

## Coverage

- **13 evidence rows**: 11 locked-item rows plus two explicit real sample scope rows.
- Rows EV-007 and EV-008 document implemented synthetic geometry/topology evidence but are not business-confirmed.
- Rows EV-009 through EV-011 document W1D5 planned evidence shape and do not create implementation.
- Every row references specific contract fields and a concrete expected artifact.
- Threshold-dependent rows reference threshold registry IDs.
