from __future__ import annotations

import math
import re
from collections import Counter

from .models import (
    FixtureSpec,
    MeasurementAnchor,
    MeasurementEvidence,
    MeasurementHeights,
    MeasurementModel,
    MeasurementOpening,
    MeasurementRoom,
    MeasurementWall,
    Observation,
    OpeningSpec,
    Point2D,
    RoomSpec,
    SourceKind,
    ValidationIssue,
)
from .validation import point_in_polygon, validate_spec, wall_length


def _measurement_status(source: SourceKind, confidence: float, confirmed: bool = False) -> str:
    if confirmed or source == SourceKind.user:
        return "verified"
    if confidence >= 0.7:
        return "provisional"
    return "unverified"


def _evidence_id(observation: Observation, index: int, used: set[str]) -> str:
    prefix = "visual_evidence:"
    candidate = observation.field[len(prefix):] if observation.field.startswith(prefix) else f"EV{index + 1}"
    candidate = re.sub(r"[^A-Za-z0-9_.:-]", "-", candidate).strip("-") or f"EV{index + 1}"
    base = candidate[:100]
    suffix = 2
    while candidate in used:
        candidate = f"{base[:94]}-{suffix}"
        suffix += 1
    used.add(candidate)
    return candidate


def measurement_from_spec(
    spec: RoomSpec,
    measurement_id: str,
    *,
    revision: int = 1,
    unresolved_fields: list[str] | None = None,
) -> MeasurementModel:
    if len(spec.boundary) < 3:
        raise ValueError("cannot create MeasurementModel without a room boundary")
    min_x = min(point.x_mm for point in spec.boundary)
    max_x = max(point.x_mm for point in spec.boundary)
    min_z = min(point.z_mm for point in spec.boundary)
    max_z = max(point.z_mm for point in spec.boundary)
    wall_status = "verified" if spec.confirmed else "provisional"
    wall_source = SourceKind.user if spec.confirmed else SourceKind.derived
    walls = [
        MeasurementWall(
            id=f"wall-{index + 1}",
            index=index,
            start=point,
            end=spec.boundary[(index + 1) % len(spec.boundary)],
            thickness_mm=spec.wall_thickness_mm,
            length_mm=max(1, round(wall_length(point, spec.boundary[(index + 1) % len(spec.boundary)]))),
            source=wall_source,
            confidence=1.0 if spec.confirmed else 0.75,
            status=wall_status,
        )
        for index, point in enumerate(spec.boundary)
    ]

    used_evidence_ids: set[str] = set()
    observation_ids: list[str] = []
    evidence: list[MeasurementEvidence] = []
    for index, observation in enumerate(spec.observations):
        evidence_id = _evidence_id(observation, index, used_evidence_ids)
        observation_ids.append(evidence_id)
        evidence.append(MeasurementEvidence(
            id=evidence_id,
            field=observation.field,
            raw_text=observation.value,
            normalized_value=observation.value if observation.source in {SourceKind.user, SourceKind.derived} else "",
            unit="mm" if observation.field in {"boundary", "height_mm"} else "text",
            source=observation.source,
            asset_id=observation.asset_id,
            bbox=observation.bbox,
            confidence=observation.confidence,
            status=_measurement_status(observation.source, observation.confidence, observation.confirmed),
            alternatives=observation.alternatives,
            note=observation.note,
        ))

    valid_evidence_ids = set(observation_ids)
    openings = [
        MeasurementOpening(
            id=item.id,
            kind=item.kind,
            wall_id=walls[item.wall_index].id if 0 <= item.wall_index < len(walls) else f"invalid-wall-{item.wall_index}",
            offset_mm=item.offset_mm,
            width_mm=item.width_mm,
            height_mm=item.height_mm,
            sill_mm=item.sill_mm,
            label=item.label,
            swing_direction=item.swing_direction,
            source=item.source,
            confidence=item.confidence,
            status=_measurement_status(item.source, item.confidence, spec.confirmed),
            evidence_ids=[evidence_id for evidence_id in item.evidence_ids if evidence_id in valid_evidence_ids],
        )
        for item in spec.openings
    ]
    anchors = [
        MeasurementAnchor(
            id=item.id,
            kind=item.kind,
            label=item.label,
            x_mm=item.x_mm,
            z_mm=item.z_mm,
            width_mm=item.width_mm,
            depth_mm=item.depth_mm,
            height_mm=item.height_mm,
            rotation_deg=item.rotation_deg,
            source=item.source,
            confidence=item.confidence,
            status=_measurement_status(item.source, item.confidence, spec.confirmed),
            evidence_ids=[evidence_id for evidence_id in item.evidence_ids if evidence_id in valid_evidence_ids],
        )
        for item in spec.fixtures
    ]
    missing = list(unresolved_fields or [])
    if spec.height_mm is None:
        missing.append("heights.room_height_mm")
    missing.extend(issue.message for issue in spec.issues if issue.severity == "error")
    return MeasurementModel(
        measurement_id=measurement_id,
        revision=revision,
        room=MeasurementRoom(name=spec.name, length_mm=max_x - min_x, width_mm=max_z - min_z),
        heights=MeasurementHeights(
            room_height_mm=spec.height_mm,
            wall_height_mm=spec.height_mm,
            net_height_mm=spec.height_mm,
        ),
        walls=walls,
        openings=openings,
        anchors=anchors,
        evidence=evidence,
        source_asset_ids=list(dict.fromkeys(item.asset_id for item in spec.observations if item.asset_id)),
        unresolved_fields=list(dict.fromkeys(missing)),
        issues=spec.issues,
        confirmed=spec.confirmed,
    )


