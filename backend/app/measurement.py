from __future__ import annotations

import math
import re
import uuid
from collections import Counter
from collections.abc import Callable

from .models import (
    FixtureSpec,
    MeasurementAnchor,
    MeasurementEvidence,
    MeasurementHeights,
    MeasurementModel,
    MeasurementOpening,
    MeasurementRoom,
    MeasurementSurfaceTreatment,
    MeasurementWall,
    Observation,
    OpeningSpec,
    Point2D,
    RoomSpec,
    SourceKind,
    ValidationIssue,
    WallProfile,
)
from .validation import point_in_polygon, validate_spec, wall_length


_MEASUREMENT_CONTRACT_NAMESPACE = uuid.UUID("c791c974-6b7e-48fc-93e6-cf5ec6f0e6d7")


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


def _observation_matches(observation: Observation, tokens: set[str]) -> bool:
    haystack = f"{observation.field} {observation.note} {observation.value}".lower()
    return any(token in haystack for token in tokens)


def _observation_matches_room_height(observation: Observation) -> bool:
    field = observation.field.lower()
    note = observation.note.lower()
    haystack = f"{field} {note} {observation.value}".lower()
    negative_tokens = {"door", "opening", "门洞", "门高", "门宽", "门"}
    if any(token in haystack for token in negative_tokens):
        return False
    explicit_field_tokens = {"height_mm", "room-height", "room_height"}
    if any(token in field for token in explicit_field_tokens):
        return True
    positive_role_tokens = {"height;", "kind=height", "related_to=层高", "related_to=净高", "related_to=吊顶"}
    if any(token in note for token in positive_role_tokens):
        return True
    return any(token in haystack for token in {"层高", "净高", "吊顶"})


def _evidence_refs_for(
    observations: list[Observation],
    observation_ids: list[str],
    tokens: set[str],
    *,
    matcher: Callable[[Observation, set[str]], bool] | None = None,
) -> list[str]:
    return [
        evidence_id
        for observation, evidence_id in zip(observations, observation_ids, strict=False)
        if (matcher or _observation_matches)(observation, tokens)
    ]


def _evidence_summary(
    observations: list[Observation],
    observation_ids: list[str],
    tokens: set[str],
    *,
    fallback_source: SourceKind,
    fallback_confidence: float,
    confirmed: bool,
    matcher: Callable[[Observation, set[str]], bool] | None = None,
) -> tuple[SourceKind, float, str, list[str]]:
    matches = matcher or _observation_matches
    matched = [
        observation
        for observation, _ in zip(observations, observation_ids, strict=False)
        if matches(observation, tokens)
    ]
    evidence_ids = _evidence_refs_for(observations, observation_ids, tokens, matcher=matcher)
    if not matched:
        status = _measurement_status(fallback_source, fallback_confidence, confirmed)
        return fallback_source, fallback_confidence, status, evidence_ids
    confidence = min(observation.confidence for observation in matched)
    source = SourceKind.user if any(observation.source == SourceKind.user for observation in matched) else matched[0].source
    status = "verified" if all(observation.confirmed for observation in matched) else _measurement_status(source, confidence, confirmed)
    return source, confidence, status, evidence_ids


def _manual_audit_evidence(
    evidence_id: str,
    *,
    field: str,
    raw_text: str,
    note: str,
) -> MeasurementEvidence:
    return MeasurementEvidence(
        id=evidence_id,
        field=field,
        raw_text=raw_text,
        normalized_value=raw_text,
        unit="mm" if field == "height_mm" else "text",
        source=SourceKind.user,
        confidence=1.0,
        status="verified",
        note=note,
    )


def _contract_uuid(*parts: object) -> str:
    raw = ":".join(str(part) for part in parts)
    try:
        return str(uuid.UUID(raw))
    except ValueError:
        return str(uuid.uuid5(_MEASUREMENT_CONTRACT_NAMESPACE, raw))


def _contract_point(point: Point2D) -> dict[str, int]:
    return {"x": point.x_mm, "y": point.z_mm}


def _contract_opening_position(wall: MeasurementWall, opening: MeasurementOpening) -> dict[str, int]:
    length = max(wall.length_mm, 1)
    ratio = min(max(opening.offset_mm + opening.width_mm / 2, 0), length) / length
    return {
        "x": round(wall.start.x_mm + (wall.end.x_mm - wall.start.x_mm) * ratio),
        "y": round(wall.start.z_mm + (wall.end.z_mm - wall.start.z_mm) * ratio),
    }


