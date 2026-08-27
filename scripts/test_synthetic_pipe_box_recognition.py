from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.ai import (
    DIMENSION_TRANSCRIPTION_PROMPT,
    _direct_plan_evidence,
    _extract_json,
    _normalize_fast_visual_payload,
    _point_marker_kind,
    _provisional_room_spec,
    _request_content,
    image_data_url,
)
from backend.app.config import settings
from backend.app.models import BoundaryEdge, ImageBBox, ShapeCorner, ShapeTraceResult
from scripts.draw_synthetic_pipe_box import CANVAS_SIZE, PIPE_BOX, PIPE_SIZE_MM, ROOM_BOX, ROOM_SIZE_MM


def normalized_bbox(box: tuple[int, int, int, int]) -> ImageBBox:
    width, height = CANVAS_SIZE
    return ImageBBox(
        x_min=round(box[0] * 1000 / width),
        y_min=round(box[1] * 1000 / height),
        x_max=round(box[2] * 1000 / width),
        y_max=round(box[3] * 1000 / height),
    )


def bbox_iou(first: ImageBBox, second: ImageBBox) -> float:
    left = max(first.x_min, second.x_min)
    top = max(first.y_min, second.y_min)
    right = min(first.x_max, second.x_max)
    bottom = min(first.y_max, second.y_max)
    intersection = max(0, right - left) * max(0, bottom - top)
    first_area = (first.x_max - first.x_min) * (first.y_max - first.y_min)
    second_area = (second.x_max - second.x_min) * (second.y_max - second.y_min)
    return intersection / max(1, first_area + second_area - intersection)


def expected_shape() -> ShapeTraceResult:
    room = normalized_bbox(ROOM_BOX)
    return ShapeTraceResult(
        corners=[
            ShapeCorner(x=room.x_min, y=room.y_min),
            ShapeCorner(x=room.x_max, y=room.y_min),
            ShapeCorner(x=room.x_max, y=room.y_max),
            ShapeCorner(x=room.x_min, y=room.y_max),
        ],
        closed=True,
    )


def metric_edges() -> list[BoundaryEdge]:
    width, depth = ROOM_SIZE_MM
    return [
        BoundaryEdge(direction="right", length_mm=width, role="wall", confidence=1),
        BoundaryEdge(direction="down", length_mm=depth, role="wall", confidence=1),
        BoundaryEdge(direction="left", length_mm=width, role="wall", confidence=1),
        BoundaryEdge(direction="up", length_mm=depth, role="wall", confidence=1),
    ]


