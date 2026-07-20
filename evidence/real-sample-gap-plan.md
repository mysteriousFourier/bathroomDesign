# Real-Sample Gap Resolution Plan

Status: Week 1 locked scope requires 3–5 de-identified bathroom samples. Currently only two real cases are known; a third (or more) is required to meet the minimum.

| Item | Detail |
|---|---|
| Gap | Minimum 1 additional de-identified bathroom sample needed to reach the 3-sample floor. The 最小实现计划书 line 222 specifies 3–5 samples. Currently: 2 known, 1+ needed. |
| Owner | Orchestrator (for escalation to business owner / member `b2fd0528`); Data to track status |
| Resolution target | Before W1D2 close; latest acceptable resolution point is W1D3 start |
| Week exit impact if unresolved | W1D3–W1D5 can proceed with synthetic fixtures only; real-sample evidence rows remain `pending_business_confirmation`; Week 1 exit cannot claim validated real-case coverage |
| Impact on W1D2 | Synthetic fixture set already covers rectangular and near-rectangular geometries; the gap blocks real-case registration and validation, not synthetic implementation |
| Split suggestion | If a third sample cannot be obtained during Week 1: (a) proceed with the two available cases for partial validation, (b) defer the third to a W2 catch-up sub-task, (c) flag the shortfall explicitly in the Week 1 exit report as open `pending_business_confirmation` |
| Tracking | `pending_business_confirmation` key `real_sample_count` to be maintained in evidence table; updated status reported at each daily commit point |

## Escalation Path

1. **W1D2**: Data reports gap in evidence registry (this document).
2. **W1D2 close**: If unresolved, Data posts a comment on this issue (AGEN-6.2) or parent (AGEN-6) flagging the gap.
3. **W1D3 start**: Last acceptable resolution point. If still unresolved, W1D3 proceeds with synthetic-only fixtures and all real-sample evidence rows carry `pending_business_confirmation` status.
4. **Week 1 exit**: Gap status documented in W1D5 evidence roll-up with explicit flag and escalation recommendation.

## Known Real Cases (Not Accessed)

| Case ID | Status | Notes |
|---|---|---|
| (Not authorized) | `pending_business_confirmation` | Two real cases known to exist but authorization for registration not yet granted |
| (Not authorized) | `pending_business_confirmation` | See above |
| (Gap) | `pending_business_confirmation` | Third sample needed; not yet identified |

These are tracked only for gap resolution planning. No real case data is read, requested, or inferred.
