#!/usr/bin/env python3
"""Run PaddleOCR in its isolated environment and emit one line per image."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: run_paddleocr.py IMAGE [IMAGE ...]", file=sys.stderr)
        return 2

    from paddleocr import PaddleOCR

    ocr = PaddleOCR(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=True,
        enable_mkldnn=False,
        text_det_limit_side_len=4000,
    )
    for raw_path in sys.argv[1:]:
        image_path = Path(raw_path).resolve()
        result = next(iter(ocr.predict(str(image_path))))
        payload = result.json if isinstance(result.json, dict) else json.loads(result.json)
        data = payload.get("res", payload)
        with Image.open(image_path) as image:
            scale = min(1.0, 4000 / max(image.size))
        output = {
            "image": str(image_path),
            "rec_texts": data.get("rec_texts", []),
            "rec_scores": data.get("rec_scores", []),
            "rec_boxes": data.get("rec_boxes", data.get("rec_polys", [])),
            "scale": scale,
        }
        print("__PADDLEOCR_JSON__" + json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
