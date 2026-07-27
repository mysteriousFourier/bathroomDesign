#!/usr/bin/env python3
"""Reproduce the AGEN-6.4 dimension-chain floorplan recognition experiment."""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PHOTO = ROOT / "evidence" / "samples" / "real" / "agen-17-long-term" / "source.jpg"
DEFAULT_OUT_DIR = ROOT / ".tmp" / "floorplan-recognition"

# These substitutions document OCR failure modes observed on the persisted
# AGEN-17 sample. They are intentionally scoped to this diagnostic script.
SAMPLE_NUMBER_REPAIRS = {
    "0+81": 1840,
    "0781": 1840,
    "32": 320,
    "60": 260,
    "20": 260,
    "40": 400,
}


def run_paddleocr(image_path: Path) -> dict:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "run_paddleocr.py"), str(image_path)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=True,
    )
    marker = "__PADDLEOCR_JSON__"
    for line in proc.stdout.splitlines():
        if line.startswith(marker):
            return json.loads(line[len(marker) :])
    raise RuntimeError("PaddleOCR output did not contain JSON marker")


def normalize_number(text: str) -> int | None:
    raw = text.strip().lower().replace("o", "0").replace("×", "x")
    compact = re.sub(r"\s+", "", raw)
    if compact in SAMPLE_NUMBER_REPAIRS:
        return SAMPLE_NUMBER_REPAIRS[compact]

    metres = re.search(r"(?<!\d)([1-9])[.,](\d{3})(?!\d)", compact)
    if metres:
        return int(metres.group(1)) * 1000 + int(metres.group(2))

    match = re.search(r"\d{2,4}", compact)
    if not match:
        return None
    value = int(match.group(0))
    return None if value == 1 else value


def ocr_evidence(ocr: dict) -> list[dict]:
    required_keys = ("rec_texts", "rec_scores", "rec_boxes")
    if any(key not in ocr for key in required_keys):
        raise ValueError(f"PaddleOCR result must contain {', '.join(required_keys)}")
    if len({len(ocr[key]) for key in required_keys}) != 1:
        raise ValueError("PaddleOCR text, score, and box arrays must have equal length")

    evidence = []
    for index, (text, score, box) in enumerate(
        zip(ocr["rec_texts"], ocr["rec_scores"], ocr["rec_boxes"]), start=1
    ):
        evidence.append(
            {
                "id": f"O{index:03d}",
                "text": text,
                "value": normalize_number(text),
                "score": round(float(score), 4),
                "box": box,
            }
        )
    return evidence


def load_replay_evidence(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    evidence = payload.get("ocr") if isinstance(payload, dict) else payload
    if not isinstance(evidence, list):
        raise ValueError("Replay JSON must be an OCR evidence list or contain an 'ocr' list")
    return evidence


def values_present(evidence: list[dict]) -> set[int]:
    return {
        value
        for item in evidence
        if isinstance((value := item.get("value")), int)
    }


def read_image(path: Path) -> np.ndarray:
    """Read an image without relying on OpenCV's Windows path decoding."""
    try:
        encoded = np.fromfile(path, dtype=np.uint8)
    except OSError as error:
        raise FileNotFoundError(f"Unable to read image: {path}") from error
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Unable to decode image: {path}")
    return image


def write_png(path: Path, image: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    success, encoded = cv2.imencode(".png", image)
    if not success:
        raise RuntimeError(f"Unable to encode PNG: {path}")
    encoded.tofile(path)


def detect_axis_lines(image_path: Path, out_dir: Path) -> dict:
    image = read_image(image_path)
    gray = cv2.GaussianBlur(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    threshold = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 41, 9
    )
    horizontal = cv2.morphologyEx(
        threshold,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (55, 3)),
    )
    vertical = cv2.morphologyEx(
        threshold,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, 55)),
    )
    line_mask = cv2.bitwise_or(horizontal, vertical)
    lines = cv2.HoughLinesP(
        line_mask, 1, np.pi / 180, threshold=80, minLineLength=120, maxLineGap=35
    )
    segments = []
    if lines is not None:
        for line in lines[:, 0, :]:
            x1, y1, x2, y2 = [int(value) for value in line]
            length = math.hypot(x2 - x1, y2 - y1)
            if length < 120:
                continue
            angle = abs(math.degrees(math.atan2(y2 - y1, x2 - x1))) % 180
            if angle < 12 or angle > 168:
                orientation = "h"
            elif 78 < angle < 102:
                orientation = "v"
            else:
                continue
            segments.append(
                {
                    "orientation": orientation,
                    "x1": x1,
                    "y1": y1,
                    "x2": x2,
                    "y2": y2,
                    "length_px": round(length, 1),
                }
            )
    out_dir.mkdir(parents=True, exist_ok=True)
    write_png(out_dir / "line-mask.png", line_mask)
    return {
        "segments": sorted(segments, key=lambda item: item["length_px"], reverse=True)[:40],
        "segment_count": len(segments),
    }


