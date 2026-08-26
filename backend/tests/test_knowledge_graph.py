import json
from pathlib import Path

import pytest

import backend.app.design_chat as design_chat_module
from backend.app.knowledge_graph import ProductKnowledgeGraph, equipment_rules
from backend.app.design_chat import PROMPT, QUOTE_TOOL, REQUIREMENT_TOOL, _budget_ceiling, _layout_candidate_blockers, _safe_model_message, calculate_design_quote, default_product_ids, design_chat, furniture_candidate_groups, furniture_price_range, furniture_quotes, material_quotes, normalize_assistant_message, requirement_state, requirement_state_from_model, resolve_style, select_furniture_quotes, surface_estimate


def test_normalize_assistant_message_removes_markdown_marks():
    source = "## 需求确认\n- **使用人群**：[父母](https://invalid.example)\n- `预算`：三万元"
    assert normalize_assistant_message(source) == "需求确认\n使用人群：父母\n预算：三万元"

def test_incremental_catalog(tmp_path: Path):
    graph=ProductKnowledgeGraph(tmp_path/"graph.json")
    assert graph.import_catalog("p.csv","SKU,名称\nA1,花洒\nA2,浴室柜\n".encode())["created"]==2
    result=graph.import_catalog("p.csv","SKU,名称\nA1,恒温花洒\n".encode())
    assert result["updated"]==1 and result["deactivated"]==1

def test_accessible_rule_forbids_partition():
    result=equipment_rules("老人坐轮椅，需要洗漱、淋浴和坐便")
    assert "适老浴室柜" in result["必须设备"]
    assert result["不能有的设备"]==["淋浴隔断"]
    assert "淋浴隔断" not in result["可有可无设备"]

def test_standard_user_can_require_shower_partition_without_accessible_profile():
    result=equipment_rules("成人使用，没有适老需求，需要淋浴隔断")
    assert "淋浴隔断" in result["必须设备"]
    assert result["不能有的设备"] == []

def test_partition_candidate_is_not_filtered_for_standard_requirements():
    product={"id":"partition","attributes":{"材料编号":"GD1-1","材料名称":"淋浴隔断","风格":"素雅","单价":"800"}}
    result=furniture_quotes([product],{"catalog_style":"素雅"})
    assert [item["家具名称"] for item in result] == ["淋浴隔断"]

def test_model_requirement_state_preserves_explicit_partition_request():
    messages=[{"role":"user","content":"成人使用，没有适老需求，需要淋浴隔断，喜欢素雅，预算2万元"}]
    state=requirement_state_from_model({"audience":["成人"],"functions":["淋浴","坐便","洗漱"],"catalog_style":"素雅","style_terms":[],"budget_text":"2万元","delegated_standard_functions":False},messages)
    assert "淋浴隔断" in state["collected"]["功能需求"]
    assert state["complete"] is True

def test_negative_partition_request_is_not_captured_as_required_equipment():
    state=requirement_state([{"role":"user","content":"成人使用，不需要淋浴隔断，喜欢素雅，预算2万元"}])
    assert "淋浴隔断" not in state["collected"]["功能需求"]

@pytest.mark.parametrize(("budget", "ceiling"), [("2w-4w", 40000), ("2W - 4W", 40000), ("2w以内", 20000)])
def test_budget_parser_accepts_w_shorthand(budget: str, ceiling: int):
    assert _budget_ceiling(budget) == ceiling

def test_requirement_state_completes_for_w_budget_shorthand():
    state = requirement_state([{"role": "user", "content": "成人淋浴、坐便、洗漱，喜欢素雅，预算2w-4w"}])
    assert state["complete"] is True
    assert state["collected"]["预期价格区间"] == "2w-4w"

def test_storage_maps_to_user_mandated_bathroom_cabinet_category():
    assert equipment_rules("需要洗漱和收纳")["必须设备"] == ["浴室柜"]

def test_sitz_bathing_enables_accessible_equipment_rules():
    result=equipment_rules("老人需要坐浴")
    assert {"淋浴椅","花洒扶手","马桶扶手"}.issubset(result["必须设备"])
    assert result["不能有的设备"] == ["淋浴隔断"]

