from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

from backend.app.ai import AIAuthenticationError, AIResponseError, _crop_data_url, _extract_json, _request_content, image_data_url
from backend.app.config import settings
from backend.app.models import ImageBBox


PROMPT = """
你是固定版式手绘量房纸解析器。只使用图片视觉，不使用或假设任何 OCR 结果。

输入依次是：完整量房纸、左侧平面草图区放大、右侧固定表格放大。完整图用于版式定位；所有草图坐标以第二张图为准。

必须完成：
1. 读取尺寸基准。未勾选时输出 finished_surface_clear；只有明确勾选毛坯面才输出 rough_surface_clear。
2. 沿房间内侧墙线连续追踪实际正交边界。忽略网格、尺寸线、门扇和开启圆弧，但保留墙垛、凹槽和门框短回折。
3. 分别抄录每条水平/垂直尺寸链及总尺寸。保留 5-20 mm 实测差异，不擅自改数。
4. 读取右侧 D1/W1/W2 表。CG=洞口下沿距地，CK=洞口内侧净宽，CH=洞口内侧净高；空行输出 null。
5. 读取净高和整屋吊顶。米制小数换算成毫米，例如 2.100 m=2100。
6. 识别草图内点位：⊗=floor_drain、实心点或○=drain、△=water、□=electric。不要把右侧图例当点位。每个点位给出其中心相对草图中房间最外包围盒的 x_ratio/z_ratio（0 到 1）。

禁止按住宅常识补值；看不清就填 null 并写入 uncertain。只输出 JSON，不要 Markdown：
{
  "dimension_basis":"finished_surface_clear|rough_surface_clear",
  "edge_chain":[{"direction":"right|down|left|up","length_mm":null,"role":"wall|door_jamb|structure_return","source_text":"","confidence":0.0}],
  "dimension_chains":[{"axis":"horizontal|vertical","location":"top|bottom|left|right|recess","segments_mm":[],"overall_mm":null,"confidence":0.0}],
  "openings":[{"id":"D1|W1|W2","kind":"door|window","CG":null,"CK":null,"CH":null,"host_wall":"top|right|bottom|left|unknown","confidence":0.0}],
  "net_height_mm":null,
  "overall_ceiling_height_mm":null,
  "points":[{"kind":"floor_drain|drain|water|electric","x_ratio":0.0,"z_ratio":0.0,"confidence":0.0}],
  "uncertain":[]
}
""".strip()

AUDIT_PROMPT = """
你是量房模板结果审计员。输入是完整量房纸、草图区放大、右侧门窗与高度表放大，以及第一轮候选 JSON。
必须重新看图逐项纠错，不能因为候选已有值就沿用：
1. edge_chain 必须包含草图内墙线的每一次实际正交转折；总尺寸线、网格、门扇和圆弧不是墙。四边形只有在图中确实无凹槽、门框回折时才允许。
2. 每个 dimension_chains.segments_mm 必须处在同一条水平或垂直尺寸线上；不能把垂直 320 混进水平底链。overall_mm 必须是图中明确总尺寸，不能把不同方向数字相加。
3. 放大逐字检查 D1/W1/W2 的 CG、CK、CH。不要按常见门高猜数，但三位/四位数字必须完整抄录。
4. 门所在墙按门洞和开启圆弧位置判断。图例符号不得计入 points。
5. 净高与整屋吊顶分开；2.100 m 必须换算为 2100 mm。
输出与候选完全相同的 JSON 字段结构，不要输出解释或 Markdown；仍看不清的值设 null 并写入 uncertain。
""".strip()


async def recognize(path: Path) -> dict:
    endpoint = settings.openai_base_url.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"}
    models = list(dict.fromkeys(filter(None, (
        settings.read_model,
    ))))
    drawing = ImageBBox(x_min=40, y_min=125, x_max=720, y_max=950)
    form = ImageBBox(x_min=700, y_min=120, x_max=985, y_max=480)
    errors: list[str] = []
    async with httpx.AsyncClient(timeout=max(settings.ai_timeout_seconds, 180)) as client:
        for model in models:
            traces: list[str] = []
            try:
                content = await _request_content(
                    client,
                    endpoint,
                    headers,
                    [
                        {"role": "system", "content": PROMPT},
                        {"role": "user", "content": [
                            {"type": "text", "text": "完整量房纸"},
                            {"type": "image_url", "image_url": {"url": image_data_url(path, 0, trim_document=True), "detail": "high"}},
                            {"type": "text", "text": "左侧平面草图区放大；点位比例以此图中的房间外包围盒为基准"},
                            {"type": "image_url", "image_url": {"url": _crop_data_url(path, 0, drawing, enhance=False), "detail": "high"}},
                            {"type": "text", "text": "右侧固定表格放大"},
                            {"type": "image_url", "image_url": {"url": _crop_data_url(path, 0, form, enhance=False), "detail": "high"}},
                        ]},
                    ],
                    model,
                    json_object=True,
                    stage="template-visual-only",
                    extra_payload={"max_tokens": 4096},
                    trace_ids=traces,
                    max_retries=1,
                )
                first_pass = _extract_json(content)
                audit_content = await _request_content(
                    client,
                    endpoint,
                    headers,
                    [
                        {"role": "system", "content": AUDIT_PROMPT},
                        {"role": "user", "content": [
                            {"type": "text", "text": "第一轮候选 JSON：\n" + json.dumps(first_pass, ensure_ascii=False)},
                            {"type": "text", "text": "完整量房纸"},
                            {"type": "image_url", "image_url": {"url": image_data_url(path, 0, trim_document=True), "detail": "high"}},
                            {"type": "text", "text": "左侧平面草图区放大"},
                            {"type": "image_url", "image_url": {"url": _crop_data_url(path, 0, drawing, enhance=False), "detail": "high"}},
                            {"type": "text", "text": "右侧门窗与高度表放大"},
                            {"type": "image_url", "image_url": {"url": _crop_data_url(path, 0, form, enhance=False), "detail": "high"}},
                        ]},
                    ],
                    model,
                    json_object=True,
                    stage="template-visual-audit",
                    extra_payload={"max_tokens": 4096},
                    trace_ids=traces,
                    max_retries=1,
                )
                return {
                    "model": model,
                    "trace_ids": traces,
                    "first_pass": first_pass,
                    "audited": _extract_json(audit_content),
                }
            except AIAuthenticationError:
                raise
            except (AIResponseError, ValueError, TypeError, json.JSONDecodeError) as error:
                errors.append(f"{model}: {error}")
    raise RuntimeError("；".join(errors))


if __name__ == "__main__":
    source = Path(sys.argv[1] if len(sys.argv) > 1 else "test0.jpg")
    print(json.dumps(asyncio.run(recognize(source)), ensure_ascii=False, indent=2))