def overlay_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        Path(r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc"),
        Path(r"C:\Windows\Fonts\simhei.ttf"),
        Path(r"C:\Windows\Fonts\simsun.ttc"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default(size=size)


def render_overlay(source: Path, detected: ImageBBox, fixture: dict, output: Path, passed: bool) -> None:
    source_image = Image.open(source).convert("RGB")
    width, height = source_image.size
    footer_height = 170
    canvas = Image.new("RGB", (width, height + footer_height), "white")
    canvas.paste(source_image, (0, 0))
    draw = ImageDraw.Draw(canvas)

    box = (
        round(detected.x_min * width / 1000),
        round(detected.y_min * height / 1000),
        round(detected.x_max * width / 1000),
        round(detected.y_max * height / 1000),
    )
    draw.rectangle(box, outline="#138A52" if passed else "#B3261E", width=6)
    draw.text((box[0], max(8, box[1] - 42)), "PIPE BOX", font=overlay_font(26, True), fill="#138A52" if passed else "#B3261E")
    draw.line((40, height, width - 40, height), fill="#BFC7CD", width=2)
    draw.text((55, height + 48), "包管闭合矩形识别通过" if passed else "包管闭合矩形识别未通过", font=overlay_font(32, True), fill="#17212B")
    draw.text(
        (55, height + 105),
        f"实体 column | 宽 {fixture.get('width_mm')} mm | 深 {fixture.get('depth_mm')} mm | "
        f"中心 ({fixture.get('x_mm')}, {fixture.get('z_mm')}) mm | 位置需复核",
        font=overlay_font(23),
        fill="#41505C",
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, "PNG", optimize=True, dpi=(144, 144))


async def recognize(source: Path, raw_override: dict | None = None) -> dict:
    trace_ids: list[str] = []
    if raw_override is None:
        if not settings.ai_configured:
            raise RuntimeError("AI visual model is not configured")
        endpoint = settings.openai_base_url.rstrip("/") + "/chat/completions"
        headers = {"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=settings.ai_timeout_seconds) as client:
            content = await _request_content(
                client,
                endpoint,
                headers,
                [
                    {"role": "system", "content": DIMENSION_TRANSCRIPTION_PROMPT},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "请直接读取这张转正原始量房图片。图中所有笔迹均为同一支单色笔。"},
                            {"type": "image_url", "image_url": {"url": image_data_url(source, 0, trim_document=False), "detail": "high"}},
                        ],
                    },
                ],
                settings.read_model,
                json_object=True,
                stage="synthetic-pipe-box-check",
                extra_payload={"max_tokens": 4096},
                trace_ids=trace_ids,
                max_retries=0,
            )
        raw = _extract_json(content)
        if not isinstance(raw, dict):
            raise RuntimeError("model did not return a JSON object")
    else:
        raw = raw_override
    normalized = _normalize_fast_visual_payload(raw)
    normalized["_require_edge_bbox"] = True
    evidence, _, parser_uncertain = _direct_plan_evidence(normalized)
    markers = [item for item in evidence if item.kind == "fixture" and _point_marker_kind(item.text) == "column"]
    spec = _provisional_room_spec(
        expected_shape(),
        {"tokens": [], "rotation_degrees": 0},
        allow_incomplete_annotation=True,
        edge_chain=metric_edges(),
        point_markers=markers,
    )
    fixtures = [item for item in (spec.fixtures if spec else []) if item.kind == "column"]
    expected = normalized_bbox(PIPE_BOX)
    detected = markers[0].bbox if len(markers) == 1 else None
    fixture = fixtures[0] if len(fixtures) == 1 else None
    expected_center = {"x_mm": 326, "z_mm": 350}
    checks = {
        "one_pipe_box": len(markers) == 1,
        "closed_box_bbox": bool(detected and bbox_iou(detected, expected) >= 0.5),
        "size_250x300": bool(fixture and (fixture.width_mm, fixture.depth_mm) == PIPE_SIZE_MM),
        "materialized_as_column": bool(fixture and fixture.kind == "column"),
        "center_within_80mm": bool(
            fixture
            and abs(fixture.x_mm - expected_center["x_mm"]) <= 80
            and abs(fixture.z_mm - expected_center["z_mm"]) <= 80
        ),
    }
    passed = all(checks.values())
    return {
        "source": str(source.resolve()),
        "model": settings.read_model,
        "trace_ids": trace_ids,
        "expected": {
            "bbox": expected.model_dump(mode="json"),
            "kind": "column",
            "width_mm": PIPE_SIZE_MM[0],
            "depth_mm": PIPE_SIZE_MM[1],
            "center_mm": expected_center,
        },
        "recognized_pipe_boxes": [
            {
                "text": marker.text,
                "bbox": marker.bbox.model_dump(mode="json"),
                "confidence": marker.confidence,
                "positioning": marker.positioning,
            }
            for marker in markers
        ],
        "materialized_fixture": fixture.model_dump(mode="json") if fixture else None,
        "checks": checks,
        "passed": passed,
        "model_uncertain": raw.get("uncertain", []),
        "parser_uncertain": parser_uncertain,
        "raw_response": raw,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one production-prompt pipe-box recognition check")
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, default=Path("reports/AGEN-68-synthetic-pipe-box-result.json"))
    parser.add_argument("--overlay", type=Path, default=Path("reports/AGEN-68-synthetic-pipe-box-overlay.png"))
    parser.add_argument("--room-spec", type=Path, default=Path("reports/AGEN-68-synthetic-pipe-box-room-spec.json"))
    parser.add_argument("--replay", type=Path, help="Reuse raw_response from an earlier result without another model call")
    args = parser.parse_args()

    raw_override = None
    if args.replay:
        replay = json.loads(args.replay.read_text(encoding="utf-8"))
        raw_override = replay.get("raw_response") if isinstance(replay, dict) else None
        if not isinstance(raw_override, dict):
            raise ValueError("replay file does not contain raw_response")
    result = asyncio.run(recognize(args.source, raw_override))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    fixture = result.get("materialized_fixture") or {}
    recognized = result.get("recognized_pipe_boxes") or []
    if recognized:
        render_overlay(args.source, ImageBBox.model_validate(recognized[0]["bbox"]), fixture, args.overlay, result["passed"])
    if result["passed"]:
        spec = _provisional_room_spec(
            expected_shape(),
            {"tokens": [], "rotation_degrees": 0},
            allow_incomplete_annotation=True,
            edge_chain=metric_edges(),
            point_markers=[
                item for item in _direct_plan_evidence(_normalize_fast_visual_payload(result["raw_response"]))[0]
                if item.kind == "fixture" and _point_marker_kind(item.text) == "column"
            ],
        )
        if spec:
            args.room_spec.write_text(spec.model_dump_json(indent=2), encoding="utf-8")
    print(json.dumps({"passed": result["passed"], "checks": result["checks"], "output": str(args.output.resolve())}, ensure_ascii=False))
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
