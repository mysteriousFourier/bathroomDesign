from __future__ import annotations

import numpy as np
import pytest

from scripts.recognize_floorplan_sample import (
    build_dimension_constrained_plan,
    normalize_number,
    read_image,
    write_png,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("1640", 1640),
        ("32", 320),
        ("60", 260),
        ("2o", 260),
        ("40", 400),
        ("0+81", 1840),
        ("0781", 1840),
        ("吊顶2.100", 2100),
        ("800×2055×120", 800),
        ("门宽高厚", None),
    ],
)
def test_sample_ocr_number_repairs(raw: str, expected: int | None) -> None:
    assert normalize_number(raw) == expected


def sample_evidence(*values: int) -> list[dict]:
    return [{"value": value} for value in values]


def test_dimension_chains_close_without_double_counting_short_return() -> None:
    evidence = sample_evidence(55, 260, 320, 400, 615, 800, 1590, 1640, 1840, 2855)
    plan = build_dimension_constrained_plan(
        evidence, {"segment_count": 45, "segments": []}
    )

    assert plan["dimension_checks"]["top_chain_sum"] == 4105
    assert plan["dimension_checks"]["door_chain"] == [400, 800, 2905]
    assert plan["dimension_checks"]["door_chain_sum"] == 4105
    assert plan["dimension_checks"]["door_tail_ocr_support"] == [55, 2855]
    assert plan["wall_lengths_mm"] == [3845, 1840, 2905, 320, 1200, 1840, 260, 320]
    assert plan["openings"][0]["width_mm"] == 800


def test_missing_critical_dimensions_fail_closed() -> None:
    evidence = sample_evidence(260, 320, 400, 1590, 1640, 1840, 2855)

    with pytest.raises(
        RuntimeError, match=r"missing required handwritten dimensions: \[615, 800\]"
    ):
        build_dimension_constrained_plan(
            evidence, {"segment_count": 0, "segments": []}
        )


def test_image_io_supports_unicode_windows_paths(tmp_path) -> None:
    image_path = tmp_path / "中文目录" / "户型预览.png"
    image = np.zeros((8, 12, 3), dtype=np.uint8)
    image[:, :, 1] = 127

    write_png(image_path, image)

    assert np.array_equal(read_image(image_path), image)
