from __future__ import annotations

import base64
import csv
import hashlib
import json
import math
import re
import shutil
import struct
from pathlib import Path
from urllib.parse import quote, unquote

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 600_000_000


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODEL_SOURCE = Path(r"D:\documents\xwechat_files\wxid_2fydyq34lhbz12_d9e9\msg\file\2026-08\卫生间通用部品2026-08-04")
SURFACE_SOURCE = Path(r"D:\opc\富邦花园2-4-701\产品数据\墙板")
DIMENSION_SOURCE = PROJECT_ROOT / "outputs" / "bathroom-model-dimensions" / "卫生间通用部品_建模长宽高.json"
CATALOG_SOURCE = PROJECT_ROOT / "backend" / "data" / "product_catalog.csv"
PUBLIC_ROOT = PROJECT_ROOT / "public" / "model-library"
MANIFEST_TARGETS = [
    PUBLIC_ROOT / "manifest.json",
    PROJECT_ROOT / "backend" / "data" / "model_library.json",
    PROJECT_ROOT / "src" / "generated-model-library.json",
]
CATALOG_JSON_TARGET = PROJECT_ROOT / "src" / "generated-product-catalog.json"

PRIMARY_EXTENSIONS = {".glb", ".gltf", ".fbx", ".obj"}
FORMAT_PRIORITY = {".glb": 0, ".gltf": 1, ".fbx": 2, ".obj": 3}
DEPENDENCY_EXTENSIONS = {".bin", ".mtl", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tga", ".dds", ".ktx", ".ktx2", ".basis"}


def safe_id(prefix: str, value: str) -> str:
    digest = hashlib.sha1(value.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}-{digest}"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def url_for(path: Path) -> str:
    relative = path.relative_to(PROJECT_ROOT / "public").as_posix()
    return "/" + quote(relative, safe="/")


def price_tier(index: int, count: int) -> str:
    if count <= 1:
        return "comfort"
    normalized = index / (count - 1)
    return "basic" if normalized < 0.34 else "comfort" if normalized < 0.67 else "premium"


def load_catalog() -> list[dict[str, str]]:
    with CATALOG_SOURCE.open("r", encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def load_dimensions() -> dict[str, dict[str, object]]:
    rows = json.loads(DIMENSION_SOURCE.read_text(encoding="utf-8"))
    return {str(row["relativePath"]).replace("\\", "/"): row for row in rows if row.get("status") == "OK"}


def model_category(source_category: str, filename: str) -> str:
    if source_category == "无障碍淋浴室坐凳001":
        return "淋浴椅"
    if source_category == "扶手":
        return "马桶扶手" if "B1" in filename.upper() else "花洒扶手"
    return source_category


def selected_model_files() -> list[Path]:
    files = sorted(
        (path for path in MODEL_SOURCE.rglob("*") if path.is_file() and path.suffix.lower() in PRIMARY_EXTENSIONS),
        key=lambda item: item.relative_to(MODEL_SOURCE).as_posix(),
    )
    grouped: dict[tuple[str, str], list[Path]] = {}
    for path in files:
        relative = path.relative_to(MODEL_SOURCE)
        key = (relative.parts[0], path.stem.casefold())
        grouped.setdefault(key, []).append(path)
    selected = [sorted(group, key=lambda item: (FORMAT_PRIORITY[item.suffix.lower()], item.stat().st_size))[0] for group in grouped.values()]
    # Heater_01 is the same geometry as the much smaller 热水器01.glb export.
    return [path for path in selected if path.name.casefold() != "heater_01.obj"]


def copy_dependencies(source: Path, destination_dir: Path) -> int:
    copied = 1
    primary_target = destination_dir / source.name
    if not primary_target.is_file() or primary_target.stat().st_size != source.stat().st_size:
        shutil.copy2(source, primary_target)
    sibling_material = source.with_suffix(".mtl")
    if sibling_material.is_file():
        material_target = destination_dir / sibling_material.name
        if not material_target.is_file() or material_target.stat().st_size != sibling_material.stat().st_size:
            shutil.copy2(sibling_material, material_target)
        copied += 1
    dependency_dir = source.with_suffix("")
    if dependency_dir.is_dir():
        for dependency in dependency_dir.rglob("*"):
            if dependency.is_file() and dependency.suffix.lower() in DEPENDENCY_EXTENSIONS:
                target = destination_dir / dependency.relative_to(source.parent)
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.is_file() or target.stat().st_size != dependency.stat().st_size:
                    shutil.copy2(dependency, target)
                copied += 1
    if source.suffix.lower() == ".gltf":
        data = json.loads(source.read_text(encoding="utf-8"))
        uris = [item.get("uri") for key in ("buffers", "images") for item in data.get(key, [])]
        for uri in uris:
            if not uri or str(uri).startswith("data:"):
                continue
            decoded = Path(unquote(str(uri)))
            if decoded.is_absolute() or ".." in decoded.parts:
                continue
            dependency = next((candidate for candidate in (source.parent / str(uri), source.parent / decoded) if candidate.is_file()), None)
            target = destination_dir / decoded
            if dependency and (not target.exists() or target.stat().st_size != dependency.stat().st_size):
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dependency, target)
                copied += 1
    return copied


def catalog_codes_by_category(catalog: list[dict[str, str]]) -> dict[str, list[dict[str, str]]]:
    result: dict[str, list[dict[str, str]]] = {}
    for row in catalog:
        result.setdefault(row["材料名称"], []).append(row)
    for rows in result.values():
        rows.sort(key=lambda row: (float(row.get("单价") or 0), row["材料编号"]))
    return result


def build_fixture_assets(catalog: list[dict[str, str]], dimensions: dict[str, dict[str, object]]) -> list[dict[str, object]]:
    selected = selected_model_files()
    grouped: dict[str, list[Path]] = {}
    for source in selected:
        category = model_category(source.relative_to(MODEL_SOURCE).parts[0], source.name)
        grouped.setdefault(category, []).append(source)
    catalog_groups = catalog_codes_by_category(catalog)
    assets: list[dict[str, object]] = []
    for category in sorted(grouped):
        sources = sorted(grouped[category], key=lambda item: item.name)
        codes = catalog_groups.get(category, [])
        code_assignments: list[list[str]] = [[] for _ in sources]
        for code_index, row in enumerate(codes):
            source_index = round((code_index / max(1, len(codes) - 1)) * max(0, len(sources) - 1))
            code_assignments[source_index].append(row["材料编号"])
        for index, source in enumerate(sources):
            relative = source.relative_to(MODEL_SOURCE).as_posix()
            asset_id = safe_id("builtin", relative)
            destination_dir = PUBLIC_ROOT / "models" / asset_id
            destination_dir.mkdir(parents=True, exist_ok=True)
            file_count = copy_dependencies(source, destination_dir)
            dimension = dimensions.get(relative, {})
            tier = price_tier(index, len(sources))
            assigned_codes = code_assignments[index]
            target = destination_dir / source.name
            assets.append({
                "id": asset_id,
                "label": source.stem,
                "category": category,
                "source_category": source.relative_to(MODEL_SOURCE).parts[0],
                "asset_type": "fixture",
                "format": source.suffix.lower().lstrip("."),
                "src": url_for(target),
                "filename": source.name,
                "bytes": target.stat().st_size,
                "sha256": file_sha256(target),
                "file_count": file_count,
                "dimensions_mm": {
                    "width": round(float(dimension.get("lengthX_mm") or 600), 1),
                    "depth": round(float(dimension.get("widthZ_mm") or 600), 1),
                    "height": round(float(dimension.get("heightY_mm") or 600), 1),
                },
                "dimension_status": "verified" if dimension else "review",
                "price_tier": tier,
                "catalog_codes": assigned_codes,
                "styles": sorted({style for row in codes if row["材料编号"] in assigned_codes for style in re.split(r"[、,，/；;\s]+", row.get("风格", "")) if style}),
                "source": "卫生间通用部品2026-08-04",
            })
    return assets


def pack_floats(values: list[float]) -> bytes:
    return struct.pack(f"<{len(values)}f", *values)


def board_gltf(width_m: float, height_m: float, depth_m: float, texture_name: str) -> dict[str, object]:
    x, y, z = width_m / 2, height_m / 2, depth_m / 2
    faces = [
        ((-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z), (0, 0, 1)),
        ((x, -y, -z), (-x, -y, -z), (-x, y, -z), (x, y, -z), (0, 0, -1)),
        ((-x, -y, -z), (-x, -y, z), (-x, y, z), (-x, y, -z), (-1, 0, 0)),
        ((x, -y, z), (x, -y, -z), (x, y, -z), (x, y, z), (1, 0, 0)),
        ((-x, y, z), (x, y, z), (x, y, -z), (-x, y, -z), (0, 1, 0)),
        ((-x, -y, -z), (x, -y, -z), (x, -y, z), (-x, -y, z), (0, -1, 0)),
    ]
    positions: list[float] = []
    normals: list[float] = []
    uvs: list[float] = []
    indices: list[int] = []
    for face_index, (*corners, normal) in enumerate(faces):
        for corner in corners:
            positions.extend(corner)
            normals.extend(normal)
        uvs.extend((0, 0, 1, 0, 1, 1, 0, 1))
        base = face_index * 4
        indices.extend((base, base + 1, base + 2, base, base + 2, base + 3))
    chunks = [pack_floats(positions), pack_floats(normals), pack_floats(uvs), struct.pack(f"<{len(indices)}H", *indices)]
    offsets: list[int] = []
    binary = b""
    for chunk in chunks:
        while len(binary) % 4:
            binary += b"\0"
        offsets.append(len(binary))
        binary += chunk
    buffer_uri = "data:application/octet-stream;base64," + base64.b64encode(binary).decode("ascii")
    return {
        "asset": {"version": "2.0", "generator": "Bathroom model library builder"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2}, "indices": 3, "material": 0}]}],
        "materials": [{"name": "Surface", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 0.78}}],
        "textures": [{"sampler": 0, "source": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
        "images": [{"uri": texture_name}],
        "buffers": [{"byteLength": len(binary), "uri": buffer_uri}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": offsets[0], "byteLength": len(chunks[0]), "target": 34962},
            {"buffer": 0, "byteOffset": offsets[1], "byteLength": len(chunks[1]), "target": 34962},
            {"buffer": 0, "byteOffset": offsets[2], "byteLength": len(chunks[2]), "target": 34962},
            {"buffer": 0, "byteOffset": offsets[3], "byteLength": len(chunks[3]), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 24, "type": "VEC3", "min": [-x, -y, -z], "max": [x, y, z]},
            {"bufferView": 1, "componentType": 5126, "count": 24, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5126, "count": 24, "type": "VEC2"},
            {"bufferView": 3, "componentType": 5123, "count": 36, "type": "SCALAR"},
        ],
    }


def build_surface_assets(catalog: list[dict[str, str]]) -> list[dict[str, object]]:
    catalog_by_code = {row["材料编号"]: row for row in catalog}
    assets: list[dict[str, object]] = []
    candidates: dict[str, list[Path]] = {}
    for source in SURFACE_SOURCE.iterdir():
        if source.is_file() and source.suffix.lower() in {".jpg", ".jpeg", ".png"}:
            candidates.setdefault(source.name.split(" ", 1)[0], []).append(source)
    for code, source_options in sorted(candidates.items()):
        row = catalog_by_code.get(code)
        if not row or row["材料名称"] not in {"墙板", "地砖"}:
            continue
        spec_words = [word for word in re.split(r"[\sT-]+", row["规格型号"]) if word and word != code and not re.search(r"\d+x\d+|\d+×\d+", word)]
        source = max(source_options, key=lambda item: sum(word in item.stem for word in spec_words))
        code = source.name.split(" ", 1)[0]
        category = row["材料名称"]
        width_mm, height_mm, depth_mm = (600, 3000, 10) if category == "墙板" else (3000, 10, 1200)
        asset_id = f"surface-{code.lower()}"
        destination_dir = PUBLIC_ROOT / "surfaces" / code
        destination_dir.mkdir(parents=True, exist_ok=True)
        texture_path = destination_dir / "texture.jpg"
        if not texture_path.is_file() or texture_path.stat().st_mtime < source.stat().st_mtime:
            with Image.open(source) as image:
                # Ask JPEG decoders to subsample oversized source photography before
                # rasterizing it; some supplied textures exceed 500 megapixels.
                image.draft("RGB", (1200, 1200))
                image = ImageOps.exif_transpose(image).convert("RGB")
                image.thumbnail((1200, 1200), Image.Resampling.LANCZOS)
                image.save(texture_path, "JPEG", quality=74, optimize=True, progressive=True)
        model_path = destination_dir / "panel.gltf"
        model_path.write_text(json.dumps(board_gltf(width_mm / 1000, height_mm / 1000, depth_mm / 1000, texture_path.name), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        level_match = re.match(r"[QD]B(\d)", code)
        level = int(level_match.group(1)) if level_match else 2
        assets.append({
            "id": asset_id,
            "label": row["规格型号"],
            "category": category,
            "source_category": category,
            "asset_type": "surface",
            "format": "gltf",
            "src": url_for(model_path),
            "texture_src": url_for(texture_path),
            "thumbnail": url_for(texture_path),
            "filename": model_path.name,
            "bytes": model_path.stat().st_size + texture_path.stat().st_size,
            "sha256": file_sha256(texture_path),
            "file_count": 2,
            "dimensions_mm": {"width": width_mm, "depth": depth_mm, "height": height_mm},
            "dimension_status": "verified",
            "price_tier": {1: "basic", 2: "comfort", 3: "premium"}.get(level, "comfort"),
            "catalog_codes": [code],
            "styles": [style for style in re.split(r"[、,，/；;\s]+", row.get("风格", "")) if style],
            "unit_price": float(row["单价"]),
            "price_unit": row["数量单位"],
            "source": "产品数据/墙板",
        })
    return assets


def main() -> None:
    for source in (MODEL_SOURCE, SURFACE_SOURCE, DIMENSION_SOURCE, CATALOG_SOURCE):
        if not source.exists():
            raise FileNotFoundError(source)
    public_root = PUBLIC_ROOT.resolve()
    expected_parent = (PROJECT_ROOT / "public").resolve()
    if public_root.parent != expected_parent:
        raise RuntimeError(f"Refusing to rebuild unexpected directory: {public_root}")
    PUBLIC_ROOT.mkdir(parents=True, exist_ok=True)
    catalog = load_catalog()
    assets = build_fixture_assets(catalog, load_dimensions()) + build_surface_assets(catalog)
    manifest = {
        "schema_version": "1.0.0",
        "generated_from": [str(MODEL_SOURCE), str(SURFACE_SOURCE)],
        "asset_count": len(assets),
        "assets": assets,
    }
    for target in MANIFEST_TARGETS:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    CATALOG_JSON_TARGET.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    fixture_count = sum(asset["asset_type"] == "fixture" for asset in assets)
    surface_count = len(assets) - fixture_count
    print(json.dumps({"assets": len(assets), "fixtures": fixture_count, "surfaces": surface_count, "public_bytes": sum(path.stat().st_size for path in PUBLIC_ROOT.rglob("*") if path.is_file())}, ensure_ascii=False))


if __name__ == "__main__":
    main()