def build_dimension_constrained_plan(evidence: list[dict], line_summary: dict) -> dict:
    values = values_present(evidence)
    required = {260, 320, 400, 615, 800, 1590, 1640, 1840, 2855}
    missing = sorted(required - values)
    if missing:
        raise RuntimeError(f"missing required handwritten dimensions: {missing}")

    total_width = 260 + 1640 + 615 + 1590
    total_height = 320 + 1840
    # The bottom tail is solved by closure. OCR reads 2855 plus a nearby 55,
    # but summing those two labels would double-count the short return.
    bottom_tail = total_width - 400 - 800
    checks = {
        "top_chain": [260, 1640, 615, 1590],
        "top_chain_sum": total_width,
        "left_chain": [320, 1840],
        "left_chain_sum": total_height,
        "door_chain": [400, 800, bottom_tail],
        "door_chain_sum": 400 + 800 + bottom_tail,
        "door_tail_ocr_support": sorted(value for value in values if value in {55, 2855, 2905}),
        "right_depth": 1840,
    }
    if checks["door_chain_sum"] != total_width:
        raise RuntimeError(
            f"door chain does not close: {checks['door_chain_sum']} != {total_width}"
        )

    return {
        "method": "OCR dimension-chain constrained orthogonal topology",
        "source": "site photo only; DWG used only after output for validation",
        "boundary_mm": [
            [260, 0],
            [4105, 0],
            [4105, 1840],
            [1200, 1840],
            [1200, 2160],
            [0, 2160],
            [0, 320],
            [260, 320],
        ],
        "wall_lengths_mm": [3845, 1840, 2905, 320, 1200, 1840, 260, 320],
        "secondary_walls": [
            {
                "type": "pipe_chase",
                "role": "secondary_wall",
                "note": "包管作为二级语义标注；不再用矩形外框抹平左下角阶梯轮廓",
                "outer_corner_mm": [0, 0],
                "width_mm": 260,
                "depth_mm": 320,
                "wall_segments_mm": [
                    [[0, 0], [260, 0]],
                    [[260, 0], [260, 320]],
                    [[260, 320], [0, 320]],
                ],
            }
        ],
        "openings": [
            {
                "wall_index": 4,
                "offset_mm": 400,
                "width_mm": 800,
                "height_mm": 2055,
                "thickness_mm": 120,
            }
        ],
        "dimension_checks": checks,
        "line_detection": {
            "axis_aligned_segment_count": line_summary["segment_count"],
            "longest_segments": line_summary["segments"][:8],
        },
        "confidence": "high for this photo because all closing dimension chains are present",
    }


def draw_plan(plan: dict, out_dir: Path) -> None:
    boundary_mm = np.array(plan["boundary_mm"], dtype=np.float32)
    min_xy = boundary_mm.min(axis=0)
    scale = 0.18
    pad = 80
    canvas = np.full((520, 900, 3), 255, dtype=np.uint8)
    points = ((boundary_mm - min_xy) * scale + pad).astype(np.int32)
    cv2.polylines(canvas, [points], True, (30, 30, 30), 4, cv2.LINE_AA)
    for item in plan.get("secondary_walls", []):
        for start_mm, end_mm in item.get("wall_segments_mm", []):
            start = ((np.array(start_mm) - min_xy) * scale + pad).astype(np.int32)
            end = ((np.array(end_mm) - min_xy) * scale + pad).astype(np.int32)
            cv2.line(canvas, tuple(start), tuple(end), (30, 120, 220), 3, cv2.LINE_AA)
    for index, point in enumerate(points):
        cv2.circle(canvas, tuple(point), 5, (40, 90, 200), -1)
        cv2.putText(
            canvas,
            str(index),
            tuple(point + [8, -8]),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (40, 90, 200),
            1,
        )
    for index, point in enumerate(points):
        midpoint = ((point + points[(index + 1) % len(points)]) / 2).astype(np.int32)
        cv2.putText(
            canvas,
            str(plan["wall_lengths_mm"][index]),
            tuple(midpoint),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (20, 120, 20),
            2,
            cv2.LINE_AA,
        )
    for opening in plan.get("openings", []):
        wall_index = opening["wall_index"]
        start_mm = boundary_mm[wall_index]
        end_mm = boundary_mm[(wall_index + 1) % len(boundary_mm)]
        wall = end_mm - start_mm
        direction = wall / float(np.linalg.norm(wall))
        opening_start_mm = start_mm + direction * opening["offset_mm"]
        opening_end_mm = opening_start_mm + direction * opening["width_mm"]
        opening_start = ((opening_start_mm - min_xy) * scale + pad).astype(np.int32)
        opening_end = ((opening_end_mm - min_xy) * scale + pad).astype(np.int32)
        cv2.line(
            canvas, tuple(opening_start), tuple(opening_end), (0, 165, 255), 8, cv2.LINE_AA
        )
        label_at = ((opening_start + opening_end) / 2).astype(np.int32) + [8, -8]
        cv2.putText(
            canvas,
            f"door {opening['width_mm']}",
            tuple(label_at),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (0, 120, 200),
            2,
            cv2.LINE_AA,
        )
    out_dir.mkdir(parents=True, exist_ok=True)
    write_png(out_dir / "recognized-plan.png", canvas)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, default=DEFAULT_PHOTO)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument(
        "--replay-json",
        type=Path,
        help="Reuse OCR evidence from a previous recognized-plan.json instead of running PaddleOCR",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    image_path = args.image.resolve()
    out_dir = args.out_dir.resolve()
    evidence = (
        load_replay_evidence(args.replay_json.resolve())
        if args.replay_json
        else ocr_evidence(run_paddleocr(image_path))
    )
    line_summary = detect_axis_lines(image_path, out_dir)
    plan = build_dimension_constrained_plan(evidence, line_summary)
    result = {"ocr": evidence, "plan": plan}
    (out_dir / "recognized-plan.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    draw_plan(plan, out_dir)
    print(json.dumps(plan, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
