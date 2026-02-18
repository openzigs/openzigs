"""
Tests for the Audio Sidecar server.

Validates request/response models, voice presets, health check, and endpoint
logic with mocked MLX models. Does NOT require Apple Silicon or GPU.

Usage:
    cd sidecars/audio
    pip install pytest httpx  # + requirements.txt
    pytest test_pipeline.py -v
"""

from __future__ import annotations

import io
import struct
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from fastapi.testclient import TestClient

from server import (
    DEFAULT_VOICE,
    VOICE_PRESETS,
    HealthResponse,
    TTSRequest,
    TranscribeResponse,
    app,
)


@pytest.fixture
def client():
    """FastAPI test client with mocked lifespan."""
    with TestClient(app) as c:
        yield c


# ── Health ──────────────────────────────────────────────────────

class TestHealth:
    """Health endpoint tests."""

    def test_health_returns_ok(self, client: TestClient):
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["ready"] is True
        assert data["tts_loaded"] is False
        assert data["stt_loaded"] is False
        assert data["voice_count"] == len(VOICE_PRESETS)

    def test_health_response_model(self):
        h = HealthResponse(
            status="ok",
            ready=True,
            tts_loaded=True,
            stt_loaded=False,
            tts_model="mlx-community/Kokoro-82M-bf16",
            stt_model="distil-large-v3",
            voice_count=19,
        )
        assert h.ready is True
        assert h.tts_loaded is True


# ── Voices ──────────────────────────────────────────────────────

class TestVoices:
    """Voice listing endpoint tests."""

    def test_list_voices(self, client: TestClient):
        resp = client.get("/voices")
        assert resp.status_code == 200
        data = resp.json()
        assert "voices" in data
        assert len(data["voices"]) == len(VOICE_PRESETS)
        assert data["default"] == DEFAULT_VOICE

    def test_voices_have_required_fields(self, client: TestClient):
        resp = client.get("/voices")
        for voice in resp.json()["voices"]:
            assert "id" in voice
            assert "language" in voice
            assert "gender" in voice
            assert "style" in voice

    def test_default_voice_is_valid(self):
        assert DEFAULT_VOICE in VOICE_PRESETS

    def test_all_voices_have_metadata(self):
        for vid, meta in VOICE_PRESETS.items():
            assert "language" in meta, f"Voice {vid} missing language"
            assert "gender" in meta, f"Voice {vid} missing gender"
            assert "style" in meta, f"Voice {vid} missing style"


# ── Request Models ──────────────────────────────────────────────

class TestRequestModels:
    """Pydantic model validation."""

    def test_tts_request_defaults(self):
        req = TTSRequest(text="Hello world")
        assert req.voice == DEFAULT_VOICE
        assert req.speed == 1.0

    def test_tts_request_custom_voice(self):
        req = TTSRequest(text="Hello", voice="bm_daniel", speed=1.5)
        assert req.voice == "bm_daniel"
        assert req.speed == 1.5

    def test_tts_request_speed_bounds(self):
        with pytest.raises(Exception):
            TTSRequest(text="Hello", speed=0.1)  # Below 0.5
        with pytest.raises(Exception):
            TTSRequest(text="Hello", speed=3.0)  # Above 2.0

    def test_tts_request_empty_text(self):
        with pytest.raises(Exception):
            TTSRequest(text="")

    def test_transcribe_response_model(self):
        resp = TranscribeResponse(
            text="Hello, how are you?",
            language="en",
            segments=[{"start": 0.0, "end": 1.5, "text": "Hello, how are you?"}],
            duration_seconds=1.5,
        )
        assert resp.text == "Hello, how are you?"
        assert resp.language == "en"
        assert len(resp.segments) == 1


# ── TTS Endpoint ────────────────────────────────────────────────

