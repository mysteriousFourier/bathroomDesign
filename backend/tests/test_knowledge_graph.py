from pathlib import Path
from backend.app.knowledge_graph import ProductKnowledgeGraph, equipment_rules
from backend.app.design_chat import PROMPT, surface_estimate

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
    assert "简短自然回应一句" in PROMPT
    assert "接回尚未确认的装修需求" in PROMPT
    assert "不要责备用户跑题" in PROMPT
