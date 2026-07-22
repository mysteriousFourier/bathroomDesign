# W1 Daily Plan

Scope: Week 1 only. This plan does not read, request, copy, summarize, or infer from real customer cases, site media, addresses, or reference DWG files. All real-case and business-threshold dependencies are represented as `pending_business_confirmation`.

Revision: v3 - W1D3-W1D5 synchronized with the current data contract and evidence delivery wording. The banned `floorHeight` term is not used as a field or deliverable.

## Planning Baseline

| Day | Primary review result | Locked item | Dependency position |
| --- | --- | --- | --- |
| W1D1 | Frozen backend data contract, adapter boundary, and asset inventories | Data dictionary, contracts, material checklist, risk checklist | First, because all later evidence must bind to stable fields and provider-neutral model-service adapter boundaries |
| W1D2 | Sample registration, synthetic test fixtures, provisional threshold configuration, and evidence baseline | Samples, thresholds, acceptance baseline, and two-real-sample authorization gap | After W1D1 contract fields exist; before geometry tests can claim pass/fail |
| W1D3 | Deterministic 2D recovery from `Measurement` using `heights.*` and optional feature collections | 2D recovery implementation, golden output, failure samples, EV-007 | After threshold registry exists; before topology graph can validate closure and references |
| W1D4 | Serializable topology graph from W1D3 output plus `FixturePlacement`, product, and drain references | Topology JSON, closure/ownership/containment/alignment tests, EV-008 | After W1D3 2D geometry outputs are available |
| W1D5 | Empty-room 3D scene JSON, annotation JSON, screenshot/report, and Week 1 evidence roll-up | 3D empty-room, auto-annotation, EV-009/EV-010/EV-011 | Last, because 3D consumes 2D+topology and annotation references all upstream outputs |

## W1D3 Standard Empty-Room 2D Recovery

Primary result: `W1D3-2d-room-recovery` - deterministic 2D room geometry recovered from measurement JSON for standard rectangular/near-rectangular bathrooms, with golden output, failure samples, and EV-007 evidence mapping ready for independent review.

Inputs:
- W1D1 `measurement.schema.json` fields for `boundary`, `walls`, optional `openings`, optional `drainagePoints`, optional `pipeEnclosures`, optional `waterSupplyPoints`, and required `heights.roomHeight`, `heights.groundElevation`, `heights.wallHeight`.
- W1D2 threshold registry and synthetic fixtures. Unconfirmed business thresholds remain `pending_business_confirmation`.
- Provider-neutral model adapter boundary as an architecture rule only. W1D3 2D recovery itself is deterministic code and does not require a real model service adapter.

Outputs:
- 2D recovery module that reads `heights.*` only; missing required height fields fail contract validation.
- Golden recovery output for deterministic closed CCW boundary, wall segments, opening placement when openings exist, drainage point coordinates when drains exist, and pipe enclosure geometry when pipe enclosures exist.
- Legal empty-room/no-feature samples: missing `openings`, `drainagePoints`, or `pipeEnclosures` is not a failure.
- Failure samples for malformed or invalid geometry, such as non-closed/self-intersecting boundary, invalid opening reference or opening outside its wall, drainage point outside boundary, pipe enclosure outside boundary, clockwise pipe enclosure, or missing required `heights.*`.
- EV-007 update with actual module, golden artifact, failure artifact, command, and unresolved threshold markers.

Acceptance evidence:
- `npm run validate:w1d3` or the W1D3 portion of `npm run validate` exits 0 against golden output and failure samples.
- Every 2D primitive carries stable source linkage to measurement fields and EV-007.
- All pass/fail criteria reference confirmed calculation thresholds or remain `unverified` where business thresholds are pending.
- No concrete model-service provider or vendor API shape is introduced.

Predecessors: W1D1, W1D2.

Responsible role: Geometry for implementation; Data for contract/evidence mapping only.

Pending business confirmation:
- `pending_business_confirmation`: tolerances THR-GEOM-005 through THR-GEOM-008.
- `pending_business_confirmation`: any business default used when optional fields are absent.

Blocking condition:
- W1D3 can implement deterministic recovery with synthetic fixtures while thresholds remain pending, but EV-007 must stay `unverified` until those thresholds are confirmed.

## W1D4 Topology Graph and Closure Verification

