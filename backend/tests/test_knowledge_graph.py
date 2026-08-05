from pathlib import Path
from backend.app.knowledge_graph import ProductKnowledgeGraph, equipment_rules
from backend.app.design_chat import PROMPT, QUOTE_TOOL, _safe_model_message, calculate_material_quote, material_quotes, requirement_state, surface_estimate

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

def test_approved_catalog_from_reference_image(tmp_path: Path):
    catalog=Path(__file__).parents[1]/"data"/"product_catalog.csv"
    graph=ProductKnowledgeGraph(tmp_path/"graph.json")
    result=graph.import_catalog(catalog.name,catalog.read_bytes())
    assert result=={"created":46,"updated":0,"unchanged":0,"deactivated":0,"total":46}
    products=[item["attributes"] for item in graph.load()["products"].values()]
    assert products[0]["材料编号"]=="QB1-SY"
    assert products[-1]["材料编号"]=="LYY-1"
    assert {item["材料名称"] for item in products} >= {"墙板","地砖","马桶","淋浴隔断","适老浴室柜"}
    assert next(item for item in products if item["材料编号"]=="MT3")["单价"]=="1200"
    assert len({item["备注"] for item in products[:9]})==1
    assert len({item["备注"] for item in products[9:18]})==1
    assert {item["attributes"]["材料名称"] for item in graph.search("老人使用，中古风格")} >= {"花洒扶手","马桶扶手","淋浴椅"}

def test_simple_bathroom_surface_area_comes_from_measurement():
    room={"boundary":[{"x_mm":0,"z_mm":0},{"x_mm":2000,"z_mm":0},{"x_mm":2000,"z_mm":2000},{"x_mm":0,"z_mm":2000}],"height_mm":2400,"openings":[{"width_mm":800,"height_mm":2000}]}
    result=surface_estimate(room)
    assert result["floor_area_sqm"]==4
    assert result["wall_gross_area_sqm"]==19.2
    assert result["opening_area_sqm"]==1.6
    assert result["wall_net_area_sqm"]==17.6
    assert result["floor_purchase_sqm"]==4.4
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
    assert "禁止输出任何单价、小计、总价" in PROMPT

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

def test_empty_quote_context_blocks_model_invented_prices():
    unsafe="建议墙板按 200 元/㎡，材料合计 16853 元。"
    safe=_safe_model_message(unsafe,[])
    assert "200" not in safe and "16853" not in safe
    assert "当前知识图谱没有可用报价" in safe

def test_invalid_catalog_price_never_becomes_quote():
    surfaces={"floor_purchase_sqm":4.4,"wall_purchase_sqm":10}
    products=[{"attributes":{"材料编号":"DB-X","材料名称":"地砖","单价":"约200元/㎡"}}]
    assert material_quotes(products,surfaces)==[]

def test_quote_tool_calculates_from_server_candidates_only():
    candidates=[
        {"product_id":"wall-qb1","材料编号":"QB1","采购量":10,"单价":80,"材料小计":800},
        {"product_id":"floor-db1","材料编号":"DB1","采购量":4.4,"单价":340,"材料小计":1496},
    ]
    result=calculate_material_quote(candidates,["wall-qb1","floor-db1","NOT-IN-CATALOG"])
    assert result["材料合计"]==2296
    assert [line["材料编号"] for line in result["报价明细"]]==["QB1","DB1"]
    assert QUOTE_TOOL["function"]["parameters"]["properties"].keys()=={"product_ids"}
    assert "必须调用 calculate_material_quote" in PROMPT

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
    result=calculate_material_quote(candidates,["floor-x1"])
    assert result["材料合计"]==1200
    assert [x["材料名称"] for x in result["报价明细"]]==["地砖"]
