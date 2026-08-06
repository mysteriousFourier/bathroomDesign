import json

import pytest
import httpx
import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw

from backend.app import ai
from backend.app.config import settings
from backend.app.models import (
    BoundaryChainResult,
    BoundaryChainSegment,
    BoundaryEdge,
    BoundaryReturn,
    CriticalDimensionRoles,
    DimensionEvidenceRef,
    EvidenceItem,
    FixtureCandidate,
    ImageBBox,
    OpeningCandidate,
    OpeningSpec,
    PlanEvidenceReport,
    PlanExtraction,
    Point2D,
    RoomSpec,
    ShapeCorner,
    ShapeTraceResult,
    SourceKind,
    TopologyCandidate,
    TopologyCandidateSelection,
    VisualEvidence,
)


def valid_spec() -> RoomSpec:
    return RoomSpec(
        boundary=[Point2D(x_mm=0, z_mm=0), Point2D(x_mm=1800, z_mm=0), Point2D(x_mm=1800, z_mm=2400)],
        height_mm=2600,
    )


def test_agen17_real_sample_metadata_uses_external_retention() -> None:
    sample_dir = Path(__file__).resolve().parents[2] / "evidence" / "samples" / "real" / "agen-17-long-term"
    manifest_path = sample_dir / "manifest.json"

    assert manifest_path.exists()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["repository_retention"] == "external_not_tracked"
    assert "image_path" not in manifest
    assert manifest["sha256"] == "ff42c622b61edf6ce3455a579e291ba989f68d36193040554cf243669fcdd602"
    assert manifest["oriented_dimensions"] == {"width_px": 3024, "height_px": 4032}


@pytest.mark.asyncio
async def test_read_model_failure_does_not_switch_models(monkeypatch) -> None:
    monkeypatch.setattr(settings, "openai_base_url", "https://example.test/v1")
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    monkeypatch.setattr(settings, "read_model", "vision-primary")
    calls: list[str] = []

    async def fake_chat_once(_client, _endpoint, _headers, _content, model):
        calls.append(model)
        raise ai.AIResponseError("读图模型不可用")

    monkeypatch.setattr(ai, "_chat_once", fake_chat_once)
    with pytest.raises(ai.AIResponseError):
        await ai._chat([])
    assert calls == ["vision-primary"]


@pytest.mark.asyncio
async def test_auth_failure_does_not_retry_read_model(monkeypatch) -> None:
    monkeypatch.setattr(settings, "openai_base_url", "https://example.test/v1")
    monkeypatch.setattr(settings, "openai_api_key", "bad-key")
    monkeypatch.setattr(settings, "read_model", "vision-primary")
    calls: list[str] = []

    async def fake_chat_once(_client, _endpoint, _headers, _content, model):
        calls.append(model)
        raise ai.AIAuthenticationError("鉴权失败")

    monkeypatch.setattr(ai, "_chat_once", fake_chat_once)
    with pytest.raises(ai.AIAuthenticationError):
        await ai._chat([])
    assert calls == ["vision-primary"]


def test_plan_extraction_builds_rectangle_and_keeps_evidence() -> None:
    extraction = PlanExtraction(
        overall_width_mm=2855,
        overall_depth_mm=1840,
        height_mm=2100,
        evidence=[EvidenceItem(text="底边 2855", meaning="总长", confidence=0.9)],
        fixtures=[FixtureCandidate(kind="floor_drain", label="地漏", x_mm=None, z_mm=300, confidence=0.7)],
    )
    spec = ai._extraction_to_spec(extraction, "底边 2855；两侧 1840；吊顶 2.100")
    assert [(point.x_mm, point.z_mm) for point in spec.boundary] == [(0, 1840), (2855, 1840), (2855, 0), (0, 0)]
    assert spec.height_mm == 2100
    assert spec.fixtures == []
    assert any("缺少完整二维定位" in issue.message for issue in spec.issues)
    assert any(observation.value == "底边 2855" for observation in spec.observations)


def visual_report() -> PlanEvidenceReport:
    return PlanEvidenceReport(
        rotation_degrees=90,
        evidence=[
            VisualEvidence(id="wall-x", kind="dimension", text="2855", bbox=ImageBBox(x_min=300, y_min=800, x_max=410, y_max=850), related_to="底部总墙长", confidence=0.95),
            VisualEvidence(id="wall-z", kind="dimension", text="1840", bbox=ImageBBox(x_min=100, y_min=350, x_max=160, y_max=460), orientation="vertical", related_to="两侧总深度", confidence=0.95),
            VisualEvidence(id="height", kind="height", text="吊顶 2.100m", bbox=ImageBBox(x_min=720, y_min=100, x_max=900, y_max=160), related_to="吊顶高度", confidence=0.9),
            VisualEvidence(id="door-width", kind="opening", text="门宽 800", bbox=ImageBBox(x_min=500, y_min=700, x_max=610, y_max=750), related_to="门洞宽度", confidence=0.9),
            VisualEvidence(id="door-height", kind="opening", text="门高 2050", bbox=ImageBBox(x_min=620, y_min=700, x_max=750, y_max=750), related_to="门洞高度", confidence=0.85),
        ],
    )


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"x": 10, "y": 20, "width": 30, "height": 40}, (10, 20, 40, 60)),
        ({"minx": 10, "miny": 20, "maxx": 40, "maxy": 60}, (10, 20, 40, 60)),
        ({"min_x": 10, "min_y": 20, "max_x": 40, "max_y": 1030}, (10, 20, 40, 1000)),
    ],
)
def test_bbox_accepts_common_model_formats(payload, expected) -> None:
    bbox = ImageBBox.model_validate(payload)
    assert (bbox.x_min, bbox.y_min, bbox.x_max, bbox.y_max) == expected


def test_cg_ck_ch_opening_row_is_classified_as_opening_size() -> None:
    tokens = [{
        "id": "opening-row",
        "raw_text": "W1 CG900 CK1200 CH900",
        "bbox": {"x_min": 700, "y_min": 100, "x_max": 950, "y_max": 150},
        "confidence": 0.94,
    }]

    ai._classify_ocr_tokens(tokens, infer_room_extents=False)

    assert tokens[0]["semantic_role"] == "door_size"


def test_point_marker_center_maps_to_closed_metric_boundary() -> None:
    marker = VisualEvidence(
        id="marker-1",
        kind="fixture",
        text="地漏",
        bbox=ImageBBox(x_min=480, y_min=480, x_max=520, y_max=520),
        confidence=0.91,
    )
    annotation = [
        ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
        ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
    ]
    boundary = [
        Point2D(x_mm=0, z_mm=0), Point2D(x_mm=3000, z_mm=0),
        Point2D(x_mm=3000, z_mm=2000), Point2D(x_mm=0, z_mm=2000),
    ]

    position = ai._point_marker_position(marker, annotation, boundary)

    assert position == Point2D(x_mm=1500, z_mm=1000)


def test_point_marker_outside_drawn_room_is_rejected() -> None:
    marker = VisualEvidence(
        id="legend-symbol",
        kind="fixture",
        text="地漏",
        bbox=ImageBBox(x_min=920, y_min=480, x_max=960, y_max=520),
        confidence=0.95,
    )
    annotation = [
        ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
        ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
    ]
    boundary = [
        Point2D(x_mm=0, z_mm=0), Point2D(x_mm=3000, z_mm=0),
        Point2D(x_mm=3000, z_mm=2000), Point2D(x_mm=0, z_mm=2000),
    ]

    assert ai._point_marker_position(marker, annotation, boundary) is None


def test_provisional_spec_adds_derived_fixture_from_point_marker() -> None:
    shape = ShapeTraceResult(
        corners=[
            ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
            ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
        ],
        closed=True,
    )
    edges = [
        BoundaryEdge(direction="right", length_mm=3000),
        BoundaryEdge(direction="down", length_mm=2000),
        BoundaryEdge(direction="left", length_mm=3000),
        BoundaryEdge(direction="up", length_mm=2000),
    ]
    marker = VisualEvidence(
        id="marker-1",
        kind="fixture",
        text="地漏",
        bbox=ImageBBox(x_min=480, y_min=480, x_max=520, y_max=520),
        confidence=0.91,
    )

    spec = ai._provisional_room_spec(
        shape,
        {"tokens": [], "rotation_degrees": 0},
        edge_chain=edges,
        point_markers=[marker],
    )

    assert spec is not None
    assert len(spec.fixtures) == 1
    assert spec.fixtures[0].kind == "floor_drain"
    assert spec.fixtures[0].source.value == "derived"
    assert (spec.fixtures[0].x_mm, spec.fixtures[0].z_mm) == (1500, 1000)
    assert spec.fixtures[0].evidence_ids == ["point-marker-1"]


def test_incomplete_annotation_keeps_point_marker_as_editable_fixture() -> None:
    shape = ShapeTraceResult(
        corners=[
            ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
            ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
        ],
        closed=True,
    )
    edges = [
        BoundaryEdge(direction="right", length_mm=3000),
        BoundaryEdge(direction="down", length_mm=None),
        BoundaryEdge(direction="left", length_mm=3000),
        BoundaryEdge(direction="up", length_mm=None),
    ]
    marker = VisualEvidence(
        id="marker-1",
        kind="fixture",
        text="地漏",
        bbox=ImageBBox(x_min=480, y_min=480, x_max=520, y_max=520),
        confidence=0.91,
    )

    spec = ai._provisional_room_spec(
        shape,
        {"tokens": [], "rotation_degrees": 0},
        edge_chain=edges,
        point_markers=[marker],
        allow_incomplete_annotation=True,
    )

    assert spec is not None
    assert spec.boundary == []
    assert len(spec.fixtures) == 1
    assert spec.fixtures[0].source.value == "estimated"
    assert (spec.fixtures[0].x_mm, spec.fixtures[0].z_mm) == (500, 500)
    assert spec.fixtures[0].confidence == pytest.approx(0.65)
    assert spec.observations[-1].field == "visual_evidence:point-marker-1"
    assert spec.observations[-1].review_required is True


def test_bbox_accepts_provider_array_and_reversed_x() -> None:
    bbox = ImageBBox.model_validate([725, 15, 717, 620])
    assert (bbox.x_min, bbox.y_min, bbox.x_max, bbox.y_max) == (717, 15, 725, 620)


def test_visual_evidence_accepts_numeric_provider_id() -> None:
    item = VisualEvidence.model_validate(
        {
            "id": 7,
            "kind": "dimension",
            "text": "800",
            "bbox": {"x": 10, "y": 20, "width": 30, "height": 40},
        }
    )
    assert item.id == "7"


def test_visual_evidence_normalizes_nullable_metadata() -> None:
    item = VisualEvidence.model_validate(
        {
            "id": 7, "kind": "wall", "text": "墙线",
            "bbox": [10, 20, 40, 60], "related_to": None, "view_id": 1,
        }
    )
    assert item.related_to == ""
    assert item.view_id == "1"


def test_extract_json_accepts_duplicate_provider_objects() -> None:
    assert ai._extract_json('{"complete":false}</think>{"complete":true}') == {"complete": False}


def test_plan_extraction_discards_truncated_supporting_evidence() -> None:
    extraction = PlanExtraction.model_validate(
        {"overall_width_mm": 1800, "evidence": [{"evidence_id": "ok", "text": "1800"}, {"evidence_id": "cut"}]}
    )
    assert len(extraction.evidence) == 1


def test_glm_46_structured_requests_disable_thinking() -> None:
    assert ai._thinking_payload("glm-4.6v-flash") == {"thinking": {"type": "disabled"}}
    assert ai._thinking_payload("glm-4v-flash") == {}


def test_visual_recognition_uses_only_read_model(monkeypatch) -> None:
    monkeypatch.setattr(settings, "read_model", "vision-primary")

    assert ai._vision_recognition_models() == ["vision-primary"]
    assert ai._template_evidence_models() == ["vision-primary"]


