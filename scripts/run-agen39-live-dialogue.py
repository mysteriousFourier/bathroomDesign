import asyncio
import json
import os
from pathlib import Path

from backend.app.design_chat import design_chat
from backend.app.knowledge_graph import ProductKnowledgeGraph


INPUTS = [
    "给我爸妈弄的，前两天我妈洗完澡差点滑了一跤",
    "主要是洗澡后地上有水，她腿没劲，想坐浴，坐便起身也要扶手借力",
    "轮椅偶尔用。地方本来就小，别弄一堆玻璃，水垢也难擦",
    "我也说不清风格，反正别像医院，暖一点，但要好擦洗",
    "就按清单里的轻法，预算2万元以内，先看看墙顶地和家具一共多少，别为了花完硬塞东西",
]
ROOM = {
    "boundary": [{"x_mm": 0, "z_mm": 0}, {"x_mm": 2400, "z_mm": 0}, {"x_mm": 2400, "z_mm": 2000}, {"x_mm": 0, "z_mm": 2000}],
    "height_mm": 2400,
    "openings": [{"width_mm": 800, "height_mm": 2000}],
}


async def main() -> None:
    graph = ProductKnowledgeGraph(Path("/tmp/agen39-live-product-graph.json"))
    graph.import_catalog("product_catalog.csv", Path("backend/data/product_catalog.csv").read_bytes())
    messages = []
    results = []
    for content in INPUTS:
        messages.append({"role": "user", "content": content})
        result = await design_chat(messages, graph, ROOM)
        results.append(result)
        messages.append({"role": "assistant", "content": result["message"]})
    output = Path(os.environ.get("LIVE_DIALOGUE_OUTPUT", "/tmp/agen39-live-dialogue.json"))
    output.write_text(json.dumps({"inputs": INPUTS, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")


asyncio.run(main())
