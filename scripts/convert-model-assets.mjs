import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Box3, MeshStandardMaterial, Vector3 } from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

globalThis.window ??= { innerWidth: 1280, innerHeight: 720 }
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer()
      .then((buffer) => { this.result = buffer; this.onloadend?.({ target: this }) })
      .catch((error) => this.onerror?.(error))
  }

  readAsDataURL(blob) {
    blob.arrayBuffer()
      .then((buffer) => {
        this.result = `data:application/octet-stream;base64,${Buffer.from(buffer).toString('base64')}`
        this.onloadend?.({ target: this })
      })
      .catch((error) => this.onerror?.(error))
  }
}

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const manifestPath = join(repoRoot, 'public/assets/models/manifest.json')

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sourcePath(src) {
  if (!src.startsWith('/assets/models/')) throw new Error(`Unsupported model src: ${src}`)
  return join(repoRoot, 'public', src)
}

function parseLegacyModel(source, path) {
  const bytes = readFileSync(path)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const loader = source.format === 'fbx' ? new FBXLoader() : source.format === '3ds' ? new TDSLoader() : null
  if (!loader) throw new Error(`Unsupported legacy format: ${source.format}`)
  const originalWarn = console.warn
  console.warn = (...args) => {
    if (String(args[0] ?? '').includes('Orthographic cameras not supported yet')) return
    originalWarn(...args)
  }
  const group = loader.parse(buffer, dirname(path))
  console.warn = originalWarn
  group.name = source.id
  const removable = []
  group.traverse((child) => {
    if (child.isLight || child.isCamera) removable.push(child)
    if (!child.isMesh) return
    child.castShadow = true
    child.receiveShadow = true
    child.material = new MeshStandardMaterial({ color: 0xf2f1ec, roughness: 0.58 })
  })
  removable.forEach((child) => child.parent?.remove(child))
  return group
}

function dimensionsMm(group) {
  const box = new Box3().setFromObject(group)
  const size = new Vector3()
  box.getSize(size)
  return {
    width: Math.max(1, Math.round(size.x * 1000)),
    depth: Math.max(1, Math.round(size.z * 1000)),
    height: Math.max(1, Math.round(size.y * 1000)),
  }
}

function runtimeDimensions(source, group) {
  if (/坐便器|马桶|toilet/i.test(`${source.label} ${source.original_filename ?? ''}`)) {
    return { width: 380, depth: 700, height: 760 }
  }
  return dimensionsMm(group)
}

async function exportGlb(group, path) {
  const result = await new GLTFExporter().parseAsync(group, { binary: true, onlyVisible: true })
  if (!(result instanceof ArrayBuffer)) throw new Error('GLTFExporter did not return binary GLB data')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.from(result))
}

function thumbnailSvg(label, source, dimensions) {
  const escapedLabel = label.replace(/[&<>"]/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[value]))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220" viewBox="0 0 320 220" role="img" aria-label="${escapedLabel} converted GLB thumbnail">
  <rect width="320" height="220" fill="#faf9f6"/>
  <rect x="24" y="24" width="272" height="172" fill="#ecece7" stroke="#bfc3ba"/>
  <path d="M86 142h150l-24 32H110z" fill="#dce9e2" stroke="#2d6650" stroke-width="4"/>
  <ellipse cx="160" cy="114" rx="68" ry="42" fill="#f2f1ec" stroke="#4d534c" stroke-width="4"/>
  <rect x="118" y="57" width="84" height="56" rx="8" fill="#f2f1ec" stroke="#4d534c" stroke-width="4"/>
  <text x="160" y="34" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" fill="#20231f">GLB</text>
  <text x="160" y="202" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#696e67">${escapedLabel} · ${source.format.toUpperCase()} · ${dimensions.width}x${dimensions.depth}x${dimensions.height}mm</text>
</svg>
`
}

function convertedId(source) {
  return `${source.id}-glb`
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const convertedByHash = new Map(manifest.assets.map((asset) => [asset.sha256, asset]))

for (const source of manifest.legacy_import_sources ?? []) {
  const inputPath = sourcePath(source.src)
  const id = convertedId(source)
  const outputSrc = `/assets/models/${id}/model.glb`
  const thumbnailSrc = `/assets/models/${id}/thumbnail.svg`
  const outputPath = sourcePath(outputSrc)
  const thumbnailPath = sourcePath(thumbnailSrc)
  const group = parseLegacyModel(source, inputPath)
  const dimensions = runtimeDimensions(source, group)

  await exportGlb(group, outputPath)
  writeFileSync(thumbnailPath, thumbnailSvg(source.label.replace(/\s+(FBX|3DS)$/i, ''), source, dimensions))

  const outputSha = sha256(outputPath)
  const duplicate = convertedByHash.get(outputSha)
  const existing = manifest.assets.find((asset) => asset.id === id)
  const asset = duplicate && duplicate.id !== id ? duplicate : {
    id,
    label: `${source.label.replace(/\s+(FBX|3DS)$/i, '')} GLB`,
    src: outputSrc,
    format: 'glb',
    type: 'glb',
    unit: 'm',
    fit: 'contain',
    version: '1.0.0',
    lifecycle: 'approved',
    canonical: true,
    sha256: outputSha,
    bytes: statSync(outputPath).size,
    thumbnail: thumbnailSrc,
    source: `Converted offline from ${source.original_filename ?? source.src}`,
    source_asset_id: source.source_asset_id,
    tags: ['fixture', 'toilet', 'converted', source.format],
    dimensions_mm: dimensions,
    legacy_source_ids: [source.id],
  }

  if (duplicate && duplicate.id !== id) {
    duplicate.legacy_source_ids = [...new Set([...(duplicate.legacy_source_ids ?? []), source.id])]
    source.converted_asset_id = duplicate.id
    source.lifecycle = 'converted_duplicate'
    continue
  }

  if (existing) Object.assign(existing, asset)
  else manifest.assets.push(asset)
  convertedByHash.set(outputSha, existing ?? asset)
  source.converted_asset_id = id
  source.lifecycle = 'converted'
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
