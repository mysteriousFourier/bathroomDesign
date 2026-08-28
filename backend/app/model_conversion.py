from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path


CONVERTIBLE_MODEL_EXTENSIONS = {".skp", ".dae", ".stl", ".ply", ".3mf", ".blend"}


class ModelConversionError(RuntimeError):
    pass


def _configured_command(template: str, source: Path, target: Path) -> list[str] | None:
    if not template.strip():
        return None
    try:
        value = json.loads(template)
        parts = value if isinstance(value, list) and all(isinstance(item, str) for item in value) else None
    except json.JSONDecodeError:
        parts = shlex.split(template, posix=os.name != "nt")
    if not parts:
        raise ModelConversionError("MODEL_CONVERTER_COMMAND 配置无效")
    return [part.replace("{input}", str(source)).replace("{output}", str(target)) for part in parts]


def model_converter_command(source: Path, target: Path, template: str = "") -> list[str] | None:
    configured = _configured_command(template, source, target)
    if configured:
        return configured
    assimp = shutil.which("assimp")
    return [assimp, "export", str(source), str(target)] if assimp else None


def model_converter_available(template: str = "") -> bool:
    try:
        command = model_converter_command(Path("input.skp"), Path("output.glb"), template)
    except ModelConversionError:
        return False
    if not command:
        return False
    executable = Path(command[0])
    return executable.is_file() or shutil.which(command[0]) is not None


def convert_model_to_glb(source: Path, target: Path, template: str = "", timeout_seconds: int = 180) -> Path:
    command = model_converter_command(source, target, template)
    if not command:
        raise ModelConversionError("服务器未安装模型转换器；请配置 MODEL_CONVERTER_COMMAND 后重新入库")
    executable = Path(command[0])
    if not executable.is_file() and shutil.which(command[0]) is None:
        raise ModelConversionError(f"模型转换器不存在：{command[0]}")
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout_seconds, check=False, shell=False)
    except subprocess.TimeoutExpired as error:
        raise ModelConversionError(f"模型转换超过 {timeout_seconds} 秒，已终止") from error
    except OSError as error:
        raise ModelConversionError(f"无法启动模型转换器：{error}") from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "未知错误").strip()[-600:]
        raise ModelConversionError(f"模型转换失败：{detail}")
    if not target.is_file() or target.stat().st_size <= 12:
        raise ModelConversionError("模型转换器未生成有效 GLB 文件")
    with target.open("rb") as converted:
        if converted.read(4) != b"glTF":
            raise ModelConversionError("模型转换器输出不是有效的 GLB 文件")
    return target
