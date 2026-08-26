#!/usr/bin/env python3
"""Run the hand-drawn floorplan regression set without storing source photos.

The manifest contains only hashes, image dimensions, and human-confirmed
expectations. Recognition JSON is written to an explicitly selected output
directory and can be replayed with ``--replay-dir`` for offline checks.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.ai import analyze_floorplan_fast  # noqa: E402
from backend.app.models import RoomSpec  # noqa: E402
from backend.app.validation import has_self_intersection, polygon_area  # noqa: E402


DEFAULT_MANIFEST = ROOT / "evidence" / "handdrawn-regression.json"
DEFAULT_OUTPUT = ROOT / ".tmp" / "handdrawn-regression"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _image_meta(path: Path) -> dict[str, Any]:
    with Image.open(path) as image:
        return {"sha256": _sha256(path), "width": image.width, "height": image.height}


def _numbers(value: object) -> set[int]:
    text = str(value or "")
    values: set[int] = set()
    for token in re.findall(r"(?<!\d)(0|\d{2,5})(?!\d)", text.replace(",", "")):
        number = int(token)
        if number != 1:
            values.add(number)
    return values


def _spec_from_payload(payload: object) -> RoomSpec:
    if isinstance(payload, RoomSpec):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("spec"), dict):
        payload = payload["spec"]
    return RoomSpec.model_validate(payload)


def _geometry_report(spec: RoomSpec) -> dict[str, Any]:
    boundary = spec.boundary
    annotation = spec.plan_annotation
    corners = annotation.boundary if annotation and annotation.boundary else boundary
    orthogonal = bool(boundary) and all(
        start.x_mm == end.x_mm or start.z_mm == end.z_mm
        for index, start in enumerate(boundary)
        for end in [boundary[(index + 1) % len(boundary)]]
    )
    closed = len(boundary) >= 3 and orthogonal and not has_self_intersection(boundary) and polygon_area(boundary) > 0
    edge_chain = annotation.edge_chain if annotation else []
    return {
        "closed": closed,
        "self_intersection": bool(boundary) and has_self_intersection(boundary),
        "orthogonal": orthogonal,
        "corner_count": len(corners),
        "edge_chain": [edge.model_dump(mode="json") for edge in edge_chain],
        "short_returns": sum(
            edge.role == "structure_return" or (edge.length_mm is not None and edge.length_mm <= 100)
            for edge in edge_chain
        ),
        "closure_adjustments_mm": [edge.closure_adjustment_mm for edge in edge_chain if edge.closure_adjustment_mm],
    }


def _recognized_values(spec: RoomSpec) -> set[int]:
    values: set[int] = set()
    for observation in spec.observations:
        values.update(_numbers(observation.value))
    for edge in (spec.plan_annotation.edge_chain if spec.plan_annotation else []):
        values.update(number for number in (edge.length_mm, edge.measured_length_mm) if number)
    for opening in spec.openings:
        values.update(number for number in (opening.sill_mm, opening.width_mm, opening.height_mm) if number is not None)
    if spec.height_mm:
        values.add(spec.height_mm)
    for zone in spec.ceiling_zones:
        values.add(zone.height_mm)
    return values


def _required_values_have_bbox(spec: RoomSpec, required: set[int]) -> bool:
    evidence_values = {
        number
        for observation in spec.observations
        if observation.bbox is not None and "fallback" not in observation.note.lower()
        for number in _numbers(observation.value)
    }
    observations_by_id = {
        observation.field.removeprefix("ocr:"): observation
        for observation in spec.observations
        if observation.field.startswith("ocr:")
    }
    for edge in (spec.plan_annotation.edge_chain if spec.plan_annotation else []):
        if edge.length_mm is None or not edge.evidence_ids:
            continue
        cited = [observations_by_id.get(evidence_id) for evidence_id in edge.evidence_ids]
        if cited and all(
            observation is not None
            and observation.bbox is not None
            and "fallback" not in observation.note.lower()
            for observation in cited
        ):
            evidence_values.add(edge.length_mm)
    return required.issubset(evidence_values)


def evaluate_spec(spec: RoomSpec, expected: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return deterministic acceptance fields for one recognition result."""
    expected = expected or {}
    required = {int(value) for value in expected.get("required_values", []) if str(value).isdigit()}
    recognized = _recognized_values(spec)
    recalled = sorted(required & recognized)
    recall = len(recalled) / len(required) if required else None
    geometry = _geometry_report(spec)
    issues = [issue.model_dump(mode="json") for issue in spec.issues]
    evidence_visible = bool(spec.observations)
    bbox_backed = _required_values_have_bbox(spec, set(recalled))
    expected_topology = expected.get("expected_topology") or {}
    corner_ok = expected_topology.get("corner_count") in (None, geometry["corner_count"])
    returns_ok = expected_topology.get("short_returns") in (None, geometry["short_returns"])
    closure_limit = max(20, min(100, round(max((abs(value) for value in geometry["closure_adjustments_mm"]), default=0))))
    known_bad = {int(value) for value in expected.get("known_bad_values", []) if str(value).isdigit()}
    passed = bool(
        evidence_visible
        and geometry["closed"]
        and corner_ok
        and returns_ok
        and (recall is None or recall >= 0.8)
        and (not required or bbox_backed)
        and not (known_bad & recognized)
        and closure_limit <= 100
    )
    return {
        "passed": passed,
        "evidence_visible": evidence_visible,
        "recognized_values": sorted(recognized),
        "required_values": sorted(required),
        "recalled_values": recalled,
        "required_recall": recall,
        "all_recalled_values_bbox_backed": bbox_backed,
        "geometry": geometry,
        "issues": issues,
        "failure_reasons": (
            []
            if passed
            else [
                reason
                for reason, condition in (
                    ("observations 为空", not evidence_visible),
                    ("轮廓需人工补画或未闭合", not geometry["closed"]),
                    ("轮廓转折数不符合期望", not corner_ok),
                    ("短回折数量不符合期望", not returns_ok),
                    ("必需尺寸召回率低于 80%", recall is not None and recall < 0.8),
                    ("采用值缺少 bbox 证据", bool(required) and not bbox_backed),
                    ("出现已知错误值", bool(known_bad & recognized)),
                )
                if condition
            ]
        ),
    }


