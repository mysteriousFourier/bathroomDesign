from __future__ import annotations

import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.knowledge_graph import ProductKnowledgeGraph, equipment_rules
SCENARIOS = {
    "standard_shower": "淋浴洗漱上厕所",
    "laundry": "洗衣淋浴洗漱上厕所",
    "elderly_safe": "适老老人轮椅淋浴洗漱上厕所",
}


def main() -> None:
    output: dict[str, object] = {"source": "ProductKnowledgeGraph.search_constrained", "scenarios": {}}
    with TemporaryDirectory() as directory:
        graph = ProductKnowledgeGraph(Path(directory) / "product-knowledge-graph.json")
        graph.import_catalog("product_catalog.csv", (ROOT / "backend/data/product_catalog.csv").read_bytes())
        for scenario, query in SCENARIOS.items():
            rules = equipment_rules(query)
            products = graph.search_constrained(
                " ".join(rules["必须设备"]) + " " + query,
                limit=30,
                forbidden=set(rules["不能有的设备"]),
                allowed_categories=set(rules["必须设备"]),
            )
            output["scenarios"][scenario] = {
                "rules": rules,
                "products": [
                    {
                        "graph_id": product["id"],
                        "code": product["attributes"]["材料编号"],
                        "category": product["attributes"]["材料名称"],
                        "spec": product["attributes"].get("规格型号", ""),
                        "price": float(product["attributes"].get("单价", 0)),
                        "retrieval": product["retrieval"],
                    }
                    for product in products
                ],
            }
    (ROOT / "src/generated-layout-products.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", "utf-8")


if __name__ == "__main__":
    main()
