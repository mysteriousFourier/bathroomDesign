from __future__ import annotations

import base64
import asyncio
import importlib.util
import os
import re
import tempfile
import wave
from functools import lru_cache
from pathlib import Path

from .config import settings


class VoiceConfigurationError(RuntimeError):
    pass


def runtime_status() -> dict[str, str | bool]:
    asr_ready = importlib.util.find_spec("funasr") is not None and importlib.util.find_spec("torch") is not None
    tts_module = "edge_tts" if settings.voice_tts_provider == "edge" else "melo"
    tts_ready = importlib.util.find_spec(tts_module) is not None
    return {
        "voice_configured": asr_ready and tts_ready,
        "voice_asr_model": settings.funasr_model,
        "voice_tts": settings.edge_tts_voice if settings.voice_tts_provider == "edge" else "MeloTTS",
    }


_MODELSCOPE_ALIASES = {
    "paraformer-zh": "iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "fsmn-vad": "iic--speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "ct-punc": "iic--punc_ct-transformer_cn-en-common-vocab471067-large",
}


def _cached_model(model: str) -> str:
    folder = _MODELSCOPE_ALIASES.get(model)
    if not folder:
        return model
    snapshot = settings.voice_model_cache_dir / "models" / folder / "snapshots" / "master"
    return str(snapshot) if (snapshot / "model.pt").is_file() else model


@lru_cache(maxsize=1)
def _asr_model():
    os.environ.setdefault("MODELSCOPE_CACHE", str(settings.voice_model_cache_dir))
    try:
        from funasr import AutoModel
    except ImportError as error:
        raise VoiceConfigurationError("语音识别组件未安装，请按 README 安装 FunASR 语音依赖") from error
    return AutoModel(
        model=_cached_model(settings.funasr_model),
        vad_model=_cached_model(settings.funasr_vad_model) if settings.funasr_vad_model else None,
        punc_model=_cached_model(settings.funasr_punc_model) if settings.funasr_punc_model else None,
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
    text = re.sub(r"\s+", " ", "".join(fragments)).strip()
    return re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", text)


def _decode_browser_audio(source: Path, target: Path) -> None:
    try:
        import av
    except ImportError as error:
        raise VoiceConfigurationError("浏览器录音解码组件未安装，请安装 voice 可选依赖") from error
    try:
        container = av.open(str(source))
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        with wave.open(str(target), "wb") as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000)
            for frame in container.decode(audio=0):
                for converted in resampler.resample(frame):
                    output.writeframes(converted.to_ndarray().tobytes())
            for converted in resampler.resample(None):
                output.writeframes(converted.to_ndarray().tobytes())
        container.close()
    except (OSError, ValueError) as error:
        raise RuntimeError("浏览器录音无法解码，请重新录制") from error


def transcribe(audio: bytes, suffix: str = ".webm") -> str:
    with tempfile.TemporaryDirectory(prefix="opc-voice-") as directory:
        source = Path(directory) / f"recording{suffix}"
        source.write_bytes(audio)
        model_input = source
        if suffix.lower() in {".webm", ".ogg", ".opus", ".mp4", ".m4a"}:
            model_input = Path(directory) / "recording.wav"
            _decode_browser_audio(source, model_input)
        text = _transcript_text(_asr_model().generate(input=str(model_input), batch_size_s=60))
    if not text:
        raise RuntimeError("没有识别到清晰语音，请靠近麦克风后重试")
    return text


async def _edge_tts_to_file(text: str, target: Path) -> None:
    try:
        import edge_tts
    except ImportError as error:
        raise VoiceConfigurationError("语音合成组件未安装，请安装 voice 可选依赖") from error
    await edge_tts.Communicate(text, settings.edge_tts_voice).save(str(target))


def synthesize(text: str) -> tuple[str, str]:
    if settings.voice_tts_provider == "edge":
        with tempfile.TemporaryDirectory(prefix="opc-voice-") as directory:
            target = Path(directory) / "reply.mp3"
            try:
                asyncio.run(_edge_tts_to_file(text, target))
            except (OSError, RuntimeError) as error:
                raise VoiceConfigurationError("语音合成服务暂时不可用，请检查网络后重试") from error
            return base64.b64encode(target.read_bytes()).decode("ascii"), "audio/mpeg"
    if settings.voice_tts_provider != "melotts":
        raise VoiceConfigurationError(f"不支持的语音合成器：{settings.voice_tts_provider}")
    with tempfile.TemporaryDirectory(prefix="opc-voice-") as directory:
        target = Path(directory) / "reply.wav"
        model = _tts_model()
        speaker_ids = model.hps.data.spk2id
        speaker = speaker_ids.get(settings.melotts_speaker)
        if speaker is None:
            speaker = next(iter(speaker_ids.values()))
        model.tts_to_file(text, speaker, str(target), speed=settings.melotts_speed)
        return base64.b64encode(target.read_bytes()).decode("ascii"), "audio/wav"
