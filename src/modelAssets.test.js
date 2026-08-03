import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(
  readFileSync(new URL('../public/assets/models/manifest.json', import.meta.url), 'utf8'),
)

function sha256(fileUrl) {
  return createHash('sha256').update(readFileSync(fileUrl)).digest('hex')
}

function publicAssetUrl(src) {
  return new URL(`../public${src}`, import.meta.url)
}

describe('model asset legacy import fixtures', () => {
  it('converts the supplied toilet FBX and 3DS models into deduped runtime GLB assets', () => {
    const legacySources = new Map(manifest.legacy_import_sources.map((source) => [source.id, source]))
    const runtimeAssets = new Map(manifest.assets.map((asset) => [asset.id, asset]))

    const expectedSources = [
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
    ]

    const convertedHashes = new Set()
    for (const expected of expectedSources) {
      const source = legacySources.get(expected.id)
      const fileUrl = publicAssetUrl(expected.src)
      const runtime = runtimeAssets.get(expected.converted_asset_id)
      const runtimeUrl = publicAssetUrl(runtime.src)
      const runtimeHeader = readFileSync(runtimeUrl).subarray(0, 4).toString('utf8')

      expect(source).toEqual(expected)
      expect(statSync(fileUrl).size).toBe(expected.bytes)
      expect(sha256(fileUrl)).toBe(expected.sha256)
      expect(runtime).toMatchObject({
        id: expected.converted_asset_id,
        format: 'glb',
        lifecycle: 'approved',
        canonical: true,
        source_asset_id: expected.source_asset_id,
        dimensions_mm: { width: 380, depth: 700, height: 760 },
      })
      expect(runtime.legacy_source_ids).toContain(expected.id)
      expect(statSync(runtimeUrl).size).toBe(runtime.bytes)
      expect(sha256(runtimeUrl)).toBe(runtime.sha256)
      expect(runtimeHeader).toBe('glTF')
      convertedHashes.add(runtime.sha256)
    }
    expect(convertedHashes.size).toBe(expectedSources.length)
  })
})
