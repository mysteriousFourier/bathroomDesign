# Evidence Baseline

W1D2 deliverable: sample registration, executable synthetic test fixtures, threshold configuration, evidence registry, and real-sample scope baseline. JSON files are the validation source; Markdown files are display summaries only.

Current mapping note: EV-007 and EV-008 describe implemented W1D3/W1D4 geometry-topology artifacts and remain `unverified` only because business thresholds are still pending. EV-009 and EV-010 now map to Fronted commit `42c46ccebc6a2180eef055ba58c08a3ebb37ebb0` as synthetic/generated W1D5 implementation evidence, remain `unverified`, and must use `roomHeight`, `wallHeight`, `groundElevation`, `netHeight`, and `doorOpeningHeight`; do not reintroduce `floorHeight`. EV-011 points to `registry/week1-rollup.json`, an executable Data-owned roll-up that preserves child row blockers and does not claim business confirmation.

## Directory

| Path | Content |
|---|---|
| `schema/evidence-table.schema.json` | JSON Schema for evidence table rows |
| `schema/evidence-registry.schema.json` | JSON Schema for the evidence registry container |
| `schema/threshold-registry.schema.json` | JSON Schema for threshold status/type policy |
| `schema/synthetic-golden.schema.json` | JSON Schema for expected synthetic geometry/topology |
| `schema/week1-rollup.schema.json` | JSON Schema for the Week 1 evidence roll-up |
| `registry/evidence-registry.json` | Validated evidence registry for all Week 1 locked items |
| `registry/evidence-registry.md` | Display summary of the evidence registry |
| `registry/week1-rollup.json` | Data-owned Week 1 evidence roll-up across all 13 rows |
| `registry/threshold-registry.json` | Validated threshold registry |
| `registry/threshold-registry.md` | Display summary of threshold rows |
| `samples/synthetic/*.json` | 5 W1D1-schema-compliant synthetic measurement fixtures |
| `samples/golden/*.json` | 5 expected geometry/topology golden JSON files |
| `samples/real/agen-17-long-term/` | Persisted real floorplan image for AGEN-17 OCR annotation and visual-model regression checks |
| `samples/synthetic-fixtures.md` | Display summary of the synthetic fixture set |
| `catalog/failure-examples.md` | 40 named failure examples (8 implemented in W1D1, 32 scoped for W1D3–W1D5) |
| `real-sample-scope.md` | Fixed two-real-sample scope note |

## Acceptance Checklist

- [x] Evidence table contains 13 rows: 11 Week 1 locked-item rows plus 2 explicit real-sample scope rows
- [x] Evidence registry JSON validates against `evidence-registry.schema.json`
- [x] Threshold registry JSON validates against `threshold-registry.schema.json`
- [x] Calculation tolerances, provisional implementation thresholds, and pending business thresholds are separated
- [x] `pending_business_confirmation` thresholds only produce `unverified` evidence
- [x] Synthetic fixture geometry spans rectangle, near-rectangle, single-opening, multi-opening, and full-featured (5 fixtures)
- [x] Five synthetic measurement JSON fixtures validate against W1D1 `measurement.schema.json`
- [x] Five golden JSON files validate and match computed geometry/topology
- [x] Failure examples are named and scoped (40 total, 32 pending)
- [x] First-week real sample target is fixed at two
- [x] No real customer cases, site media, addresses, or reference DWG files are used
- [x] No business threshold value is fabricated
- [x] All contract field references trace back to W1D1 schemas
- [x] W1D3 evidence wording treats `openings`, `drainagePoints`, and `pipeEnclosures` as optional collections; malformed/out-of-bounds/reference-invalid data is failure scope
- [x] W1D4 evidence wording includes `FixturePlacement`, product references, drain references, and rotated rectangular/circular/polygonal footprints
- [x] W1D5 evidence wording requires scene JSON, annotation JSON, screenshot/report, stable IDs, source fields, evidence IDs, and status markers
- [x] Week 1 roll-up JSON validates and mirrors all 13 evidence registry rows by day, owner, status, artifact, and contract fields

## Blocking Condition

Business acceptance cannot be confirmed from `pending_business_confirmation` thresholds. W1D3-W1D5 implementation evidence remains `unverified`, and the EV-011 roll-up remains `unverified` until all child blockers close.

## Predecessors

- W1D1 frozen contract (schemas and CONTRACT-BASELINE.md) — `pending_review`; unit, global Y-axis, semantic validation, and annotation baseline corrections remain unverified until review closes.

## Responsible Role

Data.
