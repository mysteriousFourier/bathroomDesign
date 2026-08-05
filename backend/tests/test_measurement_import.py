from __future__ import annotations

from io import StringIO

import ezdxf
import pytest

from backend.app.measurement import measurement_contract_export, measurement_from_spec, validate_measurement
from backend.app.measurement_import import (
    MeasurementImportError,
    import_measurement_file,
    inspect_measurement_file,
)
from backend.app.models import FixtureSpec
from backend.tests.test_measurement import non_rectangular_spec


SVG_PLAN = b"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4000 3000">
  <path id="room-boundary" d="M 0 0 H 4000 V 3000 H 0 Z"/>
  <circle id="floor-drain" cx="2000" cy="1500" r="50"/>
  <rect id="door" x="0" y="1100" width="40" height="800"/>
</svg>"""


def dxf_plan() -> bytes:
    document = ezdxf.new("R2010", setup=True)
    document.units = ezdxf.units.MM
    document.layers.add("A-WALL")
    document.layers.add("FLOOR-DRAIN")
    modelspace = document.modelspace()
    modelspace.add_lwpolyline([(0, 0), (4000, 0), (4000, 3000), (0, 3000)], close=True, dxfattribs={"layer": "A-WALL"})
    modelspace.add_circle((2000, 1500), 50, dxfattribs={"layer": "FLOOR-DRAIN"})
    stream = StringIO()
    document.write(stream)
    return stream.getvalue().encode(document.output_encoding)


def test_svg_inspection_and_import_preserve_boundary_point_type_and_position() -> None:
    inspection = inspect_measurement_file(SVG_PLAN, "bathroom.svg")
    assert inspection["format"] == "svg"
    assert inspection["can_import"] is True
    assert inspection["unit_required"] is True
    assert any(layer["boundary_candidates"] for layer in inspection["layers"])

    imported = import_measurement_file(SVG_PLAN, "bathroom.svg", unit="mm", height_mm=2700)

    assert [(point.x_mm, point.z_mm) for point in imported.spec.boundary] == [(0, 0), (4000, 0), (4000, 3000), (0, 3000)]
    assert imported.spec.height_mm == 2700
    assert imported.spec.fixtures[0].kind == "floor_drain"
    assert (imported.spec.fixtures[0].x_mm, imported.spec.fixtures[0].z_mm) == (2000, 1500)
    assert imported.spec.openings[0].kind == "door"
    assert imported.spec.confirmed is False
    assert any(item.field == "visual_evidence:import-boundary" for item in imported.spec.observations)


def test_dxf_declared_unit_layer_and_point_marker_are_imported() -> None:
    content = dxf_plan()
    inspection = inspect_measurement_file(content, "bathroom.dxf")

    assert inspection["detected_unit"] == "mm"
    assert {layer["name"] for layer in inspection["layers"]} >= {"A-WALL", "FLOOR-DRAIN"}

    imported = import_measurement_file(content, "bathroom.dxf", unit="auto", layer="A-WALL")

    assert imported.source_unit == "mm"
    assert imported.selected_layer == "A-WALL"
    assert max(point.x_mm for point in imported.spec.boundary) == 4000
    assert imported.spec.fixtures[0].kind == "floor_drain"


def test_exported_measurement_contract_can_be_reimported_with_points() -> None:
    source = non_rectangular_spec()
    measurement = measurement_from_spec(source, "measurement-import")
    exported = measurement_contract_export(measurement)
    content = __import__("json").dumps(exported, ensure_ascii=False).encode("utf-8")

    imported = import_measurement_file(content, "measurement.json")

    assert imported.source_format == "measurement-contract-json"
    assert imported.spec.boundary == source.boundary
    assert any(item.kind == "floor_drain" and item.x_mm == 1500 and item.z_mm == 1200 for item in imported.spec.fixtures)
    round_trip = measurement_from_spec(imported.spec, "round-trip")
    issues, _, missing, _ = validate_measurement(round_trip)
    assert not any(item.code == "required_evidence_missing" for item in issues)
    assert "heights.evidence_ids" not in missing


def test_exported_contract_round_trip_preserves_every_point_kind_and_attributes() -> None:
    source = non_rectangular_spec()
    kinds = [
        "toilet", "vanity", "shower", "floor_drain", "drain", "water",
        "electric", "pipe", "column", "radiator", "other",
    ]
    usages = {
        "floor_drain": "shower",
        "drain": "toilet",
        "water": "basin",
    }
    source.fixtures = [
        FixtureSpec(
            id=f"point-{kind}", kind=kind, label=f"测试-{kind}",
            x_mm=100 + index * 100, z_mm=200 + index * 100,
            width_mm=31 + index, depth_mm=41 + index, height_mm=51 + index,
            rotation_deg=index * 7, point_usage=usages.get(kind),
            source="user", confidence=1,
        )
        for index, kind in enumerate(kinds)
    ]
    measurement = measurement_from_spec(source, "all-point-kinds")
    exported = measurement_contract_export(measurement)

    assert exported["schemaVersion"] == "1.1.0"
    assert [item["kind"] for item in exported["measurementPoints"]] == kinds

    imported = import_measurement_file(
        __import__("json").dumps(exported, ensure_ascii=False).encode("utf-8"),
        "measurement.json",
    )
    actual = {item.kind: item for item in imported.spec.fixtures}
    assert set(actual) == set(kinds)
    for expected in source.fixtures:
        item = actual[expected.kind]
        assert item.id == expected.id
        assert item.label == expected.label
        assert item.point_usage == expected.point_usage
        assert (item.x_mm, item.z_mm) == (expected.x_mm, expected.z_mm)
        assert (item.width_mm, item.depth_mm, item.height_mm) == (
            expected.width_mm, expected.depth_mm, expected.height_mm,
        )
        assert item.rotation_deg == expected.rotation_deg


def test_geojson_requires_explicit_unit_and_normalizes_origin() -> None:
    content = b'{"type":"Polygon","coordinates":[[[10,20],[14,20],[14,23],[10,23],[10,20]]]}'
    with pytest.raises(MeasurementImportError, match="\u9009\u62e9\u6beb\u7c73"):
        import_measurement_file(content, "room.geojson", unit="auto")

    imported = import_measurement_file(content, "room.geojson", unit="m")
    assert max(point.x_mm for point in imported.spec.boundary) == 4000
    assert max(point.z_mm for point in imported.spec.boundary) == 3000


def test_dwg_inspection_is_actionable_without_converter(monkeypatch) -> None:
    monkeypatch.setattr("backend.app.measurement_import.dwg_converter_available", lambda: False)
    inspection = inspect_measurement_file(b"AC1032", "room.dwg")
    assert inspection["can_import"] is False
    assert "DXF" in inspection["warnings"][0]


def test_json_array_is_rejected_as_an_actionable_import_error() -> None:
    with pytest.raises(MeasurementImportError, match="顶层必须是对象"):
        inspect_measurement_file(b"[]", "measurement.json")
