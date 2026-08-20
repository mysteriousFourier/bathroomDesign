import { describe, expect, it } from 'vitest'
import { modelOrientation, orientationCubePlacement, orientationFaceLabels } from './modelOrientation'

describe('model orientation correction', () => {
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
