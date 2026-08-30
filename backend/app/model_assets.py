from __future__ import annotations

import asyncio
import csv
import hashlib
import json
import mimetypes
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from fastapi import HTTPException, UploadFile

from .config import settings
from .database import db
from .model_conversion import CONVERTIBLE_MODEL_EXTENSIONS, ModelConversionError, convert_model_to_glb
from .models import ModelAssetResponse


PRIMARY_EXTENSIONS = {".glb", ".gltf", ".fbx", ".3ds", ".obj"}
ALLOWED_EXTENSIONS = PRIMARY_EXTENSIONS | CONVERTIBLE_MODEL_EXTENSIONS | {
    ".bin", ".mtl", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
    ".tga", ".dds", ".ktx", ".ktx2", ".basis",
}
MAX_MODEL_FILES = 300
MAX_MODEL_BYTES = 200 * 1024 * 1024
MODEL_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
_STORE_LOCK = threading.Lock()

CATEGORY_DIMENSIONS: dict[str, dict[str, float]] = {
    "地漏": {"width": 100, "depth": 100, "height": 44.3},
    "排水点": {"width": 60, "depth": 60, "height": 20},
    "给水点": {"width": 40, "depth": 40, "height": 40},
    "电位": {"width": 86, "depth": 15, "height": 86},
    "散热器": {"width": 500, "depth": 160, "height": 700},
    "花洒扶手": {"width": 80, "depth": 600, "height": 900},
    "马桶扶手": {"width": 80, "depth": 600, "height": 750},
    "淋浴椅": {"width": 420, "depth": 360, "height": 450},
    "马桶": {"width": 380, "depth": 680, "height": 760},
    "洗衣机": {"width": 600, "depth": 620, "height": 850},
    "水龙头": {"width": 80, "depth": 160, "height": 160},
    "热水器": {"width": 720, "depth": 180, "height": 430},
    # Reviewed shower installation envelope; do not use the smaller proxy.
    "花洒": {"width": 285, "depth": 485, "height": 1327},
}

POINT_CATALOG_BINDINGS: dict[str, tuple[list[str], str]] = {
    "地漏01": (["DL-01"], "内置地漏模型与知识图谱型号对应"),
    "地漏02": (["DL-02"], "内置地漏模型与知识图谱型号对应"),
    "三孔16A插座": (["EP-16A"], "内置电气面板与知识图谱型号对应"),
    "双开面板": (["EP-2K"], "内置电气面板与知识图谱型号对应"),
    "夜灯面板": (["EP-NL"], "内置电气面板与知识图谱型号对应"),
    "正五孔插座": (["EP-5H"], "内置电气面板与知识图谱型号对应"),
    "浴霸面板": (["EP-YB"], "内置电气面板与知识图谱型号对应"),
    "防溅盒": (["EP-FJ"], "内置电气面板与知识图谱型号对应"),
}

