# Shared Model Asset Library Contract

## Runtime Format

The runtime model library is shared by every project in the same studio data directory. A model is uploaded once and can then be reused by later projects without another import. The repository also carries the generated built-in catalog manifest used for exact product binding.

- GLB is preferred because geometry, materials, and binary buffers are packaged in one file.
- GLTF plus BIN and textures is accepted as a multi-file upload.
- FBX, 3DS, and OBJ are accepted project uploads and are previewed by the corresponding browser loader.

## Storage and Metadata

Uploaded files and `asset.json` metadata are stored below the configured backend data directory and are excluded from Git. The project model-asset API returns:

- `id` and `project_id`: stable asset and original uploader audit identifiers; `project_id` does not limit reuse.
- `src`: stable shared-library model file URL.
- `format`, `filename`, `bytes`, and `file_count`: upload details.
- `sha256`: hash of the primary model file and the deduplication key. Uploading the same primary model again returns the existing shared or built-in asset.
- `library_scope` and `deduplicated`: identify shared/built-in origin and duplicate resolution.
- `category` and `dimensions_mm`: inferred fixture category and conservative installation envelope.
- `catalog_codes`, `product_ids`, and `binding_status`: explicit knowledge-graph product bindings. Category alone never authorizes automatic quote/layout substitution.
- `created_at`: upload timestamp.

## Fixture Binding

Business fixtures store a compact `model_asset` snapshot with the shared asset ID, URL, format, hash, source, unit, and fit strategy. The layout system may use a shared model only when its explicit `catalog_codes` contains the quoted product code. Category-only and unbound assets remain available for manual placement but never substitute for a quoted product. Fixtures without an exact model asset continue to use procedural fallback geometry.

## Retention

Deleting a shared model removes its files only when no fixture in any project is using it. No uploaded model or generated preview should be committed to the repository.