def test_approved_catalog_from_reference_image(tmp_path: Path):
    catalog=Path(__file__).parents[1]/"data"/"product_catalog.csv"
    graph=ProductKnowledgeGraph(tmp_path/"graph.json")
    result=graph.import_catalog(catalog.name,catalog.read_bytes())
    assert result=={"created":48,"updated":0,"unchanged":0,"deactivated":0,"total":48}
    products=[item["attributes"] for item in graph.load()["products"].values()]
    assert products[0]["材料编号"]=="QB1-SY"
    assert products[-1]["材料编号"]=="FSN1-8"
    assert {item["材料名称"] for item in products} >= {"墙板","地砖","马桶","淋浴隔断","适老浴室柜","分水器"}
    assert {item["材料编号"] for item in products if item["材料名称"]=="分水器"} == {"FSN1-6","FSN1-8"}
    assert next(item for item in products if item["材料编号"]=="MT3")["单价"]=="1200"
    assert len({item["备注"] for item in products[:9]})==1
    assert len({item["备注"] for item in products[9:18]})==1
    assert {item["attributes"]["材料名称"] for item in graph.search("老人使用，中古风格")} >= {"花洒扶手","马桶扶手","淋浴椅"}

def test_simple_bathroom_surface_area_comes_from_measurement():
    room={"boundary":[{"x_mm":0,"z_mm":0},{"x_mm":2000,"z_mm":0},{"x_mm":2000,"z_mm":2000},{"x_mm":0,"z_mm":2000}],"height_mm":2400,"openings":[{"width_mm":800,"height_mm":2000}]}
    result=surface_estimate(room)
    assert result["floor_area_sqm"]==4
    assert result["ceiling_area_sqm"]==4
    assert result["wall_gross_area_sqm"]==19.2
    assert result["opening_area_sqm"]==1.6
    assert result["wall_net_area_sqm"]==17.6
    assert result["floor_purchase_sqm"]==4.4
    assert result["ceiling_purchase_sqm"]==4.4
    assert result["wall_purchase_sqm"]==19.36

def test_chat_area_is_never_read_from_user_text():
    room={"boundary":[{"x_mm":0,"z_mm":0},{"x_mm":3000,"z_mm":0},{"x_mm":3000,"z_mm":2000},{"x_mm":0,"z_mm":2000}],"height_mm":None,"openings":[]}
    result=surface_estimate(room)
    assert result["floor_area_sqm"]==6
    assert result["wall_net_area_sqm"] is None
    assert "层高" in result["warnings"][0]

def test_prompt_brings_diverted_conversation_back_without_scolding():
    assert "无法获得可靠实时信息" in PROMPT
    assert "missing_fields" in PROMPT
    assert "capture_design_requirements" in PROMPT
    assert "服务端负责知识图谱检索、选品" in PROMPT

def test_prompt_collects_requirements_like_a_human_designer():
    assert "用户自己的词" in PROMPT
    assert "只问一个" in PROMPT
    assert "禁止让用户按表格格式回答" in PROMPT
    assert "允许用户说“不确定”" in PROMPT

def test_requirement_state_accumulates_only_user_facts():
    state=requirement_state([
        {"role":"user","content":"我父母用，需要洗澡、坐便和扶手"},
        {"role":"assistant","content":"您是不是喜欢中古风，预算三万元？"},
        {"role":"user","content":"就中古风，预算3万"},
    ])
    assert state["complete"] is True
    assert state["missing_fields"]==[]
    assert state["collected"]["使用人群"]==["父母"]
    assert state["collected"]["预期价格区间"]=="3万"

def test_requirement_state_reports_missing_fields():
    state=requirement_state([{"role":"user","content":"我想洗澡和坐便"}])
    assert state["complete"] is False
    assert state["missing_fields"]==["使用人群","喜好风格","预期价格区间"]

def test_requirement_state_accepts_natural_chinese_budget_without_prefix():
    state=requirement_state([{"role":"user","content":"成人使用，要淋浴，喜欢清爽素雅，两万元以内。"}])
    assert state["complete"] is True
    assert state["collected"]["预期价格区间"]=="两万元"

