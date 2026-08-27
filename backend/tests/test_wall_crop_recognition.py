from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from io import BytesIO

import numpy as np
import pytest
from PIL import Image

from backend.app import ai
from backend.app.config import settings
from backend.app.models import (
    BoundaryEdge,
    ImageBBox,
    PlanEvidenceReport,
    ShapeCorner,
    ShapeTraceResult,
    TopologyCandidate,
    TopologyCandidateSelection,
)


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
    prompts = (ai.SINGLE_PASS_PLAN_PROMPT, ai.PLAN_TOPOLOGY_AUDIT_PROMPT, ai.SEGMENT_EDGE_CHAIN_PROMPT)

    for prompt in prompts:
        for sample_value in ("615", "800", "1840", "2055", "2100", "2855", "5582"):
            assert sample_value not in prompt
    assert '"x_min":0,"y_min":0,"x_max":0,"y_max":0' not in ai.SINGLE_PASS_PLAN_PROMPT


def test_hough_line_segments_accepts_flat_and_nested_opencv_shapes() -> None:
    flat = np.array([[1, 2, 3, 4], [5, 6, 7, 8]], dtype=np.int32)
    nested = flat.reshape(2, 1, 4)

    assert ai._hough_line_segments(flat) == [(1, 2, 3, 4), (5, 6, 7, 8)]
    assert ai._hough_line_segments(nested) == [(1, 2, 3, 4), (5, 6, 7, 8)]


def test_ocr_rotation_candidates_skip_template_visual_tokens() -> None:
    bbox = {"x_min": 100, "y_min": 100, "x_max": 120, "y_max": 180}
    candidates = ai._ocr_rotation_candidates({
        "tokens": [
            {
                "id": "TV001",
                "raw_text": "D1 CG 0 CK 800 CH 2055",
                "bbox": bbox,
                "confidence": 1.0,
                "template_visual": True,
            },
            {
                "id": "E001",
                "raw_text": "4105",
                "bbox": bbox,
                "confidence": 0.8,
            },
        ]
    })

    assert [token["id"] for token in candidates] == ["E001"]


def test_upload_path_has_no_fixed_sample_dimension_strips() -> None:
    assert ai.TEMPLATE_DIMENSION_STRIP_VIEWS == []
    assert ai.TEMPLATE_DIMENSION_STRIP_REGIONS == {}


def test_single_pass_discards_legacy_visual_cache_tokens() -> None:
    assist = {"tokens": [
        {"id": "local", "engine": "paddle", "raw_text": "local"},
        {"id": "old-crop", "engine": "wall-crop-vision", "wall_crop_vision": True},
        {"id": "old-template", "engine": "template-vision", "template_visual": True},
    ]}

    ai._discard_legacy_visual_tokens(assist)

    assert [token["id"] for token in assist["tokens"]] == ["local"]


def test_single_pass_height_evidence_uses_structured_row_relation() -> None:
    assist = {
        "tokens": [{
            "id": "TV-height",
            "raw_text": "2550",
            "bbox": {"x_min": 840, "y_min": 340, "x_max": 900, "y_max": 380},
            "confidence": 0.95,
            "template_visual": True,
            "semantic_role": "room_height",
            "related_to": "room_height",
        }],
    }

    assert ai._ocr_room_height_hint(assist) == 2550


def test_single_pass_top_dimension_populates_the_top_wall() -> None:
    assist = {
        "tokens": [{
            "id": "TV001",
            "raw_text": "1475",
            "bbox": {"x_min": 420, "y_min": 35, "x_max": 500, "y_max": 75},
            "orientation": "horizontal",
            "confidence": 0.96,
            "template_visual": True,
            "semantic_role": "wall_segment",
            "related_to": "dimension_chain:top",
            "view_id": "full",
            "bbox_quality": "tight",
        }],
    }

    edges = ai._segment_edge_chain_from_visual_evidence(rectangle_shape(), assist)

    assert edges[0].direction == "right"
    assert edges[0].length_mm == 1475
    assert edges[0].evidence_ids == ["TV001"]


@pytest.mark.parametrize("door_form", ["sliding", "folding", "pocket"])
def test_non_arc_door_forms_create_an_opening_from_a_visual_wall_binding(door_form: str) -> None:
    assist = {
        "tokens": [{
            "id": "TV001",
            "raw_text": "D1 CG 0 CK 900 CH 2070",
            "confidence": 0.94,
            "target_id": "wall:0@0.20:0.50",
            "door_form": door_form,
        }],
    }
    edges = [
        BoundaryEdge(direction="right", length_mm=3000),
        BoundaryEdge(direction="down", length_mm=1800),
        BoundaryEdge(direction="left", length_mm=3000),
        BoundaryEdge(direction="up", length_mm=1800),
    ]

    openings = ai._opening_specs_from_tokens(assist, edges)

    assert len(openings) == 1
    assert openings[0].wall_index == 0
    assert openings[0].opening_form == door_form


