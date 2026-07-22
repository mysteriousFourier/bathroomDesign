from __future__ import annotations

import sqlite3

from backend.app.database import Database
from backend.app.measurement import measurement_from_spec, room_spec_from_measurement, validate_measurement
from backend.app.models import (
    FixtureSpec,
    ImageBBox,
    Observation,
    OpeningSpec,
    Point2D,
    RoomSpec,
    SourceKind,
)


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
                evidence_ids=["door-width"], source=SourceKind.measured, confidence=0.9,
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
    assert measurement.openings[0].evidence_ids == ["door-width"]
    assert measurement.evidence[0].bbox == ImageBBox(x_min=100, y_min=700, x_max=180, y_max=760)
    assert measurement.source_asset_ids == ["plan-1"]
    assert rebuilt is not None
    assert rebuilt.boundary == source.boundary
    assert rebuilt.openings[0].wall_index == 4
    assert rebuilt.fixtures[0].evidence_ids == ["drain-point"]
    assert room_spec_from_measurement(measurement).confirmed


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


def test_measurement_rejects_broken_wall_chain() -> None:
    measurement = measurement_from_spec(non_rectangular_spec(), "measurement-1")
    measurement.walls[1].end = Point2D(x_mm=1400, z_mm=400)

    issues, sufficient, _, _ = validate_measurement(measurement)

    assert not sufficient
    assert any(issue.code == "wall_chain_gap" for issue in issues)
    assert any(issue.code == "wall_length_mismatch" for issue in issues)


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