def test_requirement_state_accepts_delegated_functions_and_short_budget_range():
    state=requirement_state([
        {"role":"user","content":"有老人，设计尽量好看一点暖色调，预算2-4万"},
        {"role":"assistant","content":"这个卫生间主要需要哪些功能？比如是否需要淋浴、如厕或洗漱？"},
        {"role":"user","content":"没特别要求，你看着来"},
        {"role":"assistant","content":"轻法和素雅，您更喜欢哪个？"},
        {"role":"user","content":"轻法"},
    ])
    assert state["complete"] is True
    assert state["collected"]["功能需求"]==["淋浴","坐便","洗漱"]
    assert state["collected"]["预期价格区间"]=="2-4万"

def test_requirement_state_accepts_the_suggested_standard_bathroom_answer():
    state=requirement_state([
        {"role":"user","content":"有老人，设计尽量好看一点暖色调，预算2-4万"},
        {"role":"assistant","content":"如果只是日常使用，也可以说“常规卫浴”，我按适老安全配置来设计。"},
        {"role":"user","content":"中古"},
        {"role":"assistant","content":"请确认主要功能需求。"},
        {"role":"user","content":"常规卫浴"},
    ])
    assert state["complete"] is True
    assert state["collected"]["功能需求"]==["淋浴","坐便","洗漱"]
    assert state["collected"]["喜好风格"]==["中古"]

def test_model_requirement_state_handles_semantics_outside_keyword_fallback():
    messages=[
        {"role":"user","content":"给家里的长辈用，做得有老电影质感，控制在两到四万"},
        {"role":"assistant","content":"日常功能怎么安排？"},
        {"role":"user","content":"都交给你，按日常需要安排"},
    ]
    assert requirement_state(messages)["complete"] is False
    state=requirement_state_from_model({"audience":["老人"],"functions":[],"catalog_style":"中古","style_terms":["老电影质感"],"budget_text":"两到四万","delegated_standard_functions":True},messages)
    assert state["complete"] is True
    assert state["collected"]=={"使用人群":["老人"],"功能需求":["淋浴","坐便","洗漱"],"喜好风格":["中古"],"预期价格区间":"两到四万"}

@pytest.mark.asyncio
@pytest.mark.parametrize("budget_text", ["两到四万", "2w-4w"])
async def test_design_chat_uses_model_understanding_before_server_quote(tmp_path,monkeypatch,budget_text):
    graph=ProductKnowledgeGraph(tmp_path/"graph.json")
    catalog=Path(__file__).parents[1]/"data"/"product_catalog.csv"
    graph.import_catalog(catalog.name,catalog.read_bytes())
    messages=[
        {"role":"user","content":f"给家里的长辈用，做得有老电影质感，控制在{budget_text}"},
        {"role":"assistant","content":"日常功能怎么安排？"},
        {"role":"user","content":"都交给你，按日常需要安排"},
    ]
    calls=[]
    class Response:
        def __init__(self,message):self.message=message
        def raise_for_status(self):pass
        def json(self):return {"choices":[{"message":self.message}]}
    async def fake_post(_client,_url,**kwargs):
        calls.append(kwargs["json"])
        if len(calls)==1:
            arguments={"audience":["老人"],"functions":[],"catalog_style":"中古","style_terms":["老电影质感"],"budget_text":budget_text,"delegated_standard_functions":True}
            return Response({"role":"assistant","content":None,"tool_calls":[{"id":"requirements-1","type":"function","function":{"name":"capture_design_requirements","arguments":json.dumps(arguments,ensure_ascii=False)}}]})
        if len(calls)==2:
            return Response({"role":"assistant","content":None,"tool_calls":[]})
        return Response({"role":"assistant","content":"需求已确认，结构化报价已经生成。"})
    monkeypatch.setattr(design_chat_module,"serialized_post",fake_post)
    monkeypatch.setattr(design_chat_module.settings,"openai_base_url","http://model.test")
    monkeypatch.setattr(design_chat_module.settings,"openai_api_key","test-key")
    monkeypatch.setattr(design_chat_module.settings,"chat_model","test-model")
    room={"boundary":[{"x_mm":0,"z_mm":0},{"x_mm":2400,"z_mm":0},{"x_mm":2400,"z_mm":2000},{"x_mm":0,"z_mm":2000}],"height_mm":2600,"openings":[]}
    result=await design_chat(messages,graph,room)
    assert calls[0]["tools"]==[REQUIREMENT_TOOL]
    assert calls[1]["tools"][0]["function"]["name"]=="decide_layout_levels"
    assert calls[2]["messages"][-1]["role"]=="tool"
    assert result["requirements"]["complete"] is True
    assert result["pricing_status"]=="final"
    assert len(result["layout_levels"])==3
    assert all(level["products"] for level in result["layout_levels"])
    assert len(result["material_quotes"])==3
    assert len(result["furniture_quotes"])>=3
    assert result["quote_total"]>0

