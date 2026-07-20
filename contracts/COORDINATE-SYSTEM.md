# Coordinate System and Precision Specification

**Status**: Frozen — W1D1 contract baseline. Changes require Orchestrator approval.

## Coordinate System

### Origin
The origin `(0, 0, 0)` is defined as:
- The **bottom-left corner** of the room on the **finished floor surface**, as viewed from above the room looking down.

### Axis Directions
| Axis | Direction | Unit | Type |
|------|-----------|------|------|
| X    | Horizontal, positive = increasing to the right | mm | integer |
| Y    | Depth, positive = increasing inward (away from viewer) | mm | integer |
| Z    | Vertical, positive = increasing upward | mm | integer |

Z=0 is always the **finished floor level** of the room.

### Rotation Convention
- Rotation is measured around the Z axis.
- **Positive rotation = counterclockwise** when viewed from above (right-hand rule: thumb pointing up along +Z).
- Range: [0, 360) degrees.
- Rotation is specified as a `number` (degrees, not radians).

### Polygon Winding Order
- All closed polygons (room boundary, pipe enclosures, fixture footprints) MUST use **counterclockwise** vertex ordering when viewed from above.
- Clockwise ordering is invalid and will be rejected by validation.

## Precision

### Units
- All spatial measurements are in **millimeters (mm)**.
- All values are **integers** — no floating-point millimeters.

### Tolerance
- Default tolerance for geometric comparisons: ±1 mm.
- Angles: ±0.5 degrees.

## Finished Surface Convention

All measurements reference **finished surfaces**, not rough openings or structural cores:
- Wall positions: inner face of finished wall surface
- Floor: top of finished floor material (tile, etc.)
- Ceiling heights: underside of finished ceiling / soffit
- Door/window openings: finished opening dimensions
- Fixture positions: center/anchor point relative to finished floor

## Height Terminology

These are **distinct concepts** — do not conflate or abbreviate:

| Field | Definition | Required |
|-------|------------|----------|
| `roomHeight` | Finished-floor to finished-ceiling (净高 / net ceiling height) | Yes |
| `groundElevation` | Finished floor elevation relative to building reference level (±mm) | Yes |
| `wallHeight` | Finished floor to structural ceiling (before dropped ceiling) | Yes |
| `netHeight` | Net usable height after obstructions (beams, soffits). Defaults to roomHeight | No |
| `doorOpeningHeight` | Finished floor to top of door rough opening | No |

The term "floor height" is **banned** — it is ambiguous and has been a source of confusion. Use the specific field names above.
