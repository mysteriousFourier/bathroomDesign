# Project Model Asset Library Contract

## Runtime Format

The runtime model library contains only models uploaded to the current project. The repository does not bundle demo models or a static model registry.

- GLB is preferred because geometry, materials, and binary buffers are packaged in one file.
- GLTF plus BIN and textures is accepted as a multi-file upload.
- FBX, 3DS, and OBJ are accepted project uploads and are previewed by the corresponding browser loader.

## Storage and Metadata

Uploaded files and `asset.json` metadata are stored below the configured backend data directory and are excluded from Git. The project model-asset API returns:

- `id` and `project_id`: stable ownership identifiers.
- `src`: authenticated project-relative model file URL.
- `format`, `filename`, `bytes`, and `file_count`: upload details.
- `sha256`: hash of the primary model file.
- `created_at`: upload timestamp.

## Fixture Binding

Business fixtures store a compact `model_asset` snapshot with the project asset ID, URL, format, hash, source, unit, and fit strategy. Fixtures without a model asset continue to use procedural fallback geometry.

## Retention

Deleting a project model removes its files from runtime storage when no fixture is using it. No uploaded model, generated preview, or demo model should be committed to the repository.