async def _recognize(path: Path) -> RoomSpec:
    return await analyze_floorplan_fast(path, asset_id=path.name)


async def run_batch(
    manifest_path: Path = DEFAULT_MANIFEST,
    *,
    image_dir: Path | None = None,
    output_dir: Path = DEFAULT_OUTPUT,
    replay_dir: Path | None = None,
    image_names: set[str] | None = None,
    recognizer: Callable[[Path], Awaitable[RoomSpec]] = _recognize,
) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    image_entries = manifest.get("images", {})
    output_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, Any] = {}

    def write_image_result(name: str, result: dict[str, Any], image: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {"result": result}
        if image is not None:
            payload["image"] = image
        (output_dir / f"{Path(name).stem}.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    for name, expected in image_entries.items():
        if image_names is not None and name not in image_names:
            continue
        expected = expected if isinstance(expected, dict) else {}
        source = Path(expected.get("path") or name)
        if not source.is_absolute() and image_dir is not None:
            source = image_dir / source
        if not source.is_file():
            result = {
                "passed": False,
                "evidence_visible": False,
                "failure_reasons": [f"输入图片不存在: {source}"],
            }
            write_image_result(name, result)
            results[name] = result
            continue
        try:
            image_meta = _image_meta(source)
            metadata_errors = []
            if expected.get("sha256") and expected["sha256"] != image_meta["sha256"]:
                metadata_errors.append("sha256 与清单不一致")
            for dimension in ("width", "height"):
                if expected.get(dimension) and int(expected[dimension]) != image_meta[dimension]:
                    metadata_errors.append(f"{dimension} 与清单不一致")
            if metadata_errors:
                result = {
                    "passed": False,
                    "evidence_visible": False,
                    "image": {"path": str(source), **image_meta},
                    "failure_reasons": metadata_errors,
                }
                write_image_result(name, result)
                results[name] = result
                continue
            if replay_dir is not None:
                replay_path = replay_dir / f"{Path(name).stem}.json"
                payload = json.loads(replay_path.read_text(encoding="utf-8"))
                spec = _spec_from_payload(payload)
            else:
                spec = await recognizer(source)
            result = evaluate_spec(spec, expected)
            result["image"] = {"path": str(source), **image_meta}
            write_image_result(name, result, result.get("image"))
            results[name] = result
        except Exception as error:  # keep the rest of the batch inspectable
            result = {
                "passed": False,
                "evidence_visible": False,
                "failure_reasons": [f"识别异常: {error}"],
            }
            write_image_result(name, result)
            results[name] = result
    summary = {
        "passed_any": any(result.get("passed") for result in results.values()),
        "evidence_visible_all": all(result.get("evidence_visible") for result in results.values()),
        "images": results,
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


def _write_manifest_metadata(manifest_path: Path, image_dir: Path) -> None:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    for name, expected in (payload.get("images") or {}).items():
        source = image_dir / str(expected.get("path") or name)
        if source.is_file():
            expected.update(_image_meta(source))
    manifest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--image-dir", type=Path)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--replay-dir", type=Path, help="Read saved RoomSpec JSON instead of calling the AI service")
    parser.add_argument("--images", nargs="+", help="Only recognize the named manifest images, for example test5.jpg")
    parser.add_argument("--write-manifest", action="store_true", help="Update hash and dimensions from --image-dir")
    args = parser.parse_args()
    if args.write_manifest:
        if args.image_dir is None:
            parser.error("--write-manifest requires --image-dir")
        _write_manifest_metadata(args.manifest, args.image_dir)
    summary = asyncio.run(run_batch(
        args.manifest,
        image_dir=args.image_dir,
        output_dir=args.output_dir,
        replay_dir=args.replay_dir,
        image_names=set(args.images) if args.images else None,
    ))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    raise SystemExit(0 if summary["passed_any"] else 1)


if __name__ == "__main__":
    main()
