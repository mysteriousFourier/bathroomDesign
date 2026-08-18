import json
from pathlib import Path

import pytest

import backend.app.auto_layout as auto_layout_module
from backend.app.auto_layout import generate_model_layout
from backend.app.auto_layout import _strip_json_comments
from backend.app.knowledge_graph import ProductKnowledgeGraph


def room():
    return {
        "schema_version": "1.0",
        "name": "测试卫生间",
        "boundary": [{"x_mm": 0, "z_mm": 0}, {"x_mm": 3200, "z_mm": 0}, {"x_mm": 3200, "z_mm": 2600}, {"x_mm": 0, "z_mm": 2600}],
        "height_mm": 2700,
        "openings": [],
        "fixtures": [],
        "observations": [],
        "issues": [],
        "confirmed": True,
    }


def test_modelscope_json_comments_are_removed_without_changing_strings():
    raw = '{"product_ids":["abc//literal", // product comment\n"def"], /* block */ "reason":"keep /* text */"}'
    assert json.loads(_strip_json_comments(raw)) == {
        "product_ids": ["abc//literal", "def"],
        "reason": "keep /* text */",
    }


@pytest.mark.asyncio
async def test_auto_layout_requires_and_audits_real_model_tool_call(tmp_path, monkeypatch):
    graph = ProductKnowledgeGraph(tmp_path / "graph.json")
    catalog = Path(__file__).parents[1] / "data" / "product_catalog.csv"
    graph.import_catalog(catalog.name, catalog.read_bytes())
    calls = []

    class Response:
        def raise_for_status(self): pass
        def json(self):
            payload = calls[0]
            context = json.loads(payload["messages"][1]["content"])
            product_ids = [group["products"][0]["product_id"] for group in context["candidates"]]
            instructions = []
            for role in context["required_roles"]:
                instructions.append({"fixture_role": role, "wall": "nearest_plumbing" if role == "toilet" else "east", "zone": "wet" if role == "wet_zone" else "service" if role == "heater" else "dry", "near": "toilet_drain" if role == "toilet" else "", "min_clearance_mm": 0 if role in ("wet_zone", "heater") else 600})
            arguments = {"levels": [
                {"id": f"level{index + 1}", "name": f"模型直出布局 {index + 1}", "reason": "量房与产品约束推理", "product_ids": product_ids, "instructions": instructions}
                for index in range(3)
            ]}
            return {"id": "chatcmpl-layout-1", "usage": {"total_tokens": 321}, "choices": [{"message": {"tool_calls": [{"id": "call-layout-1", "function": {"name": "create_room_layout", "arguments": json.dumps(arguments, ensure_ascii=False)}}]}}]}

    async def fake_post(_client, _url, **kwargs):
        calls.append(kwargs["json"])
        return Response()

    monkeypatch.setattr(auto_layout_module, "serialized_post", fake_post)
    monkeypatch.setattr(auto_layout_module.settings, "openai_base_url", "http://model.test")
    monkeypatch.setattr(auto_layout_module.settings, "openai_api_key", "test-key")
    monkeypatch.setattr(auto_layout_module.settings, "chat_model", "test-model")
    result = await generate_model_layout(room(), graph, {"功能需求": ["淋浴", "坐便", "洗漱"], "喜好风格": ["素雅"]})
    assert len(calls) == 1
    assert calls[0]["tool_choice"]["function"]["name"] == "create_room_layout"
    assert len(result["layout_levels"]) == 3
    assert all(level["layout_script"]["source"] == "model-assisted-rule-engine" for level in result["layout_levels"])
    assert result["model_call"] == {
        "model": "test-model",
        "provider_response_id": "chatcmpl-layout-1",
        "tool_call_id": "call-layout-1",
        "usage": {"total_tokens": 321},
        "generated_at": result["model_call"]["generated_at"],
        "strict_model_output": True,
        "purpose": "initial_layout",
    }


@pytest.mark.asyncio
async def test_auto_layout_rejects_missing_tool_call_without_fallback(tmp_path, monkeypatch):
    graph = ProductKnowledgeGraph(tmp_path / "graph.json")
    catalog = Path(__file__).parents[1] / "data" / "product_catalog.csv"
    graph.import_catalog(catalog.name, catalog.read_bytes())

    class Response:
        def raise_for_status(self): pass
        def json(self): return {"id": "chatcmpl-invalid", "choices": [{"message": {"content": "普通文本"}}]}

    async def fake_post(*_args, **_kwargs): return Response()
    monkeypatch.setattr(auto_layout_module, "serialized_post", fake_post)
    monkeypatch.setattr(auto_layout_module.settings, "openai_base_url", "http://model.test")
    monkeypatch.setattr(auto_layout_module.settings, "openai_api_key", "test-key")
    monkeypatch.setattr(auto_layout_module.settings, "chat_model", "test-model")
    with pytest.raises(ValueError, match="没有调用 create_room_layout"):
        await generate_model_layout(room(), graph, {"功能需求": ["淋浴", "坐便", "洗漱"]})
