from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from fastapi import HTTPException, UploadFile

from .database import db
from .models import ModelAssetResponse


PRIMARY_EXTENSIONS = {".glb", ".gltf", ".fbx", ".3ds", ".obj"}
ALLOWED_EXTENSIONS = PRIMARY_EXTENSIONS | {
    ".bin", ".mtl", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
    ".tga", ".dds", ".ktx", ".ktx2", ".basis",
}
MAX_MODEL_FILES = 300
MAX_MODEL_BYTES = 200 * 1024 * 1024
MODEL_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_relative_path(raw_path: str) -> PurePosixPath:
    normalized = raw_path.replace("\\", "/").strip("/")
    path = PurePosixPath(normalized)
    if (
        not normalized
        or path.is_absolute()
        or len(normalized) > 500
        or any(part in {"", ".", ".."} or len(part) > 180 for part in path.parts)
        or any(":" in part or any(ord(character) < 32 for character in part) for part in path.parts)
    ):
        raise HTTPException(status_code=422, detail=f"模型文件路径不安全：{raw_path}")
    if path.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"不支持模型文件夹中的文件类型：{path.name}")
    return path


def _asset_root(project_id: str) -> Path:
    return db.asset_dir / project_id / "model-assets"


def _metadata_path(project_id: str, asset_id: str) -> Path:
    if not MODEL_ID_PATTERN.fullmatch(asset_id):
        raise HTTPException(status_code=404, detail="模型资产不存在")
    return _asset_root(project_id) / asset_id / "asset.json"


def _response_from_metadata(metadata: dict[str, object]) -> ModelAssetResponse:
    return ModelAssetResponse.model_validate(metadata)


async def store_model_asset(
    project_id: str,
    files: list[UploadFile],
    relative_paths: list[str],
) -> ModelAssetResponse:
    db.get_project(project_id)
    if not files or len(files) != len(relative_paths):
        raise HTTPException(status_code=422, detail="模型文件与相对路径数量不一致")
    if len(files) > MAX_MODEL_FILES:
        raise HTTPException(status_code=413, detail=f"单次最多导入 {MAX_MODEL_FILES} 个模型相关文件")

    safe_paths = [_safe_relative_path(path) for path in relative_paths]
    if len({path.as_posix().casefold() for path in safe_paths}) != len(safe_paths):
        raise HTTPException(status_code=422, detail="模型文件夹包含重复路径")
    primary_indexes = [index for index, path in enumerate(safe_paths) if path.suffix.lower() in PRIMARY_EXTENSIONS]
    if len(primary_indexes) != 1:
        raise HTTPException(status_code=422, detail="每次导入需要且只能包含一个 GLB、GLTF、FBX、3DS 或 OBJ 主模型")

    asset_id = uuid.uuid4().hex
    asset_root = _asset_root(project_id)
    temp_root = asset_root / f".upload-{asset_id}"
    final_root = asset_root / asset_id
    files_root = temp_root / "files"
    primary_index = primary_indexes[0]
    primary_path = safe_paths[primary_index]
    primary_hash = hashlib.sha256()
    total_bytes = 0

    try:
        files_root.mkdir(parents=True, exist_ok=False)
        for index, (upload, relative_path) in enumerate(zip(files, safe_paths, strict=True)):
            destination = files_root.joinpath(*relative_path.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("wb") as output:
                while chunk := await upload.read(1024 * 1024):
                    total_bytes += len(chunk)
                    if total_bytes > MAX_MODEL_BYTES:
                        raise HTTPException(status_code=413, detail="单次模型导入不能超过 200 MB")
                    output.write(chunk)
                    if index == primary_index:
                        primary_hash.update(chunk)
        primary_bytes = files_root.joinpath(*primary_path.parts).stat().st_size
        if primary_bytes == 0:
            raise HTTPException(status_code=422, detail="主模型文件为空")

        encoded_path = quote(primary_path.as_posix(), safe="/")
        label = primary_path.stem[:120]
        metadata = ModelAssetResponse(
            id=asset_id,
            project_id=project_id,
            label=label,
            filename=primary_path.name,
            format=primary_path.suffix.lower().lstrip("."),
            bytes=primary_bytes,
            sha256=primary_hash.hexdigest(),
            file_count=len(files),
            created_at=_now_iso(),
            src=f"/api/projects/{project_id}/model-assets/{asset_id}/files/{encoded_path}",
        )
        (temp_root / "asset.json").write_text(metadata.model_dump_json(indent=2), encoding="utf-8")
        final_root.parent.mkdir(parents=True, exist_ok=True)
        temp_root.replace(final_root)
        return metadata
    except Exception:
        shutil.rmtree(temp_root, ignore_errors=True)
        raise
    finally:
        for upload in files:
            await upload.close()


def list_model_assets(project_id: str) -> list[ModelAssetResponse]:
    db.get_project(project_id)
    root = _asset_root(project_id)
    if not root.is_dir():
        return []
    assets: list[ModelAssetResponse] = []
    for metadata_path in root.glob("*/asset.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            assets.append(_response_from_metadata(metadata))
        except (OSError, ValueError, TypeError):
            continue
    return sorted(assets, key=lambda asset: asset.created_at, reverse=True)


def delete_model_asset(project_id: str, asset_id: str) -> None:
    db.get_project(project_id)
    metadata_path = _metadata_path(project_id, asset_id)
    if not metadata_path.is_file():
        raise HTTPException(status_code=404, detail="模型资产不存在")
    shutil.rmtree(metadata_path.parent)


def set_model_orientation(project_id: str, asset_id: str, view: str, source: str) -> ModelAssetResponse:
    db.get_project(project_id)
    metadata_path = _metadata_path(project_id, asset_id)
    if not metadata_path.is_file():
        raise HTTPException(status_code=404, detail="模型资产不存在")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata.update(orientation_view=view, orientation_corrected=True, orientation_source=source)
    response = _response_from_metadata(metadata)
    temporary = metadata_path.with_suffix(".json.tmp")
    temporary.write_text(response.model_dump_json(indent=2), encoding="utf-8")
    temporary.replace(metadata_path)
    return response


def resolve_model_asset_file(project_id: str, asset_id: str, relative_path: str) -> tuple[Path, str]:
    db.get_project(project_id)
    metadata_path = _metadata_path(project_id, asset_id)
    if not metadata_path.is_file():
        raise HTTPException(status_code=404, detail="模型资产不存在")
    safe_path = _safe_relative_path(relative_path)
    files_root = (metadata_path.parent / "files").resolve()
    requested = files_root.joinpath(*safe_path.parts).resolve()
    if not requested.is_relative_to(files_root) or not requested.is_file():
        raise HTTPException(status_code=404, detail="模型相关文件不存在")
    media_type = {
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
        ".bin": "application/octet-stream",
        ".fbx": "application/octet-stream",
        ".3ds": "application/octet-stream",
        ".obj": "text/plain",
        ".mtl": "text/plain",
    }.get(requested.suffix.lower()) or mimetypes.guess_type(requested.name)[0] or "application/octet-stream"
    return requested, media_type