def test_template_evidence_merges_dimensions_height_and_points_without_geometry() -> None:
    assist = {"tokens": [], "image_hash": "sample"}
    report = PlanEvidenceReport(evidence=[
        VisualEvidence(
            id="T1", kind="dimension", text="1640",
            bbox=ImageBBox(x_min=200, y_min=200, x_max=250, y_max=230),
            related_to="dimension_chain:top", confidence=0.95,
        ),
        VisualEvidence(
            id="T2", kind="height", text="整屋吊顶 2100",
            bbox=ImageBBox(x_min=760, y_min=340, x_max=860, y_max=380),
            related_to="overall_ceiling", confidence=0.94,
        ),
        VisualEvidence(
            id="T3", kind="fixture", text="地漏",
            bbox=ImageBBox(x_min=400, y_min=400, x_max=430, y_max=430),
            related_to="point", confidence=0.9,
        ),
        VisualEvidence(
            id="T4", kind="fixture", text="地漏",
            bbox=ImageBBox(x_min=760, y_min=400, x_max=790, y_max=430),
            related_to="point", confidence=0.9,
        ),
    ])

    points = ai._merge_template_evidence(assist, report)

    assert [token["raw_text"] for token in assist["tokens"]] == ["1640", "整屋吊顶 2100"]
    assert assist["tokens"][0]["semantic_role"] == "wall_segment"
    assert assist["tokens"][0]["target_id"] is None
    assert ai._ocr_room_height_hint(assist) is None
    assert ai._ocr_ceiling_height_hint(assist) == (2100, "TV002", 0.94)
    assert [point.text for point in points] == ["地漏"]

    ai._merge_template_evidence(assist, report)
    assert [token["id"] for token in assist["tokens"]] == ["TV001", "TV002"]


def test_segment_edge_validation_accepts_a_continuous_additive_dimension_chain() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
        ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
    ], closed=True)
    assist = {"tokens": [
        {"id": "T1", "raw_text": "400", "bbox": [100, 900, 250, 940], "template_visual": True, "related_to": "dimension_chain:bottom"},
        {"id": "T2", "raw_text": "800", "bbox": [250, 900, 650, 940], "template_visual": True, "related_to": "dimension_chain:bottom"},
        {"id": "T3", "raw_text": "55", "bbox": [650, 900, 700, 940], "template_visual": True, "related_to": "dimension_chain:bottom"},
    ]}
    raw_edges = [
        BoundaryEdge(direction="right", length_mm=1255, evidence_ids=["T1", "T2", "T3"]),
        BoundaryEdge(direction="down", length_mm=None),
        BoundaryEdge(direction="left", length_mm=None),
        BoundaryEdge(direction="up", length_mm=None),
    ]

    validated = ai._validated_segment_edge_chain(raw_edges, shape, assist)

    assert validated[0].length_mm == 1255
    assert validated[0].evidence_ids == ["T1", "T2", "T3"]


def test_template_dimension_chain_uses_adjacent_wall_not_drawing_scale() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=100, y=100), ShapeCorner(x=100, y=820),
        ShapeCorner(x=300, y=820), ShapeCorner(x=300, y=760),
        ShapeCorner(x=620, y=760), ShapeCorner(x=620, y=100),
    ], closed=True)
    assist = {"tokens": [
        {
            "id": "T1", "raw_text": "400", "bbox": {"x_min": 115, "y_min": 790, "x_max": 150, "y_max": 825},
            "template_visual": True, "semantic_role": "wall_segment", "related_to": "dimension_chain:bottom",
            "confidence": 0.93,
        },
        {
            "id": "T2", "raw_text": "800", "bbox": {"x_min": 185, "y_min": 790, "x_max": 235, "y_max": 825},
            "template_visual": True, "semantic_role": "wall_segment", "related_to": "dimension_chain:bottom",
            "confidence": 0.93,
        },
        {
            "id": "T3", "raw_text": "55", "bbox": {"x_min": 270, "y_min": 790, "x_max": 295, "y_max": 825},
            "template_visual": True, "semantic_role": "wall_segment", "related_to": "dimension_chain:bottom",
            "confidence": 0.93,
        },
    ]}

    edges = ai._template_adjacent_dimension_edge_chain(shape, assist)
    estimated_boundary, estimated_edges = ai._estimated_metric_geometry_from_shape(shape, assist)

    assert edges[1].length_mm == 1255
    assert edges[1].evidence_ids == ["T1", "T2", "T3"]
    assert edges[0].length_mm is None
    assert estimated_boundary == []
    assert estimated_edges == []


def test_template_dimension_evidence_on_wrong_wall_is_rejected_by_location() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
        ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
    ], closed=True)
    assist = {"tokens": [
        {
            "id": "T1", "raw_text": "800", "bbox": {"x_min": 420, "y_min": 875, "x_max": 470, "y_max": 915},
            "template_visual": True, "semantic_role": "wall_segment", "related_to": "dimension_chain:bottom",
            "confidence": 0.95,
        },
    ]}
    raw_edges = [
        BoundaryEdge(direction="right", length_mm=800, evidence_ids=["T1"], confidence=0.95),
        BoundaryEdge(direction="down"),
        BoundaryEdge(direction="left"),
        BoundaryEdge(direction="up"),
    ]

    validated = ai._validated_segment_edge_chain(raw_edges, shape, assist)

    assert validated[0].length_mm is None
    assert validated[0].evidence_ids == []


def test_complete_opening_row_uses_the_cited_dimension_chain_for_wall_and_offset() -> None:
    assist = {"tokens": [
        {"id": "T1", "raw_text": "400", "bbox": [100, 900, 250, 940]},
        {"id": "T2", "raw_text": "800", "bbox": [250, 900, 650, 940]},
        {"id": "T3", "raw_text": "55", "bbox": [650, 900, 700, 940]},
        {"id": "D1", "raw_text": "D1 CG 0 CK 800 CH 2055", "bbox": [730, 200, 950, 250], "confidence": 0.95},
    ]}
    edges = [BoundaryEdge(direction="right", length_mm=1255, evidence_ids=["T1", "T2", "T3"])]

    openings = ai._opening_specs_from_tokens(assist, edges)

    assert len(openings) == 1
    assert openings[0].wall_index == 0
    assert openings[0].offset_mm == 400
    assert openings[0].width_mm == 800
    assert openings[0].height_mm == 2055
    assert openings[0].sill_mm == 0
    assert openings[0].thickness_mm == 100


def test_opening_table_row_without_field_labels_uses_template_column_order() -> None:
    assist = {"tokens": [
        {"id": "T1", "raw_text": "400", "bbox": [100, 900, 250, 940]},
        {"id": "T2", "raw_text": "800", "bbox": [250, 900, 650, 940]},
        {"id": "T3", "raw_text": "55", "bbox": [650, 900, 700, 940]},
        {"id": "D1", "raw_text": "D1 0 800 2055", "bbox": [730, 200, 950, 250], "confidence": 0.95},
    ]}
    edges = [BoundaryEdge(direction="right", length_mm=1255, evidence_ids=["T1", "T2", "T3"])]

    openings = ai._opening_specs_from_tokens(assist, edges)

    assert len(openings) == 1
    assert openings[0].label == "D1"
    assert openings[0].offset_mm == 400
    assert openings[0].width_mm == 800
    assert openings[0].height_mm == 2055


def test_opening_row_ck_misread_can_use_middle_dimension_chain_segment() -> None:
    assist = {"tokens": [
        {"id": "T0", "raw_text": "327", "bbox": [40, 890, 90, 930], "template_visual": True, "semantic_role": "wall_segment"},
        {"id": "T1", "raw_text": "400", "bbox": [100, 900, 250, 940], "template_visual": True, "semantic_role": "wall_segment"},
        {"id": "T2", "raw_text": "800", "bbox": [250, 900, 650, 940], "template_visual": True, "semantic_role": "wall_segment"},
        {"id": "T3", "raw_text": "55", "bbox": [650, 900, 700, 940], "template_visual": True, "semantic_role": "wall_segment"},
        {"id": "D1", "raw_text": "D1 CG 0 CK 300 CH 2055", "bbox": [0, 0, 1000, 1000], "confidence": 0.55},
    ], "shape_trace": ShapeTraceResult(corners=[
        ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
        ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
    ], closed=True)}
    edges = [
        BoundaryEdge(direction="right", length_mm=1255),
        BoundaryEdge(direction="down", length_mm=1800),
        BoundaryEdge(direction="left", length_mm=1255),
        BoundaryEdge(direction="up", length_mm=1800),
    ]

    openings = ai._opening_specs_from_tokens(assist, edges)

    assert len(openings) == 1
    assert openings[0].wall_index == 2
    assert openings[0].offset_mm == 400
    assert openings[0].width_mm == 800
    assert openings[0].height_mm == 2055
    assert openings[0].evidence_ids == ["D1", "T1", "T2", "T3"]


def test_opening_chain_survives_misclassified_template_tokens() -> None:
    assist = {"tokens": [
        {
            "id": "T1", "raw_text": "400", "bbox": [100, 900, 250, 940],
            "template_visual": True, "semantic_role": "drain_position",
            "view_id": "strip-bottom-door", "related_to": "dimension_chain:bottom",
        },
        {
            "id": "T2", "raw_text": "800", "bbox": [250, 900, 650, 940],
            "template_visual": True, "semantic_role": "door_size",
            "view_id": "strip-bottom-door", "related_to": "dimension_chain:bottom",
        },
        {
            "id": "T3", "raw_text": "55", "bbox": [650, 900, 700, 940],
            "template_visual": True, "semantic_role": "drain_position",
            "view_id": "strip-bottom-door", "related_to": "dimension_chain:bottom",
        },
        {"id": "D1", "raw_text": "D1 CG 0 CK 300 CH 2055", "bbox": [0, 0, 1000, 1000], "confidence": 0.55},
    ], "shape_trace": ShapeTraceResult(corners=[
        ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
        ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
    ], closed=True)}
    edges = [
        BoundaryEdge(direction="right", length_mm=1255),
        BoundaryEdge(direction="down", length_mm=1800),
        BoundaryEdge(direction="left", length_mm=1255),
        BoundaryEdge(direction="up", length_mm=1800),
    ]

    openings = ai._opening_specs_from_tokens(assist, edges)

    assert len(openings) == 1
    assert openings[0].width_mm == 800
    assert openings[0].offset_mm == 400
    assert openings[0].evidence_ids == ["D1", "T1", "T2", "T3"]


def test_complete_opening_row_with_wall_target_creates_reviewable_opening() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
        ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
    ], closed=True)
    assist = {"tokens": [{
        "id": "D1", "raw_text": "D1 CG 0 CK 800 CH 2055",
        "bbox": [730, 200, 950, 250], "confidence": 0.99,
        "semantic_role": "door_size", "target_id": "wall:0@0.2:0.6",
    }]}
    edges = [
        BoundaryEdge(direction="right", length_mm=1255, evidence_ids=["unrelated"]),
        BoundaryEdge(direction="down", length_mm=1800),
        BoundaryEdge(direction="left", length_mm=1255),
        BoundaryEdge(direction="up", length_mm=1800),
    ]

    spec = ai._provisional_room_spec(shape, assist, edge_chain=edges)

    assert spec is not None
    assert len(spec.openings) == 1
    assert spec.openings[0].wall_index == 0
    assert spec.openings[0].offset_mm == 251
    assert spec.openings[0].width_mm == 800
    row = next(item for item in spec.observations if item.field == "ocr:D1")
    assert row.semantic_role == "door_size"
    assert row.review_required is False