def _contract_anchor_position(anchor: MeasurementAnchor) -> dict[str, int]:
    return {"x": anchor.x_mm, "y": anchor.z_mm}


def _contract_anchor_boundary(anchor: MeasurementAnchor) -> list[dict[str, int]]:
    x0 = anchor.x_mm
    y0 = anchor.z_mm
    x1 = x0 + anchor.width_mm
    y1 = y0 + anchor.depth_mm
    return [
        {"x": x0, "y": y0},
        {"x": x1, "y": y0},
        {"x": x1, "y": y1},
        {"x": x0, "y": y1},
    ]


def measurement_contract_export(measurement: MeasurementModel) -> dict:
    """Return the frozen W1D1 measurement.schema.json representation."""
    walls = sorted(measurement.walls, key=lambda wall: wall.index)
    wall_index = {wall.id: index for index, wall in enumerate(walls)}
    boundary = [_contract_point(wall.start) for wall in walls]

    openings = []
    for opening in measurement.openings:
        wall = walls[wall_index[opening.wall_id]] if opening.wall_id in wall_index else None
        if wall is None:
            continue
        opening_type = "passage" if opening.kind == "opening" else opening.kind
        exported = {
            "openingId": _contract_uuid(measurement.measurement_id, "opening", opening.id),
            "wallIndex": wall_index[opening.wall_id],
            "position": _contract_opening_position(wall, opening),
            "width": opening.width_mm,
            "height": opening.height_mm,
            "type": opening_type,
        }
        if opening_type == "window":
            exported["sillHeight"] = opening.sill_mm
            exported["swingDirection"] = "none"
        elif opening_type == "door":
            exported["swingDirection"] = opening.swing_direction if opening.swing_direction in {"left", "right"} else "none"
            exported["swingOpening"] = opening.swing_direction if opening.swing_direction in {"inward", "outward"} else "inward"
        else:
            exported["swingDirection"] = "none"
        openings.append(exported)

    drainage_points = [
        {
            "drainId": _contract_uuid(measurement.measurement_id, "drain", anchor.id),
            "position": _contract_anchor_position(anchor),
            "type": {
                "toilet": "toilet_drain",
                "shower": "shower_drain",
                "floor_drain": "floor_drain",
                "vanity": "sink_drain",
            }.get(anchor.kind, "floor_drain"),
            "diameter": max(anchor.width_mm, 1),
        }
        for anchor in measurement.anchors
        if anchor.kind in {"toilet", "shower", "floor_drain", "vanity"}
    ]
    pipe_enclosures = [
        {
            "enclosureId": _contract_uuid(measurement.measurement_id, "pipe", anchor.id),
            "boundary": _contract_anchor_boundary(anchor),
            "isAccessible": False,
            "containsDrain": True,
        }
        for anchor in measurement.anchors
        if anchor.kind == "pipe"
    ]
    water_supply_points = [
        {
            "supplyId": _contract_uuid(measurement.measurement_id, "supply", anchor.id),
            "position": _contract_anchor_position(anchor),
            "waterType": "mixed",
            "heightAboveFloor": anchor.height_mm,
        }
        for anchor in measurement.anchors
        if anchor.kind in {"toilet", "vanity", "shower"}
    ]

    room_height = measurement.heights.room_height_mm or measurement.heights.wall_height_mm or 0
    wall_height = measurement.heights.wall_height_mm or room_height
    return {
        "schemaVersion": "1.0.0",
        "roomId": _contract_uuid(measurement.measurement_id),
        "boundary": boundary,
        "walls": [
            {
                "startPoint": _contract_point(wall.start),
                "endPoint": _contract_point(wall.end),
                "thickness": wall.thickness_mm,
                "type": "partition",
            }
            for wall in walls
        ],
        "openings": openings,
        "drainagePoints": drainage_points,
        "pipeEnclosures": pipe_enclosures,
        "waterSupplyPoints": water_supply_points,
        "heights": {
            "roomHeight": room_height,
            "groundElevation": measurement.heights.ground_elevation_mm,
            "wallHeight": wall_height,
            "netHeight": measurement.heights.net_height_mm or room_height,
        },
    }


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
    wall_profiles = {profile.wall_index: profile for profile in spec.wall_profiles}
    walls = [
        MeasurementWall(
            id=f"wall-{index + 1}",
            index=index,
            start=point,
            end=spec.boundary[(index + 1) % len(spec.boundary)],
            thickness_mm=wall_profiles[index].thickness_mm if index in wall_profiles else spec.wall_thickness_mm,
            length_mm=max(1, round(wall_length(point, spec.boundary[(index + 1) % len(spec.boundary)]))),
            source=wall_profiles[index].source if index in wall_profiles else wall_source,
            confidence=wall_profiles[index].confidence if index in wall_profiles else (1.0 if spec.confirmed else 0.75),
            status=_measurement_status(wall_profiles[index].source, wall_profiles[index].confidence, spec.confirmed) if index in wall_profiles else wall_status,
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
            semantic_role=observation.semantic_role,
            review_required=observation.review_required,
            rotation_degrees=observation.rotation_degrees,
            target_id=observation.target_id,
        ))

    valid_evidence_ids = set(observation_ids)
    boundary_evidence_ids = _evidence_refs_for(
        spec.observations,
        observation_ids,
        {"boundary", "wall", "墙", "轮廓", "尺寸链"},
    )
    if not boundary_evidence_ids and spec.confirmed:
        evidence_id = _evidence_id(
            Observation(field="manual_confirmation:boundary", value="用户确认墙体轮廓", source=SourceKind.user),
            len(observation_ids),
            used_evidence_ids,
        )
        observation_ids.append(evidence_id)
        valid_evidence_ids.add(evidence_id)
        evidence.append(_manual_audit_evidence(
            evidence_id,
            field="boundary",
            raw_text="用户确认墙体轮廓",
            note="无图证据时的人工确认审计记录",
        ))
        boundary_evidence_ids = [evidence_id]
    height_source, height_confidence, height_status, height_evidence_ids = _evidence_summary(
        spec.observations,
        observation_ids,
        {"height", "height_mm", "层高", "净高", "吊顶"},
        fallback_source=SourceKind.user if spec.confirmed else SourceKind.estimated,
        fallback_confidence=1.0 if spec.confirmed and spec.height_mm is not None else 0.5,
        confirmed=spec.confirmed,
        matcher=lambda observation, _tokens: _observation_matches_room_height(observation),
    )
    if not height_evidence_ids and spec.confirmed and spec.height_mm is not None:
        evidence_id = _evidence_id(
            Observation(field="manual_confirmation:height_mm", value=str(spec.height_mm), source=SourceKind.user),
            len(observation_ids),
            used_evidence_ids,
        )
        observation_ids.append(evidence_id)
        valid_evidence_ids.add(evidence_id)
        evidence.append(_manual_audit_evidence(
            evidence_id,
            field="height_mm",
            raw_text=str(spec.height_mm),
            note="无图证据时的人工确认净高审计记录",
        ))
        height_source = SourceKind.user
        height_confidence = 1.0
        height_status = "verified"
        height_evidence_ids = [evidence_id]
    for wall in walls:
        wall.evidence_ids = boundary_evidence_ids
    openings: list[MeasurementOpening] = []
    for item in spec.openings:
        opening_evidence_ids = [evidence_id for evidence_id in item.evidence_ids if evidence_id in valid_evidence_ids]
        if not opening_evidence_ids and (spec.confirmed or item.source == SourceKind.user):
            evidence_id = _evidence_id(
                Observation(field=f"manual_confirmation:opening:{item.id}", value=item.label, source=SourceKind.user),
                len(observation_ids),
                used_evidence_ids,
            )
            observation_ids.append(evidence_id)
            valid_evidence_ids.add(evidence_id)
            evidence.append(_manual_audit_evidence(
                evidence_id,
                field=f"opening:{item.id}",
                raw_text=f"{item.label} width={item.width_mm} height={item.height_mm}",
                note="无图证据时的人工确认门洞审计记录",
            ))
            opening_evidence_ids = [evidence_id]
        openings.append(MeasurementOpening(
            id=item.id,
            kind=item.kind,
            wall_id=walls[item.wall_index].id if 0 <= item.wall_index < len(walls) else f"invalid-wall-{item.wall_index}",
            offset_mm=item.offset_mm,
            width_mm=item.width_mm,
            height_mm=item.height_mm,
            thickness_mm=item.thickness_mm,
            sill_mm=item.sill_mm,
            label=item.label,
            swing_direction=item.swing_direction,
            source=item.source,
            confidence=item.confidence,
            status=_measurement_status(item.source, item.confidence, spec.confirmed),
            evidence_ids=opening_evidence_ids,
        ))
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
        surface_treatment=MeasurementSurfaceTreatment(
            strip_existing_finish=spec.strip_existing_finish,
            existing_finish_thickness_mm=spec.finish_surface_offset_mm,
            new_finish_thickness_mm=spec.wall_finish_thickness_mm,
            wall_finish_profiles=spec.wall_finish_profiles,
        ),
        room=MeasurementRoom(name=spec.name, length_mm=max_x - min_x, width_mm=max_z - min_z),
        heights=MeasurementHeights(
            room_height_mm=spec.height_mm,
            wall_height_mm=spec.height_mm,
            net_height_mm=spec.height_mm,
            source=height_source,
            confidence=height_confidence,
            status=height_status,
            evidence_ids=height_evidence_ids,
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
            semantic_role=item.semantic_role,
            review_required=item.review_required,
            rotation_degrees=item.rotation_degrees,
            target_id=item.target_id,
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
            thickness_mm=item.thickness_mm,
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
        strip_existing_finish=measurement.surface_treatment.strip_existing_finish,
        finish_surface_offset_mm=measurement.surface_treatment.existing_finish_thickness_mm,
        wall_finish_thickness_mm=measurement.surface_treatment.new_finish_thickness_mm,
        wall_finish_profiles=measurement.surface_treatment.wall_finish_profiles,
        wall_profiles=[
            WallProfile(
                wall_index=index,
                thickness_mm=wall.thickness_mm,
                source=wall.source,
                confidence=wall.confidence,
                evidence_ids=wall.evidence_ids,
            )
            for index, wall in enumerate(walls)
        ],
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
    evidence_by_id = {item.id: item for item in measurement.evidence}

    def check_evidence_refs(
        target_id: str,
        label: str,
        evidence_ids: list[str],
        *,
        critical: bool,
        status: str,
    ) -> None:
        if critical and not evidence_ids:
            issues.append(ValidationIssue(
                id=f"measurement-evidence-required-{target_id}",
                severity="error",
                code="required_evidence_missing",
                message=f"{label} 缺少可审计证据来源",
                target_id=target_id,
            ))
            missing.append(f"{target_id}.evidence_ids")
            return
        for evidence_id in evidence_ids:
            evidence = evidence_by_id.get(evidence_id)
            if evidence is None:
                issues.append(ValidationIssue(
                    id=f"measurement-evidence-missing-{target_id}-{evidence_id}",
                    severity="error",
                    code="missing_evidence_ref",
                    message=f"{label} 引用了不存在的证据 {evidence_id}",
                    target_id=target_id,
                ))
                missing.append(f"evidence.{evidence_id}")
                continue
            if critical and evidence.source == SourceKind.estimated:
                issues.append(ValidationIssue(
                    id=f"measurement-evidence-source-{target_id}-{evidence_id}",
                    severity="error",
                    code="invalid_evidence_source",
                    message=f"{label} 关联的证据 {evidence_id} 缺少可审计来源",
                    target_id=target_id,
                ))
                missing.append(f"evidence.{evidence_id}.source")
            if evidence.confidence < 0.6 and status != "verified":
                issues.append(ValidationIssue(
                    id=f"measurement-evidence-low-{target_id}-{evidence_id}",
                    severity="error" if critical else "warning",
                    code="low_confidence_evidence",
                    message=f"{label} 关联的证据 {evidence_id} 置信度低于 0.6",
                    target_id=target_id,
                ))
                if critical:
                    missing.append(f"evidence.{evidence_id}")

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
        check_evidence_refs(wall.id, wall.id, wall.evidence_ids, critical=True, status=wall.status)

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
        check_evidence_refs(
            opening.id,
            opening.label,
            opening.evidence_ids,
            critical=True,
            status=opening.status,
        )
    for anchor in measurement.anchors:
        if not point_in_polygon(anchor.x_mm, anchor.z_mm, boundary):
            issues.append(ValidationIssue(
                id=f"measurement-anchor-{anchor.id}", severity="error", code="anchor_outside",
                message=f"{anchor.label} 点位位于房间边界外", target_id=anchor.id,
            ))
        check_evidence_refs(
            anchor.id,
            anchor.label,
            anchor.evidence_ids,
            critical=False,
            status=anchor.status,
        )

    check_evidence_refs(
        "heights",
        "层高",
        measurement.heights.evidence_ids,
        critical=True,
        status=measurement.heights.status,
    )

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
