import { describe, expect, it } from 'vitest'
import { surfaceMaterialsForDesignQuote } from './modelLibrary'
import type { DesignChatResponse } from './types'

function quote(complete = true): DesignChatResponse {
  return {
    message: '', requirements: { collected: {}, missing_fields: [], complete },
    style_match: { user_terms: ['清爽'], catalog_style: '素雅', confidence: 1, status: 'mapped', candidates: [], resolver_version: 'test' },
    surfaces: {} as DesignChatResponse['surfaces'],
    material_quotes: [
      { product_id: 'wall', 材料编号: 'QB2-SY', 材料名称: '墙板', 单价: 1, 单位: '㎡', 来源: 'test' },
      { product_id: 'floor', 材料编号: 'DB3-SY', 材料名称: '地砖', 单价: 1, 单位: '㎡', 来源: 'test' },
    ],
    furniture_candidates: [], furniture_quotes: [], selected_furniture: [], material_total: 0,
    furniture_price_range: { min: 0, max: 0 }, total_price_range: { min: 0, max: 0 },
    furniture_total: null, quote_total: null, pricing_status: 'range_until_auto_layout_selection', equipment: {}, products: [],
  }
}

describe('demand assistant surface application', () => {
  it('maps quoted wall and floor product codes to renderable surface assets', () => {
    const result = surfaceMaterialsForDesignQuote(quote())
    expect(result.wall).toMatchObject({ asset_type: 'surface', catalog_codes: ['QB2-SY'], texture_src: '/model-library/surfaces/QB2-SY/texture.jpg' })
    expect(result.floor).toMatchObject({ asset_type: 'surface', catalog_codes: ['DB3-SY'], texture_src: '/model-library/surfaces/DB3-SY/texture.jpg' })
  })

  it('does not apply a partial requirement draft', () => {
    expect(surfaceMaterialsForDesignQuote(quote(false))).toEqual({})
  })
})
