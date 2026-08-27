from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


WIDTH = 2000
HEIGHT = 1400
SCALE = 2

INK = "#1A1A1A"
GRID = "#D8D8D8"
FORM = "#555555"
DIMENSION = "#B3261E"
POINT = "#006D77"


def font_path(bold: bool = False) -> Path:
    candidates = [
        Path(r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc"),
        Path(r"C:\Windows\Fonts\simhei.ttf"),
        Path(r"C:\Windows\Fonts\simsun.ttc"),
    ]
    for path in candidates:
        if path.exists():
            return path
    raise FileNotFoundError("找不到可用的中文字体")


REGULAR = font_path()
BOLD = font_path(bold=True)
HANDWRITTEN = Path(r"C:\Windows\Fonts\STXINGKA.TTF")


def f(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(BOLD if bold else REGULAR), size * SCALE)


def handwritten_font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(HANDWRITTEN if HANDWRITTEN.exists() else REGULAR), size * SCALE)


def q(value: float) -> int:
    return round(value * SCALE)


def pos(point: tuple[float, float]) -> tuple[int, int]:
    return q(point[0]), q(point[1])


def box(values: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    return tuple(q(value) for value in values)  # type: ignore[return-value]


def write(draw: ImageDraw.ImageDraw, at: tuple[float, float], value: str, size: int, *, bold: bool = False, fill: str = INK, anchor: str = "la") -> None:
    draw.text(pos(at), value, font=f(size, bold), fill=fill, anchor=anchor)


def arrowhead(draw: ImageDraw.ImageDraw, tip: tuple[float, float], direction: tuple[float, float]) -> None:
    length = 15
    half_width = 6
    norm = math.hypot(*direction) or 1
    ux, uy = direction[0] / norm, direction[1] / norm
    px, py = -uy, ux
    base = (tip[0] - ux * length, tip[1] - uy * length)
    draw.polygon(
        [
            pos(tip),
            pos((base[0] + px * half_width, base[1] + py * half_width)),
            pos((base[0] - px * half_width, base[1] - py * half_width)),
        ],
        fill=DIMENSION,
    )


def label(draw: ImageDraw.ImageDraw, center: tuple[float, float], value: str, size: int = 25) -> None:
    label_font = f(size, True)
    bounds = draw.textbbox((0, 0), value, font=label_font)
    text_width = bounds[2] - bounds[0]
    text_height = bounds[3] - bounds[1]
    cx, cy = pos(center)
    draw.rounded_rectangle(
        (cx - text_width // 2 - q(8), cy - text_height // 2 - q(5), cx + text_width // 2 + q(8), cy + text_height // 2 + q(5)),
        radius=q(4),
        fill="white",
    )
    draw.text((cx, cy), value, font=label_font, fill=DIMENSION, anchor="mm")


def dimension(draw: ImageDraw.ImageDraw, start: tuple[float, float], end: tuple[float, float], value: str, label_offset: tuple[float, float]) -> None:
    draw.line([pos(start), pos(end)], fill=DIMENSION, width=q(4))
    delta = (end[0] - start[0], end[1] - start[1])
    arrowhead(draw, start, delta)
    arrowhead(draw, end, (-delta[0], -delta[1]))
    label(
        draw,
        ((start[0] + end[0]) / 2 + label_offset[0], (start[1] + end[1]) / 2 + label_offset[1]),
        value,
    )


def floor_drain(draw: ImageDraw.ImageDraw, center: tuple[float, float], radius: int = 18) -> None:
    cx, cy = center
    draw.ellipse(box((cx - radius, cy - radius, cx + radius, cy + radius)), fill="white", outline=POINT, width=q(5))
    offset = radius * 0.62
    draw.line([pos((cx - offset, cy - offset)), pos((cx + offset, cy + offset))], fill=POINT, width=q(5))
    draw.line([pos((cx + offset, cy - offset)), pos((cx - offset, cy + offset))], fill=POINT, width=q(5))
    draw.ellipse(box((cx - 3, cy - 3, cx + 3, cy + 3)), fill=POINT)


def rough_line(draw: ImageDraw.ImageDraw, points: list[tuple[float, float]], width: int = 4) -> None:
    draw.line([pos(point) for point in points], fill=INK, width=q(width), joint="curve")
    shifted = [(point[0] + 0.8, point[1] - 0.6) for point in points]
    draw.line([pos(point) for point in shifted], fill=INK, width=max(1, q(width - 2)), joint="curve")


def handwritten_number(image: Image.Image, center: tuple[float, float], value: str, *, size: int = 31, angle: float = 0) -> None:
    number_font = handwritten_font(size)
    scratch = Image.new("RGBA", (q(260), q(110)), (255, 255, 255, 0))
    scratch_draw = ImageDraw.Draw(scratch)
    scratch_draw.text((scratch.width // 2, scratch.height // 2), value, font=number_font, fill=INK, anchor="mm")
    rotated = scratch.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    left = q(center[0]) - rotated.width // 2
    top = q(center[1]) - rotated.height // 2
    image.paste(rotated, (left, top), rotated)


def checkbox(draw: ImageDraw.ImageDraw, at: tuple[float, float], checked: bool, caption: str) -> None:
    x, y = at
    draw.rectangle(box((x, y, x + 25, y + 25)), outline=INK, width=q(2))
    if checked:
        draw.line([pos((x + 5, y + 13)), pos((x + 11, y + 20)), pos((x + 22, y + 5))], fill=POINT, width=q(4), joint="curve")
    write(draw, (x + 37, y + 13), caption, 21, anchor="lm")


def table(draw: ImageDraw.ImageDraw, outer: tuple[int, int, int, int], rows: list[tuple[str, str]]) -> None:
    x1, y1, x2, y2 = outer
    draw.rectangle(box(outer), outline=FORM, width=q(2))
    row_height = (y2 - y1) / len(rows)
    split = x1 + 170
    draw.line([pos((split, y1)), pos((split, y2))], fill=FORM, width=q(2))
    for index, (name, value) in enumerate(rows):
        top = y1 + index * row_height
        if index:
            draw.line([pos((x1, top)), pos((x2, top))], fill=FORM, width=q(2))
        write(draw, (x1 + 18, top + row_height / 2), name, 21, bold=index == 0, anchor="lm")
        write(draw, (split + 20, top + row_height / 2), value, 22, bold=bool(value), anchor="lm")


def render(output: Path, *, monochrome: bool = False, minimal: bool = False, wall_ticks: bool = False) -> None:
    global DIMENSION, POINT
    if monochrome:
        DIMENSION = INK
        POINT = INK
    image = Image.new("RGB", (WIDTH * SCALE, HEIGHT * SCALE), "white")
    draw = ImageDraw.Draw(image)

    write(draw, (45, 47), "单房间量房记录", 38, bold=True)
    write(draw, (430, 47), "测量人：" if minimal else "测量人：系统识别测试", 21)
    write(draw, (825, 47), "日期：" if minimal else "日期：2026-08-27", 21)
    write(draw, (1225, 47), "房间：" if minimal else f"房间：点位标定样例{'（单色笔）' if monochrome else ''}", 21)
    draw.line([pos((35, 88)), pos((1965, 88))], fill=FORM, width=q(2))

    plan_outer = (45, 120, 1400, 1350)
    draw.rectangle(box(plan_outer), outline=FORM, width=q(3))
    write(draw, (70, 155), "平面图（尺寸单位：mm）", 22, bold=True)
    for x in range(80, 1380, 50):
        draw.line([pos((x, 190)), pos((x, 1325))], fill=GRID, width=q(1))
    for y in range(190, 1330, 50):
        draw.line([pos((70, y)), pos((1380, y))], fill=GRID, width=q(1))

    room = (260, 390, 1160, 1065)
    if wall_ticks:
        draw.rectangle(box((room[0] - 5, room[1] - 5, room[2] + 5, room[3] + 5)), fill="white")
        rough_line(draw, [(room[0], room[1]), (room[2], room[1])], width=5)
        rough_line(draw, [(room[2], room[1]), (room[2], room[3])], width=5)
        rough_line(draw, [(room[2], room[3]), (room[0], room[3])], width=5)
        rough_line(draw, [(room[0], room[3]), (room[0], room[1])], width=5)
    else:
        draw.rectangle(box(room), fill="white", outline=INK, width=q(9))
        draw.rectangle(box((room[0] + 12, room[1] + 12, room[2] - 12, room[3] - 12)), outline="#888888", width=q(2))

    # Overall wall dimensions: room is 2000 x 1500 mm.
    if wall_ticks:
        rough_line(draw, [(room[0], room[1] - 28), (room[0], room[1] + 28)], width=3)
        rough_line(draw, [(room[2], room[1] - 28), (room[2], room[1] + 28)], width=3)
        handwritten_number(image, ((room[0] + room[2]) / 2, room[1] - 31), "2000", angle=-3)
        rough_line(draw, [(room[2] - 28, room[1]), (room[2] + 28, room[1])], width=3)
        rough_line(draw, [(room[2] - 28, room[3]), (room[2] + 28, room[3])], width=3)
        handwritten_number(image, (room[2] + 43, (room[1] + room[3]) / 2), "1500", angle=88)
    else:
        dimension(draw, (room[0], 320), (room[2], 320), "2000", (0, -22))
        draw.line([pos((room[0], 320)), pos((room[0], room[1]))], fill=DIMENSION, width=q(2))
        draw.line([pos((room[2], 320)), pos((room[2], room[1]))], fill=DIMENSION, width=q(2))
        dimension(draw, (1245, room[1]), (1245, room[3]), "1500", (48, 0))
        draw.line([pos((room[2], room[1])), pos((1245, room[1]))], fill=DIMENSION, width=q(2))
        draw.line([pos((room[2], room[3])), pos((1245, room[3]))], fill=DIMENSION, width=q(2))

    # P1 is 600 mm from the left wall and 400 mm from the top wall.
    point = (530, 570)
    if wall_ticks:
        rough_line(draw, [(room[0], point[1]), point], width=3)
        rough_line(draw, [(point[0], room[1]), point], width=3)
        handwritten_number(image, ((room[0] + point[0]) / 2, point[1] - 23), "600", angle=-4)
        handwritten_number(image, (point[0] + 44, (room[1] + point[1]) / 2), "400", angle=3)
    else:
        dimension(draw, (room[0], point[1]), point, "600", (0, -24))
        dimension(draw, (point[0], room[1]), point, "400", (48, 0))
    floor_drain(draw, point)
    if not minimal:
        write(draw, (560, 607), "P1 地漏", 24, bold=True, fill=POINT)
        write(draw, (285, 1132), "点位定位：P1 到左墙 600；P1 到上墙 400", 24, bold=True)
        write(draw, (285, 1172), "两条尺寸引线均落在 P1 中心，不计入墙体尺寸链", 21, fill=FORM)

    # Coordinate convention used by the application.
    if not minimal:
        draw.line([pos((1050, 970)), pos((1120, 970))], fill=FORM, width=q(3))
        arrowhead(draw, (1120, 970), (1, 0))
        write(draw, (1132, 970), "X", 19, bold=True, anchor="lm")
        draw.line([pos((1050, 970)), pos((1050, 1035))], fill=FORM, width=q(3))
        arrowhead(draw, (1050, 1035), (0, 1))
        write(draw, (1050, 1047), "Z", 19, bold=True, anchor="ma")

    right = (1420, 120, 1965, 1350)
    draw.rectangle(box(right), outline=FORM, width=q(3))
    write(draw, (1450, 155), "尺寸基准", 23, bold=True)
    checkbox(draw, (1450, 192), False, "毛坯面")
    checkbox(draw, (1650, 192), True, "完成面")

    write(draw, (1450, 278), "门窗洞口", 23, bold=True)
    table(draw, (1450, 315, 1935, 535), [("编号", "CG / CK / CH"), ("D1", ""), ("W1", ""), ("W2", "")])

    write(draw, (1450, 590), "高度", 23, bold=True)
    table(draw, (1450, 625, 1935, 770), [("项目", "数值"), ("净高", "" if minimal else "2400"), ("整屋吊顶", "" if minimal else "2300")])

    write(draw, (1450, 830), "现场实际点位符号", 23, bold=True)
    floor_drain(draw, (1480, 890), radius=14)
    write(draw, (1520, 890), "地漏", 21, anchor="lm")
    draw.ellipse(box((1468, 930, 1492, 954)), fill=INK)
    write(draw, (1520, 942), "排水", 21, anchor="lm")
    draw.polygon([pos((1480, 980)), pos((1466, 1007)), pos((1494, 1007))], outline=INK, fill="white")
    write(draw, (1520, 994), "给水", 21, anchor="lm")
    draw.rectangle(box((1468, 1032, 1492, 1056)), outline=INK, width=q(3))
    write(draw, (1520, 1044), "电点", 21, anchor="lm")

    if not minimal:
        write(draw, (1450, 1115), "点位识别规则", 22, bold=True)
        write(draw, (1450, 1155), "1. 右侧图例不是实际点位", 19)
        write(draw, (1450, 1190), "2. 点位尺寸必须量到符号中心", 19)
        write(draw, (1450, 1225), "3. 横向与纵向各至少一条", 19)
        write(draw, (1450, 1260), "4. 点位尺寸不进入墙体尺寸链", 19)

    image = image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, "PNG", optimize=True, dpi=(144, 144))


def main() -> None:
    parser = argparse.ArgumentParser(description="绘制点位尺寸识别用的模拟量房模板")
    parser.add_argument("--output", type=Path, default=Path("reports/AGEN-68-synthetic-point-measurement.png"))
    parser.add_argument("--monochrome", action="store_true", help="将墙线、点位和尺寸标注全部改为黑色")
    parser.add_argument("--minimal", action="store_true", help="仅保留墙、点位符号与必要数字，不写点位说明文字")
    parser.add_argument("--wall-ticks", action="store_true", help="墙体使用单线，总尺寸仅以墙上两端正交短线标注")
    args = parser.parse_args()
    render(args.output, monochrome=args.monochrome, minimal=args.minimal, wall_ticks=args.wall_ticks)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
