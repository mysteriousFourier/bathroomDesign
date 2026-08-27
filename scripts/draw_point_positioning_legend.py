from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


CANVAS_SIZE = (1920, 1080)
SCALE = 2

BG = "#F4F6F8"
PAPER = "#FFFFFF"
INK = "#17212B"
MUTED = "#607080"
LINE = "#C7D0D9"
WALL = "#26343F"
WALL_FILL = "#DCE2E7"
DIMENSION = "#C73E2B"
POINT = "#087E8B"
POINT_SOFT = "#DDF2F4"
VALID = "#18794E"
VALID_SOFT = "#E2F2E9"
WARNING = "#9A6700"
WARNING_SOFT = "#FFF3C4"


def resolve_font(bold: bool = False) -> Path:
    candidates = [
        Path(r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc"),
        Path(r"C:\Windows\Fonts\simhei.ttf"),
        Path(r"C:\Windows\Fonts\simsun.ttc"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError("未找到微软雅黑、黑体或宋体，无法可靠绘制中文")


REGULAR_FONT = resolve_font()
BOLD_FONT = resolve_font(bold=True)


def font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(BOLD_FONT if bold else REGULAR_FONT), size * SCALE)


def p(value: float) -> int:
    return round(value * SCALE)


def xy(point: tuple[float, float]) -> tuple[int, int]:
    return p(point[0]), p(point[1])


def rect(box: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    return tuple(p(value) for value in box)  # type: ignore[return-value]


def text(draw: ImageDraw.ImageDraw, at: tuple[float, float], value: str, size: int, fill: str = INK, *, bold: bool = False, anchor: str = "la") -> None:
    draw.text(xy(at), value, font=font(size, bold=bold), fill=fill, anchor=anchor)


def rounded_box(draw: ImageDraw.ImageDraw, box: tuple[float, float, float, float], fill: str, outline: str = LINE, radius: int = 12, width: int = 1) -> None:
    draw.rounded_rectangle(rect(box), radius=p(radius), fill=fill, outline=outline, width=p(width))


def label_box(draw: ImageDraw.ImageDraw, center: tuple[float, float], value: str, *, fill: str = PAPER, color: str = DIMENSION, size: int = 22) -> None:
    label_font = font(size, bold=True)
    bounds = draw.textbbox((0, 0), value, font=label_font)
    width = bounds[2] - bounds[0]
    height = bounds[3] - bounds[1]
    cx, cy = xy(center)
    padding_x, padding_y = p(10), p(5)
    draw.rounded_rectangle(
        (cx - width // 2 - padding_x, cy - height // 2 - padding_y, cx + width // 2 + padding_x, cy + height // 2 + padding_y),
        radius=p(5), fill=fill,
    )
    draw.text((cx, cy), value, font=label_font, fill=color, anchor="mm")


def arrowhead(draw: ImageDraw.ImageDraw, tip: tuple[float, float], direction: tuple[float, float], color: str = DIMENSION) -> None:
    length, half_width = 14, 6
    norm = math.hypot(*direction) or 1
    ux, uy = direction[0] / norm, direction[1] / norm
    px, py = -uy, ux
    base_x, base_y = tip[0] - ux * length, tip[1] - uy * length
    points = [
        xy(tip),
        xy((base_x + px * half_width, base_y + py * half_width)),
        xy((base_x - px * half_width, base_y - py * half_width)),
    ]
    draw.polygon(points, fill=color)


def dimension_line(draw: ImageDraw.ImageDraw, start: tuple[float, float], end: tuple[float, float], label: str, label_offset: tuple[float, float] = (0, -18)) -> None:
    draw.line([xy(start), xy(end)], fill=DIMENSION, width=p(3))
    direction = (end[0] - start[0], end[1] - start[1])
    arrowhead(draw, start, direction)
    arrowhead(draw, end, (-direction[0], -direction[1]))
    center = ((start[0] + end[0]) / 2 + label_offset[0], (start[1] + end[1]) / 2 + label_offset[1])
    label_box(draw, center, label)


def dashed_line(draw: ImageDraw.ImageDraw, start: tuple[float, float], end: tuple[float, float], *, color: str = DIMENSION, width: int = 3, dash: int = 11, gap: int = 8) -> None:
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dy)
    if not length:
        return
    ux, uy = dx / length, dy / length
    cursor = 0.0
    while cursor < length:
        stop = min(length, cursor + dash)
        draw.line(
            [xy((start[0] + ux * cursor, start[1] + uy * cursor)), xy((start[0] + ux * stop, start[1] + uy * stop))],
            fill=color, width=p(width),
        )
        cursor += dash + gap


def floor_drain(draw: ImageDraw.ImageDraw, center: tuple[float, float], radius: int = 15) -> None:
    cx, cy = center
    draw.ellipse(rect((cx - radius - 6, cy - radius - 6, cx + radius + 6, cy + radius + 6)), fill=POINT_SOFT)
    draw.ellipse(rect((cx - radius, cy - radius, cx + radius, cy + radius)), fill=PAPER, outline=POINT, width=p(4))
    offset = radius * 0.62
    draw.line([xy((cx - offset, cy - offset)), xy((cx + offset, cy + offset))], fill=POINT, width=p(4))
    draw.line([xy((cx + offset, cy - offset)), xy((cx - offset, cy + offset))], fill=POINT, width=p(4))
    draw.ellipse(rect((cx - 3, cy - 3, cx + 3, cy + 3)), fill=POINT)


def room_outline(draw: ImageDraw.ImageDraw, box: tuple[float, float, float, float]) -> None:
    x1, y1, x2, y2 = box
    draw.rectangle(rect((x1, y1, x2, y2)), fill=PAPER, outline=WALL, width=p(12))
    draw.rectangle(rect((x1 + 12, y1 + 12, x2 - 12, y2 - 12)), outline=WALL_FILL, width=p(3))


def section_header(draw: ImageDraw.ImageDraw, x: float, title_value: str, method: str) -> None:
    text(draw, (x, 168), title_value, 28, bold=True)
    tag_font = font(18, bold=True)
    bounds = draw.textbbox((0, 0), method, font=tag_font)
    tag_width = (bounds[2] - bounds[0]) / SCALE + 26
    rounded_box(draw, (x, 202, x + tag_width, 236), VALID_SOFT, outline=VALID_SOFT, radius=6)
    text(draw, (x + 13, 219), method, 18, fill=VALID, bold=True, anchor="lm")


def draw_wall_offsets(draw: ImageDraw.ImageDraw) -> None:
    panel = (55, 145, 940, 770)
    rounded_box(draw, panel, PAPER)
    section_header(draw, 90, "A  正交墙距定位（首选）", "wall_offsets")

    room = (140, 280, 845, 675)
    room_outline(draw, room)
    point = (351.5, 385.3)

    text(draw, (154, 267), "上基准墙", 18, fill=MUTED)
    text(draw, (126, 300), "左基准墙", 18, fill=MUTED, anchor="ra")

    draw.line([xy((room[0], point[1] - 23)), xy((room[0], point[1] + 23))], fill=DIMENSION, width=p(2))
    draw.line([xy((point[0] - 23, room[1])), xy((point[0] + 23, room[1]))], fill=DIMENSION, width=p(2))
    dimension_line(draw, (room[0], point[1]), point, "600", label_offset=(0, -22))
    dimension_line(draw, (point[0], room[1]), point, "400", label_offset=(45, 0))
    floor_drain(draw, point)

    text(draw, (point[0] + 26, point[1] + 28), "P1  地漏", 21, fill=POINT, bold=True)
    text(draw, (165, 704), "P1 = 左墙 600 mm + 上墙 400 mm", 23, bold=True)
    text(draw, (165, 737), "两条非平行尺寸线，箭头均落在点位中心", 19, fill=MUTED)

    text(draw, (750, 620), "X", 18, fill=MUTED, bold=True)
    draw.line([xy((705, 640)), xy((790, 640))], fill=MUTED, width=p(2))
    arrowhead(draw, (790, 640), (1, 0), MUTED)
    text(draw, (690, 594), "Z", 18, fill=MUTED, bold=True)
    draw.line([xy((710, 605)), xy((710, 658))], fill=MUTED, width=p(2))
    arrowhead(draw, (710, 658), (0, 1), MUTED)


def draw_two_point_ties(draw: ImageDraw.ImageDraw) -> None:
    panel = (980, 145, 1865, 770)
    rounded_box(draw, panel, PAPER)
    section_header(draw, 1015, "B  两角点斜距定位", "two_point_ties")

    room = (1065, 280, 1770, 675)
    room_outline(draw, room)
    corner_a = (1065, 280)
    corner_b = (1770, 280)
    point = (1276.5, 385.3)

    dashed_line(draw, corner_a, point)
    dashed_line(draw, corner_b, point)
    arrowhead(draw, point, (corner_a[0] - point[0], corner_a[1] - point[1]))
    arrowhead(draw, point, (corner_b[0] - point[0], corner_b[1] - point[1]))

    draw.ellipse(rect((corner_a[0] - 7, corner_a[1] - 7, corner_a[0] + 7, corner_a[1] + 7)), fill=DIMENSION)
    draw.ellipse(rect((corner_b[0] - 7, corner_b[1] - 7, corner_b[0] + 7, corner_b[1] + 7)), fill=DIMENSION)
    label_box(draw, (1198, 330), "A-P1  721")
    label_box(draw, (1515, 350), "B-P1  1456")
    floor_drain(draw, point)

    text(draw, (corner_a[0] + 12, corner_a[1] + 55), "角点 A", 19, fill=MUTED, bold=True)
    text(draw, (corner_b[0] - 12, corner_b[1] + 28), "角点 B", 19, fill=MUTED, bold=True, anchor="ra")
    text(draw, (point[0] + 26, point[1] + 28), "P1  地漏", 21, fill=POINT, bold=True)
    text(draw, (1090, 704), "P1 = 角点 A 斜距 721 mm + 角点 B 斜距 1456 mm", 22, bold=True)
    text(draw, (1090, 737), "角点必须明确；两条斜距均量到点位中心", 19, fill=MUTED)


def draw_legend(draw: ImageDraw.ImageDraw) -> None:
    rounded_box(draw, (55, 800, 1865, 1025), PAPER)
    text(draw, (90, 838), "建议放在量房图右下角的统一图例", 25, bold=True)

    floor_drain(draw, (116, 902), radius=13)
    text(draw, (148, 902), "P1 地漏：编号与类型必须同时标注", 20, anchor="lm")

    dimension_line(draw, (590, 902), (720, 902), "600", label_offset=(0, -22))
    text(draw, (748, 902), "红色尺寸线：端点必须落在墙/角点与点位中心", 20, anchor="lm")

    rounded_box(draw, (1285, 876, 1360, 928), VALID_SOFT, outline=VALID_SOFT, radius=6)
    text(draw, (1322.5, 902), "有效", 19, fill=VALID, bold=True, anchor="mm")
    text(draw, (1378, 902), "一横一纵，或两个明确角点", 20, anchor="lm")

    rounded_box(draw, (90, 954, 165, 1005), WARNING_SOFT, outline=WARNING_SOFT, radius=6)
    text(draw, (127.5, 979), "无效", 19, fill=WARNING, bold=True, anchor="mm")
    text(draw, (183, 979), "只有一条距离、基准不清或引线未落中心：记为 visual_only，不得当作实测坐标", 20, anchor="lm")
    text(draw, (1410, 979), "点位尺寸不得并入墙体尺寸链", 19, fill=DIMENSION, bold=True, anchor="lm")


def render(output: Path) -> None:
    image = Image.new("RGB", (CANVAS_SIZE[0] * SCALE, CANVAS_SIZE[1] * SCALE), BG)
    draw = ImageDraw.Draw(image)

    text(draw, (55, 58), "量房图点位定位标注示例", 38, bold=True)
    text(draw, (55, 108), "以点位中心为测量落点；所有尺寸单位均为 mm", 21, fill=MUTED)

    draw_wall_offsets(draw)
    draw_two_point_ties(draw)
    draw_legend(draw)

    image = image.resize(CANVAS_SIZE, Image.Resampling.LANCZOS)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, format="PNG", optimize=True, dpi=(144, 144))


def main() -> None:
    parser = argparse.ArgumentParser(description="绘制量房图点位定位标注示例")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("reports/AGEN-68-point-positioning-legend.png"),
        help="输出 PNG 路径",
    )
    args = parser.parse_args()
    render(args.output)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
