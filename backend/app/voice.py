from __future__ import annotations

import base64
import re
import tempfile
from functools import lru_cache
from pathlib import Path

from .config import settings


class VoiceConfigurationError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _asr_model():
    try:
        from funasr import AutoModel
    except ImportError as error:
        raise VoiceConfigurationError("语音识别组件未安装，请按 README 安装 FunASR 语音依赖") from error
    return AutoModel(
        model=settings.funasr_model,
        vad_model=settings.funasr_vad_model or None,
        punc_model=settings.funasr_punc_model or None,
        device="cpu",
        disable_update=True,
    )


@lru_cache(maxsize=1)
def _tts_model():
    try:
        from melo.api import TTS
    except ImportError as error:
        raise VoiceConfigurationError("语音合成组件未安装，请按 README 安装 MeloTTS") from error
    return TTS(language="ZH", device="cpu")


def _transcript_text(result: object) -> str:
    if not isinstance(result, list):
        return ""
    fragments = [str(item.get("text", "")) for item in result if isinstance(item, dict)]
    return re.sub(r"\s+", " ", "".join(fragments)).strip()


def transcribe(audio: bytes, suffix: str = ".webm") -> str:
    with tempfile.TemporaryDirectory(prefix="opc-voice-") as directory:
        source = Path(directory) / f"recording{suffix}"
        source.write_bytes(audio)
        text = _transcript_text(_asr_model().generate(input=str(source), batch_size_s=60))
    if not text:
        raise RuntimeError("没有识别到清晰语音，请靠近麦克风后重试")
    return text


def synthesize(text: str) -> str:
    with tempfile.TemporaryDirectory(prefix="opc-voice-") as directory:
        target = Path(directory) / "reply.wav"
        model = _tts_model()
        speaker_ids = model.hps.data.spk2id
        speaker = speaker_ids.get(settings.melotts_speaker)
        if speaker is None:
            speaker = next(iter(speaker_ids.values()))
        model.tts_to_file(text, speaker, str(target), speed=settings.melotts_speed)
        return base64.b64encode(target.read_bytes()).decode("ascii")
