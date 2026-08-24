import { describe, expect, it } from 'vitest'
import { completeOrientationMapping, modelOrientation, orientationCubePlacement, orientationFaceLabels, resolveOrientationMapping } from './modelOrientation'
import { refreshFixtureModelAsset, refreshFixtureModelAssets, type RoomModelAsset } from './modelAssets'

describe('model orientation correction', () => {
  it('refreshes corrected orientation on fixtures already in the room', () => {
    const fixtures = [{ id:'fixture', kind:'other', label:'model', x_mm:0, z_mm:0, width_mm:1, depth_mm:1, height_mm:1, rotation_deg:0, source:'user', confidence:1, model_asset:{ id:'asset', label:'old', src:'/asset.glb', unit:'m', fit:'contain', orientation_view:'front' } }] as any[]
    const asset = { ...fixtures[0].model_asset, format:'glb', dimensions_mm:{width:1,depth:1,height:1}, orientation_view:'back', orientation_mapping:{back:'front',front:'back',top:'top'} } as RoomModelAsset
    expect(refreshFixtureModelAsset(fixtures, asset)).toBe(true)
    expect(fixtures[0].model_asset.orientation_view).toBe('back')
    expect(fixtures[0].model_asset.orientation_mapping).toEqual(asset.orientation_mapping)
  })
  it('never treats missing source asset ids as a match or depends on library order', () => {
    const fixture = { id:'fixture', kind:'other', label:'model', x_mm:0, z_mm:0, width_mm:1, depth_mm:1, height_mm:1, rotation_deg:0, source:'user', confidence:1, model_asset:{ id:'asset-a', label:'A', src:'/a.glb', unit:'m', fit:'contain', orientation_view:'front' } } as any
    const assets = [
      { id:'asset-b', label:'B', src:'/b.glb', format:'glb', orientation_view:'back', dimensions_mm:{width:1,depth:1,height:1} },
      { id:'asset-a', label:'A', src:'/a.glb', format:'glb', orientation_view:'left', dimensions_mm:{width:1,depth:1,height:1} },
    ] as any[]
    for (const ordered of [assets, [...assets].reverse()]) {
      const fixtures = [structuredClone(fixture)]
      expect(refreshFixtureModelAssets(fixtures, ordered)).toBe(true)
      expect(fixtures[0].model_asset).toMatchObject({ id:'asset-a', orientation_view:'left' })
    }
  })
  it('uses only deterministic quarter-turns without compound rotation', () => {
    expect(modelOrientation('front').toArray().slice(0, 3)).toEqual([0, 0, 0])
    expect(modelOrientation('top').toArray().slice(0, 3)).toEqual([Math.PI / 2, 0, 0])
    expect(modelOrientation('bottom').toArray().slice(0, 3)).toEqual([-Math.PI / 2, 0, 0])
    expect(modelOrientation('left').toArray().slice(0, 3)).toEqual([0, Math.PI / 2, 0])
    expect(modelOrientation('right').toArray().slice(0, 3)).toEqual([0, -Math.PI / 2, 0])
    expect(modelOrientation('back').toArray().slice(0, 3)).toEqual([0, Math.PI, 0])
  })

  it('scales the selection cube for both metre and millimetre model units', () => {
    expect(orientationCubePlacement([0.6, 0.8, 0.5]).side).toBeCloseTo(0.896)
    expect(orientationCubePlacement([600, 800, 500])).toEqual({ side: 896.0000000000001, centerY: 400 })
  })

  it('relabels every stationary physical face when the chosen face becomes front', () => {
    expect(orientationFaceLabels('left')).toEqual({
      front: 'right', back: 'left', top: 'top', bottom: 'bottom', left: 'front', right: 'back',
    })
    expect(orientationFaceLabels('top')).toEqual({
      front: 'bottom', back: 'top', top: 'front', bottom: 'back', left: 'left', right: 'right',
    })
  })
})

describe('three-face orientation correction', () => {
  it('rejects fewer than three face pairs', () => {
    expect(resolveOrientationMapping({ front: 'right', top: 'top' })).toBeNull()
  })

  it('completes a valid three-face mapping to all six faces', () => {
    expect(completeOrientationMapping({ front: 'right', left: 'front', top: 'top' })).toEqual({
      front: 'right', back: 'left', top: 'top', bottom: 'bottom', left: 'front', right: 'back',
    })
  })

  it('rejects contradictory face pairs', () => {
    expect(completeOrientationMapping({ front: 'front', back: 'right', top: 'top' })).toBeNull()
  })

  it('completes a deterministic rotation for a two-sided asset tag', () => {
    expect(completeOrientationMapping({ back: 'front' }, 1)?.back).toBe('front')
    expect(completeOrientationMapping({ bottom: 'top' }, 1)?.bottom).toBe('top')
  })
})
