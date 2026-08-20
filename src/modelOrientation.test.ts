import { describe, expect, it } from 'vitest'
import { modelOrientation } from './modelOrientation'

describe('model orientation correction', () => {
  it('uses only deterministic quarter-turns without compound rotation', () => {
    expect(modelOrientation('front').toArray().slice(0, 3)).toEqual([0, 0, 0])
    expect(modelOrientation('top').toArray().slice(0, 3)).toEqual([Math.PI / 2, 0, 0])
    expect(modelOrientation('bottom').toArray().slice(0, 3)).toEqual([-Math.PI / 2, 0, 0])
    expect(modelOrientation('left').toArray().slice(0, 3)).toEqual([0, Math.PI / 2, 0])
    expect(modelOrientation('right').toArray().slice(0, 3)).toEqual([0, -Math.PI / 2, 0])
    expect(modelOrientation('back').toArray().slice(0, 3)).toEqual([0, Math.PI, 0])
  })
})
