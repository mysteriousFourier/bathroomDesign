from __future__ import annotations

import asyncio
import json

import pytest
from PIL import Image

from backend.app import ai
from backend.app.config import settings
from backend.app.models import BoundaryEdge, ImageBBox, ShapeCorner, ShapeTraceResult, TopologyCandidate


def rectangle_shape() -> ShapeTraceResult:
    return ShapeTraceResult(
        corners=[
            ShapeCorner(x=100, y=100),
            ShapeCorner(x=900, y=100),
            ShapeCorner(x=900, y=900),
            ShapeCorner(x=100, y=900),
        ],
        closed=True,
    )


def test_runtime_topology_prompts_do_not_contain_sample_answers() -> None:
    prompts = (ai.PLAN_TOPOLOGY_AUDIT_PROMPT, ai.SEGMENT_EDGE_CHAIN_PROMPT)

    for prompt in prompts:
        assert "2855" not in prompt
        assert "5582" not in prompt


def shape_with_short_returns() -> ShapeTraceResult:
    return ShapeTraceResult(
        corners=[
            ShapeCorner(x=100, y=100),
            ShapeCorner(x=900, y=100),
            ShapeCorner(x=900, y=800),
            ShapeCorner(x=500, y=800),
            ShapeCorner(x=500, y=819),
            ShapeCorner(x=300, y=819),
            ShapeCorner(x=300, y=800),
            ShapeCorner(x=100, y=800),
        ],
        closed=True,
    )


def test_wall_crop_specs_cover_wall_and_both_normal_sides() -> None:
    specs = ai._wall_crop_specs(rectangle_shape())

    assert [item["wall_id"] for item in specs] == ["W0", "W1", "W2", "W3"]
    assert specs[0]["orientation"] == "horizontal"
    assert specs[0]["bbox"] == ImageBBox(x_min=35, y_min=0, x_max=965, y_max=310)
    assert specs[1]["orientation"] == "vertical"
    assert specs[1]["bbox"] == ImageBBox(x_min=690, y_min=35, x_max=1000, y_max=965)


def test_short_returns_are_in_both_neighboring_crop_contexts() -> None:
    specs = ai._wall_crop_specs(shape_with_short_returns())
    by_id = {spec["wall_id"]: spec for spec in specs}

    assert "W3" not in by_id
    assert "W5" not in by_id
    assert [wall["wall_id"] for wall in by_id["W2"]["context_walls"]] == ["W3"]
    assert [wall["wall_id"] for wall in by_id["W4"]["context_walls"]] == ["W3", "W5"]
    assert [wall["wall_id"] for wall in by_id["W6"]["context_walls"]] == ["W5"]

    observations = ai._wall_crop_observations(
        {
            "observations": [
                {
                    "text": "120",
                    "bbox": {"x_min": 400, "y_min": 400, "x_max": 600, "y_max": 600},
                    "role": "wall_segment",
                    "scope": "single_wall",
                    "wall_id": "W3",
                    "span_start": 0.0,
                    "span_end": 1.0,
                    "confidence": 0.9,
                }
            ]
        },
        by_id["W2"],
    )

    assert observations[0]["target_id"] == "wall:3@0.500"
    assert observations[0]["wall_crop_candidates"][0]["wall_id"] == "W3"


def test_wall_crop_bbox_maps_back_to_full_image_coordinates() -> None:
    mapped = ai._map_wall_crop_bbox(
        ImageBBox(x_min=100, y_min=200, x_max=500, y_max=800),
        ImageBBox(x_min=250, y_min=100, x_max=750, y_max=900),
    )

    assert mapped == ImageBBox(x_min=200, y_min=260, x_max=400, y_max=740)


