from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .models import CaptureAssessment, CaptureCheck


def _read_image(path: Path) -> np.ndarray:
    try:
        encoded = np.fromfile(path, dtype=np.uint8)
    except OSError as error:
        raise ValueError(f"无法读取图片：{path.name}") from error
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"无法解码图片：{path.name}")
    return image


def assess_capture(path: Path) -> CaptureAssessment:
    """Run conservative, model-free checks before expensive OCR and vision calls."""
    image = _read_image(path)
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    scale = min(1.0, 1800 / max(width, height))
    sampled = (
        cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        if scale < 1
        else gray
    )
    sharpness = float(cv2.Laplacian(sampled, cv2.CV_64F).var())
    brightness = float(gray.mean())
    contrast = float(gray.std())
    dark_fraction = float((gray < 45).mean())

    checks: list[CaptureCheck] = []
    long_edge = max(width, height)
    if long_edge >= 2000:
        checks.append(CaptureCheck(
            code="resolution", status="pass", label="分辨率",
            detail=f"{width} x {height}，满足细小手写数字识别要求",
        ))
    elif long_edge >= 1200:
        checks.append(CaptureCheck(
            code="resolution", status="warning", label="分辨率",
            detail=f"{width} x {height}，可继续识别，但建议使用长边至少 2000 像素的原图",
        ))
    else:
        checks.append(CaptureCheck(
            code="resolution", status="error", label="分辨率",
            detail=f"{width} x {height}，尺寸文字可能无法可靠辨认，建议重新拍摄",
        ))

    if sharpness >= 60:
        checks.append(CaptureCheck(
            code="sharpness", status="pass", label="清晰度",
            detail="墙线和文字边缘清晰",
        ))
    elif sharpness >= 25:
        checks.append(CaptureCheck(
            code="sharpness", status="warning", label="清晰度",
            detail="图片略有模糊，识别后请重点核对短数字",
        ))
    else:
        checks.append(CaptureCheck(
            code="sharpness", status="error", label="清晰度",
            detail="图片明显模糊，建议固定手机并重新拍摄",
        ))

    if 55 <= brightness <= 235 and dark_fraction < 0.2:
        checks.append(CaptureCheck(
            code="exposure", status="pass", label="曝光",
            detail="纸面亮度适合线条与文字分离",
        ))
    elif 35 <= brightness <= 245 and dark_fraction < 0.35:
        checks.append(CaptureCheck(
            code="exposure", status="warning", label="曝光",
            detail="存在偏暗或偏亮区域，避免阴影和顶灯反光可提高识别率",
        ))
    else:
        checks.append(CaptureCheck(
            code="exposure", status="error", label="曝光",
            detail="曝光不适合文字识别，建议在均匀环境光下重新拍摄",
        ))

    if contrast >= 18:
        checks.append(CaptureCheck(
            code="contrast", status="pass", label="笔画对比",
            detail="笔画与纸面具有足够对比度",
        ))
    elif contrast >= 10:
        checks.append(CaptureCheck(
            code="contrast", status="warning", label="笔画对比",
            detail="笔画偏淡，建议使用黑色或深色笔",
        ))
    else:
        checks.append(CaptureCheck(
            code="contrast", status="error", label="笔画对比",
            detail="笔画与纸面对比过低，建议重新描写或拍摄",
        ))

    status = "retake" if any(item.status == "error" for item in checks) else (
        "usable" if any(item.status == "warning" for item in checks) else "ready"
    )
    return CaptureAssessment(
        status=status,
        width=width,
        height=height,
        sharpness=round(sharpness, 1),
        brightness=round(brightness, 1),
        contrast=round(contrast, 1),
        checks=checks,
    )