def test_empty_quote_context_blocks_model_invented_prices():
    unsafe="建议墙板按 200 元/㎡，材料合计 16853 元。"
    safe=_safe_model_message(unsafe,[])
    assert "200" not in safe and "16853" not in safe
    assert "当前知识图谱没有可用报价" in safe

def test_incomplete_requirements_do_not_report_a_populated_catalog_as_empty():
    unsafe="材料合计 16853 元。"
    safe=_safe_model_message(unsafe,[],catalog_has_prices=True,missing_fields=["功能需求"])
    assert "知识图谱没有可用报价" not in safe
    assert "产品清单已有可用价格" in safe and "功能需求" in safe

def test_nonempty_quote_context_also_blocks_model_invented_prices():
    unsafe="建议按清单单价 999 元，材料合计 8888 元。"
    safe=_safe_model_message(unsafe,[{"材料编号":"QB1"}])
    assert "999" not in safe and "8888" not in safe
    assert "服务端报价工具" in safe

def test_non_price_model_message_is_preserved():
    message="需求已经完整，请确认是否提交这版需求。"
    assert _safe_model_message(message,[{"材料编号":"QB1"}])==message

def test_invalid_catalog_price_never_becomes_quote():
    surfaces={"floor_purchase_sqm":4.4,"wall_purchase_sqm":10,"ceiling_purchase_sqm":4.4}
    products=[{"attributes":{"材料编号":"DB-X","材料名称":"地砖","单价":"约200元/㎡"}}]
    assert material_quotes(products,surfaces)==[]

def test_quote_tool_calculates_from_server_candidates_only():
    candidates=[
        {"product_id":"wall-qb1","材料编号":"QB1","采购量":10,"单价":80,"材料小计":800},
        {"product_id":"floor-db1","材料编号":"DB1","采购量":4.4,"单价":340,"材料小计":1496},
    ]
    result=calculate_design_quote(candidates,[],["wall-qb1","floor-db1","NOT-IN-CATALOG"])
    assert result["材料合计"]==2296
    assert [line["材料编号"] for line in result["材料报价"]]==["QB1","DB1"]
    assert QUOTE_TOOL["function"]["parameters"]["properties"].keys()=={"product_ids"}
    assert "calculate_design_quote 确定性计算" in PROMPT

def test_material_quotes_use_wall_ceiling_and_floor_quantities():
    surfaces={"wall_purchase_sqm":19.36,"ceiling_purchase_sqm":4.4,"floor_purchase_sqm":4.4}
    products=[
        {"id":"wall","attributes":{"材料编号":"QB1","材料名称":"墙板","单价":"80","数量单位":"平米"}},
        {"id":"ceiling","attributes":{"材料编号":"DD1","材料名称":"吊顶","单价":"45","数量单位":"平米"}},
        {"id":"floor","attributes":{"材料编号":"DB1","材料名称":"地砖","单价":"340","数量单位":"平米"}},
    ]
    result=material_quotes(products,surfaces)
    assert [(x["材料名称"],x["采购量"],x["材料小计"]) for x in result]==[("墙板",19.36,1548.8),("吊顶",4.4,198.0),("地砖",4.4,1496.0)]

def test_quote_tool_accepts_at_most_one_material_per_category():
    candidates=[
        {"product_id":"wall-a","材料名称":"墙板","材料小计":800},
        {"product_id":"wall-b","材料名称":"墙板","材料小计":1200},
        {"product_id":"ceiling-a","材料名称":"吊顶","材料小计":200},
        {"product_id":"floor-a","材料名称":"地砖","材料小计":500},
    ]
    result=calculate_design_quote(candidates,[],["wall-a","wall-b","ceiling-a","floor-a"])
    assert [x["product_id"] for x in result["材料报价"]]==["wall-a","ceiling-a","floor-a"]
    assert result["材料合计"]==1500

