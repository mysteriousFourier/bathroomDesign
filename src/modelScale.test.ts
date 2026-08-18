import { describe, expect, it } from 'vitest'
import { uniformModelScale } from './modelScale'

describe('model scale', () => {
  it('uses one uniform factor and never stretches individual axes', () => {
    const scale = uniformModelScale(
      { x: 2, y: 1, z: 0.5 },
      { x: 1, y: 0.8, z: 0.6 },
    )
    expect(scale).toBe(0.5)
    expect({ x:2 * scale, y:1 * scale, z:0.5 * scale }).toEqual({ x:1, y:0.5, z:0.25 })
  })
})