Primary result: `W1D4-topology-graph` - serializable topology JSON built from W1D3 recovery output plus `FixturePlacement`, product, and drain references, with EV-008 evidence mapping ready for independent review.

Inputs:
- W1D3 2D room boundary, wall segments, openings, drainage points, and pipe enclosures.
- W1D1 `fixture-placement.schema.json` and `product.schema.json`.
- `FixturePlacement.roomId`, `FixturePlacement.productId`, `FixturePlacement.targetDrainagePoint`, `orientation.rotationZ`, and `footprint` fields.
- W1D2 evidence table and threshold registry.

Outputs:
- Topology graph JSON with nodes for room boundary, walls, openings, fixtures, drainage points, and pipe enclosures, plus edges for adjacency, hosting, containment, and alignment.
- Closure and ownership checks for closed/non-self-intersecting room boundary and opening-to-wall assignment.
- Fixture containment checks that apply `orientation.rotationZ` and cover rectangular, circular, and polygonal footprints.
- Drain alignment output with measured distance and status. Shared drainage points are not failed without an explicit rule; if threshold or sharing rule is pending, status remains `unverified`.
- Failure samples for invalid references, fixture outside room, footprint containment failure, malformed topology, and drain reference/alignment issues.
- EV-008 update with actual topology artifact paths, command, and unresolved threshold markers.

Acceptance evidence:
- `npm run validate:w1d4` or the W1D4 portion of `npm run validate` exits 0 against topology golden output and failure samples.
- Topology JSON is serializable and can be consumed by W1D5.
- Every topology rule maps to W1D1 contract fields and EV-008.
- Threshold-dependent decisions remain `unverified` while THR-TOPO rows are `pending_business_confirmation`.

Predecessors: W1D1, W1D2, W1D3.

Responsible role: Geometry for implementation; Data for contract/evidence mapping only.

Pending business confirmation:
- `pending_business_confirmation`: THR-TOPO-001 through THR-TOPO-005, including drain distance and clearance rules.

Blocking condition:
- If W1D3 output is unavailable, W1D4 can only validate topology schema shape and cannot claim closure or containment evidence.

## W1D5 Empty-Room 3D, Annotation, and Roll-Up

Primary result: `W1D5-3d-annotation-rollup` - empty-room 3D scene JSON, annotation JSON, screenshot/report evidence, and Week 1 evidence roll-up for EV-009, EV-010, and EV-011.

Inputs:
- W1D3 2D geometry and W1D4 topology JSON.
- W1D1 height fields: `roomHeight`, `wallHeight`, `groundElevation`, optional `netHeight`, optional `doorOpeningHeight`.
- W1D1 annotation standards and W1D2 evidence/threshold registries.
- Optional asset information only. Local furniture model directories are not Week 1 acceptance scope; placeholder geometry or asset registration is sufficient.

Outputs:
- Reproducible scene JSON that extrudes 2D geometry using `roomHeight`, `wallHeight`, and `groundElevation`; `netHeight` and `doorOpeningHeight` are used when available and otherwise documented as provisional/defaulted.
- Empty-room primitives for floor, walls, ceiling/open volume, openings, drainage points, and pipe enclosures. Every primitive has stable ID, source field, evidence ID, and status.
- Annotation JSON for wall lengths, opening dimensions, height labels, drainage/pipe/fixture points, and topology-derived references. Every annotation has stable ID, source field, evidence ID, and status.
- Screenshot/report artifact generated from synthetic or generated empty-room data only.
- EV-009, EV-010, and EV-011 updates. EV-011 roll-up covers all 13 evidence rows and preserves `unverified` or `pending_business_confirmation` states.

Acceptance evidence:
- Scene JSON, annotation JSON, and screenshot/report are reproducible from repository inputs.
- No `floorHeight` field or default is reintroduced.
- Default dimensions, customer-facing wording, camera/view choices, and unconfirmed thresholds produce only `unverified` or `provisional` statuses.
- The roll-up does not claim the two real cases are validated and does not claim all business thresholds are confirmed.

Predecessors: W1D1, W1D2, W1D3, W1D4.

Responsible role: Fronted for 3D/annotation implementation; Data for evidence roll-up and mapping only.

