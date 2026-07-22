import { describe, expect, it } from 'vitest'
import { manualRoom, roomBounds, roomCentroid, wallLength } from './spec'

describe('room helpers', () => {
  it('creates a millimeter rectangle', () => {
    const spec = manualRoom(1800, 2600, 2500)
    expect(roomBounds(spec.boundary)).toEqual({ minX: 0, maxX: 1800, minZ: 0, maxZ: 2600, width: 1800, depth: 2600 })
    expect(roomCentroid(spec.boundary)).toEqual({ x: 900, z: 1300 })
    expect(wallLength(spec.boundary, 1)).toBe(2600)
  })
})

