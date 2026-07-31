# Model Asset Library Contract

## Runtime Format

The runtime model library uses GLB/GLTF as the canonical asset formats.

- GLB is preferred for distribution because geometry, materials, and binary buffers are packaged in one file.
- GLTF plus BIN is accepted when source tooling already emits sidecar buffers.
- FBX and 3DS are import sources only. They must be converted to GLB before being exposed as business `model_asset` entries.

## Manifest Fields

`public/assets/models/manifest.json` is the static registry for the current prototype. Each approved runtime asset must include:

- `id`: stable asset identifier used by fixtures.
- `src`: browser-loadable GLB/GLTF URL.
- `format`: `glb` or `gltf`.
- `version`: semantic asset version. Increment when geometry, scale, material, or origin changes.
- `sha256`: hash for the primary runtime file.
- `sidecar_sha256`: hashes for GLTF sidecar buffers or textures.
- `bytes`: total runtime payload bytes for the asset entry.
- `thumbnail`: browser-loadable preview image path.
- `source_asset_id`: OPC attachment or upstream source identifier.
- `dimensions_mm`: business placement box used for contain-fit normalization.
- `lifecycle`: `approved`, `needs_conversion`, or `deprecated`.

## Fixture Binding

Business fixtures store a compact `model_asset` snapshot with the approved asset ID, URL, format, version, hash, thumbnail, source, unit, and fit strategy. Runtime rendering resolves only GLB/GLTF assets. Fixtures without an approved model asset continue to use procedural fallback geometry.

## Import Queue

Legacy source formats remain in `legacy_import_sources` with hash and target format metadata. They are not selectable runtime assets until an offline conversion step produces a GLB, thumbnail, dimensions, and hash entry.