def test_incomplete_segment_chain_does_not_invent_metric_shape_from_drawing_scale() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=157, y=395), ShapeCorner(x=157, y=723),
        ShapeCorner(x=312, y=723), ShapeCorner(x=312, y=677),
        ShapeCorner(x=605, y=677), ShapeCorner(x=605, y=340),
        ShapeCorner(x=419, y=340), ShapeCorner(x=419, y=419),
        ShapeCorner(x=350, y=419), ShapeCorner(x=350, y=343),
        ShapeCorner(x=196, y=343), ShapeCorner(x=196, y=395),
    ], closed=True)
    tokens = [
        {"id": "TV001", "raw_text": "4110", "bbox": [320, 636, 364, 664], "confidence": 0.5, "template_visual": True, "semantic_role": "wall_segment"},
        {"id": "TV002", "raw_text": "2855", "bbox": [400, 860, 468, 888], "confidence": 0.5, "template_visual": True, "semantic_role": "wall_segment"},
        {"id": "TV003", "raw_text": "400", "bbox": [80, 776, 120, 832], "confidence": 0.5, "template_visual": True, "semantic_role": "wall_segment"},
        {"id": "TV004", "raw_text": "800", "bbox": [200, 776, 240, 832], "confidence": 0.5, "template_visual": True, "semantic_role": "wall_segment"},
        {"id": "TV005", "raw_text": "55", "bbox": [300, 776, 312, 832], "confidence": 0.5, "template_visual": True, "semantic_role": "wall_segment"},
        {"id": "TV006", "raw_text": "D1 CG 0 CK 800 CH 2055", "bbox": [700, 120, 820, 180], "confidence": 0.8, "template_visual": True, "semantic_role": "door_size"},
    ]
    edges = [
        BoundaryEdge(direction=direction, length_mm=None)
        for direction in ["down", "right", "up", "right", "up", "left", "down", "left", "up", "left", "down", "left"]
    ]

    spec = ai._provisional_room_spec(
        shape,
        {"tokens": tokens, "rotation_degrees": 0},
        edge_chain=edges,
        allow_incomplete_annotation=True,
    )

    assert spec is not None
    assert spec.boundary == []
    assert all(edge.length_mm is None for edge in spec.plan_annotation.edge_chain)
    assert spec.openings == []
    assert any("逐段尺寸尚未闭合" in issue.message for issue in spec.issues)


def test_template_dimension_with_whole_strip_bbox_is_not_bound_to_wall() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=157, y=395), ShapeCorner(x=157, y=723),
        ShapeCorner(x=312, y=723), ShapeCorner(x=312, y=677),
        ShapeCorner(x=605, y=677), ShapeCorner(x=605, y=340),
        ShapeCorner(x=419, y=340), ShapeCorner(x=419, y=419),
        ShapeCorner(x=350, y=419), ShapeCorner(x=350, y=343),
        ShapeCorner(x=196, y=343), ShapeCorner(x=196, y=395),
    ], closed=True)
    edges = ai._template_adjacent_dimension_edge_chain(shape, {"tokens": [
        {
            "id": "TV001",
            "raw_text": "4105",
            "bbox": [330, 240, 470, 340],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "bbox_quality": "whole_strip",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:top",
        },
        {
            "id": "TV002",
            "raw_text": "800",
            "bbox": [200, 888, 240, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
    ]})

    assert all("TV001" not in edge.evidence_ids for edge in edges)
    assert any(edge.length_mm == 800 and edge.evidence_ids == ["TV002"] for edge in edges)


def test_template_total_strip_and_tiny_noise_are_ocr_only_not_wall_lengths() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=157, y=395), ShapeCorner(x=157, y=723),
        ShapeCorner(x=312, y=723), ShapeCorner(x=312, y=677),
        ShapeCorner(x=605, y=677), ShapeCorner(x=605, y=340),
        ShapeCorner(x=419, y=340), ShapeCorner(x=419, y=419),
        ShapeCorner(x=350, y=419), ShapeCorner(x=350, y=343),
        ShapeCorner(x=196, y=343), ShapeCorner(x=196, y=395),
    ], closed=True)
    edges = ai._template_adjacent_dimension_edge_chain(shape, {"tokens": [
        {
            "id": "TOTAL",
            "raw_text": "4105",
            "bbox": [330, 240, 470, 340],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-top-total",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:top",
        },
        {
            "id": "NOISE",
            "raw_text": "10",
            "bbox": [350, 745, 378, 761],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-main",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "DOOR_LEFT",
            "raw_text": "400",
            "bbox": [80, 888, 120, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "DOOR_WIDTH",
            "raw_text": "800",
            "bbox": [200, 888, 240, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "DOOR_RIGHT",
            "raw_text": "55",
            "bbox": [280, 888, 300, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
    ]})

    assert all("TOTAL" not in edge.evidence_ids for edge in edges)
    assert all("NOISE" not in edge.evidence_ids for edge in edges)
    assert any(
        edge.length_mm == 1255
        and edge.evidence_ids == ["DOOR_LEFT", "DOOR_WIDTH", "DOOR_RIGHT"]
        for edge in edges
    )


def test_template_short_values_use_one_local_view_chain() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=157, y=395), ShapeCorner(x=157, y=723),
        ShapeCorner(x=312, y=723), ShapeCorner(x=312, y=677),
        ShapeCorner(x=605, y=677), ShapeCorner(x=605, y=340),
        ShapeCorner(x=419, y=340), ShapeCorner(x=419, y=419),
        ShapeCorner(x=350, y=419), ShapeCorner(x=350, y=343),
        ShapeCorner(x=196, y=343), ShapeCorner(x=196, y=395),
    ], closed=True)
    edges = ai._template_adjacent_dimension_edge_chain(shape, {"tokens": [
        {
            "id": "DOOR_LEFT",
            "raw_text": "400",
            "bbox": [80, 888, 120, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "DOOR_WIDTH",
            "raw_text": "800",
            "bbox": [200, 888, 240, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "DOOR_RIGHT",
            "raw_text": "55",
            "bbox": [280, 888, 300, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "OTHER_A",
            "raw_text": "410",
            "bbox": [416, 808, 451, 820],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "wall-1-h",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "OTHER_B",
            "raw_text": "320",
            "bbox": [388, 880, 427, 898],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "wall-1-h",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
    ]})

    assert edges[1].length_mm == 1255
    assert edges[1].evidence_ids == ["DOOR_LEFT", "DOOR_WIDTH", "DOOR_RIGHT"]


def test_template_bottom_total_constrains_single_missing_segment() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=157, y=395), ShapeCorner(x=157, y=723),
        ShapeCorner(x=312, y=723), ShapeCorner(x=312, y=677),
        ShapeCorner(x=605, y=677), ShapeCorner(x=605, y=340),
        ShapeCorner(x=419, y=340), ShapeCorner(x=419, y=419),
        ShapeCorner(x=350, y=419), ShapeCorner(x=350, y=343),
        ShapeCorner(x=196, y=343), ShapeCorner(x=196, y=395),
    ], closed=True)
    edges = ai._template_adjacent_dimension_edge_chain(shape, {"tokens": [
        {
            "id": "DOOR_LEFT",
            "raw_text": "400",
            "bbox": [80, 888, 120, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "DOOR_WIDTH",
            "raw_text": "800",
            "bbox": [200, 888, 240, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "DOOR_RIGHT",
            "raw_text": "55",
            "bbox": [280, 888, 300, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "BOTTOM_MAIN",
            "raw_text": "2855",
            "bbox": [400, 860, 468, 888],
            "orientation": "horizontal",
            "confidence": 0.8,
            "template_visual": True,
            "view_id": "strip-bottom-main",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "BOTTOM_TOTAL",
            "raw_text": "4110",
            "bbox": [320, 900, 390, 940],
            "orientation": "horizontal",
            "confidence": 0.8,
            "template_visual": True,
            "view_id": "strip-bottom-total",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
    ]})

    assert edges[1].length_mm == 1255
    assert edges[3].length_mm == 2855
    assert edges[3].evidence_ids == ["BOTTOM_MAIN", "BOTTOM_TOTAL"]


def test_template_bottom_total_replaces_single_conflicting_segment() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=157, y=395), ShapeCorner(x=157, y=723),
        ShapeCorner(x=312, y=723), ShapeCorner(x=312, y=677),
        ShapeCorner(x=605, y=677), ShapeCorner(x=605, y=340),
        ShapeCorner(x=419, y=340), ShapeCorner(x=419, y=419),
        ShapeCorner(x=350, y=419), ShapeCorner(x=350, y=343),
        ShapeCorner(x=196, y=343), ShapeCorner(x=196, y=395),
    ], closed=True)
    edges = [
        BoundaryEdge(direction="down"),
        BoundaryEdge(direction="right", length_mm=1255, evidence_ids=["DOOR_CHAIN"], confidence=0.9),
        BoundaryEdge(direction="up"),
        BoundaryEdge(direction="right", length_mm=3430, evidence_ids=["WRONG_SUM"], confidence=0.95),
        BoundaryEdge(direction="up"),
        BoundaryEdge(direction="left"),
        BoundaryEdge(direction="down"),
        BoundaryEdge(direction="left"),
        BoundaryEdge(direction="up"),
        BoundaryEdge(direction="left"),
        BoundaryEdge(direction="down"),
        BoundaryEdge(direction="left"),
    ]
    constrained = ai._apply_template_axis_total_constraints(edges, shape, {"tokens": [
        {
            "id": "BOTTOM_MAIN",
            "raw_text": "2855",
            "bbox": [400, 860, 468, 888],
            "orientation": "horizontal",
            "confidence": 0.8,
            "template_visual": True,
            "view_id": "strip-bottom-main",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "BOTTOM_TOTAL",
            "raw_text": "4110",
            "bbox": [320, 790, 390, 840],
            "orientation": "horizontal",
            "confidence": 0.8,
            "template_visual": True,
            "view_id": "strip-bottom-total",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
    ]})

    assert constrained[1].length_mm == 1255
    assert constrained[3].length_mm == 2855
    assert constrained[3].evidence_ids == ["BOTTOM_MAIN", "BOTTOM_TOTAL"]


def test_template_axis_total_repairs_dropped_digit_from_segment_sum() -> None:
    assist = {"tokens": [
        {
            "id": "DOOR_LEFT",
            "raw_text": "400",
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "DOOR_WIDTH",
            "raw_text": "800",
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "DOOR_RIGHT",
            "raw_text": "55",
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "BOTTOM_MAIN",
            "raw_text": "2855",
            "template_visual": True,
            "view_id": "strip-bottom-main",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "BOTTOM_TOTAL",
            "raw_text": "410",
            "template_visual": True,
            "view_id": "strip-bottom-total",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
    ]}

    ai._repair_template_axis_total_readings(assist)

    assert assist["tokens"][-1]["raw_text"] == "4110"
    assert assist["tokens"][-1]["alternate_readings"] == ["410"]


@pytest.mark.asyncio
async def test_resolve_segment_edge_chain_can_start_from_template_without_wall_crop_seed(monkeypatch) -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=157, y=395), ShapeCorner(x=157, y=723),
        ShapeCorner(x=312, y=723), ShapeCorner(x=312, y=677),
        ShapeCorner(x=605, y=677), ShapeCorner(x=605, y=340),
        ShapeCorner(x=419, y=340), ShapeCorner(x=419, y=419),
        ShapeCorner(x=350, y=419), ShapeCorner(x=350, y=343),
        ShapeCorner(x=196, y=343), ShapeCorner(x=196, y=395),
    ], closed=True)
    tokens = [
        {
            "id": "DOOR_LEFT",
            "raw_text": "400",
            "bbox": [80, 888, 120, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "DOOR_WIDTH",
            "raw_text": "800",
            "bbox": [200, 888, 240, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
        {
            "id": "DOOR_RIGHT",
            "raw_text": "55",
            "bbox": [280, 888, 300, 916],
            "orientation": "horizontal",
            "confidence": 0.9,
            "template_visual": True,
            "view_id": "strip-bottom-door",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:bottom",
        },
    ]

    async def empty_coordinate(*_args, **_kwargs):
        return []

    async def empty_model(*_args, **_kwargs):
        return json.dumps({
            "lengths_mm": [None] * 12,
            "evidence_ids": [[] for _ in range(12)],
        })

    monkeypatch.setattr(ai, "_coordinate_segment_edge_chain", empty_coordinate)
    monkeypatch.setattr(ai, "_request_content", empty_model)
    monkeypatch.setattr(ai, "image_data_url", lambda *_args, **_kwargs: "original")
    monkeypatch.setattr(ai, "_shape_wall_overlay", lambda *_args, **_kwargs: "overlay")

    edges = await ai._resolve_segment_edge_chain(
        None, "endpoint", {}, Path("unused.jpg"), 0, shape, {"tokens": tokens}, [], ["vision-test"],
    )

    assert edges[1].length_mm == 1255
    assert edges[1].evidence_ids == ["DOOR_LEFT", "DOOR_WIDTH", "DOOR_RIGHT"]


def test_template_large_wall_dimension_is_not_summed_with_nearby_noise() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=157, y=395), ShapeCorner(x=157, y=723),
        ShapeCorner(x=312, y=723), ShapeCorner(x=312, y=677),
        ShapeCorner(x=605, y=677), ShapeCorner(x=605, y=340),
        ShapeCorner(x=419, y=340), ShapeCorner(x=419, y=419),
        ShapeCorner(x=350, y=419), ShapeCorner(x=350, y=343),
        ShapeCorner(x=196, y=343), ShapeCorner(x=196, y=395),
    ], closed=True)
    edges = ai._template_adjacent_dimension_edge_chain(shape, {"tokens": [
        {
            "id": "RIGHT_MAIN",
            "raw_text": "2400",
            "bbox": [680, 608, 760, 720],
            "orientation": "vertical",
            "confidence": 0.8,
            "template_visual": True,
            "view_id": "strip-right-main",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:right",
        },
        {
            "id": "NEARBY_RECESS",
            "raw_text": "615",
            "bbox": [540, 392, 620, 504],
            "orientation": "vertical",
            "confidence": 0.8,
            "template_visual": True,
            "view_id": "strip-recess-right",
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:recess",
        },
    ]})

    assert edges[4].length_mm == 2400
    assert edges[4].evidence_ids == ["RIGHT_MAIN"]


@pytest.mark.parametrize("text,expected", [
    ("地漏", "floor_drain"), ("排水", "drain"), ("给水", "water"), ("电点", "electric"),
])
def test_point_marker_kinds_remain_distinct(text: str, expected: str) -> None:
    assert ai._point_marker_kind(text) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("model", "expected_calls", "expected_max_tokens", "compact_prompt"),
    [
        ("glm-4v-flash", 4, 1024, True),
        ("glm-4.6v-flash", 3, 4096, False),
    ],
)
async def test_hosted_evidence_respects_model_output_limit(
    monkeypatch, model, expected_calls, expected_max_tokens, compact_prompt,
) -> None:
    calls: list[dict] = []

    async def fake_request_content(_client, _endpoint, _headers, messages, _model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return '{"rotation_degrees":0,"evidence":[{"id":"E1","kind":"dimension","text":"1840","bbox":{"x_min":10,"y_min":10,"x_max":80,"y_max":50},"orientation":"horizontal","related_to":"墙长","view_id":"tile","confidence":0.9}],"uncertain":[]}'

    monkeypatch.setattr(ai, "_request_content", fake_request_content)
    monkeypatch.setattr(ai, "_crop_data_url", lambda *_args, **_kwargs: "data:image/jpeg;base64,AA==")

    report = await ai._collect_evidence_hosted(
        None, "https://example.test", {}, Path("unused.jpg"), 0, model, [],
    )

    assert report.evidence
    assert len(calls) == expected_calls
    assert all(call["extra_payload"]["max_tokens"] == expected_max_tokens for call in calls)
    prompts = [call["messages"][0]["content"] for call in calls]
    assert all(("最多返回 4 条" in prompt) is compact_prompt for prompt in prompts)


@pytest.mark.asyncio
async def test_request_layer_clamps_glm_4v_flash_output_tokens() -> None:
    requested: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        requested.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "{}"}}]},
            request=request,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await ai._request_message(
            client, "https://example.test/chat/completions", {}, [], "glm-4v-flash",
            stage="test-token-clamp", extra_payload={"max_tokens": 4096},
        )

    assert requested["max_tokens"] == 1024