CATALOG_BINDINGS: dict[str, tuple[list[str], str]] = {
    **POINT_CATALOG_BINDINGS,
    "无障碍扶手-折叠式": (["FSM-1"], "外观复核为壁挂折叠马桶扶手"),
    "无障碍折叠椅1": (["LYY-1"], "外观复核为带扶手的无障碍淋浴椅"),
    "智能坐便器": (["MT3"], "文件名和外观对应智能马桶产品"),
    "洗衣机": (["XYJ1-1"], "外观复核为白色波轮洗衣机"),
    "热水器": (["RSQ1-1", "RSQ2-1"], "白色 60L 横式热水器共用外观模型"),
    "花洒": (["HS2-1"], "外观复核为枪灰色恒温花洒"),
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


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


def _asset_root() -> Path:
    return db.data_dir / "model-assets"


def _metadata_path(asset_id: str) -> Path:
    if not MODEL_ID_PATTERN.fullmatch(asset_id):
        raise HTTPException(status_code=404, detail="模型资产不存在")
    return _asset_root() / asset_id / "asset.json"


def _orientation_overrides_path() -> Path:
    return _asset_root() / "builtin-orientation-overrides.json"


def _disabled_builtins_path() -> Path:
    return _asset_root() / "builtin-disabled.json"


def _disabled_builtin_ids() -> set[str]:
    try:
        payload = json.loads(_disabled_builtins_path().read_text(encoding="utf-8"))
        return {str(asset_id) for asset_id in payload} if isinstance(payload, list) else set()
    except (OSError, ValueError, TypeError):
        return set()


def _orientation_overrides() -> dict[str, dict[str, object]]:
    try:
        payload = json.loads(_orientation_overrides_path().read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def builtin_orientation_override(asset_id: object) -> dict[str, object]:
    """Orientation correction pinned for a builtin library asset (shared with design_chat)."""
    return _orientation_overrides().get(str(asset_id or ""), {})


def _response_from_metadata(metadata: dict[str, object]) -> ModelAssetResponse:
    if metadata.get("orientation_view") == "side":
        metadata = {**metadata, "orientation_view": "left"}
    return ModelAssetResponse.model_validate(metadata)


def _category_for_label(label: str) -> str | None:
    normalized = label.replace(" ", "")
    if "地漏" in normalized:
        return "地漏"
    if any(name in normalized for name in ("插座", "开关", "面板", "防溅盒")):
        return "电位"
    if "排水点" in normalized or "下水点" in normalized:
        return "排水点"
    if "给水点" in normalized or "水口" in normalized:
        return "给水点"
    if "洗衣机龙头" in normalized or "水龙头" in normalized:
        return "水龙头"
    if "小背篓" in normalized or "散热器" in normalized:
        return "散热器"
    if "折叠椅" in normalized or "淋浴椅" in normalized or "坐凳" in normalized:
        return "淋浴椅"
    if "扶手B1" in normalized.upper() or ("扶手" in normalized and "折叠" in normalized):
        return "马桶扶手"
    if "扶手" in normalized:
        return "花洒扶手"
    if "智能坐便" in normalized or "坐便器" in normalized or "马桶" in normalized:
        return "马桶"
    if "洗衣机" in normalized:
        return "洗衣机"
    if "热水器" in normalized:
        return "热水器"
    if "花洒" in normalized:
        return "花洒"
    return None


def _all_builtin_assets() -> list[dict[str, object]]:
    path = Path(__file__).resolve().parents[1] / "data" / "model_library.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        assets = payload.get("assets", []) if isinstance(payload, dict) else []
        result = []
        for asset in assets:
            normalized = dict(asset)
            codes, _note = POINT_CATALOG_BINDINGS.get(str(asset.get("label") or ""), ([], ""))
            if codes:
                category = "地漏" if str(asset.get("label") or "").startswith("地漏") else "电位"
                normalized.update(
                    category=category,
                    catalog_codes=codes,
                    dimensions_mm=CATEGORY_DIMENSIONS[category],
                    correction_tag="drain" if category == "地漏" else ("switch" if "开" in str(asset.get("label") or "") or "面板" in str(asset.get("label") or "") else "socket"),
                )
            result.append(normalized)
        return result
    except (OSError, ValueError, TypeError):
        return []


def _builtin_assets() -> list[dict[str, object]]:
    disabled = _disabled_builtin_ids()
    return [asset for asset in _all_builtin_assets() if str(asset.get("id") or "") not in disabled]


def _builtin_duplicate(project_id: str, sha256: str) -> ModelAssetResponse | None:
    asset = next((item for item in _builtin_assets() if item.get("asset_type") == "fixture" and item.get("sha256") == sha256), None)
    if not asset:
        return None
    return _builtin_response(project_id, asset).model_copy(update={"deduplicated": True, "created_at": _now_iso()})


def _builtin_response(project_id: str, asset: dict[str, object]) -> ModelAssetResponse:
    merged = {**asset, **_orientation_overrides().get(str(asset["id"]), {})}
    codes = list(merged.get("catalog_codes") or [])
    products = _catalog_products()
    return ModelAssetResponse(
        id=str(merged["id"]), project_id=project_id, label=str(merged["label"]),
        filename=str(merged["filename"]), format=str(merged["format"]),
        bytes=int(merged["bytes"]), sha256=str(merged["sha256"]),
        file_count=int(merged.get("file_count") or 1), created_at="1970-01-01T00:00:00+00:00",
        src=str(merged["src"]), library_scope="builtin", category=str(merged.get("category") or "") or None,
        dimensions_mm=merged.get("dimensions_mm"), catalog_codes=codes,
        product_ids=list(merged.get("product_ids") or [products[code][1] for code in codes if code in products]),
        binding_status="bound" if codes else "unbound",
        binding_note=str(merged.get("binding_note") or "内置模型库产品编号绑定"),
        product_attributes=merged.get("product_attributes"),
        orientation_view=merged.get("orientation_view"), orientation_mapping=merged.get("orientation_mapping"),
        orientation_corrected=bool(merged.get("orientation_corrected", False)), orientation_source=merged.get("orientation_source"),
        correction_tag=str(merged.get("correction_tag") or "standard"),
    )


def set_model_asset_tag(project_id: str, asset_id: str, tag: str) -> ModelAssetResponse:
    db.get_project(project_id)
    builtin = next((item for item in _builtin_assets() if item.get("asset_type") == "fixture" and item.get("id") == asset_id), None)
    if builtin:
        with _STORE_LOCK:
            overrides = _orientation_overrides()
            overrides[asset_id] = {**overrides.get(asset_id, {}), "correction_tag": tag}
            path = _orientation_overrides_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(overrides, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(path)
        return _builtin_response(project_id, builtin)
    metadata_path = _metadata_path(asset_id)
    if not metadata_path.is_file():
        raise HTTPException(status_code=404, detail="模型资产不存在")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["correction_tag"] = tag
    response = _response_from_metadata(metadata)
    temporary = metadata_path.with_suffix(".json.tmp")
    temporary.write_text(response.model_dump_json(indent=2), encoding="utf-8")
    temporary.replace(metadata_path)
    return response


def _catalog_products() -> dict[str, tuple[str, str]]:
    path = Path(__file__).resolve().parents[1] / "data" / "product_catalog.csv"
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as source:
            rows = list(csv.DictReader(source))
    except OSError:
        return {}
    result: dict[str, tuple[str, str]] = {}
    for row in rows:
        code, category = (row.get("材料编号") or "").strip(), (row.get("材料名称") or "").strip()
        if code and category:
            result[code] = (category, hashlib.sha256(f"{code}|{category}".encode()).hexdigest()[:20])
    return result


def _binding_for_label(label: str, category: str | None) -> dict[str, object]:
    codes, note = CATALOG_BINDINGS.get(label, ([], "当前产品目录没有可确认的对应 SKU"))
    products = _catalog_products()
    valid = [code for code in codes if code in products and products[code][0] == category]
    return {
        "catalog_codes": valid,
        "product_ids": [products[code][1] for code in valid],
        "binding_status": "bound" if valid else "unbound",
        "binding_note": note if valid else "当前产品目录没有可确认的对应 SKU",
    }


def _backfill_binding(metadata_path: Path, metadata: dict[str, object]) -> dict[str, object]:
    return metadata


def list_shared_model_assets() -> list[ModelAssetResponse]:
    root = _asset_root()
    if not root.is_dir():
        return []
    assets: list[ModelAssetResponse] = []
    for metadata_path in root.glob("*/asset.json"):
        try:
            metadata = _backfill_binding(metadata_path, json.loads(metadata_path.read_text(encoding="utf-8")))
            assets.append(_response_from_metadata(metadata))
        except (OSError, ValueError, TypeError):
            continue
    return sorted(assets, key=lambda asset: asset.created_at, reverse=True)


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
    conversion_indexes = [index for index, path in enumerate(safe_paths) if path.suffix.lower() in CONVERTIBLE_MODEL_EXTENSIONS]
    if len(primary_indexes) > 1 or (not primary_indexes and len(conversion_indexes) != 1):
        raise HTTPException(status_code=422, detail="每次导入需要一个主模型；SKP 等源格式会自动转换为 GLB")

    upload_id = uuid.uuid4().hex
    asset_root = _asset_root()
    temp_root = asset_root / f".upload-{upload_id}"
    files_root = temp_root / "files"
    primary_index = primary_indexes[0] if primary_indexes else conversion_indexes[0]
    primary_path = safe_paths[primary_index]
    source_primary_path = primary_path
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
        converted_from = None
        if primary_path.suffix.lower() in CONVERTIBLE_MODEL_EXTENSIONS:
            source_file = files_root.joinpath(*primary_path.parts)
            converted_path = primary_path.with_suffix(".glb")
            try:
                await asyncio.to_thread(
                    convert_model_to_glb,
                    source_file,
                    files_root.joinpath(*converted_path.parts),
                    settings.model_converter_command,
                    settings.model_conversion_timeout_seconds,
                )
            except ModelConversionError as error:
                raise HTTPException(status_code=503, detail=str(error)) from error
            converted_from = primary_path.suffix.lower().lstrip(".")
            primary_path = converted_path
            total_bytes += files_root.joinpath(*primary_path.parts).stat().st_size
            if total_bytes > MAX_MODEL_BYTES:
                raise HTTPException(status_code=413, detail="转换后的模型总大小不能超过 200 MB")
        primary_bytes = files_root.joinpath(*primary_path.parts).stat().st_size
        if primary_bytes == 0:
            raise HTTPException(status_code=422, detail="主模型文件为空")

        digest = _sha256_file(files_root.joinpath(*primary_path.parts))
        builtin = _builtin_duplicate(project_id, digest)
        if builtin:
            shutil.rmtree(temp_root, ignore_errors=True)
            return builtin

        asset_id = digest[:32]
        final_root = asset_root / asset_id
        encoded_path = quote(primary_path.as_posix(), safe="/")
        label = source_primary_path.stem[:120]
        category = _category_for_label(label)
        metadata = ModelAssetResponse(
            id=asset_id,
            project_id=project_id,
            label=label,
            filename=primary_path.name,
            format=primary_path.suffix.lower().lstrip("."),
            bytes=primary_bytes,
            sha256=digest,
            file_count=len(files) + (1 if converted_from else 0),
            created_at=_now_iso(),
            src=f"/api/model-assets/{asset_id}/files/{encoded_path}",
            category=category,
            dimensions_mm=CATEGORY_DIMENSIONS.get(category or ""),
            catalog_codes=[], product_ids=[], binding_status="unbound",
            binding_note=(f"文件名提示可能属于“{category}”；请用目录 SKU 显式绑定" if category else "请选择目录 SKU 显式绑定"),
            lifecycle="converted" if converted_from else "approved",
            source_format=converted_from,
        )
        with _STORE_LOCK:
            existing_path = final_root / "asset.json"
            if existing_path.is_file():
                existing = _response_from_metadata(_backfill_binding(existing_path, json.loads(existing_path.read_text(encoding="utf-8"))))
                shutil.rmtree(temp_root, ignore_errors=True)
                return existing.model_copy(update={"deduplicated": True})
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
    builtins = [_builtin_response(project_id, asset) for asset in _builtin_assets() if asset.get("asset_type") == "fixture"]
    builtin_hashes = {asset.sha256 for asset in builtins}
    # A rebuilt builtin library is authoritative. Do not show an older uploaded
    # copy of the same bytes beside the freshly generated asset.
    shared = [asset for asset in list_shared_model_assets() if asset.sha256 not in builtin_hashes]
    shared_ids = {asset.id for asset in shared}
    return shared + [asset for asset in builtins if asset.id not in shared_ids]


def delete_model_asset(project_id: str, asset_id: str) -> None:
    db.get_project(project_id)
    builtin = next((item for item in _builtin_assets() if item.get("asset_type") == "fixture" and item.get("id") == asset_id), None)
    in_use = any(
        fixture.model_asset and fixture.model_asset.id == asset_id
        for project in db.list_projects() if project.spec
        for fixture in project.spec.fixtures
    )
    if in_use:
        raise HTTPException(status_code=409, detail="模型仍被项目布局使用，不能删除或停用")
    if builtin:
        with _STORE_LOCK:
            disabled = _disabled_builtin_ids()
            disabled.add(asset_id)
            path = _disabled_builtins_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(sorted(disabled), ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(path)
        return
    metadata_path = _metadata_path(asset_id)
    if not metadata_path.is_file():
        raise HTTPException(status_code=404, detail="模型资产不存在")
    shutil.rmtree(metadata_path.parent)


def set_model_orientation(project_id: str, asset_id: str, view: str, source: str, mapping: dict[str, str] | None = None) -> ModelAssetResponse:
    db.get_project(project_id)
    builtin = next((item for item in _builtin_assets() if item.get("asset_type") == "fixture" and item.get("id") == asset_id), None)
    if builtin:
        with _STORE_LOCK:
            overrides = _orientation_overrides()
            overrides[asset_id] = {**overrides.get(asset_id, {}), "orientation_view": view, "orientation_mapping": mapping, "orientation_corrected": True, "orientation_source": source}
            path = _orientation_overrides_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(overrides, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(path)
        return _builtin_response(project_id, builtin)
    metadata_path = _metadata_path(asset_id)
    if not metadata_path.is_file():
        raise HTTPException(status_code=404, detail="模型资产不存在")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata.update(orientation_view=view, orientation_mapping=mapping, orientation_corrected=True, orientation_source=source)
    response = _response_from_metadata(metadata)
    temporary = metadata_path.with_suffix(".json.tmp")
    temporary.write_text(response.model_dump_json(indent=2), encoding="utf-8")
    temporary.replace(metadata_path)
    return response


def bind_model_asset(project_id: str, asset_id: str, product: dict) -> ModelAssetResponse:
    db.get_project(project_id)
    attrs = product["attributes"]
    category = str(attrs.get("材料名称") or "")
    code = str(attrs["材料编号"])
    product_name = str(attrs.get("规格型号") or attrs.get("物品名称") or category).strip()
    point_kind = str(attrs.get("点位类型") or "")
    point_tag = "drain" if point_kind == "floor_drain" else "switch" if point_kind == "electric" and "开关" in str(attrs.get("规格型号") or "") else "socket" if point_kind == "electric" else None
    label = product_name if code in product_name else f"{code} {product_name}"
    binding = {"label": label, "category": category, "catalog_codes": [code], "product_ids": [product["id"]], "product_attributes": {str(key): str(value) for key, value in attrs.items()}, "binding_status": "bound", "binding_note": "人工按目录 SKU 确认绑定"}
    if point_tag:
        binding["correction_tag"] = point_tag
    builtin = next((item for item in _builtin_assets() if item.get("asset_type") == "fixture" and item.get("id") == asset_id), None)
    if builtin:
        with _STORE_LOCK:
            overrides = _orientation_overrides()
            overrides[asset_id] = {**overrides.get(asset_id, {}), **binding}
            path = _orientation_overrides_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(overrides, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(path)
        return _builtin_response(project_id, builtin)
    metadata_path = _metadata_path(asset_id)
    if not metadata_path.is_file():
        raise HTTPException(status_code=404, detail="模型资产不存在")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata.update(binding)
    response = _response_from_metadata(metadata)
    temporary = metadata_path.with_suffix(".json.tmp")
    temporary.write_text(response.model_dump_json(indent=2), encoding="utf-8")
    temporary.replace(metadata_path)
    return response


def resolve_model_asset_file(asset_id: str, relative_path: str) -> tuple[Path, str]:
    metadata_path = _metadata_path(asset_id)
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