def test_cross_wall_dimension_is_not_forced_onto_current_wall() -> None:
    spec = ai._wall_crop_specs(rectangle_shape())[0]
    observations = ai._wall_crop_observations(
        {
            "observations": [
                {
                    "text": "260+1640+615+1590",
                    "bbox": {"x_min": 100, "y_min": 100, "x_max": 850, "y_max": 300},
                    "role": "room_dimension",
                    "scope": "boundary_span",
                    "span_start": 0.1,
                    "span_end": 0.9,
                    "confidence": 0.91,
                },
                {
                    "text": "4105",
                    "bbox": {"x_min": 100, "y_min": 400, "x_max": 300, "y_max": 600},
                    "role": "room_dimension",
                    "scope": "overall_width",
                    "span_start": None,
                    "span_end": None,
                    "confidence": 0.93,
                },
            ]
        },
        spec,
    )

    assert observations[0]["target_id"] is None
    assert observations[0]["review_required"] is True
    assert observations[1]["semantic_role"] == "wall_segment"
    assert observations[1]["dimension_scope"] == "boundary_span"
    assert observations[1]["target_id"] is None
    assert observations[1]["review_required"] is True


def test_conflicting_overlapping_wall_bindings_require_review() -> None:
    assist = {"tokens": []}
    base = {
        "raw_text": "800",
        "normalized_candidates": ["800"],
        "bbox": ImageBBox(x_min=400, y_min=400, x_max=500, y_max=500).model_dump(),
        "orientation": "horizontal",
        "engine": "wall-crop-vision",
        "semantic_role": "wall_segment",
        "dimension_scope": "single_wall",
        "review_required": False,
        "wall_crop_vision": True,
    }
    first = {
        **base,
        "confidence": 0.92,
        "target_id": "wall:0@0.500",
        "wall_crop_candidates": [
            {
                "wall_id": "W0", "target_id": "wall:0@0.500", "role": "wall_segment",
                "scope": "single_wall", "confidence": 0.92,
            }
        ],
    }
    second = {
        **base,
        "confidence": 0.87,
        "target_id": "wall:1@0.500",
        "wall_crop_candidates": [
            {
                "wall_id": "W1", "target_id": "wall:1@0.500", "role": "wall_segment",
                "scope": "single_wall", "confidence": 0.87,
            }
        ],
    }

    ai._merge_wall_crop_observations(assist, [first, second])

    assert len(assist["tokens"]) == 1
    assert assist["tokens"][0]["target_id"] is None
    assert assist["tokens"][0]["review_required"] is True


def test_new_wall_crop_token_uses_next_available_evidence_id() -> None:
    assist = {
        "tokens": [
            {
                "id": "E003",
                "raw_text": "old",
                "bbox": ImageBBox(x_min=0, y_min=0, x_max=50, y_max=50).model_dump(),
            }
        ]
    }
    observation = {
        "raw_text": "800",
        "normalized_candidates": ["800"],
        "bbox": ImageBBox(x_min=500, y_min=500, x_max=600, y_max=600).model_dump(),
        "orientation": "horizontal",
        "confidence": 0.9,
        "engine": "wall-crop-vision",
        "semantic_role": "wall_segment",
        "dimension_scope": "single_wall",
        "target_id": "wall:0@0.500",
        "wall_crop_candidates": [
            {
                "wall_id": "W0", "target_id": "wall:0@0.500", "role": "wall_segment",
                "scope": "single_wall", "confidence": 0.9,
            }
        ],
        "review_required": False,
        "wall_crop_vision": True,
    }

    ai._merge_wall_crop_observations(assist, [observation])

    assert [token["id"] for token in assist["tokens"]] == ["E003", "E004"]


def test_segment_mode_does_not_infer_room_extents_from_unbound_numbers() -> None:
    shape = rectangle_shape()
    assist = {
        "tokens": [
            {
                "id": "E001", "raw_text": "9876", "normalized_candidates": ["9876"],
                "bbox": ImageBBox(x_min=100, y_min=100, x_max=180, y_max=150).model_dump(),
                "confidence": 0.99,
            },
            {
                "id": "E002", "raw_text": "5432", "normalized_candidates": ["5432"],
                "bbox": ImageBBox(x_min=700, y_min=700, x_max=780, y_max=750).model_dump(),
                "confidence": 0.99,
            },
        ],
        "rotation_degrees": 0,
    }
    edges = [
        BoundaryEdge(direction=direction)
        for direction in ("right", "down", "left", "up")
    ]

    spec = ai._provisional_room_spec(
        shape, assist, allow_incomplete_annotation=True, edge_chain=edges,
    )

    assert spec is not None
    assert spec.boundary == []
    assert all(token.get("target_id") is None for token in assist["tokens"])
    assert all(token["semantic_role"] == "wall_segment" for token in assist["tokens"])