@pytest.mark.asyncio
async def test_segment_edge_chain_respects_flash_output_limit(monkeypatch) -> None:
    calls: list[dict] = []
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
        ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
    ], closed=True)

    async def fake_request_content(*_args, **kwargs):
        calls.append(kwargs)
        return json.dumps({
            "lengths_mm": [None, None, None, None],
            "evidence_ids": [[], [], [], []],
        })

    monkeypatch.setattr(ai, "_request_content", fake_request_content)
    monkeypatch.setattr(ai, "image_data_url", lambda *_args, **_kwargs: "original")
    monkeypatch.setattr(ai, "_shape_wall_overlay", lambda *_args, **_kwargs: "overlay")

    edges = await ai._resolve_segment_edge_chain(
        None, "https://example.test", {}, Path("unused.jpg"), 0, shape,
        {"tokens": []}, [], ["vision-test"],
    )

    assert len(edges) == 4
    assert calls[0]["stage"] == "segment-edge-chain"
    assert calls[0]["extra_payload"]["max_tokens"] == 1024


def test_compact_segment_edge_chain_is_expanded_and_validated() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
        ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
    ], closed=True)
    assist = {"tokens": [
        {"id": "T1", "raw_text": "3000", "target_id": "wall:0", "confidence": 0.9},
        {"id": "T2", "raw_text": "2000", "target_id": "wall:1", "confidence": 0.9},
    ]}

    raw = ai._segment_edge_chain_from_payload({
        "lengths_mm": [3000, 2000, None, None],
        "evidence_ids": [["T1"], ["T2"], [], []],
    }, shape)
    validated = ai._validated_segment_edge_chain(raw, shape, assist)

    assert [edge.direction for edge in validated] == ["right", "down", "left", "up"]
    assert [edge.length_mm for edge in validated] == [3000, 2000, None, None]

    flat_raw = ai._segment_edge_chain_from_payload({
        "lengths_mm": [3000, 2000, None, None],
        "evidence_ids": ["T1", "T2", [], []],
    }, shape)

    assert [edge.evidence_ids for edge in flat_raw] == [["T1"], ["T2"], [], []]

    wrapped_raw = ai._segment_edge_chain_from_payload({
        "answer": {
            "lengths_mm": [3000, 2000, None, None],
            "evidence_ids": [["T1"], ["T2"], [], []],
        }
    }, shape)

    assert [edge.length_mm for edge in wrapped_raw] == [3000, 2000, None, None]
    assert [edge.evidence_ids for edge in wrapped_raw] == [["T1"], ["T2"], [], []]


def test_door_detection_uses_related_to_text() -> None:
    item = VisualEvidence(
        id="door-related", kind="dimension", text="800",
        bbox=ImageBBox(x_min=10, y_min=20, x_max=40, y_max=60),
        related_to="门洞净宽",
    )
    assert ai._is_door_evidence(item)


def test_wrong_dimension_cannot_be_bound_as_door_width() -> None:
    extraction = PlanExtraction(
        overall_width_mm=2855,
        overall_depth_mm=1840,
        height_mm=2100,
        openings=[
            OpeningCandidate(
                width_mm=2855,
                height_mm=2050,
                offset_mm=400,
                evidence_ids=["door-width", "door-height"],
                confidence=0.9,
            )
        ],
    )
    spec = ai._extraction_to_spec(extraction, visual_report(), asset_id="asset-1")
    assert spec.openings == []
    assert any("缺少可追踪" in issue.message for issue in spec.issues)
    assert any("bbox=" in observation.note for observation in spec.observations)
    assert all(observation.asset_id == "asset-1" for observation in spec.observations)


def test_supported_door_dimensions_are_kept() -> None:
    extraction = PlanExtraction(
        overall_width_mm=2855,
        overall_depth_mm=1840,
        height_mm=2100,
        openings=[
            OpeningCandidate(
                width_mm=800,
                height_mm=2050,
                offset_mm=400,
                evidence_ids=["door-width", "door-height"],
                confidence=0.9,
            )
        ],
    )
    spec = ai._extraction_to_spec(extraction, visual_report())
    assert len(spec.openings) == 1
    assert spec.openings[0].width_mm == 800
    assert spec.openings[0].height_mm == 2050


def test_critical_dimension_roles_override_composite_guess() -> None:
    extraction = PlanExtraction(
        overall_width_mm=1590,
        overall_depth_mm=1840,
        height_mm=2100,
        openings=[OpeningCandidate(width_mm=2855, height_mm=2050, offset_mm=400)],
    )
    roles = CriticalDimensionRoles(
        overall_width=DimensionEvidenceRef(value_mm=2855, evidence_ids=["wall-x"], confidence=0.9),
        overall_depth=DimensionEvidenceRef(value_mm=1840, evidence_ids=["wall-z"], confidence=0.9),
        room_height=DimensionEvidenceRef(value_mm=2100, evidence_ids=["height"], confidence=0.9),
        door_width=DimensionEvidenceRef(value_mm=800, evidence_ids=["door-width"], confidence=0.9),
        door_height=DimensionEvidenceRef(value_mm=2050, evidence_ids=["door-height"], confidence=0.85),
    )
    corrected = ai._apply_critical_dimensions(extraction, roles)
    assert corrected.overall_width_mm == 2855
    assert corrected.boundary == []
    assert corrected.openings[0].width_mm == 800
    assert corrected.openings[0].evidence_ids == ["door-width", "door-height"]


def test_critical_roles_accept_model_shorthand() -> None:
    roles = CriticalDimensionRoles.model_validate(
        {
            "overall_width": "E12: 2855",
            "overall_depth": "1840",
            "room_height": "2.100",
            "door_width": "E14: 800",
            "door_height": "E16: 门高2055",
        }
    )
    assert roles.overall_width and roles.overall_width.value_mm == 2855
    assert roles.overall_width.evidence_ids == ["E12"]
    assert roles.overall_depth and roles.overall_depth.value_mm == 1840
    assert roles.room_height and roles.room_height.value_mm == 2100
    assert roles.door_height and roles.door_height.value_mm == 2055


def test_dimension_chain_drives_room_span_and_door_width() -> None:
    report = visual_report()
    report.evidence.extend(
        [
            VisualEvidence(id="left-wall", kind="dimension", text="400", bbox=ImageBBox(x_min=50, y_min=850, x_max=100, y_max=900)),
            VisualEvidence(id="short-wall", kind="dimension", text="55", bbox=ImageBBox(x_min=300, y_min=850, x_max=340, y_max=900)),
            VisualEvidence(id="main-wall", kind="dimension", text="2855", bbox=ImageBBox(x_min=400, y_min=850, x_max=520, y_max=900)),
        ]
    )
    roles = CriticalDimensionRoles(
        overall_width_segments=[
            DimensionEvidenceRef(value_mm=400, evidence_ids=["left-wall"], purpose="wall_segment"),
            DimensionEvidenceRef(value_mm=800, evidence_ids=["door-width"], purpose="door_opening"),
            DimensionEvidenceRef(value_mm=55, evidence_ids=["short-wall"], purpose="gap"),
            DimensionEvidenceRef(value_mm=2855, evidence_ids=["main-wall"], purpose="wall_segment"),
        ],
        overall_depth=DimensionEvidenceRef(value_mm=1840, evidence_ids=["wall-z"]),
        room_height=DimensionEvidenceRef(value_mm=2100, evidence_ids=["height"]),
        door_width=DimensionEvidenceRef(value_mm=860, evidence_ids=["door-width"]),
        door_height=DimensionEvidenceRef(value_mm=2050, evidence_ids=["door-height"]),
    )
    extraction = PlanExtraction(
        overall_width_mm=1590,
        overall_depth_mm=1840,
        height_mm=2100,
        openings=[OpeningCandidate(width_mm=860, height_mm=2050, offset_mm=400)],
    )
    corrected = ai._apply_critical_dimensions(extraction, roles)
    assert corrected.overall_width_mm == 4110
    assert corrected.openings[0].width_mm == 800
    spec = ai._extraction_to_spec(corrected, report, derived_values=ai._derived_role_values(roles))
    assert spec.boundary[1].x_mm == 4110
    assert spec.openings[0].width_mm == 800


