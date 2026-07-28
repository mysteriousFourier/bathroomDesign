import { describe, expect, it } from 'vitest'
import { clientValidate, manualRoom } from './spec'

describe('room boundary validation', () => {
  it('accepts a closed orthogonal room', () => {
    expect(clientValidate(manualRoom(2400, 1800, 2600)).filter((issue) => issue.severity === 'error')).toEqual([])
  })

  it('rejects diagonal edges before modeling', () => {
    const spec = manualRoom(2400, 1800, 2600)
    spec.boundary[1].z_mm = 100

    expect(clientValidate(spec).map((issue) => issue.code)).toContain('non_orthogonal_boundary')
  })

  it('rejects repeated points and self-intersection', () => {
    const repeated = manualRoom(2400, 1800, 2600)
    repeated.boundary.splice(2, 0, { ...repeated.boundary[1] })
    const crossed = manualRoom(2400, 1800, 2600)
    crossed.boundary = [
      { x_mm: 0, z_mm: 0 }, { x_mm: 2400, z_mm: 0 },
      { x_mm: 2400, z_mm: 1800 }, { x_mm: 0, z_mm: 1800 },
      { x_mm: 0, z_mm: 900 }, { x_mm: 1200, z_mm: 900 },
      { x_mm: 1200, z_mm: 1800 }, { x_mm: 0, z_mm: 1800 },
    ]

    expect(clientValidate(repeated).map((issue) => issue.code)).toContain('zero_length_boundary')
    expect(clientValidate(crossed).map((issue) => issue.code)).toContain('self_intersection')
  })
})
