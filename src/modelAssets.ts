import type { FixtureModelAsset, ModelAssetFormat, ModelAssetLifecycle } from './types'

export interface ModelAssetRegistryEntry extends FixtureModelAsset {
  format: ModelAssetFormat
  version: string
  sha256: string
  bytes: number
  thumbnail: string
  source: string
  source_asset_id: string
  lifecycle: ModelAssetLifecycle
  canonical: boolean
  tags: string[]
  dimensions_mm: { width: number; depth: number; height: number }
  legacy_source_ids?: string[]
}

export const modelAssetRegistry: Record<string, ModelAssetRegistryEntry> = {
  'accessible-shower-seat-001': {
    id: 'accessible-shower-seat-001',
    label: '无障碍淋浴室坐凳 GLTF',
    src: '/assets/models/accessible-shower-seat-001/model.gltf',
    format: 'gltf',
    unit: 'm',
    fit: 'contain',
    version: '1.0.0',
    sha256: 'b91e4089805783b773745146f1d76ffe0fc147f8238366e4699dde5cb5da8e91',
    bytes: 107293,
    thumbnail: '/assets/models/accessible-shower-seat-001/thumbnail.svg',
    source: 'AGEN-30 attachment, normalized as GLTF+BIN',
    source_asset_id: '019fb73e-e1a2-765d-a80b-df9cd7c7536d',
    lifecycle: 'approved',
    canonical: true,
    tags: ['fixture', 'shower', 'seat', 'accessibility'],
    dimensions_mm: { width: 580, depth: 520, height: 450 },
  },
  'washer-glb-test': {
    id: 'washer-glb-test',
    label: '洗衣机 GLB',
    src: '/assets/models/washer-glb-test/model.glb',
    format: 'glb',
    unit: 'm',
    fit: 'contain',
    version: '1.0.0',
    sha256: 'a964c235c8b24f3ecfc3bcb45bda7590aabb5902edaefc0c94747312a6b4e501',
    bytes: 7884792,
    thumbnail: '/assets/models/washer-glb-test/thumbnail.svg',
    source: 'AGEN-30 split attachment, accepted as canonical GLB',
    source_asset_id: '019fb75d-504c-7ab2-9947-458f38264b6f',
    lifecycle: 'approved',
    canonical: true,
    tags: ['fixture', 'appliance', 'washer'],
    dimensions_mm: { width: 600, depth: 620, height: 850 },
  },
  'toilet-fbx-test-glb': {
    id: 'toilet-fbx-test-glb',
    label: '智能坐便器 GLB',
    src: '/assets/models/toilet-fbx-test-glb/model.glb',
    format: 'glb',
    unit: 'm',
    fit: 'contain',
    version: '1.0.0',
    sha256: '483299ec09d6a30c31ecfae050e237d41597fd5184415b750b8a10b03491a7a0',
    bytes: 90848,
    thumbnail: '/assets/models/toilet-fbx-test-glb/thumbnail.svg',
    source: 'Converted offline from 智能坐便器.fbx',
    source_asset_id: '019fc51e-f903-73bb-bc5e-513f3465a88c',
    lifecycle: 'approved',
    canonical: true,
    tags: ['fixture', 'toilet', 'converted', 'fbx'],
    dimensions_mm: { width: 380, depth: 700, height: 760 },
    legacy_source_ids: ['toilet-fbx-test'],
  },
  'toilet-3ds-test-glb': {
    id: 'toilet-3ds-test-glb',
    label: '坐便器 GLB',
    src: '/assets/models/toilet-3ds-test-glb/model.glb',
    format: 'glb',
    unit: 'm',
    fit: 'contain',
    version: '1.0.0',
    sha256: '7889167aecf076b15ec93bffd1dfea1e9887ed8561abdbe4a1c933f81209e4cb',
    bytes: 2338328,
    thumbnail: '/assets/models/toilet-3ds-test-glb/thumbnail.svg',
    source: 'Converted offline from 坐便器.3ds',
    source_asset_id: '019fc51e-f903-73bb-bc5e-513f3465a88c',
    lifecycle: 'approved',
    canonical: true,
    tags: ['fixture', 'toilet', 'converted', '3ds'],
    dimensions_mm: { width: 380, depth: 700, height: 760 },
    legacy_source_ids: ['toilet-3ds-test'],
  },
}

export const legacyImportSources = [
  {
    id: 'toilet-fbx-test',
    label: '智能坐便器 FBX',
    src: '/assets/models/toilet-fbx-test/model.fbx',
    format: 'fbx',
    sha256: 'ce23ef42c17da53def16083f77c3c0ddbb35c41a7fb68dbb49c3702e530c9b99',
    bytes: 135808,
    lifecycle: 'converted',
    target_format: 'glb',
    source_asset_id: '019fc51e-f903-73bb-bc5e-513f3465a88c',
    original_filename: '智能坐便器.fbx',
    converted_asset_id: 'toilet-fbx-test-glb',
  },
  {
    id: 'toilet-3ds-test',
    label: '坐便器 3DS',
    src: '/assets/models/toilet-3ds-test/model.3ds',
    format: '3ds',
    sha256: 'f96ba8967c9db6a0d3fad1330021753ef10cf7dc1e02557ec99c9f94b3cca1c5',
    bytes: 1694375,
    lifecycle: 'converted',
    target_format: 'glb',
    source_asset_id: '019fc51e-f903-73bb-bc5e-513f3465a88c',
    original_filename: '坐便器.3ds',
    converted_asset_id: 'toilet-3ds-test-glb',
  },
] as const

export function fixtureModelAsset(id: keyof typeof modelAssetRegistry): FixtureModelAsset {
  const asset = modelAssetRegistry[id]
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
  }
}

export const showerSeatModelAsset = fixtureModelAsset('accessible-shower-seat-001')
export const washerGlbModelAsset = fixtureModelAsset('washer-glb-test')
export const toiletFbxGlbModelAsset = fixtureModelAsset('toilet-fbx-test-glb')
export const toilet3dsGlbModelAsset = fixtureModelAsset('toilet-3ds-test-glb')