Pending business confirmation:
- `pending_business_confirmation`: default `roomHeight`, `wallHeight`, `doorOpeningHeight`, view/camera requirements, label vocabulary, confidence thresholds, product library IDs, and real-case authorization.

Blocking condition:
- If scene/annotation artifacts are missing, EV-009 through EV-011 remain `pending_implementation`. If artifacts exist but depend on pending business thresholds, they remain `unverified` rather than confirmed.

## Locked Item To Day To Evidence Mapping

| Week 1 locked item | Day | Primary artifact | Acceptance evidence | Confirmation state |
| --- | --- | --- | --- | --- |
| Data dictionary | W1D1 | `CONTRACT-BASELINE.md`; schemas | Schema validation and contract review | Business labels/product-bearing IDs remain `pending_business_confirmation` |
| Backend contract | W1D1 | `contracts/COORDINATE-SYSTEM.md`; `contracts/SCHEMA-VERSIONING.md` | Provider-neutral adapter and versioning rules | Model provider details intentionally excluded |
| Measurement JSON | W1D1 | `schemas/measurement.schema.json` | `npm run validate`; negative example for banned `floorHeight` | `heights.*` terminology frozen |
| Product JSON | W1D1 | `schemas/product.schema.json` | Product placeholder validation | Concrete product and price references require product library IDs |
| Rule JSON | W1D1 | `schemas/rule.schema.json` | Rule schema validation | Specific business rules may remain pending |
| Point-annotation standard | W1D1 | annotation standard artifact or section | Stable ID/source/evidence/status requirements | Label vocabulary pending |
| Material checklist | W1D1 | material checklist artifact or section | Completeness review | Real sources not used in Week 1 |
| Risk checklist | W1D1 | risk checklist artifact or section | Completeness review | Open risks carried into evidence |
| Real sample scope REAL-001 | W1D2 | `evidence/real-sample-scope.md` | Authorization gate | `pending_business_confirmation` |
| Real sample scope REAL-002 | W1D2 | `evidence/real-sample-scope.md` | Authorization gate | `pending_business_confirmation` |
| Synthetic test fixtures | W1D2 | `evidence/samples/synthetic/*.json`; golden JSON | `npm run validate` | Confirmed synthetic baseline only |
| Evidence table structure | W1D2 | `evidence/schema/*.schema.json`; registry JSON | Registry validation | Confirmed structure |
| Threshold baseline | W1D2 | `evidence/registry/threshold-registry.json` | Pending thresholds cannot carry fabricated values | Business thresholds pending |
| Standard empty-room 2D recovery | W1D3 | `lib/recovery2d.js`; `contracts/geometry/*`; W1D3 checker | EV-007; deterministic golden/failure validation | `unverified` until business thresholds confirmed |
| Optional openings/drains/pipes handling | W1D3 | W1D3 valid/negative samples | No-feature rooms valid; malformed/out-of-bounds/references fail | Contract-confirmed optionality |
| Topology graph and closure verification | W1D4 | `lib/topology.js`; `contracts/topology/*`; W1D4 checker | EV-008; serializable topology JSON | `unverified` until business thresholds confirmed |
| Fixture containment and drain alignment | W1D4 | `FixturePlacement` + Product + Measurement references | Rectangular/circular/polygonal footprints and distance/status output | Shared drains require explicit rule before failing |
| Empty-room 3D modelling | W1D5 | scene JSON and screenshot/report | EV-009 | Pending until Fronted delivery; threshold-dependent results unverified |
| Automatic annotation | W1D5 | annotation JSON and screenshot/report | EV-010 | Pending until Fronted delivery; wording/confidence pending |
| Week 1 final evidence roll-up | W1D5 | `evidence/registry/week1-rollup.json` | EV-011 covers 13 rows | Must preserve unverified/pending markers |

## Cross-Day Acceptance Rules

- One primary review result per day; supporting outputs must serve that result.
- No Week 2 implementation scope is included.
- No real customer cases, site media, addresses, or reference DWG files are used.
- All model-service integration remains provider-neutral through adapters.
- Any product or price-bearing item must reference an approved product library ID; absent IDs remain `pending_business_confirmation`.
- Contract changes after W1D1 require Orchestrator approval before implementation tasks proceed.
- W1D3-W1D5 deliver implementation modules, tests, artifacts, and evidence updates; planning text alone is not sufficient.
