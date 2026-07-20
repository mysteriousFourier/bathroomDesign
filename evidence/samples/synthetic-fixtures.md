# Synthetic Test Fixtures

W1D2 baseline. Synthetic fixture specifications covering minimum viable bathroom geometries. The executable source files are in `evidence/samples/synthetic/*.json` and validate against the W1D1 `measurement.schema.json` contract. Expected geometry/topology outputs are in `evidence/samples/golden/*.json`. The full-featured fixture also has product and fixture-placement samples under `evidence/samples/products/` and `evidence/samples/placements/`.

No real customer cases, site media, addresses, or reference DWG files are used.

## Fixture Inventory

| Fixture ID | Name | Geometry Type | Features | Purpose |
|---|---|---|---|---|
| `FIXTURE-001` | Rectangle Empty | Rectangle | 4 walls, no openings, no drains | Minimum valid bathroom; baseline for 2D recovery |
| `FIXTURE-002` | Near-Rectangle | Near-rectangle (slight coordinate skew) | 4 walls, no openings, no drains | Tests boundary tolerance without changing room topology |
| `FIXTURE-003` | Single Door | Rectangle | 4 walls, 1 door opening | Tests single-opening geometry; door-wall mapping |
| `FIXTURE-004` | Door + Window | Rectangle | 4 walls, 1 door, 1 window | Tests multi-opening geometry; opening type discrimination |
| `FIXTURE-005` | Full-Featured | Rectangle | 4 walls, 1 door, 1 window, 1 toilet drain, 1 pipe enclosure, cold water supply, 1 toilet placement | Maximum fixture coverage; drives downstream semantic validation |

## Fixture Specifications

### FIXTURE-001: Rectangle Empty

- **Boundary**: Rectangle 2400mm × 1800mm (CCW vertices at (0,0)→(2400,0)→(2400,1800)→(0,1800))
- **Walls**: 4 structural walls, 240mm thickness each
- **Openings**: None
- **Drainage**: None
- **Pipe enclosures**: None
- **Water supply**: None
- **Heights**: roomHeight=2400, groundElevation=0, wallHeight=2800

### FIXTURE-002: Near-Rectangle

- **Boundary**: Near-rectangle quadrilateral (CCW: (0,0)→(2400,8)→(2392,1800)→(6,1794)), all vertex offsets within 20mm of the enclosing rectangle
- **Walls**: 4 structural walls, 240mm thickness each
- **Openings**: None
- **Drainage**: None
- **Pipe enclosures**: None
- **Water supply**: None
- **Heights**: roomHeight=2400, groundElevation=0, wallHeight=2800

### FIXTURE-003: Single Door

- **Boundary**: Rectangle 2400mm × 1800mm (CCW: (0,0)→(2400,0)→(2400,1800)→(0,1800))
- **Walls**: 4 walls
  - Wall 0: structural, 240mm
  - Wall 1: structural, 240mm
  - Wall 2: partition, 120mm — contains door at (1200, 1800) center, 900mm width
  - Wall 3: structural, 240mm
- **Openings**: 1 door on wallIndex=2, position=(1200, 1800), width=900, height=2100, swingDirection=right, swingOpening=inward
- **Drainage**: None
- **Pipe enclosures**: None
- **Water supply**: None
- **Heights**: roomHeight=2400, groundElevation=0, wallHeight=2800

### FIXTURE-004: Door + Window

- **Boundary**: Rectangle 3000mm × 2400mm (CCW: (0,0)→(3000,0)→(3000,2400)→(0,2400))
- **Walls**: 4 exterior walls, 240mm thickness
  - Wall 0 (bottom): contains door at (1500, 0), width=900
  - Wall 2 (top): contains window at (1500, 2400), width=1200
- **Openings**:
  - Door: wallIndex=0, position=(1500, 0), width=900, height=2100, type=door, swingDirection=right, swingOpening=inward
  - Window: wallIndex=2, position=(1500, 2400), width=1200, height=1200, type=window, sillHeight=900
- **Drainage**: None
- **Pipe enclosures**: None
- **Water supply**: None
- **Heights**: roomHeight=2400, groundElevation=0, wallHeight=2800

### FIXTURE-005: Full-Featured

- **Boundary**: Rectangle 3000mm × 2400mm (CCW: (0,0)→(3000,0)→(3000,2400)→(0,2400))
- **Walls**: 4 exterior walls, 240mm thickness
- **Openings**:
  - Door: wallIndex=0, position=(800, 0), width=900, height=2100, type=door, swingDirection=right, swingOpening=inward
  - Window: wallIndex=2, position=(1500, 2400), width=1200, height=1200, type=window, sillHeight=900
- **Drainage points**: 1 toilet drain at (1500, 1200), type=toilet_drain, diameter=110
- **Pipe enclosure**: 1 enclosure at (2800, 0)–(3000, 0)–(3000, 400)–(2800, 400), containsDrain=true, isAccessible=false
- **Water supply**: 1 cold water supply at (300, 300), waterType=cold, heightAboveFloor=450
- **Product**: 1 synthetic toilet product placeholder, `PLACEHOLDER-toilet`
- **Fixture placement**: 1 floor-mounted toilet centered at (1500, 1200, 0), footprint 400mm × 700mm, targetDrainagePoint=`55555555-5555-4555-8555-000000000003`
- **Heights**: roomHeight=2400, groundElevation=0, wallHeight=2800

## Coverage Report

| Feature | FIXTURE-001 | FIXTURE-002 | FIXTURE-003 | FIXTURE-004 | FIXTURE-005 |
|---|---|---|---|---|---|
| Rectangle boundary | ✓ | — | ✓ | ✓ | ✓ |
| Near-rectangle coordinate skew | — | ✓ | — | — | — |
| Structural walls | ✓ | ✓ | ✓ | — | — |
| Partition walls | — | — | ✓ | — | — |
| Exterior walls | — | — | — | ✓ | ✓ |
| No openings | ✓ | ✓ | — | — | — |
| Single door | — | — | ✓ | — | — |
| Door + window | — | — | — | ✓ | ✓ |
| Toilet drain | — | — | — | — | ✓ |
| Pipe enclosure | — | — | — | — | ✓ |
| Water supply | — | — | — | — | ✓ |
| Toilet product + placement | — | — | — | — | ✓ |
| Height params | ✓ | ✓ | ✓ | ✓ | ✓ |

Coverage: 13 feature dimensions across 5 fixtures. Sufficient to drive W1D3 2D recovery (boundary, walls, openings), W1D4 3D extrusion semantics (heights, fixture containment, drainage reference), and W1D5 annotation (dimensions, labels).

## Validation Source

Markdown is display-only. `npm run validate` validates all five synthetic measurement JSON fixtures, full-featured product/placement samples, and all five golden JSON files. It checks computed area, perimeter, topology counts, opening wall indexes, height ordering, boundary-wall equality, opening-wall containment, near-rectangle semantics, fixture references, toilet drain targeting, and fixture footprint containment.