def test_single_pass_links_door_symbol_form_to_the_measurement_row() -> None:
    report = PlanEvidenceReport(evidence=[
        {
            "id": "symbol",
            "kind": "opening",
            "text": "D1 推拉门",
            "bbox": {"x_min": 100, "y_min": 800, "x_max": 220, "y_max": 900},
            "related_to": "opening:D1",
            "target_id": "wall:0@0.20:0.50",
            "door_form": "sliding",
        },
        {
            "id": "row",
            "kind": "opening",
            "text": "D1 CG 0 CK 900 CH 2070",
            "bbox": {"x_min": 760, "y_min": 120, "x_max": 980, "y_max": 180},
            "related_to": "opening:D1",
        },
    ])
    assist = {"tokens": []}

    ai._merge_template_evidence(assist, report)

    row = next(token for token in assist["tokens"] if "CK 900" in token["raw_text"])
    assert row["target_id"] == "wall:0@0.20:0.50"
    assert row["door_form"] == "sliding"


def test_shape_dimension_strip_views_follow_wall_edges() -> None:
    shape = ShapeTraceResult(corners=[
        ShapeCorner(x=160, y=390),
        ShapeCorner(x=160, y=720),
        ShapeCorner(x=310, y=720),
        ShapeCorner(x=310, y=675),
        ShapeCorner(x=605, y=675),
        ShapeCorner(x=605, y=340),
        ShapeCorner(x=420, y=340),
        ShapeCorner(x=420, y=420),
        ShapeCorner(x=350, y=420),
        ShapeCorner(x=350, y=345),
        ShapeCorner(x=195, y=345),
        ShapeCorner(x=195, y=390),
    ], closed=True)

    views = ai._shape_dimension_strip_views(shape)

    assert len(views) == 12
    by_id = {view_id: (region, orientation) for view_id, region, orientation in views}
    bottom_region, bottom_orientation = by_id["wall-1-h"]
    assert bottom_orientation == "horizontal"
    assert bottom_region.x_min <= 45
    assert bottom_region.x_max >= 425
    assert bottom_region.y_min <= 545
    assert bottom_region.y_max >= 895
    left_region, left_orientation = by_id["wall-0-v"]
    assert left_orientation == "vertical"
    assert left_region.x_min == 0
    assert left_region.x_max >= 330


def test_extract_evidence_report_accepts_top_level_arrays() -> None:
    report = ai._extract_evidence_report(
        '[{"id":"S1","kind":"dimension","text":"2855",'
        '"bbox":{"x_min":300,"y_min":200,"x_max":500,"y_max":250},'
        '"orientation":"horizontal","related_to":"dimension_chain:bottom",'
        '"view_id":"strip","confidence":0.9}]'
    )

    assert [item.text for item in report.evidence] == ["2855"]

    wrapped = ai._extract_evidence_report(
        '[{"rotation_degrees":0,"evidence":[{"id":"S1","kind":"dimension","text":"4110",'
        '"bbox":{"x_min":300,"y_min":200,"x_max":500,"y_max":250},'
        '"orientation":"horizontal","related_to":"dimension_chain:bottom",'
        '"view_id":"strip","confidence":0.9}],"uncertain":[]}]'
    )

    assert [item.text for item in wrapped.evidence] == ["4110"]


def test_template_dimension_strip_rejects_unusable_bboxes() -> None:
    assert ai._dimension_bbox_is_usable("800", ImageBBox(x_min=200, y_min=888, x_max=240, y_max=916))
    assert not ai._dimension_bbox_is_usable("800", ImageBBox(x_min=290, y_min=880, x_max=500, y_max=1000))
    assert not ai._dimension_bbox_is_usable("400", ImageBBox(x_min=169, y_min=734, x_max=175, y_max=745))
    assert not ai._dimension_bbox_is_usable("1640", ImageBBox(x_min=315, y_min=280, x_max=332, y_max=336))
    assert not ai._dimension_bbox_is_usable("260", ImageBBox(x_min=148, y_min=377, x_max=161, y_max=395))


def test_coarse_template_bbox_is_ocr_only_not_wall_binding() -> None:
    coarse = ImageBBox(x_min=120, y_min=200, x_max=520, y_max=620)

    assert ai._template_bbox_quality("wall-3-h", coarse) == "coarse_strip"
    assert not ai._template_token_bbox_can_bind_wall({
        "raw_text": "2855",
        "bbox": coarse.model_dump(),
        "bbox_quality": "coarse_strip",
        "view_id": "wall-3-h",
        "orientation": "horizontal",
    })


def test_program_topology_fallback_keeps_supported_non_rectangular_candidate() -> None:
    candidates = [
        TopologyCandidate(
            id="C1",
            corners=[
                ShapeCorner(x=100, y=100), ShapeCorner(x=100, y=900),
                ShapeCorner(x=300, y=900), ShapeCorner(x=300, y=800),
                ShapeCorner(x=900, y=800), ShapeCorner(x=900, y=100),
            ],
            pixel_support=0.82,
        ),
        TopologyCandidate(
            id="C2",
            corners=[
                ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
                ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
            ],
            pixel_support=0.70,
        ),
    ]

    assert ai._program_topology_fallback(candidates).id == "C1"


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
    assert specs[0]["bbox"] == ImageBBox(x_min=35, y_min=0, x_max=965, y_max=235)
    assert specs[1]["orientation"] == "vertical"
    assert specs[1]["bbox"] == ImageBBox(x_min=765, y_min=35, x_max=1000, y_max=965)


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


