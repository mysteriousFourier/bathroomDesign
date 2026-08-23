import type { FixtureModelAsset, ModelAssetFormat } from './types'

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
