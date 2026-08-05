from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Any, Iterable

import ezdxf
from defusedxml import ElementTree as SafeElementTree
from ezdxf import bbox as dxf_bbox
from ezdxf.addons import odafc
from svgelements import (
    Circle as SVGCircle,
    Ellipse as SVGEllipse,
    Line as SVGLine,
    Path as SVGPath,
    Polygon as SVGPolygon,
    Polyline as SVGPolyline,
    Rect as SVGRect,
    SVG,
)

from .measurement import room_spec_from_measurement
from .models import (
    FixtureSpec,
    MeasurementModel,
    Observation,
    OpeningSpec,
    Point2D,
    RoomSpec,
    SourceKind,
    ValidationIssue,
)


SUPPORTED_EXTENSIONS = {".json", ".geojson", ".svg", ".dxf", ".dwg"}
UNIT_TO_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4, "ft": 304.8, "px": 25.4 / 96.0}
DXF_UNIT_NAMES = {
    1: "in", 2: "ft", 4: "mm", 5: "cm", 6: "m",
}
BOUNDARY_TOKENS = ("boundary", "outline", "room", "wall", "walls", "floor", "轮廓", "墙", "房间")
DOOR_TOKENS = ("door", "doors", "门", "门洞")
WINDOW_TOKENS = ("window", "windows", "窗", "窗洞")


class MeasurementImportError(ValueError):
    pass


@dataclass
class LayerSummary:
    name: str
    entity_count: int = 0
    boundary_candidates: int = 0
    point_markers: int = 0


@dataclass
class RawPointFeature:
    kind: str
    label: str
    x: float
    y: float
    width: float | None = None
    depth: float | None = None
    point_usage: str | None = None
    layer: str = "0"


@dataclass
class RawOpeningFeature:
    kind: str
    label: str
    x: float
    y: float
    width: float | None = None
    layer: str = "0"


@dataclass
class RawDrawing:
    source_format: str
    detected_unit: str | None
    invert_y: bool
    boundaries: list[tuple[str, list[tuple[float, float]]]] = field(default_factory=list)
    segments: dict[str, list[tuple[tuple[float, float], tuple[float, float]]]] = field(default_factory=lambda: defaultdict(list))
    points: list[RawPointFeature] = field(default_factory=list)
    openings: list[RawOpeningFeature] = field(default_factory=list)
    layer_counts: Counter[str] = field(default_factory=Counter)
    warnings: list[str] = field(default_factory=list)


@dataclass
class ImportedPlan:
    spec: RoomSpec
    source_format: str
    source_unit: str
    scale_to_mm: float
    selected_layer: str | None
    warnings: list[str]


def _extension(filename: str) -> str:
    extension = Path(filename or "").suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        supported = "、".join(sorted(item.lstrip(".").upper() for item in SUPPORTED_EXTENSIONS))
        raise MeasurementImportError(f"不支持 {extension or '无扩展名'} 文件；可导入 {supported}")
    return extension


def dwg_converter_available() -> bool:
    try:
        if odafc.is_installed():
            return True
    except Exception:
        pass
    return shutil.which("dwg2dxf") is not None


def _semantic_text(*values: object) -> str:
    return " ".join(str(value or "") for value in values).strip().lower()


def _contains_any(value: str, tokens: Iterable[str]) -> bool:
    normalized = value.lower()
    return any(token in normalized for token in tokens)


def _opening_kind(label: str) -> str | None:
    if _contains_any(label, DOOR_TOKENS):
        return "door"
    if _contains_any(label, WINDOW_TOKENS):
        return "window"
    return None


def _point_kind(label: str) -> tuple[str, str | None] | None:
    value = re.sub(r"[\s_\-]+", " ", label.lower())
    if any(token in value for token in ("马桶排水", "toilet drain", "soil", "污水")):
        return "drain", "toilet"
    if any(token in value for token in ("淋浴地漏", "shower drain")):
        return "floor_drain", "shower"
    if any(token in value for token in ("地漏", "floor drain", "floordrain")) or re.search(r"\bfd\b", value):
        return "floor_drain", "general"
    if any(token in value for token in ("台盆排水", "basin drain", "sink drain")):
        return "drain", "basin"
    if any(token in value for token in ("排水", "drain", "下水")):
        return "drain", "general"
    if any(token in value for token in ("给水", "water", "supply", "hot water", "cold water")):
        return "water", "general"
    if any(token in value for token in ("电点", "插座", "开关", "electric", "socket", "switch")):
        return "electric", None
    if any(token in value for token in ("管井", "包管", "pipe shaft", "pipe chase")):
        return "pipe", None
    if any(token in value for token in ("柱", "column")):
        return "column", None
    if any(token in value for token in ("暖气", "radiator")):
        return "radiator", None
    if any(token in value for token in ("马桶", "坐便", "toilet", "\bwc\b")):
        return "toilet", None
    if any(token in value for token in ("台盆", "洗手盆", "vanity", "basin")):
        return "vanity", None
    if any(token in value for token in ("淋浴", "shower")):
        return "shower", None
    return None


