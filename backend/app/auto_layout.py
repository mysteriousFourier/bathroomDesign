from __future__ import annotations

import json
from datetime import datetime, timezone

import httpx

from .config import settings
from .design_chat import (
    LAYOUT_ROLES,
    LAYOUT_WALLS,
    LAYOUT_ZONES,
    _layout_candidate_blockers,
    _layout_product_snapshot,
    _layout_profile,
    furniture_candidate_groups,
    furniture_quotes,
)
from .knowledge_graph import ProductKnowledgeGraph, equipment_rules
from .provider import serialized_post


AUTO_LAYOUT_TOOL = {
    "type": "function",
    "function": {
        "name": "create_room_layout",
        "description": "为当前量房和需求生成三个层级的真实产品方案及布局脚本。",
        "parameters": {
            "type": "object",
            "properties": {
                "levels": {
                    "type": "array",
                    "minItems": 3,
                    "maxItems": 3,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "enum": ["level1", "level2", "level3"]},
                            "name": {"type": "string"},
                            "reason": {"type": "string"},
                            "product_ids": {"type": "array", "items": {"type": "string"}},
                            "instructions": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "fixture_role": {"type": "string", "enum": list(LAYOUT_ROLES)},
                                        "wall": {"type": "string", "enum": list(LAYOUT_WALLS)},
                                        "zone": {"type": "string", "enum": list(LAYOUT_ZONES)},
                                        "near": {"type": "string"},
                                        "min_clearance_mm": {"type": "number", "minimum": 0, "maximum": 2000},
                                    },
                                    "required": ["fixture_role", "wall", "zone", "min_clearance_mm"],
                                    "additionalProperties": False,
                                },
                            },
                        },
                        "required": ["id", "name", "reason", "product_ids", "instructions"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["levels"],
            "additionalProperties": False,
        },
    },
}


def _strip_json_comments(value: str) -> str:
    result: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(value):
        char = value[index]
        if in_string:
            result.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            result.append(char)
            index += 1
            continue
        if char == "/" and index + 1 < len(value) and value[index + 1] == "/":
            index += 2
            while index < len(value) and value[index] not in "\r\n":
                index += 1
            continue
        if char == "/" and index + 1 < len(value) and value[index + 1] == "*":
            end = value.find("*/", index + 2)
            index = len(value) if end < 0 else end + 2
            continue
        result.append(char)
        index += 1
    return "".join(result)


def _requirement_text(requirements: dict[str, object], room: dict) -> str:
    values: list[str] = []
    for value in requirements.values():
        if isinstance(value, list):
            values.extend(str(item) for item in value)
        elif value:
            values.append(str(value))
    text = " ".join(values)
    if not any(term in text for term in ("淋浴", "洗澡", "坐便", "洗漱", "洗衣")):
        text = f"{text} 成人 常规卫浴 淋浴 坐便 洗漱"
    if any("洗衣" in str(item.get("label", "")) for item in room.get("fixtures", [])):
        text += " 洗衣"
    return text.strip()


def _strict_instructions(items: object, required_roles: set[str]) -> list[dict]:
    if not isinstance(items, list):
        raise ValueError("模型没有返回布局指令")
    result: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("模型布局指令格式错误")
        role, wall, zone = item.get("fixture_role"), item.get("wall"), item.get("zone")
        if role not in required_roles or wall not in LAYOUT_WALLS or zone not in LAYOUT_ZONES:
            raise ValueError(f"模型返回了非法布局指令：{role}/{wall}/{zone}")
        if any(existing["fixture_role"] == role for existing in result):
            raise ValueError(f"模型重复定义布局角色：{role}")
        try:
            round(float(item.get("min_clearance_mm")))
        except (TypeError, ValueError) as error:
            raise ValueError(f"模型没有给出 {role} 的有效净距") from error
        clearance = 600 if role in {"toilet", "vanity", "washer"} else 0
        result.append({
            "fixture_role": role,
            "wall": wall,
            "zone": zone,
            "near": str(item.get("near") or ""),
            "min_clearance_mm": clearance,
        })
    returned_roles = {item["fixture_role"] for item in result}
    if returned_roles != required_roles:
        missing = "、".join(sorted(required_roles - returned_roles))
        raise ValueError(f"模型布局脚本缺少角色：{missing}")
    return result


