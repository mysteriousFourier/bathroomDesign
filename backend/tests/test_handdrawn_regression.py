import asyncio
import json

from scripts.batch_floorplan_regression import evaluate_spec, run_batch

from backend.app.models import (
    BoundaryEdge,
    ImageBBox,
    Observation,
    PlanAnnotation,
    Point2D,
    RoomSpec,
    SourceKind,
    ShapeCorner,
)


def _rectangle(*, observations=True, confirmed=False) -> RoomSpec:
    return RoomSpec(
        boundary=[
            Point2D(x_mm=0, z_mm=0),
            Point2D(x_mm=3000, z_mm=0),
            Point2D(x_mm=3000, z_mm=2000),
            Point2D(x_mm=0, z_mm=2000),
        ],
        observations=(
            [Observation(
                field="ocr:width", value="3000", source=SourceKind.measured,
                bbox=ImageBBox(x_min=100, y_min=100, x_max=140, y_max=120),
            )]
            if observations else []
        ),
        plan_annotation=PlanAnnotation(
            boundary=[ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100), ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900)],
            edge_chain=[
                BoundaryEdge(direction="right", length_mm=3000),
                BoundaryEdge(direction="down", length_mm=2000),
                BoundaryEdge(direction="left", length_mm=3000),
                BoundaryEdge(direction="up", length_mm=2000),
            ],
            confirmed=confirmed,
        ),
    )


def test_evaluate_spec_requires_bbox_backed_values_and_visible_evidence() -> None:
    result = evaluate_spec(_rectangle(), {"required_values": ["3000"]})
    assert result["passed"] is True
    assert result["evidence_visible"] is True
    assert result["all_recalled_values_bbox_backed"] is True

    empty = evaluate_spec(_rectangle(observations=False), {"required_values": ["3000"]})
    assert empty["passed"] is False
    assert "observations 为空" in empty["failure_reasons"]


def test_evaluate_spec_accepts_six_corner_topology_and_reports_unconfirmed_contour() -> None:
    spec = _rectangle()
    spec.boundary = [
        Point2D(x_mm=0, z_mm=0),
        Point2D(x_mm=3000, z_mm=0),
        Point2D(x_mm=3000, z_mm=2000),
        Point2D(x_mm=1800, z_mm=2000),
        Point2D(x_mm=1800, z_mm=1600),
        Point2D(x_mm=0, z_mm=1600),
    ]
    spec.plan_annotation.boundary = [
        ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100), ShapeCorner(x=900, y=900),
        ShapeCorner(x=600, y=900), ShapeCorner(x=600, y=700), ShapeCorner(x=100, y=700),
    ]
    spec.plan_annotation.edge_chain = [
        BoundaryEdge(direction="right", length_mm=3000),
        BoundaryEdge(direction="down", length_mm=2000),
        BoundaryEdge(direction="left", length_mm=1200),
        BoundaryEdge(direction="up", length_mm=400, role="structure_return"),
        BoundaryEdge(direction="left", length_mm=1800),
        BoundaryEdge(direction="up", length_mm=1600),
    ]
    result = evaluate_spec(spec, {"expected_topology": {"corner_count": 6, "short_returns": 1}})
    assert result["geometry"]["corner_count"] == 6
    assert result["geometry"]["short_returns"] == 1
    assert result["passed"] is True


def test_run_batch_writes_failure_json_for_missing_images(tmp_path) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"images": {"test5.jpg": {}}}), encoding="utf-8")
    output = tmp_path / "out"

    summary = asyncio.run(run_batch(manifest, output_dir=output))

    assert summary["passed_any"] is False
    assert summary["evidence_visible_all"] is False
    image_result = json.loads((output / "test5.json").read_text(encoding="utf-8"))
    assert image_result["result"]["evidence_visible"] is False
    assert (output / "summary.json").exists()
