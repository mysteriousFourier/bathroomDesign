import manifest from './generated-model-library.json'
import type { DesignChatResponse, ModelAssetFormat, ModelAssetLifecycle } from './types'
import type { RoomModelAsset } from './modelAssets'
import type { ModelOrientationView, OrientationMapping } from './modelOrientation'

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
  orientation_view?: ModelOrientationView
  orientation_mapping?: OrientationMapping
  correction_tag?: RoomModelAsset['correction_tag']
  unit_price?: number
  price_unit?: string
  source: string
}

// The verified shared toilet asset is stored by FastAPI because it was imported
// after the static builtin manifest was generated. Keep its exact SKU binding
// available to local fallback layouts as well.
const sharedModelRecords: BuiltInModelRecord[] = [{
  id: 'ce23ef42c17da53def16083f77c3c0dd',
  label: 'MT3 智能马桶（加热、感应冲水、臀洗、杀菌）',
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
  // The verified FBX's source top face is the semantic front. Keep this
  // correction on the shared record so fallback layouts and API-backed layouts
  // render the same toilet orientation.
  orientation_view: 'top',
  orientation_mapping: { front: 'top', back: 'bottom', top: 'front', bottom: 'back', left: 'right', right: 'left' },
  source: '共享模型资产库',
}]
// Keep explicitly verified shared assets ahead of generated category matches;
// this preserves SKU snapshots (for example MT3) when a source directory also
// contains a similarly named raw export.
const pointModelOverrides: Record<string, Partial<BuiltInModelRecord>> = {
  '地漏01': { category: '地漏', catalog_codes: ['DL-01'], dimensions_mm: { width: 100, depth: 100, height: 44.3 }, correction_tag: 'drain' },
  '地漏02': { category: '地漏', catalog_codes: ['DL-02'], dimensions_mm: { width: 100, depth: 100, height: 44.3 }, correction_tag: 'drain' },
  '三孔16A插座': { category: '电位', catalog_codes: ['EP-16A'], dimensions_mm: { width: 86, depth: 15, height: 86 }, correction_tag: 'socket' },
  '双开面板': { category: '电位', catalog_codes: ['EP-2K'], dimensions_mm: { width: 86, depth: 15, height: 86 }, correction_tag: 'switch' },
  '夜灯面板': { category: '电位', catalog_codes: ['EP-NL'], dimensions_mm: { width: 86, depth: 15, height: 86 }, correction_tag: 'switch' },
  '正五孔插座': { category: '电位', catalog_codes: ['EP-5H'], dimensions_mm: { width: 86, depth: 15, height: 86 }, correction_tag: 'socket' },
  '浴霸面板': { category: '电位', catalog_codes: ['EP-YB'], dimensions_mm: { width: 86, depth: 15, height: 86 }, correction_tag: 'switch' },
  '防溅盒': { category: '电位', catalog_codes: ['EP-FJ'], dimensions_mm: { width: 100, depth: 50, height: 100 }, correction_tag: 'socket' },
}
const normalizedManifestRecords = (manifest.assets as BuiltInModelRecord[]).map((asset) => ({ ...asset, ...pointModelOverrides[asset.label] }))
const records = [...sharedModelRecords, ...normalizedManifestRecords]

export const builtInModelRecords = records

function roomAssetFromRecord(asset: BuiltInModelRecord): RoomModelAsset {
  return {
    id: asset.id,
    label: asset.label,
    filename: asset.filename,
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
    orientation_view: asset.orientation_view,
    orientation_mapping: asset.orientation_mapping,
    correction_tag: asset.correction_tag,
  }
}

// The API already returns verified shared assets, so omit them from the
// static fallback list to avoid a duplicate row when both sources load.
export const builtInRoomAssets: RoomModelAsset[] = records.filter((asset) => asset.id !== 'ce23ef42c17da53def16083f77c3c0dd').map(roomAssetFromRecord)

export function modelAssetForProduct(category: string, code?: string, tier?: BuiltInModelRecord['price_tier']) {
  const categories = category === '适老浴室柜' ? ['适老浴室柜', '浴室柜'] : [category]
  const candidates = records.filter((asset) => asset.asset_type === 'fixture' && categories.includes(asset.category))
  if (!candidates.length) return undefined
  if (category === '洗衣机' && code === 'XYJ2-1') return undefined
  // The RSQ1-2 export is an upright 331x628x778 scene, not the catalogued
  // horizontal 60 L appliance. RSQ2-2 is the reviewed horizontal rose-gold
  // exterior shared by this finish, so use it until the bad source is replaced.
  if (category === '热水器' && code === 'RSQ1-2') {
    return candidates.find((asset) => asset.catalog_codes.includes('RSQ2-2'))
  }
  return candidates.find((asset) => code && asset.catalog_codes.includes(code))
    ?? candidates.find((asset) => tier && asset.price_tier === tier)
    ?? candidates[0]
}

export function exactModelAssetForProduct(category: string, code: string) {
  const categories = category === '适老浴室柜' ? ['适老浴室柜', '浴室柜'] : [category]
  if (category === '热水器' && code === 'RSQ1-2') {
    return records.find((asset) => asset.asset_type === 'fixture' && asset.category === category && asset.catalog_codes.includes('RSQ2-2'))
  }
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
  return roomAssetFromRecord(record)
}