async def generate_model_layout(
    room: dict,
    graph: ProductKnowledgeGraph,
    requirements: dict[str, object] | None = None,
    previous_layout: dict[str, object] | None = None,
    geometry_feedback: dict[str, object] | None = None,
) -> dict:
    if not settings.openai_base_url or not settings.openai_api_key or not settings.chat_model:
        raise RuntimeError("请先配置 OPENAI_BASE_URL、OPENAI_API_KEY 和 CHAT_MODEL")

    collected = requirements or {}
    requirement_text = _requirement_text(collected, room)
    rules = equipment_rules(requirement_text)
    style = next(iter(collected.get("喜好风格", [])), "素雅") if isinstance(collected.get("喜好风格"), list) else str(collected.get("喜好风格") or "素雅")
    style_match = {"catalog_style": style}
    products = graph.search_constrained(
        " ".join(rules["必须设备"]) + " " + requirement_text,
        limit=40,
        forbidden=set(rules["不能有的设备"]),
        allowed_categories=set(rules["必须设备"]),
    )
    groups = furniture_candidate_groups(furniture_quotes(products, style_match), rules, require_bound_models=True)
    blockers = _layout_candidate_blockers(groups, rules)
    if blockers:
        raise ValueError("；".join(blockers))

    profile = _layout_profile(set(rules["必须设备"]))
    required_roles = {"wet_zone"}
    categories = set(rules["必须设备"])
    if {"浴室柜", "适老浴室柜"} & categories:
        required_roles.add("vanity")
    if "马桶" in categories:
        required_roles.add("toilet")
    if "热水器" in categories:
        required_roles.add("heater")
    if "洗衣机" in categories:
        required_roles.add("washer")
    if {"花洒扶手", "马桶扶手"} & categories:
        required_roles.add("grab_bars")

    room_context = {
        "boundary": room.get("boundary", []),
        "height_mm": room.get("height_mm"),
        "openings": room.get("openings", []),
        "fixtures": [
            {key: item.get(key) for key in ("kind", "label", "x_mm", "z_mm", "width_mm", "depth_mm", "point_usage")}
            for item in room.get("fixtures", [])
            if not item.get("layout_generated")
        ],
    }
    candidates = [{
        "category": group["category"],
        "products": [{
            "product_id": item["product_id"],
            "catalog_code": item["材料编号"],
            "spec": item.get("规格型号", ""),
            "price": item["家具小计"],
            "model_dimensions_mm": (item.get("model_lookup") or {}).get("model_dimensions_mm"),
        } for item in group["candidates"]],
    } for group in groups]
    is_repair = bool(previous_layout and geometry_feedback)
    model_context = {
        "requirements": collected,
        "normalized_requirement_text": requirement_text,
        "equipment_rules": rules,
        "required_roles": sorted(required_roles),
        "room": room_context,
        "candidates": candidates,
    }
    if is_repair:
        model_context.update({
            "previous_layout": previous_layout,
            "geometry_feedback": geometry_feedback,
            "repair_requirement": "针对每个硬错误修改产品选择或语义墙面/分区。净距由几何规则引擎管理，不得通过增大净距修复。马桶必须服从 toilet_drain，悬挂设备必须位于房间多边形内。",
        })
    payload = {
        "model": settings.chat_model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是卫生间空间布局规划器。必须调用 create_room_layout，一次生成 level1、level2、level3 三份明显不同的布局。"
                    "每个 level 的产品必须从候选 product_id 中选择，每个必需品类恰好一个；三个层级按经济、舒适、品质递进。"
                    "量房中的门洞、淋浴地漏、马桶排水、给水和障碍物是硬约束；"
                    "净距数值仅为意图，最终标准由几何规则引擎统一管理，不得用增大净距制造方案差异；"
                    "先给出语义墙面与净距意图，精确坐标由后续几何求解器搜索和校正。"
                    + ("这是几何校验后的修复轮次，必须逐条消除 geometry_feedback 中的硬错误。" if is_repair else "")
                ),
            },
            {"role": "user", "content": json.dumps(model_context, ensure_ascii=False)},
        ],
        "temperature": 0,
        "tools": [AUTO_LAYOUT_TOOL],
        "tool_choice": {"type": "function", "function": {"name": "create_room_layout"}},
    }
    async with httpx.AsyncClient(timeout=settings.ai_timeout_seconds) as client:
        response = await serialized_post(
            client,
            settings.openai_base_url.rstrip("/") + "/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            json=payload,
        )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            detail = " ".join(response.text[:600].split())
            raise ValueError(f"供应商返回 HTTP {response.status_code}：{detail or '无错误正文'}") from error
    body = response.json()
    message = body["choices"][0]["message"]
    call = next((item for item in message.get("tool_calls", []) if item.get("function", {}).get("name") == "create_room_layout"), None)
    if not call:
        raise ValueError("模型没有调用 create_room_layout")
    raw_arguments = call["function"].get("arguments")
    try:
        arguments = raw_arguments if isinstance(raw_arguments, dict) else json.loads(_strip_json_comments(raw_arguments or "{}"))
    except (json.JSONDecodeError, TypeError) as error:
        preview = " ".join(str(raw_arguments or "").split())[:300]
        raise ValueError(f"模型返回的布局脚本不是有效 JSON：{preview or '空参数'}") from error
    if not isinstance(arguments, dict):
        raise ValueError("模型返回的布局脚本不是 JSON 对象")

    raw_levels = arguments.get("levels")
    if not isinstance(raw_levels, list) or len(raw_levels) != 3:
        raise ValueError("模型必须返回三个 level 方案")
    allowed = {item["product_id"]: item for group in groups for item in group["candidates"]}
    tiers = {"level1": "basic", "level2": "comfort", "level3": "premium"}
    levels = []
    for raw_level in raw_levels:
        if not isinstance(raw_level, dict) or raw_level.get("id") not in tiers:
            raise ValueError("模型返回了非法 level id")
        level_id = str(raw_level["id"])
        if any(item["id"] == level_id for item in levels):
            raise ValueError(f"模型重复返回 {level_id}")
        product_ids = list(dict.fromkeys(str(item) for item in raw_level.get("product_ids", [])))
        if any(item not in allowed for item in product_ids):
            raise ValueError(f"{level_id} 选择了候选清单之外的产品")
        selected = [allowed[item] for item in product_ids]
        if {item["家具名称"] for item in selected} != categories or len(selected) != len(categories):
            raise ValueError(f"{level_id} 没有为每个必需品类选择且只选择一个产品")
        tier = tiers[level_id]
        levels.append({
            "id": level_id,
            "name": str(raw_level.get("name") or f"大模型 {level_id}"),
            "reason": str(raw_level.get("reason") or "模型根据需求、量房与产品候选生成"),
            "demand_profile": profile,
            "product_tier": tier,
            "product_ids": product_ids,
            "products": [_layout_product_snapshot(item) for item in selected],
            "layout_script": {
                "version": "layout-script-v1", "demand": profile, "budget": tier,
                "instructions": _strict_instructions(raw_level.get("instructions"), required_roles),
                "source": "model-assisted-rule-engine",
            },
        })
    levels.sort(key=lambda item: item["id"])
    return {
        "layout_levels": levels,
        "model_call": {
            "model": settings.chat_model,
            "provider_response_id": body.get("id"),
            "tool_call_id": call.get("id"),
            "usage": body.get("usage") or {},
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "strict_model_output": True,
            "purpose": "geometry_repair" if is_repair else "initial_layout",
        },
    }
