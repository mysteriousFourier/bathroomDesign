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
    TopologyCandidate,
    TopologyCandidateSelection,
    VisualEvidence,
)


def valid_spec() -> RoomSpec:
    return RoomSpec(
        boundary=[Point2D(x_mm=0, z_mm=0), Point2D(x_mm=1800, z_mm=0), Point2D(x_mm=1800, z_mm=2400)],
        height_mm=2600,
    )


def test_agen17_long_term_real_sample_is_persisted_and_orientable() -> None:
    sample_dir = Path(__file__).resolve().parents[2] / "evidence" / "samples" / "real" / "agen-17-long-term"
    image_path = sample_dir / "source.jpg"
    manifest_path = sample_dir / "manifest.json"

    assert image_path.exists()
    assert manifest_path.exists()

    oriented = ai._oriented_image(image_path)
    assert oriented.size == (3024, 4032)
    assert oriented.mode == "RGB"


@pytest.mark.asyncio
async def test_primary_failure_falls_back(monkeypatch) -> None:
    monkeypatch.setattr(settings, "openai_base_url", "https://example.test/v1")
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    monkeypatch.setattr(settings, "openai_model", "glm-4.6v-flash")
    monkeypatch.setattr(settings, "openai_fallback_model", "glm-4v-flash")
    calls: list[str] = []

    async def fake_chat_once(_client, _endpoint, _headers, _content, model):
        calls.append(model)
        if model == "glm-4.6v-flash":
            raise ai.AIResponseError("主模型不可用")
        return valid_spec()

    monkeypatch.setattr(ai, "_chat_once", fake_chat_once)
    result = await ai._chat([])
    assert result.height_mm == 2600
    assert calls == ["glm-4.6v-flash", "glm-4v-flash"]


@pytest.mark.asyncio
async def test_auth_failure_does_not_retry_fallback(monkeypatch) -> None:
    monkeypatch.setattr(settings, "openai_base_url", "https://example.test/v1")
    monkeypatch.setattr(settings, "openai_api_key", "bad-key")
    monkeypatch.setattr(settings, "openai_model", "glm-4.6v-flash")
    monkeypatch.setattr(settings, "openai_fallback_model", "glm-4v-flash")
    calls: list[str] = []

    async def fake_chat_once(_client, _endpoint, _headers, _content, model):
        calls.append(model)
        raise ai.AIAuthenticationError("鉴权失败")

    monkeypatch.setattr(ai, "_chat_once", fake_chat_once)
    with pytest.raises(ai.AIAuthenticationError):
        await ai._chat([])
    assert calls == ["glm-4.6v-flash"]


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
    boundary = ai._edge_chain_to_boundary(edges)
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
    assert ai._edge_chain_to_boundary(edges)


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


def test_shape_trace_scales_non_rectangular_boundary_to_measured_span() -> None:
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

    boundary = ai._shape_trace_to_boundary(shape, 3200, 2400)

    assert len(boundary) == 6
    assert max(point.x_mm for point in boundary) == 3200
    assert max(point.z_mm for point in boundary) == 2400
    assert {(point.x_mm, point.z_mm) for point in boundary} == {
        (0, 0), (3200, 0), (3200, 2400), (2000, 2400), (2000, 1650), (0, 1650),
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
        "vision_refined": True,
        "tokens": [{"id": "E001", "raw_text": "6500"}],
    }), encoding="utf-8")

    assert ai._load_refined_ocr_cache(source, 0) is not None
    assert ai._load_refined_ocr_cache(other, 0) is None

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
    monkeypatch.setattr(settings, "openai_model", "")

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
    monkeypatch.setattr(settings, "openai_model", "vision-test")
    monkeypatch.setattr(settings, "openai_quality_model", "")
    monkeypatch.setattr(settings, "openai_fallback_model", "")
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
    monkeypatch.setattr(settings, "openai_fallback_model", "glm-4v-flash")

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
async def test_fast_topology_selection_does_not_call_quality_model(monkeypatch) -> None:
    monkeypatch.setattr(settings, "openai_model", "glm-4.6v-flash")
    monkeypatch.setattr(settings, "openai_quality_model", "glm-4.6v")
    monkeypatch.setattr(settings, "openai_fallback_model", "glm-4v-flash")
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
        selected = "C2" if model == "glm-4.6v" else "C1"
        return TopologyCandidateSelection(selected_id=selected, accepted=True, confidence=0.9)

    monkeypatch.setattr(ai, "_resolve_topology_candidate_selection", fake_selection)
    shape = await ai._select_raster_topology(None, "endpoint", {}, __import__("pathlib").Path("unused"), 0, candidates, [])

    assert shape is not None
    assert shape.corners == candidates[0].corners
    assert calls == [("glm-4.6v-flash", "original", "enhanced", "sheet")]


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
