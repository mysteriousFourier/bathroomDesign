from backend.app.design_chat import build_layout_levels


def _groups(categories=("花洒", "热水器", "马桶", "浴室柜")):
    return [
        {
            "category": category,
            "candidates": [
                {
                    "product_id": f"{category}-{index}",
                    "材料编号": f"CODE-{category}-{index}",
                    "家具名称": category,
                    "规格型号": f"{category} {index}",
                    "家具小计": index * 100,
                    "单位": "件",
                    "model_lookup": {"catalog_code": f"CODE-{category}-{index}"},
                }
                for index in range(1, 4)
            ],
        }
        for category in categories
    ]


def test_invalid_model_result_falls_back_to_three_complete_product_snapshots():
    required = ["花洒", "热水器", "马桶", "浴室柜"]
    levels, blockers = build_layout_levels({"levels": [{"product_ids": ["马桶-1"]}] * 3}, _groups(), {"必须设备": required, "不能有的设备": []})
    assert blockers == []
    assert len(levels) == 3
    assert all({product["category"] for product in level["products"]} == set(required) for level in levels)
    assert len({tuple(level["product_ids"]) for level in levels}) == 3
    assert all(level["layout_script"]["source"] == "deterministic-rule-engine" for level in levels)


def test_missing_required_candidate_blocks_layout_instead_of_claiming_compliance():
    levels, blockers = build_layout_levels({}, _groups(("马桶",)), {"必须设备": ["马桶", "浴室柜"], "不能有的设备": []})
    assert levels == []
    assert blockers == ["产品目录缺少必需品类：浴室柜"]


def test_empty_equipment_mapping_blocks_layout():
    levels, blockers = build_layout_levels({}, [], {"必须设备": [], "不能有的设备": []})
    assert levels == []
    assert blockers and "没有映射" in blockers[0]


def test_accessible_profile_and_washer_instruction_are_derived_from_required_products():
    categories = ("花洒", "热水器", "马桶", "适老浴室柜", "淋浴椅", "花洒扶手", "马桶扶手", "洗衣机")
    groups = _groups(categories)
    levels, blockers = build_layout_levels({}, groups, {"必须设备": list(categories), "不能有的设备": ["淋浴隔断"]})
    assert blockers == []
    assert all(level["demand_profile"] == "elderly_safe" for level in levels)
    assert all(any(item["fixture_role"] == "washer" for item in level["layout_script"]["instructions"]) for level in levels)
