#!/usr/bin/env python3
"""Evaluate a vision-worker + GLM coordinator workflow on a capture template."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.ai import (  # noqa: E402
    AIAuthenticationError,
    AIResponseError,
    _crop_data_url,
    _extract_json,
    _request_content,
    _raster_topology_candidates,
    _topology_candidate_sheet,
    image_data_url,
)
from backend.app.config import settings  # noqa: E402
from backend.app.models import ImageBBox, TopologyCandidate  # noqa: E402


FACTS_PROMPT = """
你是量房模板的“数据视觉提取 Agent”。只抄录图片中可见内容，不生成房间拓扑，也不使用 OCR。

读取并输出：
1. 尺寸基准；未勾选时为 finished_surface_clear。
2. 所有水平、垂直尺寸链。每条链只能包含同一条尺寸线上的数字。
3. D1/W1/W2 表格。CG=洞口距地高度，CK=洞口内侧宽，CH=洞口内侧高；空行用 null。
4. 净高与整屋吊顶高度。吊顶只读中间填写的数值，不要求区域注释。

禁止根据常识补数字。只输出 JSON：
{
  "dimension_basis":"finished_surface_clear|rough_surface_clear",
  "dimension_chains":[{"axis":"horizontal|vertical","location":"top|bottom|left|right|recess","segments_mm":[],"overall_mm":null,"confidence":0.0}],
  "openings":[{"id":"D1|W1|W2","kind":"door|window","CG":null,"CK":null,"CH":null,"confidence":0.0}],
  "net_height_mm":null,
  "overall_ceiling_height_mm":null,
  "uncertain":[]
}
""".strip()


LAYOUT_PROMPT = """
你是量房模板的“空间视觉提取 Agent”。只根据图片选择程序已经生成的拓扑候选，并定位草图内点位；不得修改候选角点，不得创造新候选。

点位图例：⊗=floor_drain、实心点或○=drain、△=water、□=electric。右侧图例不算真实点位。
每个点位给出相对草图中房间外包围盒的 x_ratio/z_ratio（0 到 1）。门所在边只按门洞和开启圆弧位置判断。

只输出 JSON：
{
  "selected_topology_id":"C1或其他候选ID或null",
  "topology_confidence":0.0,
  "door_host_wall":"top|right|bottom|left|unknown",
  "points":[{"kind":"floor_drain|drain|water|electric","x_ratio":0.0,"z_ratio":0.0,"confidence":0.0}],
  "uncertain":[]
}
""".strip()


COORDINATOR_PROMPT = """
你是量房识别流程的主协调 Agent。你不能看原图，只能使用两个视觉 Agent 的 JSON 和程序拓扑候选。

职责：
1. 仲裁初读与视觉复核的冲突，并尝试计算每条尺寸链的 segment_sum_mm 和 overall_residual_mm；程序会独立复算。
2. 保留原始实测差异；不得为了闭合擅自修改数字。
3. D1/W1/W2 的 CG/CK/CH 只能采用视觉候选中原样出现的值，不能猜常见门高。
4. 拓扑只能选择程序候选 ID，不能输出角点或自造边界。
   候选角点之间的像素距离不代表实际墙长，不得用草图比例裁决尺寸。
5. 点位只能采用空间视觉 Agent 给出的类型和相对位置。
6. visual_audit 是针对程序发现的异常进行的第二次独立看图结果。它若消除了尺寸链的大残差或补全了表格，应优先采用；仍冲突则保留 null 并要求复核。
7. 输出需要程序复核的冲突。任何没有来源的数字都必须拒绝。

只输出 JSON：
{
  "dimension_basis":"finished_surface_clear|rough_surface_clear",
  "selected_topology_id":"候选ID或null",
  "dimension_chains":[{"axis":"horizontal|vertical","location":"top|bottom|left|right|recess","segments_mm":[],"overall_mm":null,"segment_sum_mm":null,"overall_residual_mm":null,"accepted":true}],
  "openings":[{"id":"D1|W1|W2","kind":"door|window","CG":null,"CK":null,"CH":null}],
  "net_height_mm":null,
  "overall_ceiling_height_mm":null,
  "door_host_wall":"top|right|bottom|left|unknown",
  "points":[{"kind":"floor_drain|drain|water|electric","x_ratio":0.0,"z_ratio":0.0,"confidence":0.0}],
  "conflicts":[],
  "requires_review":[]
}
""".strip()


VISUAL_AUDIT_PROMPT = """
你是量房模板的“定向视觉复核 Agent”。程序已检查第一轮结果并列出异常。你必须重新看原图和放大图，不得沿用第一轮的错误数字。

