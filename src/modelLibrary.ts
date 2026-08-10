import manifest from './generated-model-library.json'
import type { ModelAssetFormat, ModelAssetLifecycle } from './types'
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

const records = manifest.assets as BuiltInModelRecord[]

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
  return candidates.find((asset) => code && asset.catalog_codes.includes(code))
    ?? candidates.find((asset) => tier && asset.price_tier === tier)
    ?? candidates[0]
}

export function surfaceAssetForProduct(code: string) {
  return records.find((asset) => asset.asset_type === 'surface' && asset.catalog_codes.includes(code))
}

export function builtInAssetAsRoomAsset(record: BuiltInModelRecord): RoomModelAsset {
  return builtInRoomAssets.find((asset) => asset.id === record.id) as RoomModelAsset
}