def room_spec_from_measurement(measurement: MeasurementModel) -> RoomSpec:
    walls = sorted(measurement.walls, key=lambda wall: wall.index)
    boundary = [wall.start for wall in walls]
    wall_index = {wall.id: index for index, wall in enumerate(walls)}
    thickness_counts = Counter(wall.thickness_mm for wall in walls)
    thickness = thickness_counts.most_common(1)[0][0] if thickness_counts else 100
    observations = [
        Observation(
            field=item.field,
            value=item.raw_text,
            source=item.source,
            asset_id=item.asset_id,
            bbox=item.bbox,
            confidence=item.confidence,
            confirmed=item.status == "verified",
            alternatives=item.alternatives,
            note=item.note,
        )
        for item in measurement.evidence
    ]
    openings = [
        OpeningSpec(
            id=item.id,
            kind=item.kind,
            wall_index=wall_index.get(item.wall_id, len(walls)),
            offset_mm=item.offset_mm,
            width_mm=item.width_mm,
            height_mm=item.height_mm,
            sill_mm=item.sill_mm,
            label=item.label,
            source=item.source,
            confidence=item.confidence,
            swing_direction=item.swing_direction,
            evidence_ids=item.evidence_ids,
        )
        for item in measurement.openings
    ]
    fixtures = [
        FixtureSpec(
            id=item.id,
            kind=item.kind,
            label=item.label,
            x_mm=item.x_mm,
            z_mm=item.z_mm,
            width_mm=item.width_mm,
            depth_mm=item.depth_mm,
            height_mm=item.height_mm,
            rotation_deg=item.rotation_deg,
            source=item.source,
            confidence=item.confidence,
            evidence_ids=item.evidence_ids,
        )
        for item in measurement.anchors
    ]
    return RoomSpec(
        name=measurement.room.name,
        boundary=boundary,
        height_mm=measurement.heights.room_height_mm,
        wall_thickness_mm=thickness,
        openings=openings,
        fixtures=fixtures,
        observations=observations,
        issues=measurement.issues,
        confirmed=measurement.confirmed,
    )


