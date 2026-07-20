# Evidence Baseline

W1D2 deliverable: sample registration, synthetic test fixtures, provisional threshold configuration, evidence table, and real-sample gap resolution plan.

## Directory

| Path | Content |
|---|---|
| `schema/evidence-table.schema.json` | JSON Schema for evidence table rows |
| `schema/evidence-registry.schema.json` | JSON Schema for the evidence registry container |
| `registry/evidence-registry.md` | 11 evidence rows for all Week 1 locked items (6 confirmed, 5 pending_implementation) |
| `registry/threshold-registry.md` | 24 threshold rows (4 frozen from W1D1 contract, 20 `pending_business_confirmation`) |
| `samples/synthetic-fixtures.md` | 5 synthetic fixture specifications covering rectangle, near-rectangle, single-open, multi-open, and full-featured geometries |
| `catalog/failure-examples.md` | 40 named failure examples (8 implemented in W1D1, 32 scoped for W1D3–W1D5) |
| `real-sample-gap-plan.md` | Gap resolution plan for third (or more) real bathroom sample |

## Acceptance Checklist

- [x] Evidence table contains rows for every Week 1 locked item (11 rows, 11 locked items)
- [x] Each threshold row is numeric-and-sourced (4 frozen from W1D1) or explicitly `pending_business_confirmation` (20)
- [x] Synthetic fixture geometry spans rectangle, near-rectangle, single-opening, multi-opening, and full-featured (5 fixtures)
- [x] Failure examples are named and scoped (40 total, 32 pending)
- [x] Gap resolution plan is explicit enough for Orchestrator escalation
- [x] No real customer cases, site media, addresses, or reference DWG files are used
- [x] No numeric threshold is fabricated — every value is either from W1D1 frozen contract or `pending_business_confirmation`
- [x] All contract field references trace back to W1D1 schemas

## Blocking Condition

Numeric acceptance cannot be separated from unconfirmed business choices for 20 of 24 thresholds. W1D3–W1D5 must proceed with `pending_business_confirmation` markers and must not invent pass/fail thresholds.

## Predecessors

- W1D1 frozen contract (schemas and CONTRACT-BASELINE.md) — complete and verified.

## Responsible Role

Data.
