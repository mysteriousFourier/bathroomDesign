# Synthetic Test Fixtures

W1D2 baseline. Synthetic fixture specifications covering minimum viable bathroom geometries. These fixtures must validate against the W1D1 `measurement.schema.json` contract. They are designed to drive W1D3–W1D5 implementation without real cases.

No real customer cases, site media, addresses, or reference DWG files are used.

## Fixture Inventory

| Fixture ID | Name | Geometry Type | Features | Purpose |
|---|---|---|---|---|
| `FIXTURE-001` | Rectangle Empty | Rectangle | 4 walls, no openings, no drains | Minimum valid bathroom; baseline for 2D recovery |
| `FIXTURE-002` | Near-Rectangle | Near-rectangle (one chamfer) | 5 walls, no openings, no drains | Tests boundary tolerance; non-quadrilateral rooms |
| `FIXTURE-003` | Single Door | Rectangle | 4 walls, 1 door opening | Tests single-opening geometry; door-wall mapping |
| `FIXTURE-004` | Door + Window | Rectangle | 4 walls, 1 door, 1 window | Tests multi-opening geometry; opening type discrimination |
| `FIXTURE-005` | Full-Featured | Rectangle | 4 walls, 1 door, 1 window, 1 floor drain, 1 pipe enclosure, cold water supply | Maximum fixture coverage; drives all downstream tests |

## Fixture Specifications

### FIXTURE-001: Rectangle Empty

- **Boundary**: Rectangle 2400mm × 1800mm (CCW vertices at (0,0)→(2400,0)→(2400,1800)→(0,1800))
- **Walls**: 4 structural walls, 240mm thickness each
- **Openings**: None
- **Drainage**: None
- **Pipe enclosures**: None
- **Water supply**: None
- **Heights**: roomHeight=2800, groundElevation=0, wallHeight=2400

### FIXTURE-002: Near-Rectangle

- **Boundary**: 5-sided polygon (CCW: (0,0)→(2400,0)→(2400,1200)→(2100,1800)→(0,1800)), approximates a rectangle with one chamfered corner
- **Walls**: 5 structural walls, 240mm thickness each
- **Openings**: None
- **Drainage**: None
- **Pipe enclosures**: None
- **Water supply**: None
- **Heights**: roomHeight=2800, groundElevation=0, wallHeight=2400

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
- **Heights**: roomHeight=2800, groundElevation=0, wallHeight=2400

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
- **Heights**: roomHeight=2800, groundElevation=0, wallHeight=2400

### FIXTURE-005: Full-Featured

- **Boundary**: Rectangle 3000mm × 2400mm (CCW: (0,0)→(3000,0)→(3000,2400)→(0,2400))
- **Walls**: 4 exterior walls, 240mm thickness
- **Openings**:
  - Door: wallIndex=0, position=(800, 0), width=900, height=2100, type=door, swingDirection=right, swingOpening=inward
  - Window: wallIndex=2, position=(1500, 2400), width=1200, height=1200, type=window, sillHeight=900
- **Drainage points**: 1 floor drain at (1500, 1200), type=floor_drain, diameter=110
- **Pipe enclosure**: 1 enclosure at (2800, 0)–(3000, 0)–(3000, 400)–(2800, 400), containsDrain=true, isAccessible=false
- **Water supply**: 1 cold water supply at (300, 300), waterType=cold, heightAboveFloor=450
- **Heights**: roomHeight=2800, groundElevation=0, wallHeight=2400

## Coverage Report

| Feature | FIXTURE-001 | FIXTURE-002 | FIXTURE-003 | FIXTURE-004 | FIXTURE-005 |
|---|---|---|---|---|---|
| Rectangle boundary | ✓ | — | ✓ | ✓ | ✓ |
| Non-quadrilateral | — | ✓ | — | — | — |
| Structural walls | ✓ | ✓ | ✓ | — | — |
| Partition walls | — | — | ✓ | — | — |
| Exterior walls | — | — | — | ✓ | ✓ |
| No openings | ✓ | ✓ | — | — | — |
| Single door | — | — | ✓ | — | — |
| Door + window | — | — | — | ✓ | ✓ |
| Floor drain | — | — | — | — | ✓ |
| Pipe enclosure | — | — | — | — | ✓ |
| Water supply | — | — | — | — | ✓ |
| Height params | ✓ | ✓ | ✓ | ✓ | ✓ |

Coverage: 12 feature dimensions across 5 fixtures. Sufficient to drive W1D3 2D recovery (boundary, walls, openings), W1D4 3D extrusion (heights, walls, openings), and W1D5 annotation (dimensions, labels).
