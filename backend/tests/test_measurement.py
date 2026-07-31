from __future__ import annotations

import sqlite3

from backend.app.database import Database
from backend.app.measurement import measurement_contract_export, measurement_from_spec, room_spec_from_measurement, validate_measurement
from backend.app.models import (
    FixtureSpec,
    ImageBBox,
    Observation,
    OpeningSpec,
    Point2D,
    RoomSpec,
    SourceKind,
)
from backend.app.validation import wall_length


def non_rectangular_spec() -> RoomSpec:
    return RoomSpec(
        name="异形卫生间",
        boundary=[
            Point2D(x_mm=0, z_mm=0),
            Point2D(x_mm=1200, z_mm=0),
            Point2D(x_mm=1200, z_mm=400),
            Point2D(x_mm=1800, z_mm=400),
            Point2D(x_mm=1800, z_mm=2200),
            Point2D(x_mm=0, z_mm=2200),
        ],
        height_mm=2600,
        openings=[
            OpeningSpec(
                id="door-1", wall_index=4, offset_mm=200, width_mm=800, height_mm=2100,
                thickness_mm=40, evidence_ids=["door-width"], source=SourceKind.measured, confidence=0.9,
            )
        ],
        fixtures=[
            FixtureSpec(
                id="drain-1", kind="floor_drain", label="地漏", x_mm=1500, z_mm=1200,
                width_mm=120, depth_mm=120, height_mm=10,
                evidence_ids=["drain-point"], source=SourceKind.measured, confidence=0.85,
            )
        ],
        observations=[
            Observation(
                field="visual_evidence:door-width", value="800", source=SourceKind.measured,
                asset_id="plan-1", bbox=ImageBBox(x_min=100, y_min=700, x_max=180, y_max=760),
                confidence=0.9, note="门洞净宽",
            ),
            Observation(
                field="visual_evidence:drain-point", value="地漏", source=SourceKind.measured,
                asset_id="plan-1", bbox=ImageBBox(x_min=600, y_min=400, x_max=640, y_max=450),
                confidence=0.85, note="排水点",
            ),
        ],
        confirmed=True,
    )


def test_non_rectangular_measurement_round_trip_preserves_topology_and_evidence() -> None:
    source = non_rectangular_spec()
    measurement = measurement_from_spec(source, "measurement-1")
    issues, sufficient, missing, rebuilt = validate_measurement(measurement)

    assert sufficient
    assert missing == []
    assert not any(issue.severity == "error" for issue in issues)
    assert len(measurement.walls) == len(source.boundary)
    assert measurement.openings[0].wall_id == "wall-5"
    assert measurement.openings[0].thickness_mm == 40
    assert measurement.openings[0].evidence_ids == ["door-width"]
    assert measurement.evidence[0].bbox == ImageBBox(x_min=100, y_min=700, x_max=180, y_max=760)
    assert measurement.source_asset_ids == ["plan-1"]
    assert rebuilt is not None
    assert rebuilt.boundary == source.boundary
    assert rebuilt.openings[0].wall_index == 4
    assert rebuilt.openings[0].thickness_mm == 40
    assert rebuilt.fixtures[0].evidence_ids == ["drain-point"]
    assert room_spec_from_measurement(measurement).confirmed


def test_point_usage_round_trip_and_contract_export() -> None:
    source = non_rectangular_spec()
    source.fixtures.extend([
        FixtureSpec(
            id="toilet-drain", kind="drain", point_usage="toilet", label="马桶排水",
            x_mm=200, z_mm=0, width_mm=110, depth_mm=110, height_mm=100,
            source=SourceKind.user, confidence=1,
        ),
        FixtureSpec(
            id="basin-water", kind="water", point_usage="basin", label="台盆给水",
            x_mm=800, z_mm=0, width_mm=40, depth_mm=40, height_mm=500,
            source=SourceKind.user, confidence=1,
        ),
    ])

    measurement = measurement_from_spec(source, "point-usage")
    rebuilt = room_spec_from_measurement(measurement)
    exported = measurement_contract_export(measurement)

    assert {item.id: item.point_usage for item in measurement.anchors}["toilet-drain"] == "toilet"
    assert {item.id: item.point_usage for item in rebuilt.fixtures}["basin-water"] == "basin"
    assert any(item["type"] == "toilet_drain" for item in exported["drainagePoints"])
    assert len(exported["waterSupplyPoints"]) == 1


