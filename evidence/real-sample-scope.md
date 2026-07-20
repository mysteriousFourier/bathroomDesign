# Real Sample Scope

Status: W1D2 corrected baseline. Week 1 real-sample target is fixed at two representative bathrooms.

Real sample authorization remains `pending_business_confirmation`; no real case data is read, requested, or inferred by W1D2.

## Fixed Target

| Sample Slot | Required Variation | Purpose | Status |
|---|---|---|---|
| `REAL-001` | Simple rectangular bathroom | Baseline 2D/3D dimension recovery | pending_business_confirmation |
| `REAL-002` | Bathroom with door + window | Opening topology and annotation coverage | pending_business_confirmation |

## Acceptance Guard

- Do not read real cases or reference DWG files in W1D2.
- Do not create synthetic data and label it as real.
- Do not mark real-sample evidence as `confirmed` while authorization is `pending_business_confirmation`.
- Do not expand the Week 1 real-sample target beyond the fixed two-sample scope.
- Do not block synthetic fixture work on real-sample availability.