def test_segment_seed_accepts_only_full_wall_vision_spans() -> None:
    shape = rectangle_shape()
    assist = {
        "tokens": [
            {
                "id": "E001",
                "raw_text": "3000",
                "wall_crop_vision": True,
                "wall_crop_candidates": [
                    {
                        "wall_id": "W0", "target_id": "wall:0@0.500", "text": "3000",
                        "role": "wall_segment", "scope": "single_wall",
                        "span_start": 0.0, "span_end": 1.0, "confidence": 0.93,
                    }
                ],
            },
            {
                "id": "E002",
                "raw_text": "900",
                "wall_crop_vision": True,
                "wall_crop_candidates": [
                    {
                        "wall_id": "W1", "target_id": "wall:1@0.300", "text": "900",
                        "role": "wall_segment", "scope": "single_wall",
                        "span_start": 0.2, "span_end": 0.4, "confidence": 0.95,
                    }
                ],
            },
        ]
    }

    edges = ai._seed_segment_edge_chain(shape, assist)

    assert edges[0].length_mm == 3000
    assert edges[0].evidence_ids == ["E001"]
    assert edges[1].length_mm is None
    assert edges[2].length_mm is None
    assert edges[3].length_mm is None


def test_segment_chain_rejects_length_without_matching_wall_evidence() -> None:
    shape = rectangle_shape()
    assist = {
        "tokens": [
            {
                "id": "E001", "raw_text": "3000", "alternate_readings": [],
                "target_id": "wall:1@0.500",
            }
        ]
    }
    proposed = [
        BoundaryEdge(direction="right", length_mm=3000, evidence_ids=["E001"], confidence=0.95),
        BoundaryEdge(direction="down"),
        BoundaryEdge(direction="left"),
        BoundaryEdge(direction="up"),
    ]

    validated = ai._validated_segment_edge_chain(proposed, shape, assist)

    assert validated[0].length_mm is None
    assert validated[0].evidence_ids == []


