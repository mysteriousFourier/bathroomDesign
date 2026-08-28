import type { FixtureModelAsset, FixtureSpec, ImportedModelAsset, ModelAssetFormat } from './types'

export interface RoomModelAsset extends FixtureModelAsset {
  format: ModelAssetFormat
  /** Original source filename, retained when the display label is a product specification. */
  filename?: string
  dimensions_mm: { width: number; depth: number; height: number }
  category?: string
  asset_type?: 'fixture' | 'surface'
  price_tier?: 'basic' | 'comfort' | 'premium'
  catalog_codes?: string[]
  styles?: string[]
  tags?: string[]
  correction_tag?: 'standard' | 'handrail' | 'drain' | 'socket' | 'switch'
  product_attributes?: Record<string, string> | null
  source_format?: string | null
}

export type ModelAssetPointKind = Extract<FixtureSpec['kind'], 'floor_drain' | 'drain' | 'water' | 'electric'>

export function modelAssetPointKind(asset: Pick<RoomModelAsset, 'correction_tag' | 'category' | 'product_attributes'>): ModelAssetPointKind | null {
  const explicit = asset.product_attributes?.['点位类型']
  if (explicit === 'floor_drain' || explicit === 'drain' || explicit === 'water' || explicit === 'electric') return explicit
  if (asset.correction_tag === 'drain' || asset.category === '地漏') return 'floor_drain'
  if (asset.category === '排水点') return 'drain'
  if (asset.category === '给水点') return 'water'
  if (asset.correction_tag === 'socket' || asset.correction_tag === 'switch' || asset.category === '电位' || asset.category === '电气面板') return 'electric'
  return null
}

export function fixtureModelAssetFromLibrary(asset: RoomModelAsset): FixtureModelAsset {
  return {
    id: asset.id,
    label: asset.label,
    src: asset.src,
    format: asset.format,
    unit: asset.unit,
    fit: asset.fit,
    version: asset.version,
    sha256: asset.sha256,
    bytes: asset.bytes,
    thumbnail: asset.thumbnail,
    source: asset.source,
    source_asset_id: asset.source_asset_id,
    lifecycle: asset.lifecycle,
    legacy_source_ids: asset.legacy_source_ids,
    orientation_view: asset.orientation_view,
    orientation_mapping: asset.orientation_mapping,
  }
}

/** Refresh model metadata snapshots already embedded in room fixtures. */
export function refreshFixtureModelAsset(fixtures: FixtureSpec[], asset: RoomModelAsset) {
  let changed = false
  const assetIds = new Set([asset.id, asset.source_asset_id, ...(asset.legacy_source_ids ?? [])].filter((id): id is string => !!id))
  fixtures.forEach((fixture) => {
    const snapshot = fixture.model_asset
    if (!snapshot) return
    const fixtureIds = [snapshot.id, snapshot.source_asset_id, ...(snapshot.legacy_source_ids ?? [])].filter((id): id is string => !!id)
    if (!fixtureIds.some((id) => assetIds.has(id))) return
    fixture.model_asset = fixtureModelAssetFromLibrary(asset)
    changed = true
  })
  return changed
}

export function refreshFixtureModelAssets(fixtures: FixtureSpec[], assets: ImportedModelAsset[]) {
  let changed = false
  assets.forEach((asset) => {
    if (!asset.orientation_mapping && !asset.orientation_view) return
    changed = refreshFixtureModelAsset(fixtures, {
      id: asset.id, label: asset.label, src: asset.src, format: asset.format, unit: 'm', fit: 'contain',
      sha256: asset.sha256, bytes: asset.bytes, source_asset_id: asset.id,
      dimensions_mm: asset.dimensions_mm ?? { width: 600, depth: 600, height: 600 },
      orientation_view: asset.orientation_view, orientation_mapping: asset.orientation_mapping,
    }) || changed
  })
  return changed
}