def test_measurement_export_maps_wall_and_height_evidence() -> None:
    spec = non_rectangular_spec()
    spec.observations.extend(
        [
            Observation(
                field="visual_evidence:wall-chain",
                value="异形轮廓尺寸链",
                source=SourceKind.measured,
                asset_id="plan-1",
                bbox=ImageBBox(x_min=10, y_min=10, x_max=400, y_max=900),
                confidence=0.92,
                note="boundary",
            ),
            Observation(
                field="visual_evidence:room-height",
                value="层高 2600",
                source=SourceKind.measured,
                asset_id="plan-1",
                bbox=ImageBBox(x_min=700, y_min=80, x_max=900, y_max=140),
                confidence=0.88,
                note="height",
            ),
        ]
    )

    measurement = measurement_from_spec(spec, "measurement-1")

    assert all(wall.evidence_ids == ["wall-chain"] for wall in measurement.walls)
    assert measurement.heights.evidence_ids == ["room-height"]
    assert measurement.heights.status == "verified"
    assert measurement.model_dump(mode="json")["heights"]["evidence_ids"] == ["room-height"]


def test_measurement_export_does_not_bind_door_height_as_room_height_evidence() -> None:
    spec = non_rectangular_spec()
    spec.observations.extend(
        [
            Observation(
                field="visual_evidence:wall-chain",
                value="异形轮廓尺寸链",
                source=SourceKind.measured,
                asset_id="plan-1",
                bbox=ImageBBox(x_min=10, y_min=10, x_max=400, y_max=900),
                confidence=0.92,
                note="boundary",
            ),
            Observation(
                field="visual_evidence:door-height",
                value="门高 2100",
                source=SourceKind.measured,
                asset_id="plan-1",
                bbox=ImageBBox(x_min=700, y_min=80, x_max=900, y_max=140),
                confidence=0.88,
                note="kind=opening; related_to=door/opening",
            ),
        ]
    )

    measurement = measurement_from_spec(spec, "measurement-1")

    assert measurement.heights.evidence_ids
    assert "door-height" not in measurement.heights.evidence_ids
    assert measurement.heights.evidence_ids[0].startswith("EV")
    audit = {item.id: item for item in measurement.evidence}
    assert audit[measurement.heights.evidence_ids[0]].field == "height_mm"
    assert audit[measurement.heights.evidence_ids[0]].source == SourceKind.user


def test_confirmed_measurement_export_creates_manual_audit_evidence() -> None:
    spec = non_rectangular_spec()
    spec.observations = []
    spec.openings[0].evidence_ids = []
    spec.openings[0].source = SourceKind.user

    measurement = measurement_from_spec(spec, "measurement-1")
    issues, sufficient, missing, _ = validate_measurement(measurement)

    assert sufficient
    assert missing == []
    assert not any(issue.severity == "error" for issue in issues)
    assert all(wall.evidence_ids for wall in measurement.walls)
    assert measurement.openings[0].evidence_ids
    assert measurement.heights.evidence_ids
    audit_sources = {item.id: item.source for item in measurement.evidence}
    assert audit_sources[measurement.walls[0].evidence_ids[0]] == SourceKind.user
    assert audit_sources[measurement.openings[0].evidence_ids[0]] == SourceKind.user
    assert audit_sources[measurement.heights.evidence_ids[0]] == SourceKind.user


def test_measurement_validation_blocks_empty_critical_evidence() -> None:
    measurement = measurement_from_spec(non_rectangular_spec(), "measurement-1")
    for wall in measurement.walls:
        wall.evidence_ids = []
    measurement.openings[0].evidence_ids = []
    measurement.heights.evidence_ids = []

    issues, sufficient, missing, _ = validate_measurement(measurement)

    assert not sufficient
    assert "wall-1.evidence_ids" in missing
    assert "door-1.evidence_ids" in missing
    assert "heights.evidence_ids" in missing
    assert sum(issue.code == "required_evidence_missing" for issue in issues) >= 3