def test_dimension_correction_preserves_supported_non_rectangular_contour() -> None:
    boundary = [
        Point2D(x_mm=0, z_mm=1840),
        Point2D(x_mm=4110, z_mm=1840),
        Point2D(x_mm=4105, z_mm=0),
        Point2D(x_mm=2515, z_mm=0),
        Point2D(x_mm=2515, z_mm=610),
        Point2D(x_mm=1900, z_mm=610),
        Point2D(x_mm=1900, z_mm=0),
        Point2D(x_mm=260, z_mm=0),
        Point2D(x_mm=260, z_mm=320),
        Point2D(x_mm=0, z_mm=320),
    ]
    extraction = PlanExtraction(
        overall_width_mm=4110,
        overall_depth_mm=1840,
        height_mm=2100,
        boundary=boundary,
    )
    roles = CriticalDimensionRoles(
        overall_width_segments=[
            DimensionEvidenceRef(value_mm=400, evidence_ids=["a"], purpose="wall_segment"),
            DimensionEvidenceRef(value_mm=800, evidence_ids=["b"], purpose="door_opening"),
            DimensionEvidenceRef(value_mm=55, evidence_ids=["c"], purpose="gap"),
            DimensionEvidenceRef(value_mm=2855, evidence_ids=["d"], purpose="wall_segment"),
        ],
        overall_depth=DimensionEvidenceRef(value_mm=1840, evidence_ids=["e"]),
    )
    corrected = ai._apply_critical_dimensions(extraction, roles)
    assert corrected.boundary == boundary


def test_boundary_is_canonicalized_to_bottom_wall_from_left_to_right() -> None:
    source = [
        Point2D(x_mm=0, z_mm=0),
        Point2D(x_mm=4105, z_mm=0),
        Point2D(x_mm=4110, z_mm=1840),
        Point2D(x_mm=0, z_mm=1840),
    ]
    result = ai._canonicalize_boundary(source)
    assert result[0] == Point2D(x_mm=0, z_mm=1840)
    assert result[1] == Point2D(x_mm=4110, z_mm=1840)


def test_boundary_canonicalization_removes_repeated_closing_point() -> None:
    source = [
        Point2D(x_mm=0, z_mm=0),
        Point2D(x_mm=1800, z_mm=0),
        Point2D(x_mm=1800, z_mm=2400),
        Point2D(x_mm=0, z_mm=2400),
        Point2D(x_mm=0, z_mm=0),
    ]
    result = ai._canonicalize_boundary(source)
    assert len(result) == 4
    assert result[0] != result[-1]


def test_edge_chain_is_integrated_without_losing_returns() -> None:
    edges = [
        BoundaryEdge(direction="right", length_mm=1200),
        BoundaryEdge(direction="up", length_mm=220, role="door_jamb"),
        BoundaryEdge(direction="right", length_mm=55, role="structure_return"),
        BoundaryEdge(direction="right", length_mm=2855),
        BoundaryEdge(direction="up", length_mm=1620),
        BoundaryEdge(direction="left", length_mm=1590),
        BoundaryEdge(direction="down", length_mm=610, role="structure_return"),
        BoundaryEdge(direction="left", length_mm=615),
        BoundaryEdge(direction="up", length_mm=610, role="structure_return"),
        BoundaryEdge(direction="left", length_mm=1640),
        BoundaryEdge(direction="down", length_mm=320, role="structure_return"),
        BoundaryEdge(direction="left", length_mm=260),
        BoundaryEdge(direction="down", length_mm=1520),
    ]
    solved = ai._solve_edge_lengths(edges)
    adjusted = [edge for edge in solved if edge.closure_adjustment_mm]
    boundary = ai._edge_chain_to_boundary(edges)
    assert len(adjusted) == 1
    assert adjusted[0].measured_length_mm == 260
    assert adjusted[0].length_mm == 265
    assert adjusted[0].closure_adjustment_mm == 5
    assert all(
        start.x_mm == end.x_mm or start.z_mm == end.z_mm
        for start, end in zip(boundary, [*boundary[1:], boundary[0]])
    )
    assert (boundary[1].x_mm, boundary[1].z_mm) == (1200, 1840)
    assert (boundary[2].x_mm, boundary[2].z_mm) == (1200, 1620)
    assert (boundary[4].x_mm, boundary[4].z_mm) == (4110, 1620)


def test_edge_chain_solves_one_unknown_length_per_axis() -> None:
    edges = [
        BoundaryEdge(direction="right", length_mm=1200, evidence_ids=["wall-x"]),
        BoundaryEdge(direction="down", length_mm=220, role="door_jamb", evidence_ids=["door-width"]),
        BoundaryEdge(direction="right", length_mm=55, evidence_ids=["door-width"]),
        BoundaryEdge(direction="down", length_mm=None, evidence_ids=["wall-z"]),
        BoundaryEdge(direction="left", length_mm=None, evidence_ids=["wall-x"]),
        BoundaryEdge(direction="up", length_mm=1840, evidence_ids=["wall-z"]),
    ]
    solved = ai._solve_edge_lengths(edges)
    assert solved[3].length_mm == 1620
    assert solved[4].length_mm == 1255
    assert solved[3].source == SourceKind.derived
    assert solved[3].measured_length_mm is None
    assert ai._edge_chain_to_boundary(edges)


def test_edge_chain_absorbs_five_mm_measurement_error_without_mutating_input() -> None:
    edges = [
        BoundaryEdge(direction="right", length_mm=4105, confidence=0.95, evidence_ids=["top-chain"]),
        BoundaryEdge(direction="down", length_mm=1840, confidence=0.95),
        BoundaryEdge(direction="left", length_mm=4110, confidence=0.8, evidence_ids=["bottom-chain"]),
        BoundaryEdge(direction="up", length_mm=1840, confidence=0.95),
    ]

    solved = ai._solve_edge_lengths(edges)

    assert edges[2].length_mm == 4110
    assert edges[2].measured_length_mm is None
    assert solved[2].measured_length_mm == 4110
    assert solved[2].length_mm == 4105
    assert solved[2].closure_adjustment_mm == -5
    assert solved[2].source == SourceKind.derived
    assert ai._edge_chain_to_boundary(edges)


def test_provisional_spec_persists_closure_adjustment_and_original_measurement() -> None:
    shape = ShapeTraceResult(
        corners=[
            ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
            ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
        ],
        closed=True,
    )
    edges = [
        BoundaryEdge(direction="right", length_mm=4105, confidence=0.95),
        BoundaryEdge(direction="down", length_mm=1840, confidence=0.95),
        BoundaryEdge(direction="left", length_mm=4110, confidence=0.8),
        BoundaryEdge(direction="up", length_mm=1840, confidence=0.95),
    ]

    spec = ai._provisional_room_spec(
        shape, {"tokens": [], "rotation_degrees": 0}, edge_chain=edges,
    )

    assert spec is not None and spec.plan_annotation is not None
    adjusted = spec.plan_annotation.edge_chain[2]
    assert adjusted.measured_length_mm == 4110
    assert adjusted.length_mm == 4105
    assert adjusted.closure_adjustment_mm == -5
    closure_observation = next(item for item in spec.observations if item.field == "closure:wall:2")
    assert "实测 4110 mm" in closure_observation.note
    assert "建模采用 4105 mm" in closure_observation.note
    assert any(issue.code == "closure_adjustment" for issue in spec.issues)


def test_edge_chain_absorbs_scale_aware_vertical_measurement_error() -> None:
    edges = [
        BoundaryEdge(direction="right", length_mm=3000),
        BoundaryEdge(direction="down", length_mm=2030, confidence=0.9),
        BoundaryEdge(direction="left", length_mm=3000),
        BoundaryEdge(direction="up", length_mm=2000, confidence=0.8),
    ]

    solved = ai._solve_edge_lengths(edges)

    assert solved[3].measured_length_mm == 2000
    assert solved[3].length_mm == 2030
    assert solved[3].closure_adjustment_mm == 30
    assert ai._edge_chain_to_boundary(edges)


def test_edge_chain_rejects_measurement_error_above_scale_aware_tolerance() -> None:
    edges = [
        BoundaryEdge(direction="right", length_mm=3000),
        BoundaryEdge(direction="down", length_mm=2031),
        BoundaryEdge(direction="left", length_mm=3000),
        BoundaryEdge(direction="up", length_mm=2000),
    ]

    assert ai._solve_edge_lengths(edges) == []
    assert ai._edge_chain_to_boundary(edges) == []


def test_edge_chain_rejects_multiple_unknowns_on_same_axis() -> None:
    edges = [
        BoundaryEdge(direction="right", length_mm=None),
        BoundaryEdge(direction="down", length_mm=1000),
        BoundaryEdge(direction="left", length_mm=None),
        BoundaryEdge(direction="up", length_mm=1000),
    ]
    assert ai._solve_edge_lengths(edges) == []


def test_shape_trace_determines_ordered_edge_directions() -> None:
    shape = ShapeTraceResult(
        closed=True,
        corners=[
            ShapeCorner(x=100, y=100),
            ShapeCorner(x=800, y=100),
            ShapeCorner(x=800, y=700),
            ShapeCorner(x=100, y=700),
        ],
    )
    assert ai._shape_directions(shape) == ["right", "down", "left", "up"]


def test_non_rectangular_shape_is_never_scaled_from_pixel_proportions() -> None:
    shape = ShapeTraceResult(
        closed=True,
        corners=[
            ShapeCorner(x=100, y=100),
            ShapeCorner(x=900, y=100),
            ShapeCorner(x=900, y=900),
            ShapeCorner(x=600, y=900),
            ShapeCorner(x=600, y=650),
            ShapeCorner(x=100, y=650),
        ],
    )

    assert ai._rectangular_boundary_from_extents(shape, 3200, 2400) == []


def test_rectangle_uses_measured_extents_not_drawn_aspect_ratio() -> None:
    shape = ShapeTraceResult(
        closed=True,
        corners=[
            ShapeCorner(x=100, y=100), ShapeCorner(x=950, y=100),
            ShapeCorner(x=950, y=220), ShapeCorner(x=100, y=220),
        ],
    )

    boundary = ai._rectangular_boundary_from_extents(shape, 1800, 3200)

    assert {(point.x_mm, point.z_mm) for point in boundary} == {
        (0, 0), (1800, 0), (1800, 3200), (0, 3200),
    }


def test_raster_topology_candidates_keep_non_rectangular_turns(tmp_path) -> None:
    image = Image.new("RGB", (1000, 700), "white")
    polygon = [
        (120, 580), (120, 120), (330, 120), (330, 220),
        (500, 220), (500, 120), (860, 120), (860, 580),
    ]
    draw = ImageDraw.Draw(image)
    draw.line([*polygon, polygon[0]], fill="black", width=9, joint="curve")
    path = tmp_path / "orthogonal-plan.png"
    image.save(path)

    candidates = ai._raster_topology_candidates(path, 0)

    assert candidates
    assert any(len(candidate.corners) >= 8 for candidate in candidates)
    assert all(ai._shape_directions(ShapeTraceResult(corners=item.corners, closed=True)) for item in candidates)


