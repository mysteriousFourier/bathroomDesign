import { describe, expect, it } from 'vitest'
import { fixtureTopAppearance, planModelPosition, planTextureLayout, planTopCamera } from './planAppearance'

describe('top-down plan appearance', () => {
  it('keeps the selected floor product at its physical module size', () => {
    expect(planTextureLayout(600, 300, 0, 40, 20)).toEqual({
      tileWidthMm: 600,
      tileDepthMm: 300,
      offsetXmm: 40,
      offsetZmm: 20,
    })
  })

  it('rotates a rectangular floor module without stretching its texture', () => {
    expect(planTextureLayout(600, 300, 90)).toMatchObject({ tileWidthMm: 300, tileDepthMm: 600 })
  })

  it('uses recognizable furniture silhouettes and preserves point symbols', () => {
    expect(fixtureTopAppearance('toilet')).toBe('toilet')
    expect(fixtureTopAppearance('vanity')).toBe('vanity')
    expect(fixtureTopAppearance('floor_drain')).toBe('utility-point')
  })

  it('pins the model camera to SVG viewBox units instead of CSS pixels', () => {
    expect(planTopCamera(920, 680)).toMatchObject({
      position: [460, 1000, 340],
      left: -460,
      right: 460,
      top: 340,
      bottom: -340,
      manual: true,
    })
  })

  it('maps furniture centers through the same transform as SVG fixtures', () => {
    expect(planModelPosition(1600, 900, 0.2, 80, 50)).toEqual([400, 0, 230])
  })
})
