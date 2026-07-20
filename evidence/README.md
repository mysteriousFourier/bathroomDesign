# Evidence Baseline

W1D2 deliverable: sample registration, executable synthetic test fixtures, threshold configuration, evidence registry, and real-sample scope baseline. JSON files are the validation source; Markdown files are display summaries only.

## Directory

| Path | Content |
|---|---|
| `schema/evidence-table.schema.json` | JSON Schema for evidence table rows |
| `schema/evidence-registry.schema.json` | JSON Schema for the evidence registry container |
| `schema/threshold-registry.schema.json` | JSON Schema for threshold status/type policy |
| `schema/synthetic-golden.schema.json` | JSON Schema for expected synthetic geometry/topology |
| `registry/evidence-registry.json` | Validated evidence registry for all Week 1 locked items |
| `registry/evidence-registry.md` | Display summary of the evidence registry |
| `registry/threshold-registry.json` | Validated threshold registry |
| `registry/threshold-registry.md` | Display summary of threshold rows |
| `samples/synthetic/*.json` | 5 W1D1-schema-compliant synthetic measurement fixtures |
| `samples/golden/*.json` | 5 expected geometry/topology golden JSON files |
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

## Blocking Condition

Business acceptance cannot be confirmed from `pending_business_confirmation` thresholds. W1D3–W1D5 must preserve `unverified` markers until the business decision is confirmed.

## Predecessors

- W1D1 frozen contract (schemas and CONTRACT-BASELINE.md) — `pending_review`; unit, global Y-axis, semantic validation, and annotation baseline corrections remain unverified until review closes.

## Responsible Role

Data.
