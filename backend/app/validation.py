from __future__ import annotations

import math

from .models import Point2D, RoomSpec, ValidationIssue


def wall_length(a: Point2D, b: Point2D) -> float:
    return math.hypot(b.x_mm - a.x_mm, b.z_mm - a.z_mm)


def polygon_area(points: list[Point2D]) -> float:
    if len(points) < 3:
        return 0
    return abs(
        sum(
            points[i].x_mm * points[(i + 1) % len(points)].z_mm
            - points[(i + 1) % len(points)].x_mm * points[i].z_mm
            for i in range(len(points))
        )
        / 2
    )


def _orientation(a: Point2D, b: Point2D, c: Point2D) -> int:
    value = (b.z_mm - a.z_mm) * (c.x_mm - b.x_mm) - (b.x_mm - a.x_mm) * (c.z_mm - b.z_mm)
    if value == 0:
        return 0
    return 1 if value > 0 else 2


def _segments_intersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D) -> bool:
    return _orientation(a, b, c) != _orientation(a, b, d) and _orientation(c, d, a) != _orientation(c, d, b)


def has_self_intersection(points: list[Point2D]) -> bool:
    count = len(points)
    for i in range(count):
        a, b = points[i], points[(i + 1) % count]
        for j in range(i + 1, count):
            if j in (i, (i + 1) % count) or (j + 1) % count in (i, (i + 1) % count):
                continue
            if _segments_intersect(a, b, points[j], points[(j + 1) % count]):
                return True
    return False


def point_in_polygon(x: int, z: int, points: list[Point2D]) -> bool:
    inside = False
    j = len(points) - 1
    for i, point in enumerate(points):
        previous = points[j]
        crosses = (point.z_mm > z) != (previous.z_mm > z)
        if crosses:
            boundary_x = (previous.x_mm - point.x_mm) * (z - point.z_mm) / (previous.z_mm - point.z_mm) + point.x_mm
            if x < boundary_x:
                inside = not inside
        j = i
    return inside


def validate_spec(spec: RoomSpec) -> tuple[list[ValidationIssue], bool, list[str]]:
    issues: list[ValidationIssue] = []
    missing: list[str] = []
    if len(spec.boundary) < 3 or polygon_area(spec.boundary) < 100_000:
        issues.append(ValidationIssue(id="boundary", severity="error", code="invalid_boundary", message="房间轮廓未闭合或面积过小"))
        missing.append("闭合且有尺度的房间轮廓")
    elif has_self_intersection(spec.boundary):
        issues.append(ValidationIssue(id="boundary-cross", severity="error", code="self_intersection", message="房间轮廓存在自相交"))

    if spec.height_mm is None:
        issues.append(ValidationIssue(id="height", severity="error", code="missing_height", message="缺少房间层高，请手动填写或补充照片"))
        missing.append("房间层高")

    for opening in spec.openings:
        if opening.wall_index >= len(spec.boundary):
            issues.append(ValidationIssue(id=f"opening-wall-{opening.id}", severity="error", code="opening_wall", message=f"{opening.label} 未关联到有效墙面", target_id=opening.id))
            continue
        start = spec.boundary[opening.wall_index]
        end = spec.boundary[(opening.wall_index + 1) % len(spec.boundary)]
        if opening.offset_mm + opening.width_mm > wall_length(start, end) + 1:
            issues.append(ValidationIssue(id=f"opening-range-{opening.id}", severity="error", code="opening_outside", message=f"{opening.label} 超出所属墙面", target_id=opening.id))

    if len(spec.boundary) >= 3:
        for fixture in spec.fixtures:
            if not point_in_polygon(fixture.x_mm, fixture.z_mm, spec.boundary):
                issues.append(ValidationIssue(id=f"fixture-{fixture.id}", severity="warning", code="fixture_outside", message=f"{fixture.label} 的中心点位于房间外", target_id=fixture.id))
            if fixture.confidence < 0.6 and fixture.source != "user":
                issues.append(ValidationIssue(id=f"confidence-{fixture.id}", severity="warning", code="low_confidence", message=f"{fixture.label} 为低置信度识别结果", target_id=fixture.id))

    for index, left in enumerate(spec.fixtures):
        if left.kind in {"floor_drain", "pipe"}:
            continue
        for right in spec.fixtures[index + 1 :]:
            if right.kind in {"floor_drain", "pipe"}:
                continue
            overlaps_x = abs(left.x_mm - right.x_mm) * 2 < left.width_mm + right.width_mm
            overlaps_z = abs(left.z_mm - right.z_mm) * 2 < left.depth_mm + right.depth_mm
            if overlaps_x and overlaps_z:
                issues.append(
                    ValidationIssue(
                        id=f"collision-{left.id}-{right.id}",
                        severity="warning",
                        code="fixture_collision",
                        message=f"{left.label} 与 {right.label} 的占地范围重叠",
                        target_id=left.id,
                    )
                )

    sufficient = not any(issue.severity == "error" for issue in issues)
    return issues, sufficient, list(dict.fromkeys(missing))
