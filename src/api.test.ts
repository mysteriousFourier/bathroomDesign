import { describe, expect, it } from 'vitest'
import { formatApiErrorDetail } from './api'

describe('formatApiErrorDetail', () => {
  it('renders structured validation errors instead of object coercion', () => {
    expect(formatApiErrorDetail([
      { loc: ['body', 'fixtures', 0, 'x_mm'], msg: 'Input should be a valid number' },
      { loc: ['body', 'dry_wet_zones', 0, 'boundary'], msg: 'Field required' },
    ], '请求失败 (422)')).toBe(
      'fixtures.0.x_mm：Input should be a valid number；dry_wet_zones.0.boundary：Field required',
    )
  })

  it('keeps string details and falls back for unknown objects', () => {
    expect(formatApiErrorDetail('项目不存在', '请求失败 (404)')).toBe('项目不存在')
    expect(formatApiErrorDetail({}, '请求失败 (500)')).toBe('请求失败 (500)')
  })
})