def test_measurement_validation_blocks_estimated_critical_evidence_source() -> None:
    measurement = measurement_from_spec(non_rectangular_spec(), "measurement-1")
    measurement.evidence[0].source = SourceKind.estimated

    issues, sufficient, missing, _ = validate_measurement(measurement)

    assert not sufficient
    assert "evidence.door-width.source" in missing
    assert any(issue.code == "invalid_evidence_source" for issue in issues)


def test_measurement_rejects_broken_wall_chain() -> None:
    measurement = measurement_from_spec(non_rectangular_spec(), "measurement-1")
    measurement.walls[1].end = Point2D(x_mm=1400, z_mm=400)

    issues, sufficient, _, _ = validate_measurement(measurement)

    assert not sufficient
    assert any(issue.code == "wall_chain_gap" for issue in issues)
    assert any(issue.code == "wall_length_mismatch" for issue in issues)


def test_measurement_rejects_diagonal_wall_before_modeling() -> None:
    measurement = measurement_from_spec(non_rectangular_spec(), "measurement-1")
    measurement.walls[0].end.z_mm += 100
    measurement.walls[1].start.z_mm += 100
    measurement.walls[0].length_mm = round(wall_length(measurement.walls[0].start, measurement.walls[0].end))
    measurement.walls[1].length_mm = round(wall_length(measurement.walls[1].start, measurement.walls[1].end))

    issues, sufficient, _, _ = validate_measurement(measurement)

    assert not sufficient
    assert any(issue.code == "non_orthogonal_boundary" for issue in issues)


def test_measurement_rejects_invalid_opening_host_and_outside_anchor() -> None:
    measurement = measurement_from_spec(non_rectangular_spec(), "measurement-1")
    measurement.openings[0].wall_id = "missing-wall"
    measurement.anchors[0].x_mm = 4000

    issues, sufficient, _, _ = validate_measurement(measurement)

    assert not sufficient
    assert any(issue.code == "opening_wall" for issue in issues)
    assert any(issue.code == "anchor_outside" for issue in issues)


def test_measurement_validation_requires_valid_traceable_evidence_ids() -> None:
    measurement = measurement_from_spec(non_rectangular_spec(), "measurement-1")
    measurement.openings[0].evidence_ids = ["missing-evidence"]

    issues, sufficient, missing, _ = validate_measurement(measurement)

    assert not sufficient
    assert "evidence.missing-evidence" in missing
    assert any(issue.code == "missing_evidence_ref" for issue in issues)


def test_measurement_validation_blocks_low_confidence_critical_evidence() -> None:
    measurement = measurement_from_spec(non_rectangular_spec(), "measurement-1")
    measurement.confirmed = False
    measurement.openings[0].status = "provisional"
    measurement.evidence[0].confidence = 0.42
    measurement.evidence[0].status = "unverified"

    issues, sufficient, missing, _ = validate_measurement(measurement)

    assert not sufficient
    assert "evidence.door-width" in missing
    assert any(issue.code == "low_confidence_evidence" for issue in issues)


