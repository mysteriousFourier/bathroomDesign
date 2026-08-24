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
}

export function modelAssetPointKind(asset: Pick<RoomModelAsset, 'correction_tag'>) {
  if (asset.correction_tag === 'drain') return 'floor_drain' as const
  if (asset.correction_tag === 'socket' || asset.correction_tag === 'switch') return 'electric' as const
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
  fixtures.forEach((fixture) => {
    if (fixture.model_asset?.id !== asset.id && fixture.model_asset?.source_asset_id !== asset.id && fixture.model_asset?.source_asset_id !== asset.source_asset_id) return
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
