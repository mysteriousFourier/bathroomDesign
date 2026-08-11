import { describe, expect, it } from 'vitest'
import { physicalTextureTransform, physicalWorldTextureTransform } from './surfaceTexture'

describe('physical surface texture layout', () => {
  it('keeps the original material size on a surface smaller than one panel', () => {
    expect(physicalTextureTransform(300, 400, 600, 800)).toEqual({
      repeatX: 0.5,
      repeatY: 0.5,
      offsetX: 0,
      offsetY: 0,
    })
  })

  it('keeps split wall parts aligned to one continuous layout grid', () => {
    expect(physicalTextureTransform(600, 1200, 600, 600, 1200, 600)).toEqual({
      repeatX: 1,
      repeatY: 2,
      offsetX: 2,
      offsetY: 1,
    })
  })

  it('converts ShapeGeometry world UVs from meters without multiplying by the room span twice', () => {
    expect(physicalWorldTextureTransform(600, 600, 1200, -600)).toEqual({
      repeatX: 5 / 3,
      repeatY: 5 / 3,
      offsetX: -2,
      offsetY: 1,
    })
  })
})