def _polygon_area(points: list[tuple[float, float]]) -> float:
    return abs(sum(
        x * points[(index + 1) % len(points)][1] - points[(index + 1) % len(points)][0] * y
        for index, (x, y) in enumerate(points)
    )) / 2 if len(points) >= 3 else 0


def _distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _clean_ring(points: Iterable[tuple[float, float]], tolerance: float = 1e-6) -> list[tuple[float, float]]:
    cleaned: list[tuple[float, float]] = []
    for point in points:
        value = (float(point[0]), float(point[1]))
        if not cleaned or _distance(cleaned[-1], value) > tolerance:
            cleaned.append(value)
    if len(cleaned) > 2 and _distance(cleaned[0], cleaned[-1]) <= tolerance:
        cleaned.pop()
    changed = True
    while changed and len(cleaned) > 3:
        changed = False
        reduced: list[tuple[float, float]] = []
        for index, current in enumerate(cleaned):
            previous = cleaned[index - 1]
            following = cleaned[(index + 1) % len(cleaned)]
            cross = abs((current[0] - previous[0]) * (following[1] - current[1]) - (current[1] - previous[1]) * (following[0] - current[0]))
            span = max(_distance(previous, current) + _distance(current, following), 1)
            if cross / span <= tolerance:
                changed = True
            else:
                reduced.append(current)
        cleaned = reduced
    return cleaned


def _stitch_segments(
    segments: list[tuple[tuple[float, float], tuple[float, float]]],
    tolerance: float,
) -> list[list[tuple[float, float]]]:
    unused = list(segments)
    rings: list[list[tuple[float, float]]] = []
    while unused:
        start, end = unused.pop(0)
        chain = [start, end]
        while unused:
            current = chain[-1]
            match_index = -1
            next_point: tuple[float, float] | None = None
            for index, (left, right) in enumerate(unused):
                if _distance(current, left) <= tolerance:
                    match_index, next_point = index, right
                    break
                if _distance(current, right) <= tolerance:
                    match_index, next_point = index, left
                    break
            if match_index < 0 or next_point is None:
                break
            unused.pop(match_index)
            if _distance(next_point, chain[0]) <= tolerance:
                if len(chain) >= 3:
                    rings.append(_clean_ring(chain, tolerance / 10))
                break
            chain.append(next_point)
    return [ring for ring in rings if len(ring) >= 3]


def _dxf_document(content: bytes, extension: str):
    with tempfile.TemporaryDirectory(prefix="measurement-cad-") as temp_dir:
        input_path = Path(temp_dir) / f"drawing{extension}"
        input_path.write_bytes(content)
        if extension == ".dxf":
            try:
                return ezdxf.readfile(input_path)
            except (ezdxf.DXFError, OSError) as error:
                raise MeasurementImportError(f"DXF 解析失败：{error}") from error
        if not dwg_converter_available():
            raise MeasurementImportError("DWG 需要服务器安装 ODA File Converter 或 LibreDWG；当前运行环境未检测到转换器，可先另存为 DXF")
        try:
            if odafc.is_installed():
                return odafc.readfile(input_path, audit=True)
        except Exception as error:
            oda_error = error
        else:
            oda_error = None
        converter = shutil.which("dwg2dxf")
        if converter:
            output_path = Path(temp_dir) / "drawing.dxf"
            completed = subprocess.run(
                [converter, "-o", str(output_path), str(input_path)],
                capture_output=True,
                text=True,
                timeout=90,
                check=False,
            )
            if completed.returncode == 0 and output_path.exists():
                try:
                    return ezdxf.readfile(output_path)
                except (ezdxf.DXFError, OSError) as error:
                    raise MeasurementImportError(f"DWG 已转换，但生成的 DXF 无法读取：{error}") from error
        detail = str(oda_error) if oda_error else "转换器未生成 DXF"
        raise MeasurementImportError(f"DWG 转换失败：{detail}")


def _entity_extent(entity: Any) -> tuple[float, float] | None:
    try:
        extent = dxf_bbox.extents([entity], fast=True)
        if not extent.has_data:
            return None
        size = extent.size
        return abs(float(size.x)), abs(float(size.y))
    except Exception:
        return None