@pytest.mark.asyncio
async def test_wall_crop_recognition_is_bounded_concurrent_and_cached(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.jpg"
    overlay = tmp_path / "overlay.png"
    tokens_path = tmp_path / "tokens.json"
    Image.new("RGB", (800, 800), "white").save(source)
    Image.new("RGB", (800, 800), "white").save(overlay)
    tokens_path.write_text('{"schema_version":9,"engine":"paddle","tokens":[]}', encoding="utf-8")
    assist = {
        "image_hash": "sample",
        "oriented_original": source,
        "overlay": overlay,
        "tokens_path": tokens_path,
        "tokens": [],
        "rotation_degrees": 0,
    }
    active = 0
    max_active = 0
    calls = 0
    called_models: list[str] = []

    async def fake_request(_client, _endpoint, _headers, messages, model, **_kwargs):
        nonlocal active, max_active, calls
        calls += 1
        called_models.append(model)
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return json.dumps(
            {
                "observations": [
                    {
                        "text": "1840",
                        "bbox": {"x_min": 450, "y_min": 450, "x_max": 550, "y_max": 550},
                        "role": "wall_segment",
                        "scope": "single_wall",
                        "span_start": 0.2,
                        "span_end": 0.4,
                        "confidence": 0.92,
                    }
                ]
            }
        )

    monkeypatch.setattr(ai, "_request_content", fake_request)
    monkeypatch.setattr(settings, "openai_model", "vision-test")
    monkeypatch.setattr(settings, "openai_quality_model", "quality-test")
    monkeypatch.setattr(settings, "openai_fallback_model", "")
    monkeypatch.setattr(settings, "ai_wall_crop_concurrency", 2)

    result = await ai._recognize_wall_crops_with_vision(
        None, "endpoint", {}, source, 0, rectangle_shape(), assist, [],
    )

    assert calls == 4
    assert set(called_models) == {"quality-test"}
    assert max_active == 2
    assert len(result["tokens"]) == 4
    assert {token["target_id"].split("@")[0] for token in result["tokens"]} == {
        "wall:0", "wall:1", "wall:2", "wall:3",
    }
    cached = json.loads(tokens_path.read_text(encoding="utf-8"))
    assert cached["wall_crop_refined"] is True
    assert cached["wall_crop_shape_hash"] == ai._shape_signature(rectangle_shape())
    assert cached["wall_crop_cache_version"] == ai.WALL_CROP_CACHE_VERSION

    await ai._recognize_wall_crops_with_vision(
        None, "endpoint", {}, source, 0, rectangle_shape(), assist, [],
    )
    assert calls == 4


@pytest.mark.asyncio
async def test_wall_crop_recognition_propagates_authentication_failure(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.jpg"
    overlay = tmp_path / "overlay.png"
    tokens_path = tmp_path / "tokens.json"
    Image.new("RGB", (800, 800), "white").save(source)
    Image.new("RGB", (800, 800), "white").save(overlay)
    tokens_path.write_text('{"schema_version":9,"engine":"paddle","tokens":[]}', encoding="utf-8")
    assist = {
        "image_hash": "sample",
        "oriented_original": source,
        "overlay": overlay,
        "tokens_path": tokens_path,
        "tokens": [],
        "rotation_degrees": 0,
    }

    async def reject_request(*_args, **_kwargs):
        raise ai.AIAuthenticationError("invalid key")

    monkeypatch.setattr(ai, "_request_content", reject_request)
    monkeypatch.setattr(settings, "openai_model", "vision-test")
    monkeypatch.setattr(settings, "openai_fallback_model", "")

    with pytest.raises(ai.AIAuthenticationError, match="invalid key"):
        await ai._recognize_wall_crops_with_vision(
            None, "endpoint", {}, source, 0, rectangle_shape(), assist, [],
        )


@pytest.mark.asyncio
async def test_fast_analysis_builds_shape_before_text_recognition(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.jpg"
    Image.new("RGB", (320, 240), "white").save(source)
    shape = rectangle_shape()
    candidate = TopologyCandidate(id="C1", corners=shape.corners, pixel_support=0.9)
    events: list[str] = []

    monkeypatch.setattr(ai, "_preferred_plan_rotation", lambda *_args: 0)
    monkeypatch.setattr(ai, "_raster_topology_candidates", lambda *_args, **_kwargs: [candidate])

    async def fake_shape(*_args, **_kwargs):
        events.append("shape")
        return shape

    async def fake_audit(*_args, **_kwargs):
        events.append("audit")
        return shape

    def fake_ocr(*_args, **_kwargs):
        events.append("ocr")
        return {"tokens": [], "rotation_degrees": 0}

    async def fake_wall(*args, **_kwargs):
        events.append("wall")
        return args[-2]

    async def fake_global(*args, **_kwargs):
        events.append("global")
        return args[-2]

    async def fake_binding(*_args, **_kwargs):
        events.append("bind")

    async def fake_edges(*_args, **_kwargs):
        events.append("edges")
        return []

    monkeypatch.setattr(ai, "_select_raster_topology", fake_shape)
    monkeypatch.setattr(ai, "_audit_shape_trace", fake_audit)
    monkeypatch.setattr(ai, "_prepare_ocr_assist", fake_ocr)
    monkeypatch.setattr(ai, "_recognize_wall_crops_with_vision", fake_wall)
    monkeypatch.setattr(ai, "_refine_ocr_with_vision", fake_global)
    monkeypatch.setattr(ai, "_refine_photo_annotation_bindings", fake_binding)
    monkeypatch.setattr(ai, "_resolve_segment_edge_chain", fake_edges)
    monkeypatch.setattr(settings, "openai_base_url", "https://example.test/v1")
    monkeypatch.setattr(settings, "openai_api_key", "key")
    monkeypatch.setattr(settings, "openai_model", "vision-test")
    monkeypatch.setattr(settings, "openai_fallback_model", "")

    spec = await ai.analyze_floorplan_fast(source)

    assert events == ["shape", "audit", "ocr", "wall", "global", "bind", "edges"]
    assert spec.plan_annotation.boundary == shape.corners
