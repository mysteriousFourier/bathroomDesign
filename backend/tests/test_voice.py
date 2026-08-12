import base64

import httpx
import pytest

import backend.app.voice as voice
from backend.app.main import VOICE_GREETING, app


def test_transcript_text_removes_only_spaces_between_chinese_characters():
    result = [{"text": "你 好 我 是 小 和 voice assistant"}]
    assert voice._transcript_text(result) == "你好我是小和 voice assistant"


def test_edge_synthesis_returns_mp3(monkeypatch):
    async def fake_synthesize(_text, target):
        target.write_bytes(b"\xff\xf3fake-mp3")

    monkeypatch.setattr(voice, "_edge_tts_to_file", fake_synthesize)
    monkeypatch.setattr(voice.settings, "voice_tts_provider", "edge")
    encoded, mime = voice.synthesize("测试")
    assert mime == "audio/mpeg"
    assert base64.b64decode(encoded).startswith(b"\xff\xf3")


def test_unknown_tts_provider_is_rejected(monkeypatch):
    monkeypatch.setattr(voice.settings, "voice_tts_provider", "unknown")
    with pytest.raises(voice.VoiceConfigurationError, match="不支持"):
        voice.synthesize("测试")


def test_edge_network_failure_has_clear_error(monkeypatch):
    async def fail_synthesis(_text, _target):
        raise OSError("network unavailable")

    monkeypatch.setattr(voice, "_edge_tts_to_file", fail_synthesis)
    monkeypatch.setattr(voice.settings, "voice_tts_provider", "edge")
    with pytest.raises(voice.VoiceConfigurationError, match="网络"):
        voice.synthesize("测试")


def test_cached_model_uses_complete_snapshot(monkeypatch, tmp_path):
    snapshot = tmp_path / "models" / voice._MODELSCOPE_ALIASES["paraformer-zh"] / "snapshots" / "master"
    snapshot.mkdir(parents=True); (snapshot / "model.pt").write_bytes(b"model")
    monkeypatch.setattr(voice.settings, "voice_model_cache_dir", tmp_path)
    assert voice._cached_model("paraformer-zh") == str(snapshot)
    assert voice._cached_model("custom-model") == "custom-model"


@pytest.mark.asyncio
async def test_voice_greeting_returns_playable_audio(monkeypatch):
    monkeypatch.setattr("backend.app.main.synthesize", lambda text: (base64.b64encode(b"audio").decode("ascii"), "audio/mpeg"))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/voice/greeting")

    assert response.status_code == 200
    assert response.json() == {
        "text": VOICE_GREETING,
        "audio_base64": base64.b64encode(b"audio").decode("ascii"),
        "audio_mime_type": "audio/mpeg",
    }