def test_constrained_graph_forbidden_category_wins(tmp_path: Path):
    graph=ProductKnowledgeGraph(tmp_path/"graph.json")
    graph.import_catalog("p.csv","材料编号,材料名称,人群\nG1,淋浴隔断,老人\nS1,淋浴椅,老人\n".encode())
    products=graph.search_constrained("老人淋浴",forbidden={"淋浴隔断"})
    assert all(item["attributes"]["材料名称"]!="淋浴隔断" for item in products)

def test_hybrid_graph_retrieval_is_traceable(tmp_path: Path):
    graph=ProductKnowledgeGraph(tmp_path/"graph.json")
    graph.import_catalog("p.csv","材料编号,材料名称,人群,风格\nS1,淋浴椅,老人,中古\nT1,地砖,成人,现代\n".encode())
    stored=graph.load()
    assert stored["version"]==2 and stored["relations"]
    result=graph.search("父母想要中古适老淋浴",limit=2)
    assert result[0]["attributes"]["材料编号"]=="S1"
    assert result[0]["retrieval"]["method"]=="hybrid_rrf"
    assert result[0]["retrieval"]["rrf_k"]==60
    assert result[0]["retrieval"]["weights"]=={"bm25":1.0,"vector":1.0,"graph":1.0}
    assert result[0]["retrieval"]["source"].startswith("product_catalog:")

def test_quote_uses_unique_product_id_when_catalog_codes_collide():
    candidates=[
        {"product_id":"wall-x1","材料编号":"X1","材料名称":"墙板","材料小计":800},
        {"product_id":"floor-x1","材料编号":"X1","材料名称":"地砖","材料小计":1200},
    ]
    result=calculate_design_quote(candidates,[],["floor-x1"])
    assert result["材料合计"]==1200
    assert [x["材料名称"] for x in result["材料报价"]]==["地砖"]

def test_unified_quote_has_material_furniture_and_grand_total():
    materials=[{"product_id":"wall","材料名称":"墙板","材料小计":800}]
    furniture=[{"product_id":"toilet","家具名称":"马桶","家具小计":1200}]
    result=calculate_design_quote(materials,furniture,["wall","toilet","fake"])
    assert result["材料合计"]==800
    assert result["家具合计"]==1200
    assert result["总计"]==2000
    assert [x["家具名称"] for x in result["家具报价"]]==["马桶"]

def test_style_aliases_converge_to_catalog_vocabulary():
    mapped=resolve_style([{"role":"user","content":"想要奶油色、温柔精致一点"}])
    assert mapped["catalog_style"]=="轻法" and mapped["status"]=="mapped"
    exact=resolve_style([{"role":"user","content":"那就知识图谱里的轻法"}])
    assert exact["catalog_style"]=="轻法" and exact["confidence"]==1

def test_unknown_style_exposes_feelings_for_clarification():
    result=resolve_style([{"role":"user","content":"要像周末雨后一样的感觉"}])
    assert result["status"]=="needs_clarification"
    assert {x["catalog_style"] for x in result["candidates"]}=={"素雅","轻法","中古"}

def test_furniture_style_filter_and_model_lookup_contract():
    products=[{"id":"dark","attributes":{"材料编号":"HS1","材料名称":"花洒","风格":"中古","规格型号":"枪灰","单价":"500"}},{"id":"light","attributes":{"材料编号":"HS2","材料名称":"花洒","风格":"素雅、轻法","规格型号":"银白","单价":"600"}},{"id":"chair","attributes":{"材料编号":"LYY","材料名称":"淋浴椅","风格":"通用","单价":"300"}}]
    result=furniture_quotes(products,{"catalog_style":"中古","user_terms":["复古"]})
    assert [x["product_id"] for x in result]==["dark","chair"]
    assert result[0]["风格匹配依据"]==["复古"]
    assert result[0]["model_lookup"]["binding_status"]=="awaiting_model_asset"

def test_exact_catalog_code_binds_builtin_model_asset():
    products=[{"id":"catalog-shower","attributes":{"材料编号":"HS1-1","材料名称":"花洒","风格":"素雅","规格型号":"基础花洒","单价":"500"}}]
    result=furniture_quotes(products,{"catalog_style":"素雅","user_terms":["素雅"]})
    lookup=result[0]["model_lookup"]
    assert lookup["binding_status"]=="bound"
    assert lookup["model_asset_id"]
    assert lookup["model_asset_src"].startswith("/model-library/models/")
    assert lookup["model_dimensions_mm"]["width"]>0

