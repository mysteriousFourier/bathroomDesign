from __future__ import annotations

import cv2
import numpy as np

from backend.app.capture import assess_capture


def write_test_image(path, image: np.ndarray) -> None:
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    encoded.tofile(path)


def test_assess_capture_accepts_clear_high_resolution_plan(tmp_path) -> None:
    image = np.full((2200, 3000, 3), 225, dtype=np.uint8)
    for x in range(250, 2750, 250):
        cv2.line(image, (x, 180), (x, 2020), (35, 35, 35), 5)
    cv2.putText(image, "1840", (850, 1150), cv2.FONT_HERSHEY_SIMPLEX, 4, (20, 20, 20), 8)
    path = tmp_path / "clear-plan.png"
    write_test_image(path, image)

    result = assess_capture(path)

    assert result.status == "ready"
    assert all(item.status == "pass" for item in result.checks)


def test_assess_capture_recommends_retake_for_small_flat_image(tmp_path) -> None:
    image = np.full((400, 600, 3), 128, dtype=np.uint8)
    path = tmp_path / "flat-plan.png"
    write_test_image(path, image)

    result = assess_capture(path)

    assert result.status == "retake"
    assert {item.code for item in result.checks if item.status == "error"} >= {
        "resolution", "sharpness", "contrast",
    }