def _parse_dxf(content: bytes, extension: str) -> RawDrawing:
    document = _dxf_document(content, extension)
    detected_unit = DXF_UNIT_NAMES.get(int(document.units or 0))
    drawing = RawDrawing(source_format=extension.lstrip("."), detected_unit=detected_unit, invert_y=True)
    for entity in document.modelspace():
        layer = str(entity.dxf.get("layer", "0") or "0")
        drawing.layer_counts[layer] += 1
        entity_type = entity.dxftype()
        block_name = entity.dxf.get("name", "") if entity_type == "INSERT" else ""
        semantic = _semantic_text(layer, entity_type, block_name)
        opening_kind = _opening_kind(semantic)
        point_kind = _point_kind(semantic)
        if entity_type == "LWPOLYLINE":
            points = [(float(x), float(y)) for x, y, *_ in entity.get_points("xy")]
            if opening_kind and points:
                extent = _entity_extent(entity)
                drawing.openings.append(RawOpeningFeature(opening_kind, semantic, sum(x for x, _ in points) / len(points), sum(y for _, y in points) / len(points), max(extent or (0, 0)) or None, layer))
            elif entity.closed and len(points) >= 3:
                drawing.boundaries.append((layer, _clean_ring(points)))
            else:
                drawing.segments[layer].extend((points[index], points[index + 1]) for index in range(len(points) - 1))
        elif entity_type == "POLYLINE":
            points = [(float(vertex.dxf.location.x), float(vertex.dxf.location.y)) for vertex in entity.vertices]
            if opening_kind and points:
                extent = _entity_extent(entity)
                drawing.openings.append(RawOpeningFeature(opening_kind, semantic, sum(x for x, _ in points) / len(points), sum(y for _, y in points) / len(points), max(extent or (0, 0)) or None, layer))
            elif entity.is_closed and len(points) >= 3:
                drawing.boundaries.append((layer, _clean_ring(points)))
            else:
                drawing.segments[layer].extend((points[index], points[index + 1]) for index in range(len(points) - 1))
        elif entity_type == "LINE":
            start = entity.dxf.start
            end = entity.dxf.end
            drawing.segments[layer].append(((float(start.x), float(start.y)), (float(end.x), float(end.y))))
        elif entity_type in {"INSERT", "POINT", "CIRCLE"}:
            if entity_type == "INSERT":
                position = entity.dxf.insert
            elif entity_type == "POINT":
                position = entity.dxf.location
            else:
                position = entity.dxf.center
            extent = _entity_extent(entity)
            if opening_kind:
                drawing.openings.append(RawOpeningFeature(opening_kind, semantic, float(position.x), float(position.y), max(extent or (0, 0)) or None, layer))
            elif point_kind:
                drawing.points.append(RawPointFeature(point_kind[0], semantic, float(position.x), float(position.y), *(extent or (None, None)), point_kind[1], layer))
    source_tolerance = 2 / UNIT_TO_MM.get(detected_unit or "mm", 1)
    for layer, segments in drawing.segments.items():
        drawing.boundaries.extend((layer, ring) for ring in _stitch_segments(segments, source_tolerance))
    if detected_unit is None:
        drawing.warnings.append("CAD 文件未声明绘图单位，导入前需要确认单位")
    return drawing


def _svg_label(element: Any) -> str:
    values = getattr(element, "values", {}) or {}
    names = [getattr(element, "id", None), values.get("class"), values.get("label"), values.get("inkscape:label")]
    names.extend(value for key, value in values.items() if str(key).endswith("}label"))
    return _semantic_text(*names)


def _svg_points(element: Any) -> list[tuple[float, float]]:
    try:
        if isinstance(element, SVGPath):
            points: list[tuple[float, float]] = []
            for segment in element:
                length = float(segment.length(error=1e-4))
                if length <= 0:
                    continue
                sample_count = max(1, min(256, math.ceil(length / 10)))
                for index in range(sample_count + 1):
                    point = segment.point(index / sample_count)
                    value = (float(point.x), float(point.y))
                    if not points or _distance(points[-1], value) > 1e-6:
                        points.append(value)
            return points
        return [(float(point.x), float(point.y)) for point in element.as_points() if point is not None]
    except (AttributeError, TypeError, ValueError):
        return []


