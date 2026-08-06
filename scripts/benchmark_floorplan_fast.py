#!/usr/bin/env python3
"""Run the production fast pipeline and enforce offline launch gates."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app import ai


EXPECTED_VALUES = {4105, 4110, 1590, 1640, 615, 1840, 2855, 800, 2090}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True, help="Path to an authorized local source image (not stored in Git)")
    parser.add_argument("--max-seconds", type=float, default=360)
    parser.add_argument("--min-value-recall", type=float, default=0.8)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


async def run(args: argparse.Namespace) -> dict:
    started = time.perf_counter()
    spec = await ai.analyze_floorplan_fast(args.image.resolve())
    elapsed = time.perf_counter() - started
    observations = [item for item in spec.observations if item.field.startswith("ocr:")]
    recognized_values = {
        value
        for item in observations
        for value in ai._ocr_numbers(item.value)
    }
    directions = [edge.direction for edge in spec.plan_annotation.edge_chain]
    corners = spec.plan_annotation.boundary
    short_edges = sum(
        max(abs(end.x - start.x), abs(end.y - start.y)) <= 110
        for start, end in zip(corners, [*corners[1:], *corners[:1]])
    ) if corners else 0
    recalled = sorted(EXPECTED_VALUES & recognized_values)
    recall = len(recalled) / len(EXPECTED_VALUES)
    metric_edges = spec.plan_annotation.edge_chain
    closure_adjustments = [
        edge.closure_adjustment_mm for edge in metric_edges if edge.closure_adjustment_mm
    ]
    checks = {
        "read_model_configured": bool(ai.settings.read_model),
        "latency_within_budget": elapsed <= args.max_seconds,
        "non_rectangular_topology": len(corners) >= 8 and len(directions) == len(corners),
        "short_returns_preserved": short_edges >= 2,
        "metric_boundary_generated": len(spec.boundary) == len(corners) and len(spec.boundary) >= 8,
        "dimension_chain_fully_solved": bool(metric_edges) and all(edge.length_mm for edge in metric_edges),
        "both_horizontal_total_readings_preserved": {4105, 4110} <= recognized_values,
        "five_mm_measurement_error_absorbed": any(abs(value) == 5 for value in closure_adjustments),
        "no_pixel_scaled_metric_edges": all(edge.source != "estimated" for edge in metric_edges),
        "known_bad_reading_absent": 5582 not in recognized_values and all(edge.length_mm != 5582 for edge in spec.plan_annotation.edge_chain),
        "handwriting_recall": recall >= args.min_value_recall,
        "critical_value_is_local": any(
            2855 in ai._ocr_numbers(item.value)
            and item.semantic_role == "wall_segment"
            and item.target_id
            and item.target_id.startswith("wall:")
            for item in observations
        ),
    }
    return {
        "passed": all(checks.values()),
        "model": ai.settings.read_model,
        "elapsed_seconds": round(elapsed, 2),
        "corner_count": len(corners),
        "short_edge_count": short_edges,
        "recognized_expected_values": recalled,
        "value_recall": round(recall, 3),
        "auto_edge_lengths": [edge.length_mm for edge in spec.plan_annotation.edge_chain if edge.length_mm],
        "closure_adjustments_mm": closure_adjustments,
        "checks": checks,
    }


def main() -> None:
    args = parse_args()
    result = asyncio.run(run(args))
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