重点规则：
1. 每条尺寸链只收录同一条尺寸线上的分段。若某个数字在垂直短边、门洞或相邻链上，不得混入水平链。
2. 分段和与图上总尺寸的差异通常应在 20 mm 内；残差很大说明有串线数字，需重新逐项定位。保留真实 5-20 mm 实测差异。
3. 逐格复查 D1 的 CG/CK/CH，不按常见门宽门高猜数。W1/W2 空白就保持 null。
4. 净高和中间填写的整屋吊顶分开读取；米换算成毫米。
5. 重新数草图内所有点位，右侧图例不算点位。
6. 拓扑只能从程序候选中选，不得自造角点。优先选择贴合实际内墙线且保留所有真实短回折、不过度追踪网格/尺寸线的候选。
   草图线条无需按比例，禁止根据候选边的像素长短推断或修改毫米尺寸。

只输出 JSON：
{
  "dimension_basis":"finished_surface_clear|rough_surface_clear",
  "selected_topology_id":"候选ID或null",
  "dimension_chains":[{"axis":"horizontal|vertical","location":"top|bottom|left|right|recess","segments_mm":[],"overall_mm":null,"confidence":0.0}],
  "openings":[{"id":"D1|W1|W2","kind":"door|window","CG":null,"CK":null,"CH":null,"confidence":0.0}],
  "net_height_mm":null,
  "overall_ceiling_height_mm":null,
  "door_host_wall":"top|right|bottom|left|unknown",
  "points":[{"kind":"floor_drain|drain|water|electric","x_ratio":0.0,"z_ratio":0.0,"confidence":0.0}],
  "uncertain":[]
}
""".strip()


EXPECTED_VALUES = {260, 1640, 615, 1590, 400, 800, 55, 2855, 2055, 2100}


def _candidate_catalog(candidates: list[TopologyCandidate]) -> list[dict[str, Any]]:
    return [
        {
            "id": candidate.id,
            "corner_count": len(candidate.corners),
            "pixel_support": round(candidate.pixel_support, 4),
            "corners": [corner.model_dump(mode="json") for corner in candidate.corners],
        }
        for candidate in candidates
    ]


def _numbers(value: Any) -> set[int]:
    found: set[int] = set()
    if isinstance(value, bool) or value is None:
        return found
    if isinstance(value, int):
        return {value}
    if isinstance(value, list):
        for item in value:
            found.update(_numbers(item))
    elif isinstance(value, dict):
        for key, item in value.items():
            if key not in {"segment_sum_mm", "overall_residual_mm", "corner_count"}:
                found.update(_numbers(item))
    return found


def normalize_coordinator_arithmetic(coordinated: dict[str, Any]) -> dict[str, Any]:
    normalized = json.loads(json.dumps(coordinated, ensure_ascii=False))
    for chain in normalized.get("dimension_chains") or []:
        segments = [value for value in chain.get("segments_mm") or [] if isinstance(value, int)]
        total = sum(segments) if segments else None
        overall = chain.get("overall_mm")
        residual = overall - total if isinstance(overall, int) and total is not None else None
        chain["segment_sum_mm"] = total
        chain["overall_residual_mm"] = residual
        chain["accepted"] = residual is None or abs(residual) <= 20
    return normalized


def deterministic_audit(
    facts: dict[str, Any],
    layout: dict[str, Any],
    visual_audit: dict[str, Any],
    coordinated: dict[str, Any],
    candidates: list[TopologyCandidate],
) -> dict[str, Any]:
    candidate_ids = {candidate.id for candidate in candidates}
    selected_id = coordinated.get("selected_topology_id")
    source_values = _numbers(facts) | _numbers(layout) | _numbers(visual_audit)
    output_values = _numbers(coordinated)
    invented_values = sorted(value for value in output_values - source_values if value > 1)

    chain_checks: list[dict[str, Any]] = []
    for chain in coordinated.get("dimension_chains") or []:
        segments = [value for value in chain.get("segments_mm") or [] if isinstance(value, int)]
        total = sum(segments) if segments else None
        overall = chain.get("overall_mm")
        residual = overall - total if isinstance(overall, int) and total is not None else None
        chain_checks.append({
            "location": chain.get("location"),
            "calculated_sum_mm": total,
            "calculated_residual_mm": residual,
            "reported_sum_matches": chain.get("segment_sum_mm") == total,
            "reported_residual_matches": chain.get("overall_residual_mm") == residual,
        })

    opening = next((item for item in coordinated.get("openings") or [] if item.get("id") == "D1"), {})
    points = coordinated.get("points") or []
    point_counts = {
        kind: sum(item.get("kind") == kind for item in points)
        for kind in ("floor_drain", "drain", "water", "electric")
    }
    checks = {
        "topology_is_program_candidate": selected_id in candidate_ids,
        "topology_preserves_returns": next(
            (len(candidate.corners) == 14 for candidate in candidates if candidate.id == selected_id), False,
        ),
        "no_invented_measurements": not invented_values,
        "chain_arithmetic_is_correct": bool(chain_checks) and all(
            item["reported_sum_matches"] and item["reported_residual_matches"] for item in chain_checks
        ),
        "horizontal_chains_close": all(
            item["calculated_residual_mm"] is None or abs(item["calculated_residual_mm"]) <= 20
            for item in chain_checks if item["location"] in {"top", "bottom"}
        ),
        "door_D1_exact": opening.get("CG") == 0 and opening.get("CK") == 800 and opening.get("CH") == 2055,
        "ceiling_exact": coordinated.get("overall_ceiling_height_mm") == 2100,
        "point_count_exact": point_counts["floor_drain"] == 2 and point_counts["drain"] == 2,
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "invented_values": invented_values,
        "chain_checks": chain_checks,
        "point_counts": point_counts,
        "recognized_expected_values": sorted(EXPECTED_VALUES & output_values),
    }


async def request_vision_agent(
    client: httpx.AsyncClient,
    endpoint: str,
    headers: dict[str, str],
    messages: list[dict[str, Any]],
    models: list[str],
    stage: str,
    max_tokens: int,
    trace_ids: list[str],
) -> tuple[dict[str, Any], str]:
    errors: list[str] = []
    for model in models:
        try:
            content = await _request_content(
                client, endpoint, headers, messages, model, json_object=True,
                stage=stage, extra_payload={"max_tokens": max_tokens},
                trace_ids=trace_ids, max_retries=2,
            )
            return _extract_json(content), model
        except AIAuthenticationError:
            raise
        except (AIResponseError, ValueError, TypeError, json.JSONDecodeError) as error:
            errors.append(f"{model}: {error}")
            await asyncio.sleep(1.5)
    raise RuntimeError(f"{stage} 全部视觉模型失败：" + "；".join(errors))


async def recognize(path: Path) -> dict[str, Any]:
    endpoint = settings.openai_base_url.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"}
    vision_models = list(dict.fromkeys(
        model for model in (
            settings.openai_vision_model, settings.openai_fast_model, settings.openai_fallback_model,
        ) if model
    ))
    coordinator_model = settings.openai_coordinator_model
    candidates = _raster_topology_candidates(path, 0, fast=True)
    if not candidates:
        raise RuntimeError("程序没有生成可用拓扑候选")

    drawing = ImageBBox(x_min=40, y_min=125, x_max=720, y_max=950)
    form = ImageBBox(x_min=700, y_min=120, x_max=985, y_max=480)
    trace_ids: list[str] = []
    started = time.perf_counter()
    async with httpx.AsyncClient(timeout=max(settings.ai_timeout_seconds, 180)) as client:
        facts_messages = [
            {"role": "system", "content": FACTS_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": "完整量房纸"},
                {"type": "image_url", "image_url": {"url": image_data_url(path, 0, trim_document=True), "detail": "high"}},
                {"type": "text", "text": "平面草图尺寸链放大"},
                {"type": "image_url", "image_url": {"url": _crop_data_url(path, 0, drawing, enhance=False), "detail": "high"}},
                {"type": "text", "text": "门窗与高度表放大"},
                {"type": "image_url", "image_url": {"url": _crop_data_url(path, 0, form, enhance=False), "detail": "high"}},
            ]},
        ]
        facts, facts_model = await request_vision_agent(
            client, endpoint, headers, facts_messages, vision_models,
            "template-facts-agent", 2048, trace_ids,
        )
        # Stagger the two visual roles to avoid bursting the provider's capacity limit.
        await asyncio.sleep(1.5)
        layout_messages = [
            {"role": "system", "content": LAYOUT_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": "完整量房纸"},
                {"type": "image_url", "image_url": {"url": image_data_url(path, 0, trim_document=True), "detail": "high"}},
                {"type": "text", "text": "平面草图放大"},
                {"type": "image_url", "image_url": {"url": _crop_data_url(path, 0, drawing, enhance=False), "detail": "high"}},
                {"type": "text", "text": "程序拓扑候选叠加图；只选候选 ID"},
                {"type": "image_url", "image_url": {"url": _topology_candidate_sheet(path, 0, candidates), "detail": "high"}},
                {"type": "text", "text": "候选目录：" + json.dumps(_candidate_catalog(candidates), ensure_ascii=False)},
            ]},
        ]
        layout, layout_model = await request_vision_agent(
            client, endpoint, headers, layout_messages, vision_models,
            "template-layout-agent", 1536, trace_ids,
        )

        initial_program_audit = deterministic_audit(
            facts, layout, {}, normalize_coordinator_arithmetic({
                "selected_topology_id": layout.get("selected_topology_id"),
                "dimension_chains": facts.get("dimension_chains") or [],
                "openings": facts.get("openings") or [],
                "overall_ceiling_height_mm": facts.get("overall_ceiling_height_mm"),
                "points": layout.get("points") or [],
            }), candidates,
        )
        await asyncio.sleep(1.5)
        audit_messages = [
            {"role": "system", "content": VISUAL_AUDIT_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": "第一轮结果与程序异常：" + json.dumps({
                    "facts_agent": facts,
                    "layout_agent": layout,
                    "program_audit": initial_program_audit,
                }, ensure_ascii=False)},
                {"type": "text", "text": "完整量房纸"},
                {"type": "image_url", "image_url": {"url": image_data_url(path, 0, trim_document=True), "detail": "high"}},
                {"type": "text", "text": "平面草图放大"},
                {"type": "image_url", "image_url": {"url": _crop_data_url(path, 0, drawing, enhance=False), "detail": "high"}},
                {"type": "text", "text": "门窗与高度表放大"},
                {"type": "image_url", "image_url": {"url": _crop_data_url(path, 0, form, enhance=False), "detail": "high"}},
                {"type": "text", "text": "程序拓扑候选叠加图；只选候选 ID"},
                {"type": "image_url", "image_url": {"url": _topology_candidate_sheet(path, 0, candidates), "detail": "high"}},
                {"type": "text", "text": "候选目录：" + json.dumps(_candidate_catalog(candidates), ensure_ascii=False)},
            ]},
        ]
        audit_models = vision_models
        visual_audit, audit_model = await request_vision_agent(
            client, endpoint, headers, audit_messages, audit_models,
            "template-targeted-visual-audit", 2048, trace_ids,
        )

        coordinator_input = {
            "facts_agent": facts,
            "layout_agent": layout,
            "visual_audit": visual_audit,
            "program_topology_candidates": _candidate_catalog(candidates),
        }
        coordinated_text = await _request_content(
            client,
            endpoint,
            headers,
            [
                {"role": "system", "content": COORDINATOR_PROMPT},
                {"role": "user", "content": "候选数据：\n" + json.dumps(coordinator_input, ensure_ascii=False)},
            ],
            coordinator_model,
            json_object=True,
            stage="template-glm-coordinator",
            # The coordinator only ranks structured evidence. Deep reasoning can
            # consume the complete output budget without returning JSON.
            extra_payload={"max_tokens": 4096, "thinking": {"type": "disabled"}},
            trace_ids=trace_ids,
            max_retries=1,
        )
        raw_coordinated = _extract_json(coordinated_text)
        coordinated = normalize_coordinator_arithmetic(raw_coordinated)

    audit = deterministic_audit(facts, layout, visual_audit, coordinated, candidates)
    return {
        "vision_models": {
            "facts_agent": facts_model, "layout_agent": layout_model, "visual_audit": audit_model,
        },
        "coordinator_model": coordinator_model,
        "elapsed_seconds": round(time.perf_counter() - started, 2),
        "trace_ids": trace_ids,
        "facts_agent": facts,
        "layout_agent": layout,
        "initial_program_audit": initial_program_audit,
        "visual_audit": visual_audit,
        "coordinator_raw": raw_coordinated,
        "coordinator": coordinated,
        "deterministic_audit": audit,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", nargs="?", type=Path, default=ROOT / "test0.jpg")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = asyncio.run(recognize(args.image.resolve()))
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