def test_raster_topology_candidates_isolate_blue_outline_on_printed_form(tmp_path) -> None:
    image = Image.new("RGB", (1200, 800), (226, 218, 207))
    draw = ImageDraw.Draw(image)
    printed = (115, 108, 101)
    grid = (190, 181, 169)
    blue = (65, 70, 84)
    draw.rectangle((35, 90, 815, 760), outline=printed, width=3)
    draw.rectangle((835, 90, 1165, 330), outline=printed, width=3)
    for coordinate in range(75, 815, 45):
        draw.line((coordinate, 115, coordinate, 740), fill=grid, width=1)
    for coordinate in range(115, 740, 45):
        draw.line((55, coordinate, 795, coordinate), fill=grid, width=1)
    draw.line((250, 235, 650, 235), fill=blue, width=5)
    draw.line((250, 235, 250, 620), fill=blue, width=5)
    draw.line((650, 235, 650, 620), fill=blue, width=5)
    draw.line((250, 620, 390, 620), fill=blue, width=5)
    draw.line((500, 620, 650, 620), fill=blue, width=5)
    draw.text((425, 190), "1600", fill=blue)
    draw.text((900, 160), "800 2055", fill=blue)
    path = tmp_path / "photographed-form.jpg"
    image.save(path, quality=90)

    candidates = ai._raster_topology_candidates(path, 0, fast=True)

    assert candidates
    colored = next(candidate for candidate in candidates if candidate.source == "colored_ink")
    assert colored.pixel_support >= 0.55
    assert len(colored.corners) == 4
    assert (
        min(corner.x for corner in colored.corners),
        max(corner.x for corner in colored.corners),
    ) == pytest.approx((208, 542), abs=12)
    assert (
        min(corner.y for corner in colored.corners),
        max(corner.y for corner in colored.corners),
    ) == pytest.approx((254, 762), abs=12)


def test_applied_opening_row_does_not_require_duplicate_review() -> None:
    opening = OpeningSpec(
        id="opening-d1", kind="door", wall_index=2, offset_mm=770,
        width_mm=800, height_mm=2055, sill_mm=0, label="D1",
        source=SourceKind.derived, confidence=0.95,
    )

    assert ai._opening_row_is_applied("D1 CG 0 CK 800 CH 2055", [opening])
    assert not ai._opening_row_is_applied("门窗洞口 CG 距地 CK 内宽 CH 内高", [opening])
    assert not ai._opening_row_is_applied("D1 CG 0 CK 700 CH 2055", [opening])


def test_false_boundary_simplifier_removes_door_leaf_u_but_keeps_plain_recess() -> None:
    image = Image.new("RGB", (500, 400), "white")
    draw = ImageDraw.Draw(image)
    draw.arc((90, 90, 310, 310), 180, 270, fill="black", width=6)
    door_trace = [
        (20, 300), (100, 300), (100, 100), (300, 100),
        (300, 300), (420, 300), (420, 20), (20, 20),
    ]
    plain_recess = [
        (20, 300), (100, 300), (100, 100), (300, 100),
        (300, 300), (420, 300), (420, 20), (20, 20),
    ]

    simplified = ai._simplify_false_boundary_detours(image, door_trace)
    untouched = ai._simplify_false_boundary_detours(Image.new("RGB", image.size, "white"), plain_recess)

    assert simplified == [(20, 300), (420, 300), (420, 20), (20, 20)]
    assert untouched == plain_recess


def test_false_boundary_simplifier_merges_monotonic_perspective_staircase() -> None:
    image = Image.new("RGB", (1000, 1000), "white")
    noisy = [
        (20, 300), (420, 300), (420, 20), (120, 20),
        (120, 60), (108, 60), (108, 76), (70, 76), (70, 120), (20, 120),
    ]

    simplified = ai._simplify_false_boundary_detours(image, noisy)

    assert simplified == [
        (20, 300), (420, 300), (420, 20), (120, 20),
        (120, 76), (70, 76), (70, 120), (20, 120),
    ]


def test_current_template_sample_has_twelve_fixed_wall_segments() -> None:
    path = Path(__file__).resolve().parents[2] / "test0.jpg"
    if not path.exists():
        pytest.skip("current template sample is not available")

    candidates = ai._raster_topology_candidates(path, 0, fast=True)

    assert candidates
    assert len(candidates[0].corners) == 12
    assert ai._shape_directions(ShapeTraceResult(corners=candidates[0].corners, closed=True)) == [
        "down", "right", "up", "right", "up", "left",
        "down", "left", "up", "left", "down", "left",
    ]


def test_program_topology_fallback_prefers_simplest_supported_non_rectangle() -> None:
    def candidate(candidate_id: str, corner_count: int, support: float) -> TopologyCandidate:
        corners = [ShapeCorner(x=index * 10, y=(index % 2) * 10) for index in range(corner_count)]
        return TopologyCandidate(id=candidate_id, corners=corners, pixel_support=support)

    selected = ai._program_topology_fallback([
        candidate("C16", 16, 0.482),
        candidate("C10", 10, 0.475),
        candidate("C8", 8, 0.433),
    ])

    assert selected is not None
    assert selected.id == "C8"
    assert ai._program_topology_fallback([candidate("C4", 4, 0.7), candidate("C8", 8, 0.6)]) is None
    assert ai._program_topology_fallback([candidate("C8", 8, 0.39), candidate("C10", 10, 0.38)]) is None


def test_ocr_assist_writes_hash_isolated_artifacts(tmp_path, monkeypatch) -> None:
    image = Image.new("RGB", (320, 220), "white")
    draw = ImageDraw.Draw(image)
    draw.text((120, 80), "1840", fill="black")
    path = tmp_path / "plan.jpg"
    image.save(path)
    monkeypatch.setattr(settings, "ocr_cache_dir", tmp_path / "ocr-cache")

    def fake_ocr(_image_path, prepared_image, image_hash, rotation):
        return [
            {
                "id": "E001",
                "raw_text": "1840",
                "normalized_candidates": ["1840"],
                "bbox": ImageBBox(x_min=350, y_min=330, x_max=520, y_max=430).model_dump(),
                "pixel_bbox": {"left": 112, "top": 72, "width": 55, "height": 22},
                "orientation": "horizontal",
                "confidence": 0.68,
                "image_hash": image_hash,
                "coordinate_transform": {
                    "exif_transposed": True,
                    "rotation_degrees": rotation,
                    "trim_document": True,
                    "coordinate_space": "oriented-original normalized 0..1000",
                },
            }
        ]

    monkeypatch.setattr(ai, "_run_local_ocr", fake_ocr)

    bundle = ai._prepare_ocr_assist(path, 0)
    cache_dir = __import__("pathlib").Path(bundle["cache_dir"])

    assert cache_dir.name == bundle["image_hash"]
    assert (cache_dir / "oriented-original.jpg").exists()
    assert (cache_dir / "ocr-overlay.png").exists()
    assert (cache_dir / "ocr-tokens.json").exists()
    assert (cache_dir / "crops" / "E001.png").exists()
    assert bundle["tokens"][0]["coordinate_transform"]["trim_document"] is True


def test_refined_ocr_cache_only_matches_the_same_source_image(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.jpg"
    other = tmp_path / "other.jpg"
    Image.new("RGB", (320, 220), "white").save(source)
    Image.new("RGB", (320, 220), "black").save(other)
    cache_root = tmp_path / "ocr-cache"
    monkeypatch.setattr(settings, "ocr_cache_dir", cache_root)

    image_hash = ai._image_hash(ai._oriented_image(source, 0, trim_document=True))
    cache_dir = cache_root / image_hash
    (cache_dir / "crops").mkdir(parents=True)
    (cache_dir / "oriented-original.jpg").write_bytes(source.read_bytes())
    (cache_dir / "ocr-overlay.png").write_bytes(source.read_bytes())
    (cache_dir / "ocr-tokens.json").write_text(json.dumps({
        "schema_version": 7,
        "engine": settings.ocr_engine,
        "image_hash": image_hash,
        "rotation_degrees": 0,
        "ocr_orientations": [0, 180],
        "vision_refined": True,
        "vision_model": settings.read_model,
        "tokens": [{"id": "E001", "raw_text": "6500"}],
    }), encoding="utf-8")

    assert ai._load_refined_ocr_cache(source, 0) is not None
    assert ai._load_refined_ocr_cache(other, 0) is None

    cached = json.loads((cache_dir / "ocr-tokens.json").read_text(encoding="utf-8"))
    cached["vision_model"] = "previous-model"
    (cache_dir / "ocr-tokens.json").write_text(json.dumps(cached), encoding="utf-8")
    assert ai._load_refined_ocr_cache(source, 0) is None
    cached["vision_model"] = settings.read_model
    (cache_dir / "ocr-tokens.json").write_text(json.dumps(cached), encoding="utf-8")

    cached = json.loads((cache_dir / "ocr-tokens.json").read_text(encoding="utf-8"))
    cached.update({"wall_crop_refined": True, "wall_crop_cache_version": ai.WALL_CROP_CACHE_VERSION - 1})
    (cache_dir / "ocr-tokens.json").write_text(json.dumps(cached), encoding="utf-8")
    assert ai._load_refined_ocr_cache(source, 0) is None


@pytest.mark.asyncio
async def test_fast_analysis_does_not_invent_placeholder_without_a_detected_contour(tmp_path, monkeypatch) -> None:
    source = tmp_path / "blank.jpg"
    Image.new("RGB", (320, 240), "white").save(source)
    monkeypatch.setattr(ai, "_prepare_ocr_assist", lambda *_args, **_kwargs: {
        "tokens": [], "rotation_degrees": 0,
    })
    monkeypatch.setattr(ai, "_raster_topology_candidates", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(settings, "openai_base_url", "")
    monkeypatch.setattr(settings, "openai_api_key", "")
    monkeypatch.setattr(settings, "read_model", "")

    spec = await ai.analyze_floorplan_fast(source)

    assert spec.boundary == []
    assert spec.plan_annotation is not None
    assert spec.plan_annotation.boundary == []
    assert spec.plan_annotation.edge_chain == []
    assert not any("3000" in issue.message or "2000" in issue.message for issue in spec.issues)


def test_photo_binding_target_rejects_null_mismatched_and_out_of_range_values() -> None:
    assert ai._valid_photo_binding_target("room_dimension", "room:width", 8) == "room:width"
    assert ai._valid_photo_binding_target("room_dimension", "null", 8) is None
    assert ai._valid_photo_binding_target("room_height", "wall:0", 8) is None
    assert ai._valid_photo_binding_target("door_size", "wall:2", 8) is None
    assert ai._valid_photo_binding_target("door_size", "wall:2@0.42", 8) is None
    assert ai._valid_photo_binding_target("door_size", "wall:2@0.32:0.52", 8) == "wall:2@0.32:0.52"
    assert ai._valid_photo_binding_target("door_size", "wall:2@0.52:0.32", 8) is None
    assert ai._valid_photo_binding_target("wall_segment", "wall:8@0.5", 8) is None


def test_photo_binding_keeps_template_dimensions_out_of_door_size_role() -> None:
    dimension = {
        "id": "TV001",
        "raw_text": "800",
        "semantic_role": "wall_segment",
        "template_visual": True,
    }
    door_row = {
        "id": "TV002",
        "raw_text": "D1 CG 0 CK 800 CH 2055",
        "semantic_role": "door_size",
        "template_visual": True,
    }

    assert ai._photo_binding_role_for_token(dimension, "door_size") == "wall_segment"
    assert ai._photo_binding_role_for_token(dimension, "drain_position") == "wall_segment"
    assert ai._photo_binding_role_for_token(door_row, "door_size") == "door_size"


@pytest.mark.asyncio
async def test_photo_binding_only_accepts_ids_from_the_current_chunk(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.jpg"
    Image.new("RGB", (100, 100), "white").save(source)
    tokens = [
        {
            "id": f"E{index:03d}", "raw_text": str(1000 + index),
            "bbox": {"x_min": index * 10, "y_min": 10, "x_max": index * 10 + 5, "y_max": 20},
            "confidence": 0.9, "alternate_readings": [],
        }
        for index in range(1, 10)
    ]
    ocr_assist = {"tokens": tokens, "oriented_original": str(source), "overlay": str(source)}
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=0, y=0), ShapeCorner(x=1000, y=0),
        ShapeCorner(x=1000, y=1000), ShapeCorner(x=0, y=1000),
    ], closed=True)
    calls = 0

    async def fake_request(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return json.dumps({"bindings": [
                {"id": "E001", "text": "1001", "semantic_role": "room_dimension", "target_id": "room:width", "confidence": 0.95},
                {"id": "E009", "text": "1009", "semantic_role": "drain_position", "target_id": "drain:1", "confidence": 0.95},
            ]})
        return json.dumps({"bindings": [
            {"id": "E001", "text": "1001", "semantic_role": "room_dimension", "target_id": "room:width", "confidence": 0.95},
        ]})

    monkeypatch.setattr(ai, "_request_content", fake_request)
    monkeypatch.setattr(settings, "read_model", "vision-test")
    await ai._refine_photo_annotation_bindings(None, "", {}, ocr_assist, shape, [])

    assert tokens[0].get("target_id") is None
    assert tokens[8].get("target_id") is None


def test_provisional_photo_annotation_does_not_materialize_ai_objects() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
        ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
    ], closed=True)
    tokens = [
        {"id": "E001", "raw_text": "2855", "bbox": [100, 100, 180, 140], "confidence": 0.99},
        {"id": "E002", "raw_text": "1840", "bbox": [800, 200, 850, 300], "confidence": 0.99},
        {
            "id": "E003", "raw_text": "洗衣机地漏", "bbox": [400, 400, 520, 470],
            "confidence": 0.99, "semantic_role": "drain_position", "target_id": "drain:1", "vision_bound": True,
        },
        {
            "id": "E004", "raw_text": "800x2055x120", "bbox": [200, 700, 400, 780],
            "confidence": 0.99, "semantic_role": "door_size", "target_id": "wall:2@0.5", "vision_bound": True,
        },
    ]

    spec = ai._provisional_room_spec(shape, {"tokens": tokens, "rotation_degrees": 270})

    assert spec is not None
    assert len(spec.plan_annotation.boundary) == 4
    assert spec.height_mm is None
    assert spec.openings == []
    assert spec.fixtures == []


