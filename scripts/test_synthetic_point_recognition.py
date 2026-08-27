from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.ai import (
    DIMENSION_TRANSCRIPTION_PROMPT,
    _direct_plan_evidence,
    _extract_json,
    _normalize_fast_visual_payload,
    _point_marker_position_from_refs,
    _request_content,
    image_data_url,
)
from backend.app.config import settings
from backend.app.models import Point2D


EXPECTED_BOUNDARY = [
    Point2D(x_mm=0, z_mm=0),
    Point2D(x_mm=2000, z_mm=0),
    Point2D(x_mm=2000, z_mm=1500),
    Point2D(x_mm=0, z_mm=1500),
]


async def recognize(source: Path) -> dict:
    if not settings.ai_configured:
        raise RuntimeError("AI 视觉模型未配置")
    endpoint = settings.openai_base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }
    trace_ids: list[str] = []
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
                        {"type": "text", "text": "请直接读取这张转正原始量房图片。"},
                        {
                            "type": "image_url",
                            "image_url": {"url": image_data_url(source, 0, trim_document=False), "detail": "high"},
                        },
                    ],
                },
            ],
            settings.read_model,
            json_object=True,
            stage="synthetic-point-positioning-check",
            extra_payload={"max_tokens": 4096},
            trace_ids=trace_ids,
            max_retries=0,
        )

    raw = _extract_json(content)
    if not isinstance(raw, dict):
        raise RuntimeError("模型未返回 JSON 对象")
    normalized = _normalize_fast_visual_payload(raw)
    normalized["_require_edge_bbox"] = True
    evidence, _, parser_uncertain = _direct_plan_evidence(normalized)
    fixtures = [item for item in evidence if item.kind == "fixture"]
    recognized = []
    normalized_fixtures = normalized.get("fixtures") if isinstance(normalized.get("fixtures"), list) else []
    for index, item in enumerate(fixtures):
        raw_fixture = normalized_fixtures[index] if index < len(normalized_fixtures) and isinstance(normalized_fixtures[index], dict) else {}
        point = _point_marker_position_from_refs(item, EXPECTED_BOUNDARY)
        recognized.append(
            {
                "id": item.id,
                "type": raw_fixture.get("type") or raw_fixture.get("kind"),
                "text": item.text,
                "bbox": item.bbox.model_dump(mode="json"),
                "confidence": item.confidence,
                "positioning": item.positioning,
                "resolved_position_mm": point.model_dump(mode="json") if point else None,
            }
        )

    expected_refs = {("left", 600), ("top", 400)}
    exact = [
        item
        for item in recognized
        if item["type"] == "floor_drain"
        and isinstance(item["positioning"], dict)
        and item["positioning"].get("method") == "wall_offsets"
        and {
            (str(ref.get("from")), ref.get("value_mm"))
            for ref in item["positioning"].get("refs", [])
            if isinstance(ref, dict)
        } == expected_refs
        and item["resolved_position_mm"] == {"x_mm": 600, "z_mm": 400}
    ]
    return {
        "source": str(source.resolve()),
        "model": settings.read_model,
        "trace_ids": trace_ids,
        "expected": {
            "actual_fixture_count": 1,
            "type": "floor_drain",
            "position_method": "wall_offsets",
            "point_refs": [
                {"from": "left", "value_mm": 600},
                {"from": "top", "value_mm": 400},
            ],
            "resolved_position_mm": {"x_mm": 600, "z_mm": 400},
        },
        "recognized_fixtures": recognized,
        "checks": {
            "one_actual_fixture_only": len(recognized) == 1,
            "wall_offsets_exact": len(exact) == 1,
            "legend_symbols_excluded": len(recognized) == 1,
        },
        "passed": len(recognized) == 1 and len(exact) == 1,
        "model_uncertain": raw.get("uncertain", []),
        "parser_uncertain": parser_uncertain,
        "raw_response": raw,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="使用生产视觉提示词验证模拟点位标注")
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, default=Path("reports/AGEN-68-synthetic-recognition-result.json"))
    args = parser.parse_args()
    result = asyncio.run(recognize(args.source))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": result["passed"], "checks": result["checks"], "output": str(args.output.resolve())}, ensure_ascii=False))
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
