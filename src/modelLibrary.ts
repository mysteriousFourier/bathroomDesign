import manifest from './generated-model-library.json'
import type { DesignChatResponse, ModelAssetFormat, ModelAssetLifecycle } from './types'
import type { RoomModelAsset } from './modelAssets'

export type BuiltInModelRecord = {
  id: string
  label: string
  category: string
  asset_type: 'fixture' | 'surface'
  format: ModelAssetFormat
  src: string
  texture_src?: string
  thumbnail?: string
  filename: string
  bytes: number
  sha256: string
  file_count: number
  dimensions_mm: { width: number; depth: number; height: number }
  dimension_status: 'verified' | 'review'
  price_tier: 'basic' | 'comfort' | 'premium'
  catalog_codes: string[]
  styles: string[]
  unit_price?: number
  price_unit?: string
  source: string
}

// The verified shared toilet asset is stored by FastAPI because it was imported
// after the static builtin manifest was generated. Keep its exact SKU binding
// available to local fallback layouts as well.
const sharedModelRecords: BuiltInModelRecord[] = [{
  id: 'ce23ef42c17da53def16083f77c3c0dd',
  label: '智能坐便器',
  category: '马桶',
  asset_type: 'fixture',
  format: 'fbx',
  src: '/api/model-assets/ce23ef42c17da53def16083f77c3c0dd/files/%E6%99%BA%E8%83%BD%E5%9D%90%E4%BE%BF%E5%99%A8.fbx',
  filename: '智能坐便器.fbx',
  bytes: 135808,
  sha256: 'ce23ef42c17da53def16083f77c3c0ddbb35c41a7fb68dbb49c3702e530c9b99',
  file_count: 1,
  dimensions_mm: { width: 380, depth: 680, height: 760 },
  dimension_status: 'verified',
  price_tier: 'premium',
  catalog_codes: ['MT3'],
  styles: ['通用'],
  source: '共享模型资产库',
}]
const records = [...(manifest.assets as BuiltInModelRecord[]), ...sharedModelRecords]

export const builtInModelRecords = records

export const builtInRoomAssets: RoomModelAsset[] = records.map((asset) => ({
  id: asset.id,
  label: asset.label,
  src: asset.src,
  format: asset.format,
  unit: 'm',
  fit: 'contain',
  version: 'builtin-1.0.0',
  sha256: asset.sha256,
  bytes: asset.bytes,
  thumbnail: asset.thumbnail,
  source: asset.asset_type === 'surface' ? '内置表面材质库' : '内置模型库',
  source_asset_id: asset.id,
  lifecycle: 'approved' as ModelAssetLifecycle,
  dimensions_mm: asset.dimensions_mm,
  category: asset.category,
  asset_type: asset.asset_type,
  price_tier: asset.price_tier,
  catalog_codes: asset.catalog_codes,
  styles: asset.styles,
}))

export function modelAssetForProduct(category: string, code?: string, tier?: BuiltInModelRecord['price_tier']) {
  const categories = category === '适老浴室柜' ? ['适老浴室柜', '浴室柜'] : [category]
  const candidates = records.filter((asset) => asset.asset_type === 'fixture' && categories.includes(asset.category))
  if (!candidates.length) return undefined
  if (category === '洗衣机' && code === 'XYJ2-1') return undefined
  return candidates.find((asset) => code && asset.catalog_codes.includes(code))
    ?? candidates.find((asset) => tier && asset.price_tier === tier)
    ?? candidates[0]
}

export function exactModelAssetForProduct(category: string, code: string) {
  const categories = category === '适老浴室柜' ? ['适老浴室柜', '浴室柜'] : [category]
  return records.find((asset) => asset.asset_type === 'fixture' && categories.includes(asset.category) && asset.catalog_codes.includes(code))
}

export function surfaceAssetForProduct(code: string) {
  return records.find((asset) => asset.asset_type === 'surface' && asset.catalog_codes.includes(code))
}

export type AppliedSurfaceMaterials = { wall?: BuiltInModelRecord; floor?: BuiltInModelRecord }

/** Resolve the exact wall/floor products selected by the demand assistant. */
export function surfaceMaterialsForDesignQuote(quote: DesignChatResponse | null): AppliedSurfaceMaterials {
  if (!quote?.requirements.complete) return {}
  const material = (category: '墙板' | '地砖') => {
    const line = quote.material_quotes.find((item) => item.材料名称 === category)
    return line ? surfaceAssetForProduct(line.材料编号) : undefined
  }
  return { wall: material('墙板'), floor: material('地砖') }
}

export function builtInAssetAsRoomAsset(record: BuiltInModelRecord): RoomModelAsset {
  return builtInRoomAssets.find((asset) => asset.id === record.id) as RoomModelAsset
}