def _parse_svg(content: bytes) -> RawDrawing:
    if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
        raise MeasurementImportError("SVG 不允许包含 DOCTYPE 或自定义实体")
    try:
        root = SafeElementTree.fromstring(content)
        svg = SVG.parse(BytesIO(content), reify=True, ppi=96)
    except Exception as error:
        raise MeasurementImportError(f"SVG 解析失败：{error}") from error
    root_width = str(root.attrib.get("width", "")).strip()
    declared_svg_unit = bool(re.search(r"(?:mm|cm|m|in|ft|px)\s*$", root_width, re.IGNORECASE) or re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", root_width))
    drawing = RawDrawing(source_format="svg", detected_unit="px" if declared_svg_unit else None, invert_y=False)
    if re.search(r"(?:mm|cm|m|in|ft)\s*$", root_width, re.IGNORECASE):
        drawing.warnings.append("SVG 物理尺寸已按 96 DPI 展开，自动单位会还原为毫米")
    elif not declared_svg_unit:
        drawing.warnings.append("SVG 只有 viewBox、没有物理宽度，导入前需要确认坐标单位")
    for element in svg.elements():
        if element is svg:
            continue
        layer = _svg_label(element) or "svg"
        drawing.layer_counts[layer] += 1
        opening_kind = _opening_kind(layer)
        point_kind = _point_kind(layer)
        if isinstance(element, (SVGCircle, SVGEllipse)) and point_kind:
            width = abs(float(getattr(element, "rx", getattr(element, "r", 20)))) * 2
            depth = abs(float(getattr(element, "ry", getattr(element, "r", 20)))) * 2
            drawing.points.append(RawPointFeature(point_kind[0], layer, float(element.cx), float(element.cy), width, depth, point_kind[1], layer))
            continue
        if isinstance(element, SVGRect):
            x, y = float(element.x), float(element.y)
            width, height = float(element.width), float(element.height)
            if opening_kind:
                drawing.openings.append(RawOpeningFeature(opening_kind, layer, x + width / 2, y + height / 2, max(width, height), layer))
            elif point_kind:
                drawing.points.append(RawPointFeature(point_kind[0], layer, x + width / 2, y + height / 2, width, height, point_kind[1], layer))
            else:
                drawing.boundaries.append((layer, [(x, y), (x + width, y), (x + width, y + height), (x, y + height)]))
            continue
        points = _svg_points(element)
        if isinstance(element, SVGLine):
            drawing.segments[layer].append(((float(element.x1), float(element.y1)), (float(element.x2), float(element.y2))))
        elif isinstance(element, (SVGPath, SVGPolygon, SVGPolyline)) and len(points) >= 2:
            if opening_kind:
                xs, ys = [x for x, _ in points], [y for _, y in points]
                drawing.openings.append(RawOpeningFeature(opening_kind, layer, sum(xs) / len(xs), sum(ys) / len(ys), max(max(xs) - min(xs), max(ys) - min(ys)), layer))
            elif point_kind:
                xs, ys = [x for x, _ in points], [y for _, y in points]
                drawing.points.append(RawPointFeature(point_kind[0], layer, sum(xs) / len(xs), sum(ys) / len(ys), max(xs) - min(xs), max(ys) - min(ys), point_kind[1], layer))
            else:
                closed = isinstance(element, SVGPolygon) or _distance(points[0], points[-1]) <= 0.01
                if closed and len(points) >= 3:
                    drawing.boundaries.append((layer, _clean_ring(points, 0.01)))
                else:
                    drawing.segments[layer].extend((points[index], points[index + 1]) for index in range(len(points) - 1))
    for layer, segments in drawing.segments.items():
        drawing.boundaries.extend((layer, ring) for ring in _stitch_segments(segments, 0.5))
    return drawing


def _drawing_layers(drawing: RawDrawing) -> list[LayerSummary]:
    names = set(drawing.layer_counts)
    names.update(layer for layer, _ in drawing.boundaries)
    result = []
    for name in sorted(names, key=str.lower):
        result.append(LayerSummary(
            name=name,
            entity_count=drawing.layer_counts[name],
            boundary_candidates=sum(1 for layer, _ in drawing.boundaries if layer == name),
            point_markers=sum(1 for point in drawing.points if point.layer == name),
        ))
    return result


def inspect_measurement_file(content: bytes, filename: str) -> dict[str, Any]:
    extension = _extension(filename)
    if extension in {".json", ".geojson"}:
        try:
            payload = json.loads(content.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise MeasurementImportError(f"JSON 解析失败：{error}") from error
        if not isinstance(payload, dict):
            raise MeasurementImportError("JSON 顶层必须是对象")
        if extension == ".geojson" or payload.get("type") in {"Feature", "FeatureCollection", "Polygon"}:
            detected_format = "geojson"
        elif "measurement_id" in payload:
            detected_format = "measurement-json"
        elif "schemaVersion" in payload and "walls" in payload:
            detected_format = "measurement-contract-json"
        elif "boundary" in payload and "schema_version" in payload:
            detected_format = "room-spec-json"
        else:
            raise MeasurementImportError("JSON 不是内部量房、导出量房、RoomSpec 或 GeoJSON 格式")
        return {
            "filename": Path(filename).name,
            "format": detected_format,
            "detected_unit": "mm" if detected_format != "geojson" else None,
            "unit_required": detected_format == "geojson",
            "can_import": True,
            "dwg_converter_available": dwg_converter_available(),
            "layers": [],
            "warnings": ["GeoJSON 通常不声明工程单位，请确认坐标单位"] if detected_format == "geojson" else [],
        }
    if extension == ".dwg" and not dwg_converter_available():
        return {
            "filename": Path(filename).name,
            "format": "dwg",
            "detected_unit": None,
            "unit_required": True,
            "can_import": False,
            "dwg_converter_available": False,
            "layers": [],
            "warnings": ["服务器未安装 ODA File Converter 或 LibreDWG；可先另存为 DXF"],
        }
    drawing = _parse_svg(content) if extension == ".svg" else _parse_dxf(content, extension)
    layers = _drawing_layers(drawing)
    if not drawing.boundaries:
        drawing.warnings.append("未找到闭合轮廓；请确认墙体图层中的线段首尾相接")
    return {
        "filename": Path(filename).name,
        "format": drawing.source_format,
        "detected_unit": drawing.detected_unit,
        "unit_required": drawing.detected_unit is None,
        "can_import": bool(drawing.boundaries),
        "dwg_converter_available": dwg_converter_available(),
        "layers": [item.__dict__ for item in layers],
        "warnings": list(dict.fromkeys(drawing.warnings)),
    }


def _select_boundary(drawing: RawDrawing, layer: str | None) -> tuple[str, list[tuple[float, float]]]:
    candidates = [(candidate_layer, points) for candidate_layer, points in drawing.boundaries if not layer or candidate_layer == layer]
    if not candidates:
        detail = f"图层 {layer}" if layer else "文件"
        raise MeasurementImportError(f"{detail}中没有可用闭合轮廓")
    def score(item: tuple[str, list[tuple[float, float]]]) -> tuple[int, float]:
        candidate_layer, points = item
        return (1 if _contains_any(candidate_layer, BOUNDARY_TOKENS) else 0, _polygon_area(points))
    selected_layer, boundary = max(candidates, key=score)
    if _polygon_area(boundary) <= 0:
        raise MeasurementImportError("选中的房间轮廓面积为 0")
    return selected_layer, boundary


def _unit_scale(unit: str, detected_unit: str | None) -> tuple[str, float]:
    selected = detected_unit if unit == "auto" else unit
    if selected not in UNIT_TO_MM:
        raise MeasurementImportError("文件没有单位信息，请选择毫米、厘米、米、英寸、英尺或像素")
    return selected, UNIT_TO_MM[selected]


def _normalizer(boundary: list[tuple[float, float]], scale: float, invert_y: bool):
    scaled = [(x * scale, y * scale) for x, y in boundary]
    min_x = min(x for x, _ in scaled)
    min_y = min(y for _, y in scaled)
    max_y = max(y for _, y in scaled)
    def apply(x: float, y: float) -> tuple[int, int]:
        sx, sy = x * scale, y * scale
        return round(sx - min_x), round((max_y - sy) if invert_y else (sy - min_y))
    return apply


FIXTURE_DEFAULTS = {
    "toilet": (700, 400, 760), "vanity": (600, 500, 850), "shower": (900, 900, 2100),
    "floor_drain": (100, 100, 20), "drain": (110, 110, 100), "water": (40, 40, 500),
    "electric": (40, 40, 1200), "pipe": (400, 400, 2600), "column": (300, 300, 2600),
    "radiator": (600, 120, 600), "other": (300, 300, 300),
}
FIXTURE_LABELS = {
    "toilet": "马桶", "vanity": "台盆", "shower": "淋浴区", "floor_drain": "地漏",
    "drain": "排水点", "water": "给水点", "electric": "电点", "pipe": "管井",
    "column": "柱", "radiator": "暖气", "other": "点位",
}


def _nearest_wall(boundary: list[Point2D], x_mm: int, z_mm: int) -> tuple[int, int]:
    best = (0, 0, float("inf"))
    for index, start in enumerate(boundary):
        end = boundary[(index + 1) % len(boundary)]
        dx, dz = end.x_mm - start.x_mm, end.z_mm - start.z_mm
        length_sq = max(dx * dx + dz * dz, 1)
        ratio = min(1.0, max(0.0, ((x_mm - start.x_mm) * dx + (z_mm - start.z_mm) * dz) / length_sq))
        px, pz = start.x_mm + ratio * dx, start.z_mm + ratio * dz
        distance = math.hypot(x_mm - px, z_mm - pz)
        offset = round(math.hypot(px - start.x_mm, pz - start.z_mm))
        if distance < best[2]:
            best = (index, offset, distance)
    return best[0], best[1]


def _wall_offset(boundary: list[Point2D], wall_index: int, x_mm: int, z_mm: int) -> int:
    start = boundary[wall_index]
    end = boundary[(wall_index + 1) % len(boundary)]
    dx, dz = end.x_mm - start.x_mm, end.z_mm - start.z_mm
    length_sq = max(dx * dx + dz * dz, 1)
    ratio = min(1.0, max(0.0, ((x_mm - start.x_mm) * dx + (z_mm - start.z_mm) * dz) / length_sq))
    return round(math.hypot(dx, dz) * ratio)


def _build_spec_from_drawing(
    drawing: RawDrawing,
    filename: str,
    unit: str,
    layer: str | None,
    height_mm: int,
) -> ImportedPlan:
    selected_layer, raw_boundary = _select_boundary(drawing, layer)
    source_unit, scale = _unit_scale(unit, drawing.detected_unit)
    apply = _normalizer(raw_boundary, scale, drawing.invert_y)
    normalized = _clean_ring([apply(x, y) for x, y in raw_boundary], 1)
    boundary = [Point2D(x_mm=round(x), z_mm=round(y)) for x, y in normalized]
    if len(boundary) < 3:
        raise MeasurementImportError("归一化后的房间轮廓少于三个有效点")
    if _polygon_area([(point.x_mm, point.z_mm) for point in boundary]) < 10_000:
        raise MeasurementImportError("房间轮廓面积小于 0.01 平方米，请检查导入单位")
    observations = [
        Observation(
            field="visual_evidence:import-boundary", value=filename, source=SourceKind.measured,
            confidence=0.95, note=f"从 {drawing.source_format.upper()} 图层 {selected_layer} 导入的闭合轮廓",
            semantic_role="room_dimension", review_required=True,
        ),
        Observation(
            field="visual_evidence:import-height", value=str(height_mm), source=SourceKind.user,
            confidence=1, note="导入时设置的默认层高", semantic_role="room_height", review_required=True,
        ),
    ]
    fixtures: list[FixtureSpec] = []
    for index, item in enumerate(drawing.points):
        x_mm, z_mm = apply(item.x, item.y)
        default_width, default_depth, default_height = FIXTURE_DEFAULTS[item.kind]
        evidence_id = f"import-point-{index + 1}"
        fixtures.append(FixtureSpec(
            id=f"{item.kind}-{index + 1}", kind=item.kind, label=FIXTURE_LABELS[item.kind],
            x_mm=x_mm, z_mm=z_mm,
            width_mm=max(1, round((item.width or default_width / scale) * scale)),
            depth_mm=max(1, round((item.depth or default_depth / scale) * scale)),
            height_mm=default_height, rotation_deg=0, source=SourceKind.measured, confidence=0.9,
            evidence_ids=[evidence_id], point_usage=item.point_usage,
        ))
        observations.append(Observation(
            field=f"visual_evidence:{evidence_id}", value=item.label, source=SourceKind.measured,
            confidence=0.9, note=f"从 {drawing.source_format.upper()} 图层 {item.layer} 导入的点位",
            semantic_role="drain_position" if item.kind in {"drain", "floor_drain"} else "other", review_required=True,
            target_id=fixtures[-1].id,
        ))
    openings: list[OpeningSpec] = []
    for index, item in enumerate(drawing.openings):
        x_mm, z_mm = apply(item.x, item.y)
        wall_index, center_offset = _nearest_wall(boundary, x_mm, z_mm)
        wall_start, wall_end = boundary[wall_index], boundary[(wall_index + 1) % len(boundary)]
        wall_length = round(math.hypot(wall_end.x_mm - wall_start.x_mm, wall_end.z_mm - wall_start.z_mm))
        width = max(300, round((item.width or ((900 if item.kind == "door" else 1200) / scale)) * scale))
        width = min(width, max(wall_length, 1))
        offset = max(0, min(center_offset - width // 2, wall_length - width))
        evidence_id = f"import-opening-{index + 1}"
        openings.append(OpeningSpec(
            id=f"{item.kind}-{index + 1}", kind=item.kind, wall_index=wall_index, offset_mm=offset,
            width_mm=width, height_mm=2100 if item.kind == "door" else 1200,
            sill_mm=0 if item.kind == "door" else 900, label="门洞" if item.kind == "door" else "窗洞",
            source=SourceKind.measured, confidence=0.8, evidence_ids=[evidence_id],
        ))
        observations.append(Observation(
            field=f"visual_evidence:{evidence_id}", value=item.label, source=SourceKind.measured,
            confidence=0.8, note=f"从 {drawing.source_format.upper()} 图层 {item.layer} 映射到最近墙段",
            semantic_role="door_position", review_required=True, target_id=openings[-1].id,
        ))
    warnings = list(dict.fromkeys(drawing.warnings))
    candidates_on_layer = sum(1 for candidate_layer, _ in drawing.boundaries if candidate_layer == selected_layer)
    if candidates_on_layer > 1:
        warnings.append(f"图层 {selected_layer} 有 {candidates_on_layer} 个闭合轮廓，已采用面积最大的轮廓")
    warnings.append("CAD/SVG 门窗与点位由图层或元素名称识别，进入二维审图后仍需复核")
    issues = [ValidationIssue(
        id=f"measurement-import-warning-{index + 1}", severity="warning", code="measurement_import_review",
        message=message,
    ) for index, message in enumerate(warnings)]
    thickness = 100
    spec = RoomSpec(
        name=Path(filename).stem[:100] or "导入量房",
        boundary=boundary,
        height_mm=height_mm,
        wall_thickness_mm=thickness,
        openings=openings,
        fixtures=fixtures,
        observations=observations,
        issues=issues,
        confirmed=False,
    )
    return ImportedPlan(spec, drawing.source_format, source_unit, scale, selected_layer, warnings)


def _contract_json_spec(payload: dict[str, Any], filename: str) -> RoomSpec:
    walls = payload.get("walls") or []
    if len(walls) < 3:
        raise MeasurementImportError("导出量房 JSON 至少需要三段墙体")
    boundary = [Point2D(x_mm=int(item["startPoint"]["x"]), z_mm=int(item["startPoint"]["y"])) for item in walls]
    observations = [Observation(
        field="visual_evidence:import-boundary", value=filename, source=SourceKind.measured,
        confidence=1, note="从量房契约 JSON 导入", semantic_role="room_dimension", review_required=True,
    )]
    height = int((payload.get("heights") or {}).get("roomHeight") or 2600)
    observations.append(Observation(
        field="visual_evidence:import-height", value=str(height), source=SourceKind.measured,
        confidence=1, note="从量房契约 JSON 导入的层高", semantic_role="room_height", review_required=True,
    ))
    openings = []
    for index, item in enumerate(payload.get("openings") or []):
        wall_index = int(item.get("wallIndex", 0))
        if not 0 <= wall_index < len(boundary):
            continue
        start, end = boundary[wall_index], boundary[(wall_index + 1) % len(boundary)]
        position = item.get("position") or {}
        center_offset = _wall_offset(boundary, wall_index, int(position.get("x", start.x_mm)), int(position.get("y", start.z_mm)))
        width = int(item.get("width") or 900)
        evidence_id = f"import-opening-{index + 1}"
        openings.append(OpeningSpec(
            id=str(item.get("openingId") or f"opening-{index + 1}")[:80],
            kind="opening" if item.get("type") == "passage" else item.get("type", "door"),
            wall_index=wall_index, offset_mm=max(0, center_offset - width // 2), width_mm=width,
            height_mm=int(item.get("height") or 2100), sill_mm=int(item.get("sillHeight") or 0),
            label="门洞" if item.get("type") == "door" else "窗洞" if item.get("type") == "window" else "洞口",
            source=SourceKind.measured, confidence=1, evidence_ids=[evidence_id],
        ))
        observations.append(Observation(
            field=f"visual_evidence:{evidence_id}", value=filename, source=SourceKind.measured,
            confidence=1, note="从量房契约 JSON 导入", semantic_role="door_position", review_required=True,
        ))
    fixtures: list[FixtureSpec] = []
    def add_fixture(
        kind: str,
        label: str,
        position: dict[str, Any],
        *,
        fixture_id: str | None = None,
        usage: str | None = None,
        width: int | None = None,
        depth: int | None = None,
        height_mm: int | None = None,
        rotation_deg: int = 0,
    ) -> None:
        index = len(fixtures) + 1
        default_width, default_depth, default_height = FIXTURE_DEFAULTS[kind]
        evidence_id = f"import-point-{index}"
        fixtures.append(FixtureSpec(
            id=(fixture_id or f"{kind}-{index}")[:80], kind=kind, label=label, x_mm=int(position.get("x", 0)), z_mm=int(position.get("y", 0)),
            width_mm=width or default_width, depth_mm=depth or default_depth, height_mm=height_mm or default_height,
            rotation_deg=rotation_deg, source=SourceKind.measured, confidence=1, evidence_ids=[evidence_id], point_usage=usage,
        ))
        observations.append(Observation(
            field=f"visual_evidence:{evidence_id}", value=label, source=SourceKind.measured,
            confidence=1, note="从量房契约 JSON 导入", semantic_role="drain_position" if kind in {"drain", "floor_drain"} else "other", review_required=True,
        ))
    measurement_points = payload.get("measurementPoints")
    if isinstance(measurement_points, list):
        for index, item in enumerate(measurement_points):
            if not isinstance(item, dict):
                raise MeasurementImportError(f"measurementPoints[{index}] 必须是对象")
            kind = str(item.get("kind") or "other")
            if kind not in FIXTURE_DEFAULTS:
                raise MeasurementImportError(f"measurementPoints[{index}] 的点位类型 {kind} 不受支持")
            add_fixture(
                kind,
                str(item.get("label") or FIXTURE_LABELS[kind]),
                item.get("position") or {},
                fixture_id=str(item.get("pointId") or f"{kind}-{index + 1}"),
                usage=item.get("pointUsage"),
                width=int(item.get("width") or FIXTURE_DEFAULTS[kind][0]),
                depth=int(item.get("depth") or FIXTURE_DEFAULTS[kind][1]),
                height_mm=int(item.get("height") or FIXTURE_DEFAULTS[kind][2]),
                rotation_deg=int(item.get("rotation") or 0),
            )
    else:
        for item in payload.get("drainagePoints") or []:
            drain_type = item.get("type", "floor_drain")
            mapping = {
                "floor_drain": ("floor_drain", "general", "地漏"), "shower_drain": ("floor_drain", "shower", "淋浴地漏"),
                "toilet_drain": ("drain", "toilet", "马桶排水"), "sink_drain": ("drain", "basin", "台盆排水"),
                "wall_drain": ("drain", "general", "排水点"), "bathtub_drain": ("drain", "general", "浴缸排水"),
            }
            kind, usage, label = mapping.get(drain_type, ("drain", "general", "排水点"))
            diameter = int(item.get("diameter") or FIXTURE_DEFAULTS[kind][0])
            add_fixture(kind, label, item.get("position") or {}, usage=usage, width=diameter, depth=diameter)
        for item in payload.get("waterSupplyPoints") or []:
            add_fixture("water", "给水点", item.get("position") or {}, usage="general", height_mm=int(item.get("heightAboveFloor") or 500))
        for item in payload.get("pipeEnclosures") or []:
            enclosure = item.get("boundary") or []
            if len(enclosure) < 3:
                continue
            xs = [int(point["x"]) for point in enclosure]
            ys = [int(point["y"]) for point in enclosure]
            add_fixture("pipe", "管井", {"x": min(xs), "y": min(ys)}, width=max(xs) - min(xs), depth=max(ys) - min(ys), height_mm=height)
    thicknesses = [int(item.get("thickness") or 100) for item in walls]
    return RoomSpec(
        name=Path(filename).stem[:100] or "导入量房", boundary=boundary, height_mm=height,
        wall_thickness_mm=Counter(thicknesses).most_common(1)[0][0], openings=openings, fixtures=fixtures,
        observations=observations, issues=[], confirmed=False,
    )


def _geojson_spec(payload: dict[str, Any], filename: str, unit: str, height_mm: int) -> ImportedPlan:
    features = payload.get("features", []) if payload.get("type") == "FeatureCollection" else [payload]
    polygons: list[tuple[dict[str, Any], list[tuple[float, float]]]] = []
    points: list[RawPointFeature] = []
    for feature in features:
        geometry = feature.get("geometry", feature)
        properties = feature.get("properties") or {}
        geometry_type = geometry.get("type")
        if geometry_type == "Polygon" and geometry.get("coordinates"):
            polygons.append((properties, [(float(x), float(y)) for x, y, *_ in geometry["coordinates"][0]]))
        elif geometry_type == "Point" and geometry.get("coordinates"):
            label = _semantic_text(properties.get("kind"), properties.get("type"), properties.get("label"))
            kind = _point_kind(label)
            if kind:
                x, y, *_ = geometry["coordinates"]
                points.append(RawPointFeature(kind[0], label, float(x), float(y), point_usage=kind[1], layer=str(properties.get("layer") or "geojson")))
    if not polygons:
        raise MeasurementImportError("GeoJSON 没有 Polygon 房间轮廓")
    drawing = RawDrawing(source_format="geojson", detected_unit=None, invert_y=True, points=points)
    drawing.boundaries = [(str(properties.get("layer") or "geojson"), _clean_ring(coordinates)) for properties, coordinates in polygons]
    drawing.warnings.append("GeoJSON 坐标按平面工程坐标处理，不支持经纬度投影自动换算")
    return _build_spec_from_drawing(drawing, filename, unit, None, height_mm)


def import_measurement_file(
    content: bytes,
    filename: str,
    *,
    unit: str = "auto",
    layer: str | None = None,
    height_mm: int = 2600,
) -> ImportedPlan:
    if height_mm < 1800 or height_mm > 6000:
        raise MeasurementImportError("默认层高必须在 1800 到 6000 mm 之间")
    extension = _extension(filename)
    if extension in {".json", ".geojson"}:
        try:
            payload = json.loads(content.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise MeasurementImportError(f"JSON 解析失败：{error}") from error
        if not isinstance(payload, dict):
            raise MeasurementImportError("JSON 顶层必须是对象")
        if extension == ".geojson" or payload.get("type") in {"Feature", "FeatureCollection", "Polygon"}:
            return _geojson_spec(payload, filename, unit, height_mm)
        if "measurement_id" in payload:
            try:
                spec = room_spec_from_measurement(MeasurementModel.model_validate(payload))
            except ValueError as error:
                raise MeasurementImportError(f"内部量房 JSON 校验失败：{error}") from error
            spec.confirmed = False
            return ImportedPlan(spec, "measurement-json", "mm", 1, None, ["已保留内部量房证据，导入后需要重新确认"])
        if "schemaVersion" in payload and "walls" in payload:
            try:
                spec = _contract_json_spec(payload, filename)
            except (KeyError, TypeError, ValueError) as error:
                raise MeasurementImportError(f"量房契约 JSON 校验失败：{error}") from error
            return ImportedPlan(spec, "measurement-contract-json", "mm", 1, None, ["导出契约不包含原始置信度与图像证据，导入后需要复核"])
        if "boundary" in payload and "schema_version" in payload:
            try:
                spec = RoomSpec.model_validate(payload)
            except ValueError as error:
                raise MeasurementImportError(f"RoomSpec JSON 校验失败：{error}") from error
            spec.confirmed = False
            return ImportedPlan(spec, "room-spec-json", "mm", 1, None, ["RoomSpec 已导入，提交建模前需要重新确认"])
        raise MeasurementImportError("JSON 不是内部量房、导出量房、RoomSpec 或 GeoJSON 格式")
    drawing = _parse_svg(content) if extension == ".svg" else _parse_dxf(content, extension)
    return _build_spec_from_drawing(drawing, filename, unit, layer, height_mm)
