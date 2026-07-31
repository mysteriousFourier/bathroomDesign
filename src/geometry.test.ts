import { describe, expect, it } from 'vitest'
import { metricBoundaryFromEdges, reconcileBoundaryEdges, solveBoundaryEdges } from './geometry'
import { defaultFinishSurfaceOffsetMm, defaultWallFinishThicknessMm, defaultWallThicknessMm, manualRoom, offsetBoundary, wallOutwardNormal } from './spec'
import type { BoundaryEdge, ImageBoundaryPoint } from './types'

const edge = (direction: BoundaryEdge['direction'], length_mm: number): BoundaryEdge => ({
  direction,
  length_mm,
  role: 'wall',
  evidence_ids: [],
  confidence: 0.9,
})

describe('measurement-chain closure', () => {
  it('absorbs a 5 mm field measurement error and preserves the reading', () => {
    const input = [edge('right', 4105), edge('down', 1840), edge('left', 4110), edge('up', 1840)]
    input[2].confidence = 0.8

    const result = metricBoundaryFromEdges(input)

    expect(result?.boundary).toHaveLength(4)
    expect(result?.edges[2]).toMatchObject({
      measured_length_mm: 4110,
      length_mm: 4105,
      closure_adjustment_mm: -5,
      source: 'derived',
    })
    expect(input[2].length_mm).toBe(4110)
    expect(input[2].measured_length_mm).toBeUndefined()
  })

  it('uses a bounded 1.5% field tolerance for a measured axis', () => {
    expect(solveBoundaryEdges([
      edge('right', 3000), edge('down', 2030), edge('left', 3000), edge('up', 2000),
    ])).not.toBeNull()
    expect(solveBoundaryEdges([
      edge('right', 3000), edge('down', 2031), edge('left', 3000), edge('up', 2000),
    ])).toBeNull()
  })

  it('does not invent a solution for multiple unknowns on one axis', () => {
    const input = [edge('right', 3000), edge('down', 2000), edge('left', 3000), edge('up', 2000)]
    input[0].length_mm = null
    input[2].length_mm = null
    expect(solveBoundaryEdges(input)).toBeNull()
  })
})

const point = (x: number, y: number): ImageBoundaryPoint => ({ x, y })

describe('boundary edge reconciliation', () => {
  const boundary = [point(0, 0), point(100, 0), point(100, 100), point(0, 100)]
  const edges = [edge('right', 1001), edge('down', 1002), edge('left', 1003), edge('up', 1004)]

  it('keeps untouched measurements associated with their segments after inserting a point', () => {
    const next = [point(0, 0), point(40, 0), point(100, 0), point(100, 100), point(0, 100)]

    const result = reconcileBoundaryEdges(next, boundary, edges)

    expect(result.map((item) => item.length_mm)).toEqual([null, null, 1002, 1003, 1004])
  })

  it('keeps untouched measurements associated with their segments after deleting a point', () => {
    const previous = [point(0, 0), point(40, 0), point(100, 0), point(100, 100), point(0, 100)]
    const previousEdges = [
      edge('right', 401), edge('right', 601), edge('down', 1002), edge('left', 1003), edge('up', 1004),
    ]

    const result = reconcileBoundaryEdges(boundary, previous, previousEdges)

    expect(result.map((item) => item.length_mm)).toEqual([null, 1002, 1003, 1004])
  })

  it('clears only the two segments adjacent to a moved point', () => {
    const next = [point(0, 0), point(100, 20), point(100, 100), point(0, 100)]

    const result = reconcileBoundaryEdges(next, boundary, edges)

    expect(result.map((item) => item.length_mm)).toEqual([null, null, 1003, 1004])
  })
})

describe('finished-surface wall expansion', () => {
  it('uses editable defaults for finished surface offset and wall thickness', () => {
    const room = manualRoom(3000, 2000, 2600)

    expect(room.finish_surface_offset_mm).toBe(defaultFinishSurfaceOffsetMm)
    expect(room.strip_existing_finish).toBe(true)
    expect(room.wall_finish_thickness_mm).toBe(defaultWallFinishThicknessMm)
    expect(room.wall_thickness_mm).toBe(defaultWallThicknessMm)
  })

  it('expands walls outward from a clockwise finished boundary', () => {
    const room = manualRoom(3000, 2000, 2600)

    expect(wallOutwardNormal(room.boundary, 0)).toEqual({ x: 0, z: -1 })
    expect(wallOutwardNormal(room.boundary, 1)).toEqual({ x: 1, z: 0 })
    expect(wallOutwardNormal(room.boundary, 2)).toEqual({ x: 0, z: 1 })
    expect(wallOutwardNormal(room.boundary, 3)).toEqual({ x: -1, z: 0 })
  })

  it('builds a continuous outer offset boundary for a rectangle', () => {
    const room = manualRoom(3000, 2000, 2600)

    expect(offsetBoundary(room.boundary, 220)).toEqual([
      { x_mm: -220, z_mm: -220 },
      { x_mm: 3220, z_mm: -220 },
      { x_mm: 3220, z_mm: 2220 },
      { x_mm: -220, z_mm: 2220 },
    ])
  })

  it('keeps concave and convex corners connected as one offset loop', () => {
    const boundary = [
      { x_mm: 0, z_mm: 0 },
      { x_mm: 3000, z_mm: 0 },
      { x_mm: 3000, z_mm: 1000 },
      { x_mm: 2000, z_mm: 1000 },
      { x_mm: 2000, z_mm: 2000 },
      { x_mm: 0, z_mm: 2000 },
    ]

    expect(offsetBoundary(boundary, 200)).toEqual([
      { x_mm: -200, z_mm: -200 },
      { x_mm: 3200, z_mm: -200 },
      { x_mm: 3200, z_mm: 1200 },
      { x_mm: 2200, z_mm: 1200 },
      { x_mm: 2200, z_mm: 2200 },
      { x_mm: -200, z_mm: 2200 },
    ])
  })
})