def validate_measurement(
    measurement: MeasurementModel,
) -> tuple[list[ValidationIssue], bool, list[str], RoomSpec | None]:
    issues: list[ValidationIssue] = []
    missing = list(measurement.unresolved_fields)
    walls = sorted(measurement.walls, key=lambda wall: wall.index)
    if len(walls) < 3:
        issues.append(ValidationIssue(
            id="measurement-walls", severity="error", code="wall_chain_missing",
            message="量房数据缺少至少三段有序墙体",
        ))
        missing.append("walls[]")
        return issues, False, list(dict.fromkeys(missing)), None
    expected_indices = list(range(len(walls)))
    if [wall.index for wall in walls] != expected_indices:
        issues.append(ValidationIssue(
            id="measurement-wall-order", severity="error", code="wall_order",
            message="墙体 index 必须从 0 连续排列",
        ))
    for index, wall in enumerate(walls):
        following = walls[(index + 1) % len(walls)]
        gap = math.hypot(wall.end.x_mm - following.start.x_mm, wall.end.z_mm - following.start.z_mm)
        if gap > 1:
            issues.append(ValidationIssue(
                id=f"measurement-wall-gap-{wall.id}", severity="error", code="wall_chain_gap",
                message=f"{wall.id} 终点与 {following.id} 起点未闭合（间隙 {gap:.1f} mm）", target_id=wall.id,
            ))
        actual_length = wall_length(wall.start, wall.end)
        if abs(actual_length - wall.length_mm) > 20:
            issues.append(ValidationIssue(
                id=f"measurement-wall-length-{wall.id}", severity="error", code="wall_length_mismatch",
                message=f"{wall.id} 的端点距离与 length_mm 相差超过 20 mm", target_id=wall.id,
            ))

    boundary = [wall.start for wall in walls]
    span_x = max(point.x_mm for point in boundary) - min(point.x_mm for point in boundary)
    span_z = max(point.z_mm for point in boundary) - min(point.z_mm for point in boundary)
    if abs(span_x - measurement.room.length_mm) > 20 or abs(span_z - measurement.room.width_mm) > 20:
        issues.append(ValidationIssue(
            id="measurement-room-span", severity="error", code="room_span_mismatch",
            message="room 长宽摘要与 walls[] 的实际包围尺寸不一致",
        ))
    wall_by_id = {wall.id: wall for wall in walls}
    for opening in measurement.openings:
        host = wall_by_id.get(opening.wall_id)
        if host is None:
            issues.append(ValidationIssue(
                id=f"measurement-opening-wall-{opening.id}", severity="error", code="opening_wall",
                message=f"{opening.label} 引用了不存在的墙体 {opening.wall_id}", target_id=opening.id,
            ))
        elif opening.offset_mm + opening.width_mm > host.length_mm + 1:
            issues.append(ValidationIssue(
                id=f"measurement-opening-range-{opening.id}", severity="error", code="opening_outside",
                message=f"{opening.label} 超出所属墙体 {opening.wall_id}", target_id=opening.id,
            ))
    for anchor in measurement.anchors:
        if not point_in_polygon(anchor.x_mm, anchor.z_mm, boundary):
            issues.append(ValidationIssue(
                id=f"measurement-anchor-{anchor.id}", severity="error", code="anchor_outside",
                message=f"{anchor.label} 点位位于房间边界外", target_id=anchor.id,
            ))

    spec: RoomSpec | None = None
    try:
        spec = room_spec_from_measurement(measurement)
    except ValueError as error:
        issues.append(ValidationIssue(
            id="measurement-conversion", severity="error", code="measurement_conversion",
            message=f"量房数据无法转换为建模参数：{error}",
        ))
    if spec is not None:
        spec_issues, _, spec_missing = validate_spec(spec)
        existing_codes = {(issue.code, issue.target_id) for issue in issues}
        issues.extend(issue for issue in spec_issues if (issue.code, issue.target_id) not in existing_codes)
        missing.extend(spec_missing)
    combined = [*measurement.issues, *issues]
    sufficient = not missing and not any(issue.severity == "error" for issue in combined)
    return combined, sufficient, list(dict.fromkeys(missing)), spec