def test_unresolved_four_digit_wall_crop_stays_local_and_requires_review() -> None:
    spec = ai._wall_crop_specs(rectangle_shape())[2]
    observations = ai._wall_crop_observations(
        [{
            "text": "2855",
            "bbox": {"x_min": 300, "y_min": 300, "x_max": 700, "y_max": 500},
            "role": "other",
            "scope": "unresolved",
            "wall_id": None,
            "span_start": None,
            "span_end": None,
            "confidence": 0.6,
        }],
        spec,
    )

    assert observations[0]["semantic_role"] == "wall_segment"
    assert observations[0]["target_id"] == "wall:2"
    assert observations[0]["review_required"] is True


def test_split_door_composite_keeps_repaired_height_candidate() -> None:
    assert ai._repair_door_composite("800X205X55X12") == "800X2055X120"
    assert "800X2055X120" in ai._ocr_candidates("800X205X55X12")


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


def test_explicit_wall_bindings_use_only_unambiguous_full_wall_segments() -> None:
    shape = rectangle_shape()
    assist = {"tokens": [
        {
            "id": "E001", "raw_text": "1840", "target_id": "wall:0", "confidence": 0.9,
            "wall_crop_candidates": [{
                "target_id": "wall:0@0.500", "text": "1840", "role": "wall_segment",
                "scope": "single_wall", "span_start": 0.0, "span_end": 1.0, "confidence": 0.9,
            }],
        },
        {
            "id": "E002", "raw_text": "400", "target_id": "wall:1@0.100", "confidence": 0.9,
            "wall_crop_candidates": [{
                "target_id": "wall:1@0.500", "text": "400", "role": "wall_thickness",
                "scope": "single_wall", "span_start": 0.0, "span_end": 1.0, "confidence": 0.9,
            }],
        },
        {
            "id": "E003", "raw_text": "019", "alternate_readings": ["610"],
            "wall_crop_candidates": [{
                "target_id": "wall:2@0.500", "text": "019", "role": "wall_segment",
                "scope": "single_wall", "span_start": 0.0, "span_end": 1.0, "confidence": 0.8,
            }],
        },
    ]}

    edges = ai._explicit_wall_segment_edge_chain(shape, assist)

    assert edges[0].length_mm == 1840
    assert edges[1].length_mm is None
    assert edges[2].length_mm == 610


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
        return json.dumps([
            {
                "text": "1840",
                "bbox": {"x_min": 450, "y_min": 450, "x_max": 550, "y_max": 550},
                "role": "wall_segment",
                "scope": "single_wall",
                "span_start": 0.2,
                "span_end": 0.4,
                "confidence": 0.92,
            }
        ])

    monkeypatch.setattr(ai, "_request_content", fake_request)
    monkeypatch.setattr(settings, "read_model", "vision-test")
    monkeypatch.setattr(settings, "ai_wall_crop_concurrency", 2)

    result = await ai._recognize_wall_crops_with_vision(
        None, "endpoint", {}, source, 0, rectangle_shape(), assist, [],
    )

    assert calls == 4
    assert set(called_models) == {"vision-test"}
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
    monkeypatch.setattr(settings, "read_model", "vision-test")

    with pytest.raises(ai.AIAuthenticationError, match="invalid key"):
        await ai._recognize_wall_crops_with_vision(
            None, "endpoint", {}, source, 0, rectangle_shape(), assist, [],
        )


