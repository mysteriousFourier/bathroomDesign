# Entity IDs, References, and Schema Versioning

**Status**: Frozen — W1D1 contract baseline. Changes require Orchestrator approval.

## Stable Entity IDs

All entities use **UUID v4** as their stable identifier. UUIDs are assigned at entity creation and never change.

### ID Fields by Entity

| Entity | ID Field | Format | Scope |
|--------|----------|--------|-------|
| Room Measurement | `roomId` | UUID v4 | Globally unique per room |
| Wall Segment | Index-based (position in `walls` array) | integer (0-based) | Scoped to measurement |
| Opening | `openingId` | UUID v4 | Globally unique |
| Drainage Point | `drainId` | UUID v4 | Globally unique |
| Pipe Enclosure | `enclosureId` | UUID v4 | Globally unique |
| Water Supply Point | `supplyId` | UUID v4 | Globally unique |
| Product (Fixture) | `productId` | `PROD-<uuid>` or `PLACEHOLDER-<category>` | Globally unique |
| Rule | `ruleId` | UUID v4 | Globally unique |
| Fixture Placement | `placementId` | UUID v4 | Globally unique |

### Product ID Resolution
- Concrete product IDs use format `PROD-<uuid>` and must reference an approved product library entry.
- When canonical product library IDs are `pending_business_confirmation`, use format `PLACEHOLDER-<category>` (e.g., `PLACEHOLDER-toilet`).
- All price-bearing assertions must reference a confirmed `PROD-*` ID before acceptance.

## Reference Relationships

Entities reference each other by their stable IDs:

```
FixturePlacement
  ├── roomId        → Measurement.roomId
  ├── productId     → Product.productId
  └── targetDrainagePoint → Measurement.drainagePoints[].drainId

Opening
  └── wallIndex     → Measurement.walls[index]
```

### Reference Integrity Rules
1. All references MUST resolve to an existing entity ID in the current dataset.
2. Forward references (referring to an entity that has not been loaded) are valid in partial datasets but invalid when a full dataset is validated.
3. An entity can be referenced by multiple other entities (e.g., multiple fixtures can target the same drain).
4. Referenced entities MUST be loaded before or concurrently with the referencing entity for full validation.

## Schema Versioning

### Version Format
All schemas carry a `version` field using **semantic versioning** (SemVer): `MAJOR.MINOR.PATCH`

### Version in `$id`
Each schema's `$id` URI includes the canonical endpoint. The `version` property in the schema body is the authoritative version.

### Compatibility Rules

| Change Type | Version Bump | Migration Required |
|-------------|-------------|-------------------|
| Adding an optional field | PATCH | No |
| Adding a required field | MINOR | Yes — existing valid data may become invalid |
| Removing a field | MAJOR | Yes |
| Changing a field type, enum values, or constraints | MAJOR | Yes |
| Renaming a field | MAJOR | Yes — provide an alias period |
| Changing coordinate system or precision | MAJOR | Yes — all coordinates must be re-derived |

### Migration Rules
1. Migration scripts must be provided for any MINOR or MAJOR version bump.
2. Migration scripts must validate that all data conforms after migration.
3. Old schema version data must be migratable to any newer version.
4. Data tagged with a schema version that is more than one MAJOR version behind the current schema must go through intermediate versions sequentially.
5. Migration scripts live in `migrations/` alongside the schemas.

### Backward Compatibility
- A PATCH bump guarantees backward compatibility (all v1.0.x data is valid for v1.0.y).
- A MINOR bump guarantees that all data valid under the old version can be made valid under the new version with the provided migration script.