def test_ceiling_display_prefers_plausible_paddle_alternative() -> None:
    token = {
        "raw_text": "吊顶20100",
        "alternate_readings": ["吊顶2100"],
    }
    assert ai._ocr_display_text(token, "ceiling_height", set(), None) == "吊顶2100"


def test_ocr_overlay_outlines_bbox_without_obscuring_text() -> None:
    image = Image.new("RGB", (100, 80), "white")
    draw = ImageDraw.Draw(image)
    draw.text((42, 30), "1840", fill="black")

    overlay = ai._ocr_overlay(
        image,
        [
            {
                "id": "E001",
                "raw_text": "1840",
                "bbox": ImageBBox(x_min=400, y_min=300, x_max=700, y_max=500).model_dump(),
                "confidence": 0.9,
            }
        ],
    )

    assert overlay.getpixel((10, 10)) == image.getpixel((10, 10))
    assert overlay.getpixel((85, 30)) == image.getpixel((85, 30))
    assert overlay.getpixel((40, 30)) != image.getpixel((40, 30))
    assert overlay.getpixel((45, 32)) == image.getpixel((45, 32))


def test_ocr_rotated_boxes_map_back_to_canonical_coordinates() -> None:
    rotated = ImageBBox(x_min=100, y_min=200, x_max=300, y_max=400)

    clockwise = ai._ocr_bbox_to_canonical(rotated, 90)
    counterclockwise = ai._ocr_bbox_to_canonical(rotated, 270)

    assert clockwise == ImageBBox(x_min=200, y_min=700, x_max=400, y_max=900)
    assert counterclockwise == ImageBBox(x_min=600, y_min=100, x_max=800, y_max=300)


def test_multi_orientation_ocr_merges_overlapping_alternate_readings() -> None:
    first = {
        "id": "E001", "raw_text": "0+81", "normalized_candidates": ["0", "81"],
        "bbox": ImageBBox(x_min=100, y_min=200, x_max=220, y_max=260).model_dump(),
        "confidence": 0.61,
    }
    second = {
        "id": "E001", "raw_text": "1840", "normalized_candidates": ["1840"],
        "bbox": ImageBBox(x_min=105, y_min=198, x_max=225, y_max=262).model_dump(),
        "confidence": 0.93,
    }

    merged = ai._merge_ocr_tokens([[first], [second]])

    assert len(merged) == 1
    assert merged[0]["raw_text"] == "1840"
    assert set(merged[0]["alternate_readings"]) == {"0+81", "1840"}
    assert "1840" in merged[0]["normalized_candidates"]


def test_ocr_dimension_hints_exclude_height_label() -> None:
    shape = ShapeTraceResult(
        closed=True,
        corners=[
            ShapeCorner(x=0, y=0), ShapeCorner(x=1000, y=0),
            ShapeCorner(x=1000, y=645), ShapeCorner(x=0, y=645),
        ],
    )
    assist = {
        "tokens": [
            {"raw_text": "2855", "normalized_candidates": ["2855"]},
            {"raw_text": "1840", "normalized_candidates": ["1840"]},
            {"raw_text": "吊顶2.100", "normalized_candidates": ["2100"]},
        ]
    }

    assert ai._ocr_dimension_hints(assist, shape) == (2855, 1840)


def test_central_ceiling_label_is_separate_from_room_height() -> None:
    central = {
        "raw_text": "吊顶2.100",
        "normalized_candidates": ["2100"],
        "bbox": ImageBBox(x_min=430, y_min=440, x_max=570, y_max=500).model_dump(),
        "confidence": 0.9,
    }
    edge = {
        "raw_text": "局部吊顶2350",
        "normalized_candidates": ["2350"],
        "bbox": ImageBBox(x_min=30, y_min=100, x_max=190, y_max=160).model_dump(),
        "confidence": 0.9,
    }

    assert ai._ocr_room_height_hint({"tokens": [central]}) is None
    assert ai._ocr_ceiling_height_hint({"tokens": [central]}) == (2100, "", 0.9)
    assert ai._ocr_ceiling_height_hint({"tokens": [edge]}) is None
    ai._classify_ocr_tokens([central, edge])
    assert central["semantic_role"] == "room_height"
    assert edge["semantic_role"] == "ceiling_height"


def test_reversed_paddle_reading_is_demoted_when_vision_reads_same_band() -> None:
    paddle = {
        "id": "E001", "raw_text": "5582", "engine": "paddleocr",
        "bbox": ImageBBox(x_min=520, y_min=640, x_max=600, y_max=700).model_dump(),
    }
    vision = {
        "id": "E002", "raw_text": "2855", "engine": "wall-crop-vision",
        "bbox": ImageBBox(x_min=650, y_min=600, x_max=880, y_max=630).model_dump(),
        "alternate_readings": [],
    }

    ai._suppress_reversed_ocr_artifacts([paddle, vision])

    assert paddle["suppressed_by_vision"] == "E002"
    assert "5582" in vision["alternate_readings"]


def test_unbound_wall_number_is_attached_to_nearest_shape_edge_for_review() -> None:
    shape = ShapeTraceResult(
        closed=True,
        corners=[
            ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
            ShapeCorner(x=900, y=800), ShapeCorner(x=100, y=800),
        ],
    )
    token = {
        "raw_text": "2855",
        "semantic_role": "wall_segment",
        "target_id": None,
        "review_required": True,
        "bbox": ImageBBox(x_min=450, y_min=820, x_max=570, y_max=870).model_dump(),
        "coordinate_transform": {"ocr_relative_rotation_degrees": 180},
    }

    ai._bind_ocr_tokens_to_boundary([token], shape.corners)

    assert token["target_id"].startswith("wall:2@")
    assert token["review_required"] is True


def test_ocr_dimension_hints_preserve_rooms_larger_than_five_metres() -> None:
    assist = {
        "tokens": [
            {"raw_text": "6500", "normalized_candidates": ["6500"]},
            {"raw_text": "4800", "normalized_candidates": ["4800"]},
        ]
    }

    assert ai._ocr_dimension_hints(assist) == (6500, 4800)


def test_ocr_dimension_hints_prefer_vision_corrected_values() -> None:
    corrected = {"vision_rotation_degrees": 90}
    assist = {
        "tokens": [
            {"raw_text": "5582", "normalized_candidates": ["5582"], "coordinate_transform": {}},
            {"raw_text": "2855", "normalized_candidates": ["2855"], "coordinate_transform": corrected},
            {"raw_text": "1840", "normalized_candidates": ["1840"], "coordinate_transform": corrected},
        ]
    }

    assert ai._ocr_dimension_hints(assist) == (2855, 1840)


def test_ocr_rotation_contact_sheet_includes_vertical_and_uncertain_tokens(tmp_path) -> None:
    original = tmp_path / "oriented.jpg"
    Image.new("RGB", (600, 400), "white").save(original)
    assist = {
        "oriented_original": original,
        "tokens": [
            {
                "id": "E001", "raw_text": "0781", "confidence": 0.99,
                "bbox": ImageBBox(x_min=100, y_min=100, x_max=160, y_max=360).model_dump(),
            },
            {
                "id": "E002", "raw_text": "uncertain", "confidence": 0.5,
                "bbox": ImageBBox(x_min=300, y_min=100, x_max=520, y_max=180).model_dump(),
            },
        ],
    }

    sheet, token_ids = ai._ocr_rotation_contact_sheet(assist)

    assert sheet.startswith("data:image/jpeg;base64,")
    assert token_ids == ["E001", "E002"]


@pytest.mark.asyncio
async def test_vision_ocr_refinement_updates_rotated_token_and_cache(tmp_path, monkeypatch) -> None:
    original = tmp_path / "oriented.jpg"
    overlay = tmp_path / "overlay.png"
    tokens_path = tmp_path / "tokens.json"
    Image.new("RGB", (600, 400), "white").save(original)
    Image.new("RGB", (600, 400), "white").save(overlay)
    token = {
        "id": "E001", "raw_text": "0781", "normalized_candidates": ["0781"],
        "confidence": 0.8,
        "bbox": ImageBBox(x_min=100, y_min=100, x_max=160, y_max=360).model_dump(),
        "coordinate_transform": {},
    }
    tokens_path.write_text(
        '{"schema_version":7,"engine":"paddle","tokens":[]}', encoding="utf-8",
    )
    assist = {
        "oriented_original": original, "overlay": overlay, "tokens_path": tokens_path,
        "tokens": [token], "vision_refined": False,
    }
    monkeypatch.setattr(settings, "read_model", "glm-4v-flash")

    async def fake_request(*_args, **_kwargs):
        return '{"tokens":[{"id":"E001","rotation_degrees":90,"text":"1840","confidence":0.95}]}'

    monkeypatch.setattr(ai, "_request_content", fake_request)
    refined = await ai._refine_ocr_with_vision(
        httpx.AsyncClient(), "endpoint", {}, assist, [],
    )

    assert refined["tokens"][0]["raw_text"] == "1840"
    assert refined["tokens"][0]["coordinate_transform"]["vision_rotation_degrees"] == 90
    assert '"vision_refined": true' in tokens_path.read_text(encoding="utf-8")


