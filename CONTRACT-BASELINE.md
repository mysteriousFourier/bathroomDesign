# W1D1 Contract Baseline (Revised)

**Status**: Frozen — W1D1 backend data contracts. Changes require Orchestrator approval.
**Schema Version**: 1.0.0
**Revision**: v3 — deliverables changed from Markdown field tables to executable JSON Schema + validator per review.

## Deliverables

### Executable JSON Schema Files (`schemas/`)

| File | Entity | Description |
|------|--------|-------------|
| `measurement.schema.json` | Room Measurement | Room boundary, walls, openings, drainage points, pipe enclosures, water supply points, height parameters |
| `product.schema.json` | Product / Fixture | Fixture identifiers, dimensions, installation requirements, price placeholder |
| `rule.schema.json` | Rule / Constraint | Constraint types, applicability conditions, severity levels |
| `fixture-placement.schema.json` | Fixture Placement | Device ID, position, orientation, footprint/outline, target drainage point |

### Contract Specifications (`contracts/`)

| File | Content |
|------|---------|
| `COORDINATE-SYSTEM.md` | Frozen coordinate origin, X/Y/Z directions, rotation convention (±CCW), units (mm, integer), finished surface convention, height terminology |
| `SCHEMA-VERSIONING.md` | Stable UUID-based entity IDs, reference relationships, SemVer versioning, migration rules |

### Examples (`examples/`)

- `valid/` — 4 positive examples (one per schema) that must pass validation
- `invalid/` — 8 negative examples covering: missing required fields, wrong types, invalid enum values, conditional required failures, banned field names

### Validator (`scripts/validate.js`)

Runs all contract validations:
1. Schema files are valid JSON Schema (draft-07)
2. All valid examples pass
3. All invalid examples are correctly rejected

**Command**: `npm run validate`

**Exit codes**:
- `0` — All validations passed
- `1` — One or more validations failed
- `2` — Usage error

### Architecture Constraint (Not Implemented in W1D1)

- The geometric pipeline is a **deterministic code interface** (not a model service).
- **Model service adapters** exist as an architectural boundary rule only — no adapter code is implemented.
- All model service access must go through provider-neutral adapters; no vendor-specific API shape becomes part of the data contract.

## Coordinate System (Frozen)

| Parameter | Value |
|-----------|-------|
| Origin | Bottom-left corner of the room on finished floor, viewed from above |
| X axis | Horizontal, positive = right |
| Y axis | Depth, positive = inward |
| Z axis | Vertical, Z=0 = finished floor, positive = upward |
| Rotation | Positive = counterclockwise (right-hand rule) |
| Polygon winding | Counterclockwise |
| Units | Millimeters (mm), integer only |
| Default tolerance | ±1 mm geometric, ±0.5° angular |

## Height Terminology (Frozen)

The term "floor height" is **banned**. Use these specific fields:

| Field | Definition | Required |
|-------|------------|----------|
| `roomHeight` | Finished-floor to finished-ceiling (净高) | Yes |
| `groundElevation` | Finished floor elevation relative to building reference (±mm) | Yes |
| `wallHeight` | Finished floor to structural ceiling (before dropped ceiling) | Yes |
| `netHeight` | Net usable height after obstructions. Defaults to roomHeight | No |
| `doorOpeningHeight` | Finished floor to top of door rough opening | No |

## Field Requirement Classification

| Field Group | Required | Conditional | Optional |
|-------------|----------|-------------|----------|
| `roomId`, `boundary`, `walls`, `heights.roomHeight`, `heights.groundElevation`, `heights.wallHeight` | Yes | — | — |
| `openings` | — | — | Yes (room may have no openings recorded) |
| `openings[].sillHeight` | — | Yes (when type=window) | — |
| `openings[].swingOpening` | — | Yes (when type=door) | — |
| `drainagePoints` | — | — | Yes (room without drains is valid) |
| `pipeEnclosures` | — | — | Yes (no pipe enclosure does NOT mean failure) |
| `waterSupplyPoints` | — | — | Yes (room without water supply is valid) |
| `heights.netHeight` | — | — | Yes (defaults to roomHeight) |
| `heights.doorOpeningHeight` | — | — | Yes (scenario-dependent default) |

## Entity IDs and References

- All entities use **UUID v4** as stable identifiers, assigned at creation and never changed.
- Product IDs use format `PROD-<uuid>` (confirmed) or `PLACEHOLDER-<category>` (pending_business_confirmation).
- Reference integrity: `FixturePlacement.roomId` → `Measurement.roomId`, `FixturePlacement.productId` → `Product.productId`, `FixturePlacement.targetDrainagePoint` → `Measurement.drainagePoints[].drainId`.
- Schema version follows SemVer with defined migration rules for each bump level (see `contracts/SCHEMA-VERSIONING.md`).

## FixturePlacement Entity

Added to support W1D4 topology validation. Each placement records:
- `placementId` — stable UUID for this fixture instance
- `roomId` — reference to the room measurement
- `productId` — reference to the product definition
- `position` — 3D point (x, y, z) of fixture anchor
- `orientation` — rotation around Z axis (CCW positive) + cardinal facing
- `footprint` — occupied floor area (rectangular, circular, or polygonal)
- `targetDrainagePoint` — which drain this fixture connects to

## Acceptance Criteria

1. **Schema validation passes**: `npm run validate` exits with code 0
2. **All 4 schemas** compile and validate as valid JSON Schema (draft-07)
3. **All 4 valid examples** pass their respective schema validations
4. **All 8 invalid examples** are correctly rejected by their respective schemas
5. **Coordinates, heights, IDs, versions** are frozen per the contract specs

## Pending Business Confirmation

- `pending_business_confirmation`: Canonical product library IDs — placeholder IDs (PLACEHOLDER-*) are used until confirmed
- `pending_business_confirmation`: Customer-facing field labels and annotation vocabulary
- `pending_business_confirmation`: Default wall height, room height, and door opening height values
- `pending_business_confirmation`: Authorization to register real cases

## Blocking Condition

If a required contract field cannot be mapped to an owner or confirmation state, W1D2 must not start.

## Repository Layout

```
bathroomDesign/
├── schemas/
│   ├── measurement.schema.json
│   ├── product.schema.json
│   ├── rule.schema.json
│   └── fixture-placement.schema.json
├── examples/
│   ├── valid/
│   │   ├── measurement-valid-001.json
│   │   ├── product-valid-001.json
│   │   ├── rule-valid-001.json
│   │   └── fixture-placement-valid-001.json
│   └── invalid/
│       ├── measurement-invalid-001-missing-roomId.json
│       ├── measurement-invalid-002-too-few-boundary.json
│       ├── measurement-invalid-003-banned-floor-height.json
│       ├── measurement-invalid-004-window-without-sill.json
│       ├── measurement-invalid-005-string-coordinate.json
│       ├── product-invalid-001-bad-product-id.json
│       ├── rule-invalid-001-bad-severity.json
│       └── fixture-placement-invalid-001-missing-orientation.json
├── contracts/
│   ├── COORDINATE-SYSTEM.md
│   └── SCHEMA-VERSIONING.md
├── scripts/
│   └── validate.js
└── package.json
```

## Adapter Boundary Rule

All model services are accessed through provider-neutral adapters. No vendor-specific API shape becomes part of the data contract. The geometric pipeline is deterministic code (not a model service). Model service adapters are an architectural constraint only — no implementation in W1D1.

## Contract Change Rule

Any interface change after W1D1 requires Orchestrator approval before implementation work starts.

Responsible role: Data.
