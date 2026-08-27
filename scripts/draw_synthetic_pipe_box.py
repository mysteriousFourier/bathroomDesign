from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


CANVAS_SIZE = (1600, 1100)
RENDER_SCALE = 2
ROOM_BOX = (260, 250, 1160, 925)
PIPE_BOX = (350, 340, 463, 475)
ROOM_SIZE_MM = (2000, 1500)
PIPE_SIZE_MM = (250, 300)
INK = "#191919"


def handwritten_font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        Path(r"C:\Windows\Fonts\segoepr.ttf"),
        Path(r"C:\Windows\Fonts\STXINGKA.TTF"),
        Path(r"C:\Windows\Fonts\arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size * RENDER_SCALE)
    return ImageFont.load_default(size=size * RENDER_SCALE)


def scaled_point(point: tuple[float, float]) -> tuple[int, int]:
    return round(point[0] * RENDER_SCALE), round(point[1] * RENDER_SCALE)


def scaled_box(values: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    return tuple(round(value * RENDER_SCALE) for value in values)  # type: ignore[return-value]


def rough_line(draw: ImageDraw.ImageDraw, points: list[tuple[float, float]], width: int = 5) -> None:
    draw.line([scaled_point(point) for point in points], fill=INK, width=width * RENDER_SCALE, joint="curve")


def handwritten_text(draw: ImageDraw.ImageDraw, point: tuple[float, float], value: str, size: int = 34, anchor: str = "mm") -> None:
    draw.text(scaled_point(point), value, font=handwritten_font(size), fill=INK, anchor=anchor)


def render(output: Path) -> None:
    width, height = CANVAS_SIZE
    image = Image.new("RGB", (width * RENDER_SCALE, height * RENDER_SCALE), "white")
    draw = ImageDraw.Draw(image)

    left, top, right, bottom = ROOM_BOX
    rough_line(draw, [(left, top), (right, top), (right, bottom), (left, bottom), (left, top)], width=5)

    # Overall room sizes use only two short marks on the actual wall. All
    # numerals stay horizontal even for the vertical wall dimension.
    rough_line(draw, [(left, top - 24), (left, top + 24)], width=3)
    rough_line(draw, [(right, top - 24), (right, top + 24)], width=3)
    handwritten_text(draw, ((left + right) / 2, top - 42), "2000", size=36)
    rough_line(draw, [(right - 24, top), (right + 24, top)], width=3)
    rough_line(draw, [(right - 24, bottom), (right + 24, bottom)], width=3)
    handwritten_text(draw, (right + 78, (top + bottom) / 2), "1500", size=36)

    box_left, box_top, box_right, box_bottom = PIPE_BOX
    rough_line(
        draw,
        [
            (box_left, box_top),
            (box_right, box_top + 1),
            (box_right - 1, box_bottom),
            (box_left + 1, box_bottom - 1),
            (box_left, box_top),
        ],
        width=5,
    )
    rough_line(draw, [(box_left + 15, box_bottom - 18), (box_right - 14, box_top + 17)], width=4)
    handwritten_text(draw, (box_right + 105, (box_top + box_bottom) / 2), "250x300", size=34)

    image = image.resize(CANVAS_SIZE, Image.Resampling.LANCZOS)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, "PNG", optimize=True, dpi=(144, 144))


def main() -> None:
    parser = argparse.ArgumentParser(description="Draw a monochrome pipe-box recognition sample")
    parser.add_argument("--output", type=Path, default=Path("reports/AGEN-68-synthetic-pipe-box-monochrome.png"))
    args = parser.parse_args()
    render(args.output)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
