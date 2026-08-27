from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.models import FixtureSpec, ImageBBox, Observation, Point2D, RoomSpec, SourceKind


def font_path(bold: bool = False) -> Path:
    candidates = [
        Path(r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc"),
        Path(r"C:\Windows\Fonts\simhei.ttf"),
        Path(r"C:\Windows\Fonts\simsun.ttc"),
    ]
    for path in candidates:
        if path.exists():
            return path
    raise FileNotFoundError("找不到中文字体")


REGULAR = font_path()
BOLD = font_path(bold=True)


def font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(BOLD if bold else REGULAR), size)


def load_result(path: Path) -> tuple[dict, dict]:
    result = json.loads(path.read_text(encoding="utf-8"))
    fixtures = result.get("recognized_fixtures")
    if not result.get("passed") or not isinstance(fixtures, list) or len(fixtures) != 1:
        raise ValueError("识别结果未通过，或点位数量不是 1")
    fixture = fixtures[0]
    if not isinstance(fixture, dict):
        raise ValueError("点位结果格式无效")
    return result, fixture


def render_overlay(source: Path, fixture: dict, output: Path) -> None:
    source_image = Image.open(source).convert("RGB")
    width, height = source_image.size
    footer_height = 180
    image = Image.new("RGB", (width, height + footer_height), "#FFFFFF")
    image.paste(source_image, (0, 0))
    draw = ImageDraw.Draw(image)

    bbox = fixture["bbox"]
    x1 = round(width * bbox["x_min"] / 1000)
    y1 = round(height * bbox["y_min"] / 1000)
    x2 = round(width * bbox["x_max"] / 1000)
    y2 = round(height * bbox["y_max"] / 1000)
    pad = 12
    highlight = "#16835B"
    draw.rounded_rectangle((x1 - pad, y1 - pad, x2 + pad, y2 + pad), radius=10, outline=highlight, width=7)
    label_value = "识别点位：地漏"
    label_font = font(28, bold=True)
    label_bounds = draw.textbbox((0, 0), label_value, font=label_font)
    label_width = label_bounds[2] - label_bounds[0]
    label_top = min(height - 60, y2 + 24)
    label_left = min(width - label_width - 38, x2 + 24)
    draw.rounded_rectangle((label_left, label_top, label_left + label_width + 30, label_top + 52), radius=8, fill=highlight)
    draw.text((label_left + 15, label_top + 25), label_value, font=label_font, fill="white", anchor="lm")

    draw.rectangle((0, height, width, height + footer_height), fill="#F2F7F4")
    draw.line((0, height, width, height), fill=highlight, width=5)
    draw.ellipse((55, height + 45, 125, height + 115), fill=highlight)
    draw.text((90, height + 80), "OK", font=font(24, bold=True), fill="white", anchor="mm")
    draw.text((155, height + 55), "点位定位识别通过", font=font(34, bold=True), fill="#17212B", anchor="lm")

    refs = fixture.get("positioning", {}).get("refs", [])
    refs_by_origin = {item.get("from"): item.get("value_mm") for item in refs if isinstance(item, dict)}
    point = fixture.get("resolved_position_mm") or {}
    summary = (
        f"地漏  |  wall_offsets  |  左墙 {refs_by_origin.get('left')} mm  |  "
        f"上墙 {refs_by_origin.get('top')} mm  |  坐标 ({point.get('x_mm')}, {point.get('z_mm')}) mm  |  "
        f"置信度 {fixture.get('confidence', 0):.2f}"
    )
    draw.text((155, height + 112), summary, font=font(24), fill="#41505C", anchor="lm")

    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, "PNG", optimize=True, dpi=(144, 144))


def write_room_spec(fixture: dict, output: Path) -> None:
    bbox = ImageBBox.model_validate(fixture["bbox"])
    point = fixture["resolved_position_mm"]
    evidence_id = str(fixture.get("id") or "direct-fixture-1")
    spec = RoomSpec(
        name="单色笔点位识别结果",
        boundary=[
            Point2D(x_mm=0, z_mm=0),
            Point2D(x_mm=2000, z_mm=0),
            Point2D(x_mm=2000, z_mm=1500),
            Point2D(x_mm=0, z_mm=1500),
        ],
        fixtures=[
            FixtureSpec(
                id="P1",
                kind="floor_drain",
                label="地漏",
                x_mm=int(point["x_mm"]),
                z_mm=int(point["z_mm"]),
                width_mm=75,
                depth_mm=75,
                height_mm=10,
                rotation_deg=0,
                source=SourceKind.measured,
                confidence=float(fixture.get("confidence", 0.95)),
                evidence_ids=[evidence_id],
                point_usage="general",
                position_status="measured",
            )
        ],
        observations=[
            Observation(
                field=f"visual_evidence:{evidence_id}",
                value="地漏",
                source=SourceKind.measured,
                bbox=bbox,
                confidence=float(fixture.get("confidence", 0.95)),
                note="点位通过左墙 600 mm 与上墙 400 mm 两条独立尺寸约束反算",
                semantic_role="drain_position",
                review_required=False,
                target_id="point:P1",
            )
        ],
        confirmed=False,
    )
    validated = RoomSpec.model_validate_json(spec.model_dump_json())
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(validated.model_dump_json(indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="把点位诊断 JSON 转为可视结果和可导入 RoomSpec")
    parser.add_argument("source", type=Path)
    parser.add_argument("result", type=Path)
    parser.add_argument("--overlay", type=Path, required=True)
    parser.add_argument("--room-spec", type=Path, required=True)
    args = parser.parse_args()
    _, fixture = load_result(args.result)
    render_overlay(args.source, fixture, args.overlay)
    write_room_spec(fixture, args.room_spec)
    print(json.dumps({"overlay": str(args.overlay.resolve()), "room_spec": str(args.room_spec.resolve())}, ensure_ascii=False))


if __name__ == "__main__":
    main()