def test_furniture_combination_price_range_uses_each_required_category():
    candidates=[
        {"product_id":"toilet-a","家具名称":"马桶","家具小计":800},
        {"product_id":"toilet-b","家具名称":"马桶","家具小计":1600},
        {"product_id":"chair-a","家具名称":"淋浴椅","家具小计":170},
        {"product_id":"chair-b","家具名称":"淋浴椅","家具小计":390},
    ]
    rules={"必须设备":["马桶","淋浴椅"],"不能有的设备":[]}
    groups=furniture_candidate_groups(candidates,rules)
    assert groups[0]["candidate_count"]==2
    assert (groups[0]["min_price"],groups[0]["max_price"])==(800,1600)
    assert furniture_price_range(groups)=={"min":970,"max":1990}

def test_auto_layout_keeps_only_exactly_bound_toilet_model():
    candidates=[
        {"product_id":"mt1","家具名称":"马桶","家具小计":550,"材料编号":"MT1","model_lookup":{"catalog_code":"MT1","binding_status":"awaiting_model_asset"}},
        {"product_id":"mt2","家具名称":"马桶","家具小计":800,"材料编号":"MT2","model_lookup":{"catalog_code":"MT2","binding_status":"awaiting_model_asset"}},
        {"product_id":"mt3","家具名称":"马桶","家具小计":1200,"材料编号":"MT3","model_lookup":{"catalog_code":"MT3","binding_status":"bound","model_asset_src":"/api/model-assets/toilet.fbx","model_dimensions_mm":{"width":380,"depth":680,"height":760}}},
    ]
    groups=furniture_candidate_groups(candidates,{"必须设备":["马桶"],"不能有的设备":[]},require_bound_models=True)
    assert groups[0]["candidate_count"]==1
    assert groups[0]["candidates"][0]["材料编号"]=="MT3"

def test_auto_layout_blocks_toilet_when_no_exact_model_is_bound():
    groups=furniture_candidate_groups([{"product_id":"mt1","家具名称":"马桶","家具小计":550,"材料编号":"MT1","model_lookup":{"catalog_code":"MT1","binding_status":"awaiting_model_asset"}}],{"必须设备":["马桶"],"不能有的设备":[]},require_bound_models=True)
    assert _layout_candidate_blockers(groups,{"必须设备":["马桶"],"不能有的设备":[]})==["必需品类缺少精确模型资产绑定：马桶"]

def test_final_furniture_quote_selects_one_item_per_category_against_budget():
    groups=[
        {"category":"马桶","min_price":800,"max_price":1600,"candidates":[
            {"product_id":"toilet-a","家具名称":"马桶","家具小计":800},
            {"product_id":"toilet-b","家具名称":"马桶","家具小计":1600},
        ]},
        {"category":"花洒","min_price":500,"max_price":900,"candidates":[
            {"product_id":"shower-a","家具名称":"花洒","家具小计":500},
            {"product_id":"shower-b","家具名称":"花洒","家具小计":900},
        ]},
    ]
    assert [item["product_id"] for item in select_furniture_quotes(groups,"预算3000元",1800)]==["toilet-a","shower-a"]
    assert [item["product_id"] for item in select_furniture_quotes(groups,"两万元以内",1800)]==["toilet-b","shower-b"]
    assert [item["product_id"] for item in select_furniture_quotes(groups,"预算2-4万",1800)]==["toilet-b","shower-b"]

def test_default_quote_never_preselects_furniture():
    materials=[{"product_id":"wall","材料名称":"墙板"},{"product_id":"floor","材料名称":"地砖"},{"product_id":"ceiling","材料名称":"吊顶"}]
    furniture=[{"product_id":"toilet-1","家具名称":"马桶"}]
    rules={"必须设备":["马桶"],"不能有的设备":[]}
    assert default_product_ids(materials,furniture,rules)==["wall","floor","ceiling"]
    assert "不得传入家具 ID" in QUOTE_TOOL["function"]["parameters"]["properties"]["product_ids"]["description"]