def test_temporary_visual_substitute_real_plan_output_exports_traceable_measurement() -> None:
    spec = RoomSpec(
        name="真实手绘图临时视觉替代样例",
        boundary=[
            Point2D(x_mm=0, z_mm=0),
            Point2D(x_mm=1840, z_mm=0),
            Point2D(x_mm=1840, z_mm=5530),
            Point2D(x_mm=0, z_mm=5530),
        ],
        height_mm=2100,
        openings=[
            OpeningSpec(
                id="door-1",
                wall_index=3,
                offset_mm=400,
                width_mm=800,
                height_mm=2100,
                label="手绘门洞",
                source=SourceKind.measured,
                confidence=0.86,
                evidence_ids=["door-800x2100"],
            )
        ],
        fixtures=[
            FixtureSpec(
                id="drain-1",
                kind="floor_drain",
                label="右侧地漏",
                x_mm=1540,
                z_mm=1900,
                width_mm=120,
                depth_mm=120,
                height_mm=10,
                source=SourceKind.measured,
                confidence=0.78,
                evidence_ids=["right-drain"],
            ),
            FixtureSpec(
                id="drain-2",
                kind="floor_drain",
                label="下侧地漏",
                x_mm=1450,
                z_mm=5150,
                width_mm=120,
                depth_mm=120,
                height_mm=10,
                source=SourceKind.measured,
                confidence=0.74,
                evidence_ids=["bottom-drain"],
            ),
        ],
        observations=[
            Observation(
                field="visual_evidence:wall-chain-real-plan",
                value="1840 x 5530 主墙体轮廓",
                source=SourceKind.measured,
                asset_id="019f87f8-6b1e-7dd2-857a-60abfe565b31",
                bbox=ImageBBox(x_min=220, y_min=200, x_max=860, y_max=920),
                confidence=0.82,
                confirmed=True,
                note="temporary visual substitute boundary wall 尺寸链",
            ),
            Observation(
                field="visual_evidence:door-800x2100",
                value="800 x 2100",
                source=SourceKind.measured,
                asset_id="019f87f8-6b1e-7dd2-857a-60abfe565b31",
                bbox=ImageBBox(x_min=205, y_min=245, x_max=350, y_max=420),
                confidence=0.86,
                confirmed=True,
                note="temporary visual substitute door opening 门洞",
            ),
            Observation(
                field="visual_evidence:room-height-real-plan",
                value="门高/高度 2100",
                source=SourceKind.measured,
                asset_id="019f87f8-6b1e-7dd2-857a-60abfe565b31",
                bbox=ImageBBox(x_min=735, y_min=385, x_max=835, y_max=560),
                confidence=0.76,
                confirmed=True,
                note="temporary visual substitute height 层高",
            ),
            Observation(
                field="visual_evidence:right-drain",
                value="右侧地漏 300/200/700 定位",
                source=SourceKind.measured,
                asset_id="019f87f8-6b1e-7dd2-857a-60abfe565b31",
                bbox=ImageBBox(x_min=690, y_min=360, x_max=860, y_max=600),
                confidence=0.78,
                confirmed=True,
                note="temporary visual substitute fixture floor drain",
            ),
            Observation(
                field="visual_evidence:bottom-drain",
                value="下侧地漏 400/450 定位",
                source=SourceKind.measured,
                asset_id="019f87f8-6b1e-7dd2-857a-60abfe565b31",
                bbox=ImageBBox(x_min=690, y_min=810, x_max=870, y_max=950),
                confidence=0.74,
                confirmed=True,
                note="temporary visual substitute fixture floor drain",
            ),
        ],
        confirmed=True,
    )

    measurement = measurement_from_spec(spec, "real-plan-temporary-vision")
    issues, sufficient, missing, rebuilt = validate_measurement(measurement)

    assert sufficient
    assert missing == []
    assert not any(issue.severity == "error" for issue in issues)
    assert measurement.source_asset_ids == ["019f87f8-6b1e-7dd2-857a-60abfe565b31"]
    assert all(wall.evidence_ids == ["wall-chain-real-plan"] for wall in measurement.walls)
    assert measurement.openings[0].evidence_ids == ["door-800x2100"]
    assert measurement.heights.evidence_ids != ["room-height-real-plan"]
    assert {item.id: item.field for item in measurement.evidence}[measurement.heights.evidence_ids[0]] == "height_mm"
    assert {anchor.id for anchor in measurement.anchors} == {"drain-1", "drain-2"}
    assert rebuilt is not None
    assert rebuilt.boundary == spec.boundary
    assert rebuilt.openings[0].width_mm == 800


def test_database_migrates_legacy_spec_to_measurement(tmp_path) -> None:
    database = Database(tmp_path)
    tmp_path.mkdir(parents=True, exist_ok=True)
    spec = non_rectangular_spec()
    with sqlite3.connect(database.db_path) as connection:
        connection.execute(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, spec_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
        )
        connection.execute(
            "INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)",
            ("legacy-1", "旧项目", "review", spec.model_dump_json(), "2026-01-01", "2026-01-01"),
        )

    database.initialize()
    project = database.get_project("legacy-1")

    assert project.measurement is not None
    assert len(project.measurement.walls) == 6
    assert project.spec is not None
    assert project.spec.boundary == spec.boundary