def test_ocr_assist_content_includes_overlay_tokens_and_crops(tmp_path, monkeypatch) -> None:
    overlay = tmp_path / "ocr-overlay.png"
    crop = tmp_path / "E001.png"
    Image.new("RGB", (20, 20), "white").save(overlay)
    Image.new("RGB", (20, 20), "white").save(crop)
    monkeypatch.setattr(ai, "_image_path_data_url", lambda *_args, **_kwargs: "data:image/jpeg;base64,test")

    content = ai._ocr_assist_content(
        {
            "image_hash": "abc123",
            "overlay": overlay,
            "tokens": [
                {
                    "id": "E001",
                    "raw_text": "1840",
                    "normalized_candidates": ["1840"],
                    "bbox": ImageBBox(x_min=1, y_min=2, x_max=3, y_max=4).model_dump(),
                    "orientation": "horizontal",
                    "confidence": 0.88,
                }
            ],
            "crops": [crop],
        }
    )

    text_blocks = [item["text"] for item in content if item["type"] == "text"]
    assert "abc123" in text_blocks[0]
    assert "E001" in text_blocks[0]
    assert sum(item["type"] == "image_url" for item in content) == 2

    hosted_content = ai._ocr_assist_content(
        {
            "image_hash": "abc123",
            "overlay": overlay,
            "tokens": [],
            "crops": [crop, crop, crop],
        },
        include_images=False,
    )
    assert sum(item["type"] == "image_url" for item in hosted_content) == 0


@pytest.mark.asyncio
async def test_fast_topology_selection_uses_only_flash_model(monkeypatch) -> None:
    monkeypatch.setattr(settings, "read_model", "glm-4v-flash")
    monkeypatch.setattr(settings, "ai_compare_topology_models", True)
    monkeypatch.setattr(ai, "image_data_url", lambda *_args, **_kwargs: "original")
    monkeypatch.setattr(ai, "_enhanced_plan_data_url", lambda *_args, **_kwargs: "enhanced")
    monkeypatch.setattr(ai, "_topology_candidate_sheet", lambda *_args, **_kwargs: "sheet")
    monkeypatch.setattr(ai, "_write_trace", lambda *_args, **_kwargs: None)
    candidates = [
        TopologyCandidate(id="C1", corners=[ShapeCorner(x=100, y=100), ShapeCorner(x=800, y=100), ShapeCorner(x=800, y=800), ShapeCorner(x=100, y=800)]),
        TopologyCandidate(id="C2", corners=[ShapeCorner(x=100, y=100), ShapeCorner(x=500, y=100), ShapeCorner(x=500, y=250), ShapeCorner(x=800, y=250), ShapeCorner(x=800, y=800), ShapeCorner(x=100, y=800)]),
    ]
    calls: list[tuple[str, str, str, str]] = []

    async def fake_selection(_client, _endpoint, _headers, original, enhanced, sheet, _candidates, model, _trace_ids, **_kwargs):
        calls.append((model, original, enhanced, sheet))
        selected = "C1"
        return TopologyCandidateSelection(selected_id=selected, accepted=True, confidence=0.9)

    monkeypatch.setattr(ai, "_resolve_topology_candidate_selection", fake_selection)
    shape = await ai._select_raster_topology(None, "endpoint", {}, __import__("pathlib").Path("unused"), 0, candidates, [])

    assert shape is not None
    assert shape.corners == candidates[0].corners
    assert calls == [("glm-4v-flash", "original", "enhanced", "sheet")]


@pytest.mark.asyncio
async def test_fast_topology_selection_retries_unexplained_zero_confidence_rejection(monkeypatch) -> None:
    monkeypatch.setattr(ai, "image_data_url", lambda *_args, **_kwargs: "original")
    monkeypatch.setattr(ai, "_enhanced_plan_data_url", lambda *_args, **_kwargs: "enhanced")
    monkeypatch.setattr(ai, "_topology_candidate_sheet", lambda *_args, **_kwargs: "sheet")
    monkeypatch.setattr(ai, "_write_trace", lambda *_args, **_kwargs: None)
    candidates = [
        TopologyCandidate(id="C1", corners=[
            ShapeCorner(x=100, y=100), ShapeCorner(x=800, y=100),
            ShapeCorner(x=800, y=800), ShapeCorner(x=100, y=800),
        ]),
    ]
    calls: list[str] = []

    async def fake_selection(_client, _endpoint, _headers, _original, _enhanced, _sheet, _candidates, model, _trace_ids, **_kwargs):
        calls.append(model)
        if model == "legacy-flash":
            return TopologyCandidateSelection(accepted=False, confidence=0, missing_features=[])
        return TopologyCandidateSelection(selected_id="C1", accepted=True, confidence=0.88)

    monkeypatch.setattr(ai, "_resolve_topology_candidate_selection", fake_selection)
    shape = await ai._select_raster_topology(
        None, "endpoint", {}, __import__("pathlib").Path("unused"), 0, candidates, [],
        ["legacy-flash", "current-flash"],
    )

    assert shape is not None
    assert shape.corners == candidates[0].corners
    assert calls == ["legacy-flash", "current-flash"]


def test_orthogonalization_removes_only_two_axis_small_spikes() -> None:
    noisy = np.array(
        [(0, 0), (100, 0), (100, 40), (92, 40), (92, 48), (100, 48), (100, 100), (0, 100)],
        dtype="int32",
    ).reshape((-1, 1, 2))
    real_return = np.array(
        [(0, 0), (100, 0), (100, 40), (92, 40), (92, 60), (100, 60), (100, 100), (0, 100)],
        dtype="int32",
    ).reshape((-1, 1, 2))

    assert ai._orthogonalize_contour(noisy, minimum_edge=1, spike_limit=10) == [
        (0, 0), (100, 0), (100, 100), (0, 100),
    ]
    assert len(ai._orthogonalize_contour(real_return, minimum_edge=1, spike_limit=10)) == 8


def test_partial_door_wall_chain_does_not_override_overall_width() -> None:
    roles = CriticalDimensionRoles()
    partial = BoundaryChainResult(
        wall_side="left",
        wall_orientation="vertical",
        traversal="top_to_bottom",
        complete=False,
        segments=[
            BoundaryChainSegment(value_mm=400, purpose="wall_segment"),
            BoundaryChainSegment(value_mm=800, purpose="door_opening"),
            BoundaryChainSegment(value_mm=55, purpose="gap"),
        ]
    )
    assert ai._merge_door_wall_chain(roles, partial, visual_report()) is False
    assert roles.overall_width_segments == []
    assert roles.door_width and roles.door_width.value_mm == 800


def test_evidence_backed_edge_chain_requires_return_citations() -> None:
    report = visual_report()
    report.evidence.append(
        VisualEvidence(
            id="return-220", kind="dimension", text="220",
            bbox=ImageBBox(x_min=650, y_min=650, x_max=700, y_max=720),
        )
    )
    edges = [
        BoundaryEdge(direction="right", length_mm=1200, evidence_ids=["wall-x"]),
        BoundaryEdge(direction="up", length_mm=220, role="door_jamb", evidence_ids=["return-220"]),
        BoundaryEdge(direction="right", length_mm=55, role="structure_return", evidence_ids=["door-width"]),
        BoundaryEdge(direction="right", length_mm=2855, evidence_ids=["wall-x"]),
        BoundaryEdge(direction="up", length_mm=1620, evidence_ids=["wall-z"]),
        BoundaryEdge(direction="left", length_mm=4110, evidence_ids=["wall-x"]),
        BoundaryEdge(direction="down", length_mm=1840, evidence_ids=["wall-z"]),
    ]
    assert ai._edge_chain_is_evidence_backed(edges, report)
    edges[1].evidence_ids = []
    assert not ai._edge_chain_is_evidence_backed(edges, report)


def test_boundary_chain_discards_non_axis_dimension_segments() -> None:
    result = BoundaryChainResult.model_validate(
        {
            "segments": [
                {"value_mm": 400, "purpose": "wall_segment"},
                {"value_mm": 2055, "purpose": "door_height"},
                {"value_mm": 120, "purpose": "door_thickness"},
            ]
        }
    )

    assert [segment.value_mm for segment in result.segments] == [400]
    assert any("door_height" in item and "door_thickness" in item for item in result.uncertain)


def test_door_wall_returns_must_exist_in_edge_chain() -> None:
    expected = [
        BoundaryReturn(
            position="after_door", direction="up", value_mm=220,
            evidence_ids=["return-220"],
        )
    ]
    matching = [
        BoundaryEdge(
            direction="up", length_mm=220, role="door_jamb",
            evidence_ids=["return-220"],
        )
    ]
    assert ai._edge_chain_contains_returns(matching, expected)
    assert not ai._edge_chain_contains_returns([], expected)


def test_invalid_model_geometry_is_rejected_before_persisting() -> None:
    spec = RoomSpec(
        boundary=[
            Point2D(x_mm=0, z_mm=0),
            Point2D(x_mm=1590, z_mm=0),
            Point2D(x_mm=1590, z_mm=1840),
            Point2D(x_mm=0, z_mm=1840),
        ],
        height_mm=2100,
        openings=[
            OpeningSpec(
                id="bad-door", kind="door", wall_index=0, offset_mm=400,
                width_mm=2855, height_mm=2055, label="门",
            )
        ],
    )
    with pytest.raises(ai.AIResponseError, match="门 超出所属墙面"):
        ai._ensure_usable_geometry(spec)


def test_door_dimension_chain_uses_arc_host_before_false_detour() -> None:
    edges = [
        BoundaryEdge(direction="down", length_mm=1760),
        BoundaryEdge(direction="right", length_mm=830),
        BoundaryEdge(direction="up", length_mm=247),
        BoundaryEdge(direction="right", length_mm=1570),
        BoundaryEdge(direction="up", length_mm=1808),
        BoundaryEdge(direction="left", length_mm=996),
    ]
    ocr_assist = {
        "tokens": [
            {
                "id": "TV001",
                "raw_text": "D1 CG 0 CK 300 CH 2055",
                "confidence": 0.5,
                "template_visual": True,
                "semantic_role": "door_size",
                "bbox": {"x_min": 0, "y_min": 0, "x_max": 1000, "y_max": 1000},
            },
            {
                "id": "TV004",
                "raw_text": "400",
                "template_visual": True,
                "semantic_role": "wall_segment",
                "bbox": {"x_min": 80, "y_min": 888, "x_max": 120, "y_max": 916},
            },
            {
                "id": "TV005",
                "raw_text": "800",
                "template_visual": True,
                "semantic_role": "wall_segment",
                "bbox": {"x_min": 200, "y_min": 888, "x_max": 240, "y_max": 916},
            },
            {
                "id": "TV006",
                "raw_text": "55",
                "template_visual": True,
                "semantic_role": "wall_segment",
                "bbox": {"x_min": 280, "y_min": 888, "x_max": 300, "y_max": 916},
            },
        ],
    }

    [opening] = ai._opening_specs_from_dimension_chain_tokens(ocr_assist, edges)

    assert opening.wall_index == 1
    assert opening.offset_mm == 30
    assert opening.width_mm == 800
    assert opening.evidence_ids == ["TV001", "TV004", "TV005", "TV006"]


def test_fixture_kind_from_model_is_normalized() -> None:
    fixture = FixtureCandidate(kind="washing machine floor drain", label="洗衣机地漏")
    assert fixture.kind == "floor_drain"
    heating = FixtureCandidate(kind="heating", label="暖气")
    assert heating.kind == "other"


@pytest.mark.asyncio
async def test_rate_limit_is_retried(monkeypatch) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, json={"error": {"code": "1305", "message": "busy"}}, request=request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]}, request=request)

    monkeypatch.setattr(settings, "ai_max_retries", 1)
    monkeypatch.setattr(settings, "ai_retry_base_seconds", 0)
    monkeypatch.setattr(settings, "ai_trace_enabled", False)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        response = await ai._post_with_retry(
            client,
            "https://example.test/chat/completions",
            {},
            {"model": "glm-4.6v-flash", "messages": []},
            "test-rate-limit",
        )
    assert response.status_code == 200
    assert calls == 2