class TestTTSEndpoint:
    """TTS synthesis endpoint tests (with mocked model)."""

    @patch("server._load_tts")
    @patch("server._tts_loaded", True)
    def test_tts_success(self, mock_load, client: TestClient):
        """Test successful TTS synthesis with mocked model."""
        import server

        # Create a mock model that yields audio
        mock_result = MagicMock()
        mock_result.audio = np.zeros(24000, dtype=np.float32)  # 1 second of silence

        mock_model = MagicMock()
        mock_model.generate.return_value = [mock_result]

        # Inject the mock model
        original_model = server._tts_model
        server._tts_model = mock_model

        try:
            resp = client.post(
                "/tts",
                json={"text": "Hello world", "voice": "af_heart", "speed": 1.0},
            )
            assert resp.status_code == 200
            assert resp.headers["content-type"] == "audio/wav"
            assert "X-Synthesis-Time" in resp.headers
            assert "X-Audio-Duration" in resp.headers
            # WAV header check
            assert resp.content[:4] == b"RIFF"
        finally:
            server._tts_model = original_model

    def test_tts_invalid_voice(self, client: TestClient):
        """Reject unknown voice IDs."""
        resp = client.post(
            "/tts",
            json={"text": "Hello", "voice": "nonexistent_voice"},
        )
        assert resp.status_code == 400
        assert "Unknown voice" in resp.json()["detail"]

    def test_tts_empty_text(self, client: TestClient):
        """Reject empty text."""
        resp = client.post("/tts", json={"text": ""})
        assert resp.status_code == 422  # Pydantic validation


# ── Transcribe Endpoint ────────────────────────────────────────

class TestTranscribeEndpoint:
    """STT transcription endpoint tests (with mocked model)."""

    @patch("server._load_stt")
    @patch("server._stt_loaded", True)
    def test_transcribe_success(self, mock_load, client: TestClient):
        """Test successful transcription with mocked model."""
        import server

        mock_model = MagicMock()
        mock_model.transcribe.return_value = {
            "text": "Hello, how are you?",
            "language": "en",
            "segments": [
                {"start": 0.0, "end": 1.5, "text": "Hello, how are you?"}
            ],
        }

        original_model = server._stt_model
        server._stt_model = mock_model

        try:
            # Create a minimal WAV file (silence, 0.1s)
            wav_buf = io.BytesIO()
            import soundfile as sf

            audio_data = np.zeros(2400, dtype=np.float32)  # 0.1s at 24kHz
            sf.write(wav_buf, audio_data, 24000, format="WAV")
            wav_buf.seek(0)

            resp = client.post(
                "/transcribe",
                files={"audio": ("test.wav", wav_buf, "audio/wav")},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["text"] == "Hello, how are you?"
            assert data["language"] == "en"
            assert len(data["segments"]) == 1
        finally:
            server._stt_model = original_model


# ── Unload Endpoint ─────────────────────────────────────────────

class TestUnloadEndpoint:
    """Model unload endpoint tests."""

    def test_unload_all_when_not_loaded(self, client: TestClient):
        resp = client.post("/unload?model=all")
        assert resp.status_code == 200
        data = resp.json()
        assert data["tts"] == "not_loaded"
        assert data["stt"] == "not_loaded"

    def test_unload_tts_only(self, client: TestClient):
        resp = client.post("/unload?model=tts")
        assert resp.status_code == 200
        data = resp.json()
        assert "tts" in data
        assert "stt" not in data

    def test_unload_stt_only(self, client: TestClient):
        resp = client.post("/unload?model=stt")
        assert resp.status_code == 200
        data = resp.json()
        assert "stt" in data
        assert "tts" not in data

    def test_unload_invalid_model(self, client: TestClient):
        resp = client.post("/unload?model=invalid")
        assert resp.status_code == 400


# ── Integration Validation ──────────────────────────────────────

class TestVoicePresetIntegrity:
    """Validate voice preset structure and consistency."""

    def test_voice_ids_are_lowercase(self):
        for vid in VOICE_PRESETS:
            assert vid == vid.lower(), f"Voice ID '{vid}' should be lowercase"

    def test_voice_prefix_matches_language(self):
        prefix_map = {
            "af": "American English",
            "am": "American English",
            "bf": "British English",
            "bm": "British English",
            "jf": "Japanese",
            "jm": "Japanese",
            "zf": "Chinese",
            "zm": "Chinese",
        }
        for vid, meta in VOICE_PRESETS.items():
            prefix = vid[:2]
            if prefix in prefix_map:
                assert meta["language"] == prefix_map[prefix], (
                    f"Voice {vid} prefix '{prefix}' implies "
                    f"{prefix_map[prefix]} but got {meta['language']}"
                )

    def test_voice_genders_consistent(self):
        for vid, meta in VOICE_PRESETS.items():
            expected_gender = "Female" if vid[1] == "f" else "Male"
            assert meta["gender"] == expected_gender, (
                f"Voice {vid} second char implies "
                f"{expected_gender} but got {meta['gender']}"
            )

    def test_minimum_voice_count(self):
        """Ensure we have a reasonable number of voice presets."""
        assert len(VOICE_PRESETS) >= 15