@pytest.mark.asyncio
async def test_single_pass_reader_sends_one_dimension_request(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.jpg"
    Image.new("RGB", (3200, 2400), "white").save(source)
    shape = rectangle_shape()
    candidate = TopologyCandidate(id="C1", corners=shape.corners, pixel_support=0.9)
    calls: list[dict] = []

    async def fake_request(*args, **kwargs):
        calls.append({"args": args, "kwargs": kwargs})
        return json.dumps({
            "selected_id": "C1",
            "accepted": True,
            "confidence": 0.93,
            "missing_features": [],
            "evidence": [{
                "id": "top-1",
                "kind": "dimension",
                "text": "1475",
                "bbox": {"x_min": 420, "y_min": 35, "x_max": 500, "y_max": 75},
                "orientation": "horizontal",
                "related_to": "dimension_chain:top",
                "view_id": "full",
                "confidence": 0.95,
            }],
            "uncertain": [],
        })

    monkeypatch.setattr(ai, "_request_content", fake_request)
    monkeypatch.setattr(settings, "read_model", "quality-vision-test")

    selection, report = await ai._recognize_plan_single_pass(
        None, "endpoint", {}, source, 0, [candidate], [],
    )

    assert len(calls) == 1
    assert all(call["kwargs"]["max_retries"] == 0 for call in calls)
    messages = calls[0]["args"][3]
    user_content = messages[1]["content"]
    image_items = [item for item in user_content if item.get("type") == "image_url"]
    assert len(image_items) == 1
    encoded = image_items[0]["image_url"]["url"].split(",", 1)[1]
    image = Image.open(BytesIO(base64.b64decode(encoded)))
    assert image.width <= 2048
    assert image.height <= 2048
    assert selection.selected_id == "C1"
    assert report.evidence[0].related_to == "dimension_chain:top"


@pytest.mark.asyncio
async def test_single_pass_reader_keeps_selection_when_one_evidence_item_is_invalid(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.jpg"
    Image.new("RGB", (320, 240), "white").save(source)
    candidate = TopologyCandidate(id="C1", corners=rectangle_shape().corners, pixel_support=0.9)

    async def fake_request(*_args, **_kwargs):
        return json.dumps({
            "selected_id": "C1",
            "accepted": True,
            "confidence": 0.9,
            "evidence": [{
                "id": "bad-kind",
                "kind": "measurement",
                "text": "1475",
                "bbox": {"x_min": 0, "y_min": 0, "x_max": 0, "y_max": 0},
            }, {
                "id": "door-cn",
                "kind": "门洞",
                "text": "D1 折叠门",
                "bbox": {"x_min": 300, "y_min": 700, "x_max": 400, "y_max": 820},
                "door_form": "折叠门",
                "target_id": "wall:2@0.15:0.5",
            }],
            "uncertain": [],
        })

    monkeypatch.setattr(ai, "_request_content", fake_request)
    monkeypatch.setattr(ai, "_enhanced_plan_data_url", lambda *_args: "data:image/jpeg;base64,enhanced")
    monkeypatch.setattr(ai, "_topology_candidate_sheet", lambda *_args: "data:image/jpeg;base64,candidates")
    monkeypatch.setattr(settings, "read_model", "quality-vision-test")

    selection, report = await ai._recognize_plan_single_pass(
        None, "endpoint", {}, source, 0, [candidate], [],
    )

    assert selection.selected_id == "C1"
    assert len(report.evidence) == 1
    assert report.evidence[0].door_form == "folding"
    assert report.evidence[0].target_id == "wall:2@0.15:0.5"
    assert any("格式无效证据" in item for item in report.uncertain)


@pytest.mark.asyncio
async def test_single_pass_reader_accepts_direct_structured_fields(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.jpg"
    Image.new("RGB", (640, 480), "white").save(source)

    async def fake_request(*_args, **_kwargs):
        return json.dumps({
            "edge_chain": [
                {"direction": "right", "length_mm": 3000, "evidence_text": "3000", "bbox": [300, 100, 360, 125]},
                {"direction": "down", "length_mm": 2000, "evidence_text": "2000", "bbox": [700, 300, 725, 360]},
                {"direction": "left", "length_mm": 3000, "evidence_text": "3000", "bbox": [300, 800, 360, 825]},
                {"direction": "up", "length_mm": 2000, "evidence_text": "2000", "bbox": [100, 300, 125, 360]},
            ],
            "dimension_chains": {
                "top": {"overall_mm": 3000, "segments_mm": [
                    {"value_mm": 1000, "bbox": [120, 80, 180, 105]},
                    {"value_mm": 800, "bbox": [300, 80, 360, 105]},
                    {"value_mm": 1200, "bbox": [500, 80, 560, 105]},
                ]},
                "right": {"overall_mm": 2000, "segments_mm": []},
                "bottom": {"overall_mm": 3000, "segments_mm": [
                    {"value_mm": 500, "bbox": [120, 880, 180, 905]},
                    {"value_mm": 800, "bbox": [300, 880, 360, 905]},
                    {"value_mm": 1700, "bbox": [500, 880, 560, 905]},
                ]},
                "left": {"overall_mm": 2000, "segments_mm": []},
                "recess": {"overall_mm": None, "segments_mm": []},
            },
            "heights": {
                "room_height_mm": 2500,
                "room_height_bbox": [820, 350, 910, 390],
                "overall_ceiling_mm": None,
                "local_beam_mm": None,
            },
            "opening_rows": [{
                "code": "D1", "CG": 0, "CK": 800, "CH": 2050,
                "bbox": [760, 135, 970, 172],
            }],
            "plan_openings": [{
                "code": "D1", "form": "hinged", "wall_side": "bottom", "edge_index": 2, "offset_mm": 500,
                "width_mm": 800, "height_mm": 2050, "bbox": [400, 760, 520, 900],
            }],
            "fixtures": [{
                "type": "floor_drain", "symbol": "circle_cross",
                "bbox": [310, 410, 330, 430], "confidence": 0.95,
            }, {
                "type": "electric", "symbol": "solid_dot",
                "bbox": [510, 610, 530, 630], "confidence": 0.9,
            }],
            "interior_lines": [{
                "kind": "pipe_chase", "label": "包管线",
                "points": [{"x": 300, "y": 350}, {"x": 300, "y": 500}, {"x": 360, "y": 500}],
                "confidence": 0.8,
            }],
            "uncertain": [],
        })

    monkeypatch.setattr(ai, "_request_content", fake_request)
    monkeypatch.setattr(settings, "read_model", "quality-vision-test")

    selection, report = await ai._recognize_plan_single_pass(
        None, "endpoint", {}, source, 0, [], [],
    )

    assert not selection.accepted
    assert [item["length_mm"] for item in report.edge_chain] == [3000, 2000, 3000, 2000]
    assert any(item.text == "净高 2500" for item in report.evidence)
    opening = next(item for item in report.evidence if item.text == "D1 CG 0 CK 800 CH 2050")
    assert opening.target_id == "wall:2@0.166667:0.433333"
    fixture = next(item for item in report.evidence if item.kind == "fixture")
    assert fixture.text == "floor_drain"
    assert fixture.bbox.model_dump() == {"x_min": 310, "y_min": 410, "x_max": 330, "y_max": 430}
    assert any("electric(solid_dot)" in item for item in report.uncertain)
    assert report.plan_lines[0]["kind"] == "pipe_chase"


def test_direct_dimension_chains_reject_cross_axis_point_coordinates() -> None:
    payload = {
        "dimension_chains": {
            "bottom": {
                "overall_mm": 4110,
                "segments_mm": [
                    {"value_mm": 400, "orientation": "horizontal"},
                    {"value_mm": 800, "orientation": "horizontal"},
                    {"value_mm": 55, "orientation": "horizontal"},
                    {"value": 320, "direction": "vertical", "bbox": [300, 680, 325, 715]},
                    {"value_mm": 2855, "orientation": "horizontal"},
                ],
            },
            "left": {
                "overall_mm": 2160,
                "segments_mm": [
                    {"value": 260, "direction": "horizontal", "bbox": [140, 365, 175, 400]},
                    {"value_mm": 320, "orientation": "vertical"},
                    {"value_mm": 1840, "orientation": "vertical"},
                ],
            },
        },
    }

    evidence, _, uncertain = ai._direct_plan_evidence(payload)
    bottom = [item.text for item in evidence if item.view_id.startswith("direct-bottom-segment")]
    left = [item.text for item in evidence if item.view_id.startswith("direct-left-segment")]

    assert bottom == ["400", "800", "55", "2855"]
    assert left == ["320", "1840"]
    assert any("bottom:320(vertical)" in item and "left:260(horizontal)" in item for item in uncertain)


def test_direct_plan_arc_inherits_inferred_dimension_chain_target() -> None:
    payload = {
        "dimension_chains": {
            "top": {"overall_mm": 1790, "overall_bbox": [320, 75, 355, 110], "segments_mm": [
                {"value_mm": 1280, "bbox": [240, 140, 280, 170]},
                {"value_mm": 510, "bbox": [380, 140, 410, 170]},
            ]},
            "right": {"overall_mm": 2135, "overall_bbox": [335, 930, 375, 965], "segments_mm": [
                {"value_mm": 1015, "bbox": [550, 550, 590, 580]},
                {"value_mm": 215, "bbox": [575, 780, 600, 815]},
            ]},
            "bottom": {"overall_mm": 2135, "overall_bbox": [335, 930, 375, 965], "segments_mm": [
                {"value_mm": 630, "bbox": [190, 880, 220, 910]},
                {"value_mm": 1390, "bbox": [355, 880, 395, 910]},
                {"value_mm": 115, "bbox": [510, 880, 535, 910]},
            ]},
            "left": {"overall_mm": 2155, "overall_bbox": [85, 505, 125, 540], "segments_mm": [
                {"value_mm": 745, "bbox": [120, 330, 150, 360]},
                {"value_mm": 805, "bbox": [135, 565, 160, 600]},
                {"value_mm": 400, "bbox": [135, 790, 160, 825]},
            ]},
        },
        "opening_rows": [{"code": "D1", "CG": 0, "CK": 745, "CH": 2100, "bbox": [700, 120, 820, 180]}],
        "plan_openings": [{"code": "D1", "form": "hinged", "arc_bbox": [220, 220, 420, 440]}],
    }
    evidence, _, _ = ai._direct_plan_evidence(payload)
    arc = next(item for item in evidence if item.id == "direct-plan-opening-1")
    row = next(item for item in evidence if item.id == "direct-opening-row-d1")
    assert arc.target_id == row.target_id == "wall:5@0.095128:0.440835"


def test_compact_door_inventory_keeps_explicit_wall_binding() -> None:
    payload = {
        "edge_chain": [
            {"direction": "right", "length_mm": 3000, "bbox": [100, 100, 900, 120]},
            {"direction": "down", "length_mm": 2000, "bbox": [900, 120, 920, 900]},
            {"direction": "left", "length_mm": 3000, "bbox": [100, 900, 900, 920]},
            {"direction": "up", "length_mm": 2000, "bbox": [80, 120, 100, 900]},
        ],
        "doors": [{
            "code": "D1", "bbox": [300, 820, 480, 930], "wall_side": "bottom",
            "form": "hinged", "edge_index": 2, "offset_mm": 500,
            "width_mm": 800, "height_mm": 2050,
        }],
    }
    normalized = ai._normalize_fast_visual_payload(payload)
    evidence, edges, _ = ai._direct_plan_evidence(normalized)
    report = PlanEvidenceReport(evidence=evidence, edge_chain=[edge.model_dump(mode="json") for edge in edges])
    assist = {"tokens": []}
    ai._merge_template_evidence(assist, report)
    openings = ai._opening_specs_from_tokens(assist, edges)

    assert len(openings) == 1
    assert openings[0].label == "D1"
    assert openings[0].wall_index == 2
    assert openings[0].offset_mm == 500
    assert openings[0].width_mm == 800


def test_plan_arc_survives_missing_table_bbox() -> None:
    payload = {
        "edge_chain": [
            {"direction": "right", "length_mm": 3000, "bbox": [100, 100, 900, 120]},
            {"direction": "down", "length_mm": 2000, "bbox": [900, 120, 920, 900]},
            {"direction": "left", "length_mm": 3000, "bbox": [100, 900, 900, 920]},
            {"direction": "up", "length_mm": 2000, "bbox": [80, 120, 100, 900]},
        ],
        "opening_rows": [{"code": "D1", "CG": 0, "CK": 800, "CH": 2050}],
        "plan_openings": [{
            "code": "D1", "arc_bbox": [300, 820, 480, 930],
            "edge_index": 2, "offset_mm": 500, "width_mm": 800, "height_mm": 2050,
        }],
    }
    evidence, edges, _ = ai._direct_plan_evidence(payload)
    assert any(item.id == "direct-plan-opening-1" for item in evidence)
    assist = {"tokens": []}
    ai._merge_template_evidence(assist, PlanEvidenceReport(evidence=evidence))
    openings = ai._opening_specs_from_tokens(assist, edges)
    assert len(openings) == 1
    assert openings[0].wall_index == 2
    assert openings[0].offset_mm == 500


def test_direct_edge_chain_does_not_write_overall_dimension_to_folded_wall() -> None:
    payload = {
        "_require_edge_bbox": True,
        "dimension_chains": {"left": {"overall_mm": 2160}},
        "edge_chain": [
            {"direction": "down", "length_mm": 2160, "bbox": [100, 200, 130, 260]},
            {"direction": "right", "length_mm": 1255, "bbox": [200, 800, 260, 830]},
            {"direction": "up", "length_mm": 320, "bbox": [300, 700, 330, 760]},
            {"direction": "right", "length_mm": 2855, "bbox": [400, 650, 460, 680]},
            {"direction": "up", "length_mm": 1840, "bbox": [700, 300, 730, 360]},
            {"direction": "left", "length_mm": 1590, "bbox": [600, 150, 660, 180]},
        ],
    }

    _, edges, uncertain = ai._direct_plan_evidence(payload)

    assert edges[0].length_mm is None
    assert edges[4].length_mm == 1840
    assert any("2160(overall)" in item for item in uncertain)


def test_fixture_crop_bbox_is_mapped_back_to_full_image() -> None:
    payload = {
        "_fixture_bbox_region": {"x_min": 50, "y_min": 150, "x_max": 750, "y_max": 850},
        "fixtures": [{
            "type": "drain", "symbol": "solid_dot", "bbox": [200, 300, 240, 340],
        }],
    }

    evidence, _, _ = ai._direct_plan_evidence(payload)

    assert evidence[0].bbox.model_dump() == {"x_min": 190, "y_min": 360, "x_max": 218, "y_max": 388}


def test_merge_segment_edge_chains_keeps_more_complete_photo_topology() -> None:
    simplified = [
        BoundaryEdge(direction=direction, length_mm=length)
        for direction, length in (("right", 4105), ("down", 2160), ("left", 4110), ("up", 1840))
    ]
    photo_topology = [
        BoundaryEdge(direction=direction, length_mm=None)
        for direction in ("down", "right", "up", "right", "down", "right", "up", "left", "down", "left", "up", "left")
    ]

    merged = ai._merge_segment_edge_chains(simplified, photo_topology)

    assert merged == photo_topology


def test_upload_recognition_has_no_sample_specific_measurement_tables() -> None:
    assert not hasattr(ai, "VERIFIED_PLAN_EDGE_CHAINS")
    assert not hasattr(ai, "VERIFIED_PLAN_OPENINGS")


@pytest.mark.asyncio
async def test_fast_analysis_builds_nonempty_spec_from_direct_edge_chain_without_ocr_or_local_contour(
    tmp_path, monkeypatch,
) -> None:
    source = tmp_path / "source.jpg"
    Image.new("RGB", (640, 480), "white").save(source)
    payload = {
        "edge_chain": [
            {"direction": "right", "length_mm": 3000, "evidence_text": "3000"},
            {"direction": "down", "length_mm": 2000, "evidence_text": "2000"},
            {"direction": "left", "length_mm": 3000, "evidence_text": "3000"},
            {"direction": "up", "length_mm": 2000, "evidence_text": "2000"},
        ],
        "dimension_chains": {
            "top": {"overall_mm": 3000, "segments_mm": [
                {"value_mm": 1000, "bbox": [120, 80, 180, 105]},
                {"value_mm": 800, "bbox": [300, 80, 360, 105]},
                {"value_mm": 1200, "bbox": [500, 80, 560, 105]},
            ]},
            "right": {"overall_mm": 2000, "segments_mm": []},
            "bottom": {"overall_mm": 3000, "segments_mm": [
                {"value_mm": 500, "bbox": [120, 880, 180, 905]},
                {"value_mm": 800, "bbox": [300, 880, 360, 905]},
                {"value_mm": 1700, "bbox": [500, 880, 560, 905]},
            ]},
            "left": {"overall_mm": 2000, "segments_mm": []},
            "recess": {"overall_mm": None, "segments_mm": []},
        },
            "heights": {
                "room_height_mm": 2500,
                "room_height_bbox": [820, 350, 910, 390],
            },
            "opening_rows": [{
                "code": "D1", "CG": 0, "CK": 800, "CH": 2050,
                "bbox": [760, 135, 970, 172],
            }],
            "plan_openings": [{
                "code": "D1", "form": "hinged", "wall_side": "bottom",
                "bbox": [400, 760, 520, 900],
            }],
        "fixtures": [],
        "interior_lines": [{
            "kind": "inner_wall", "label": "内墙线",
            "points": [{"x": 300, "y": 350}, {"x": 300, "y": 500}],
            "confidence": 0.8,
        }],
        "uncertain": [],
    }
    direct_evidence, direct_edges, uncertain = ai._direct_plan_evidence(payload)
    report = PlanEvidenceReport(
        evidence=direct_evidence,
        edge_chain=[edge.model_dump(mode="json") for edge in direct_edges],
        plan_lines=ai._direct_plan_lines(payload),
        uncertain=uncertain,
    )

    monkeypatch.setattr(ai, "_preferred_plan_rotation", lambda *_args: 0)
    monkeypatch.setattr(ai, "_raster_topology_candidates", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(ai, "_prepare_ocr_assist", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("OCR called")))

    async def fake_single(*_args, **_kwargs):
        return TopologyCandidateSelection(), report

    monkeypatch.setattr(ai, "_recognize_plan_single_pass", fake_single)
    monkeypatch.setattr(settings, "openai_base_url", "https://example.test/v1")
    monkeypatch.setattr(settings, "openai_api_key", "key")
    monkeypatch.setattr(settings, "read_model", "vision-test")

    spec = await ai.analyze_floorplan_fast(source)

    assert len(spec.boundary) == 4
    assert spec.height_mm == 2500
    assert spec.openings[0].width_mm == 800
    assert spec.openings[0].wall_index == 0
    assert spec.plan_lines[0].kind == "inner_wall"


@pytest.mark.asyncio
async def test_fast_analysis_builds_shape_before_text_recognition(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.jpg"
    Image.new("RGB", (320, 240), "white").save(source)
    shape = rectangle_shape()
    candidate = TopologyCandidate(id="C1", corners=shape.corners, pixel_support=0.9)
    events: list[str] = []

    monkeypatch.setattr(ai, "_preferred_plan_rotation", lambda *_args: 0)
    monkeypatch.setattr(ai, "_raster_topology_candidates", lambda *_args, **_kwargs: [candidate])

    def fake_ocr(*_args, **_kwargs):
        raise AssertionError("fast analysis must not call OCR")

    report = PlanEvidenceReport(evidence=[
        {
            "id": "top", "kind": "dimension", "text": "3000",
            "bbox": {"x_min": 400, "y_min": 40, "x_max": 500, "y_max": 70},
            "orientation": "horizontal", "related_to": "dimension_chain:top", "confidence": 0.95,
        },
        {
            "id": "right", "kind": "dimension", "text": "2000",
            "bbox": {"x_min": 900, "y_min": 400, "x_max": 940, "y_max": 500},
            "orientation": "vertical", "related_to": "dimension_chain:right", "confidence": 0.95,
        },
        {
            "id": "bottom", "kind": "dimension", "text": "3000",
            "bbox": {"x_min": 400, "y_min": 900, "x_max": 500, "y_max": 940},
            "orientation": "horizontal", "related_to": "dimension_chain:bottom", "confidence": 0.95,
        },
        {
            "id": "left", "kind": "dimension", "text": "2000",
            "bbox": {"x_min": 40, "y_min": 400, "x_max": 70, "y_max": 500},
            "orientation": "vertical", "related_to": "dimension_chain:left", "confidence": 0.95,
        },
    ])

    async def fake_single(*_args, **_kwargs):
        events.append("vision")
        return TopologyCandidateSelection(selected_id="C1", accepted=True, confidence=0.9), report

    monkeypatch.setattr(ai, "_recognize_plan_single_pass", fake_single)
    monkeypatch.setattr(ai, "_prepare_ocr_assist", fake_ocr)
    monkeypatch.setattr(settings, "openai_base_url", "https://example.test/v1")
    monkeypatch.setattr(settings, "openai_api_key", "key")
    monkeypatch.setattr(settings, "read_model", "vision-test")
    monkeypatch.setattr(settings, "chat_model", "chat-test")

    spec = await ai.analyze_floorplan_fast(source)

    assert events == ["vision"]
    assert spec.plan_annotation.boundary == shape.corners


@pytest.mark.asyncio
async def test_fast_analysis_returns_editable_annotation_when_dimensions_are_incomplete(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.jpg"
    Image.new("RGB", (320, 240), "white").save(source)
    shape = rectangle_shape()
    candidate = TopologyCandidate(id="C1", corners=shape.corners, pixel_support=0.9)

    monkeypatch.setattr(ai, "_preferred_plan_rotation", lambda *_args: 0)
    monkeypatch.setattr(ai, "_raster_topology_candidates", lambda *_args, **_kwargs: [candidate])

    async def fake_single(*_args, **_kwargs):
        return TopologyCandidateSelection(selected_id="C1", accepted=True, confidence=0.9), PlanEvidenceReport()

    monkeypatch.setattr(ai, "_recognize_plan_single_pass", fake_single)
    monkeypatch.setattr(settings, "openai_base_url", "https://example.test/v1")
    monkeypatch.setattr(settings, "openai_api_key", "key")
    monkeypatch.setattr(settings, "read_model", "vision-test")

    spec = await ai.analyze_floorplan_fast(source)

    assert spec.boundary == []
    assert spec.plan_annotation is not None
    assert spec.plan_annotation.boundary == shape.corners
    assert any("逐段尺寸尚未闭合" in issue.message for issue in spec.issues)


@pytest.mark.asyncio
async def test_fast_analysis_does_not_run_crop_or_secondary_vision_pass(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.jpg"
    Image.new("RGB", (320, 240), "white").save(source)
    shape = rectangle_shape()
    candidate = TopologyCandidate(id="C1", corners=shape.corners, pixel_support=0.9)
    events: list[str] = []

    monkeypatch.setattr(ai, "_preferred_plan_rotation", lambda *_args: 0)
    monkeypatch.setattr(ai, "_raster_topology_candidates", lambda *_args, **_kwargs: [candidate])

    def prepare_ocr(*_args, **_kwargs):
        raise AssertionError("fast analysis must not call OCR")

    report = PlanEvidenceReport(evidence=[
        {
            "id": "top", "kind": "dimension", "text": "3000",
            "bbox": {"x_min": 400, "y_min": 40, "x_max": 500, "y_max": 70},
            "orientation": "horizontal", "related_to": "dimension_chain:top", "confidence": 0.95,
        },
        {
            "id": "right", "kind": "dimension", "text": "2000",
            "bbox": {"x_min": 900, "y_min": 400, "x_max": 940, "y_max": 500},
            "orientation": "vertical", "related_to": "dimension_chain:right", "confidence": 0.95,
        },
        {
            "id": "bottom", "kind": "dimension", "text": "3000",
            "bbox": {"x_min": 400, "y_min": 900, "x_max": 500, "y_max": 940},
            "orientation": "horizontal", "related_to": "dimension_chain:bottom", "confidence": 0.95,
        },
        {
            "id": "left", "kind": "dimension", "text": "2000",
            "bbox": {"x_min": 40, "y_min": 400, "x_max": 70, "y_max": 500},
            "orientation": "vertical", "related_to": "dimension_chain:left", "confidence": 0.95,
        },
    ])

    async def fake_single(*_args, **_kwargs):
        events.append("vision")
        return TopologyCandidateSelection(selected_id="C1", accepted=True, confidence=0.9), report

    monkeypatch.setattr(ai, "_recognize_plan_single_pass", fake_single)
    monkeypatch.setattr(ai, "_prepare_ocr_assist", prepare_ocr)
    monkeypatch.setattr(settings, "openai_base_url", "https://example.test/v1")
    monkeypatch.setattr(settings, "openai_api_key", "key")
    monkeypatch.setattr(settings, "read_model", "vision-test")
    monkeypatch.setattr(settings, "chat_model", "chat-test")

    spec = await ai.analyze_floorplan_fast(source)

    assert events == ["vision"]
    assert spec.plan_annotation.boundary == shape.corners


@pytest.mark.asyncio
async def test_fast_analysis_preserves_evidence_after_model_failure(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.jpg"
    Image.new("RGB", (320, 240), "white").save(source)
    candidate = TopologyCandidate(id="C1", corners=rectangle_shape().corners, pixel_support=0.9)

    monkeypatch.setattr(ai, "_preferred_plan_rotation", lambda *_args: 0)
    monkeypatch.setattr(ai, "_raster_topology_candidates", lambda *_args, **_kwargs: [candidate])
    monkeypatch.setattr(
        ai,
        "_prepare_ocr_assist",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("local OCR must not run")),
    )

    async def fail(*_args, **_kwargs):
        raise ai.AIResponseError("upstream rejected image")

    monkeypatch.setattr(ai, "_recognize_plan_single_pass", fail)
    monkeypatch.setattr(settings, "openai_base_url", "https://example.test/v1")
    monkeypatch.setattr(settings, "openai_api_key", "key")
    monkeypatch.setattr(settings, "read_model", "vision-test")

    spec = await ai.analyze_floorplan_fast(source)
    assert spec.plan_annotation is not None
    assert spec.plan_annotation.boundary == candidate.corners
    assert not any(item.value == "1840" for item in spec.observations)
    assert any("未混入本地 OCR" in item.value for item in spec.observations)
    assert any("视觉抄录失败" in item.message for item in spec.issues) or any(
        "视觉抄录失败" in item.note for item in spec.observations
    )
