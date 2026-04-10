"""
Audio Sidecar -- CUDA/PyTorch Backend
Drop-in replacement for the MLX audio sidecar using faster-whisper (STT)
and Kokoro PyTorch (TTS) on NVIDIA GPUs. Same HTTP API contract.

Endpoints:
    POST /tts              -- Synthesize speech, returns WAV
    POST /f5tts            -- F5-TTS synthesis (stub -- not yet on CUDA)
    POST /transcribe       -- Transcribe audio to text
    GET  /voices           -- List voice presets
    GET  /health           -- Readiness probe
    POST /switch_engine    -- Switch TTS engine
    POST /unload           -- Free VRAM

Port: 5006 (default)
"""

from __future__ import annotations

import argparse
import asyncio
import gc
import io
import json
import logging
import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal, Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

# ── Logging ────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("audio-sidecar-cuda")

# ── Lazy imports ───────────────────────────────────────────────
torch = None

# ── Voice Presets ──────────────────────────────────────────────
VOICE_PRESETS: dict[str, dict] = {
    "af_heart":  {"language": "American English", "gender": "Female", "style": "Warm, expressive"},
    "af_bella":  {"language": "American English", "gender": "Female", "style": "Calm, collected"},
    "af_nova":   {"language": "American English", "gender": "Female", "style": "Bright, energetic"},
    "af_sarah":  {"language": "American English", "gender": "Female", "style": "Soft, gentle"},
    "af_sky":    {"language": "American English", "gender": "Female", "style": "Clear, airy"},
    "am_adam":   {"language": "American English", "gender": "Male",   "style": "Deep, authoritative"},
    "am_echo":   {"language": "American English", "gender": "Male",   "style": "Smooth, resonant"},
    "am_liam":   {"language": "American English", "gender": "Male",   "style": "Casual, friendly"},
    "am_michael":{"language": "American English", "gender": "Male",   "style": "Professional, clear"},
    "bf_alice":  {"language": "British English",  "gender": "Female", "style": "Refined, posh"},
    "bf_emma":   {"language": "British English",  "gender": "Female", "style": "Natural, warm"},
    "bf_lily":   {"language": "British English",  "gender": "Female", "style": "Light, expressive"},
    "bm_daniel": {"language": "British English",  "gender": "Male",   "style": "Deep, broadcast"},
    "bm_george": {"language": "British English",  "gender": "Male",   "style": "Classic, distinguished"},
    "bm_lewis":  {"language": "British English",  "gender": "Male",   "style": "Modern, conversational"},
    "jf_alpha":  {"language": "Japanese",         "gender": "Female", "style": "Clear, natural"},
    "jm_kumo":   {"language": "Japanese",         "gender": "Male",   "style": "Calm, measured"},
    "zf_xiaobei":{"language": "Chinese",          "gender": "Female", "style": "Bright, friendly"},
    "zm_yunxi":  {"language": "Chinese",          "gender": "Male",   "style": "Smooth, professional"},
}

DEFAULT_VOICE = "af_heart"
DEFAULT_STT_MODEL = "large-v3"
TTS_SAMPLE_RATE = 24000

# Language code mapping for Kokoro
VOICE_LANG_CODES: dict[str, str] = {
    "American English": "a",
    "British English": "b",
    "Japanese": "j",
    "Chinese": "z",
}

# ── Global State ───────────────────────────────────────────────
_tts_pipeline = None
_stt_model = None
_tts_loaded: bool = False
_stt_loaded: bool = False
_tts_loading: bool = False
_stt_loading: bool = False
_tts_last_used: float = 0.0
_stt_last_used: float = 0.0
_idle_timeout: float = 300.0
_ready: bool = False
_tts_model_name: str = "kokoro"
_stt_model_name: str = DEFAULT_STT_MODEL
_active_engine: Literal["kokoro", "sovits", "f5tts"] = "kokoro"


# ── Model Lifecycle ────────────────────────────────────────────

def _ensure_torch():
    global torch
    if torch is None:
        import torch as _torch
        torch = _torch


def _load_stt() -> float:
    """Load faster-whisper STT model on CUDA."""
    global _stt_model, _stt_loaded, _stt_loading, _stt_last_used

    if _stt_loaded:
        return 0.0

    _stt_loading = True
    try:
        start = time.monotonic()
        log.info(f"Loading STT model '{_stt_model_name}' (faster-whisper, CUDA) ...")

        from faster_whisper import WhisperModel
        _stt_model = WhisperModel(
            _stt_model_name,
            device="cuda",
            compute_type="float16",
        )

        elapsed = time.monotonic() - start
        _stt_loaded = True
        _stt_last_used = time.monotonic()
        log.info(f"STT model loaded in {elapsed:.1f}s")
        return elapsed
    except Exception as e:
        log.error(f"Failed to load STT model: {e}")
        raise
    finally:
        _stt_loading = False


def _load_tts() -> float:
    """Load Kokoro TTS pipeline on CUDA."""
    global _tts_pipeline, _tts_loaded, _tts_loading, _tts_last_used

    if _tts_loaded:
        return 0.0

    _tts_loading = True
    try:
        start = time.monotonic()
        log.info("Loading Kokoro TTS pipeline (CUDA) ...")

        try:
            import kokoro
            _tts_pipeline = kokoro.KPipeline(lang_code="a", device="cuda")
        except ImportError:
            log.warning("kokoro not installed, TTS will not be available")
            _tts_pipeline = None
            return 0.0

        elapsed = time.monotonic() - start
        _tts_loaded = True
        _tts_last_used = time.monotonic()
        log.info(f"TTS pipeline loaded in {elapsed:.1f}s")
        return elapsed
    except Exception as e:
        log.error(f"Failed to load TTS pipeline: {e}")
        raise
    finally:
        _tts_loading = False


def _unload_tts():
    global _tts_pipeline, _tts_loaded
    if _tts_pipeline is not None:
        del _tts_pipeline
        _tts_pipeline = None
    _tts_loaded = False
    _clear_vram()
    log.info("TTS model unloaded")


def _unload_stt():
    global _stt_model, _stt_loaded
    if _stt_model is not None:
        del _stt_model
        _stt_model = None
    _stt_loaded = False
    _clear_vram()
    log.info("STT model unloaded")


def _clear_vram():
    gc.collect()
    gc.collect()
    _ensure_torch()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


# ── Request/Response Models ──────────────────────────────────

class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice: str = Field(default=DEFAULT_VOICE)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    format: str = Field(default="wav", pattern=r"^(wav|mp3)$")


class F5TTSClip(BaseModel):
    ref_audio: str  # base64
    ref_text: str
    gen_text: str
    remove_silence: bool = True


class F5TTSRequest(BaseModel):
    text: str = Field(default="", max_length=5000)
    clips: list[F5TTSClip] = Field(default_factory=list)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


class SwitchEngineRequest(BaseModel):
    engine: Literal["kokoro", "sovits", "f5tts"]


class TranscribeResponse(BaseModel):
    text: str
    language: str = ""
    segments: list[dict] = []
    duration_seconds: float = 0.0


class HealthResponse(BaseModel):
    status: str
    ready: bool
    tts_loaded: bool
    stt_loaded: bool
    tts_loading: bool
    stt_loading: bool
    tts_model: str
    stt_model: str
    voice_count: int
    active_engine: str
    sovits_url: str = ""
    sovits_reachable: bool = False
    f5tts_loaded: bool = False
    f5tts_loading: bool = False
    f5tts_available: bool = False


# ── TTS Synthesis ────────────────────────────────────────────

async def _synthesize_kokoro(req: TTSRequest) -> Response:
    """Synthesize using Kokoro TTS (PyTorch/CUDA)."""
    global _tts_last_used

    if not _tts_loaded:
        _load_tts()

    if _tts_pipeline is None:
        raise HTTPException(status_code=503, detail="TTS model not available")

    voice = req.voice if req.voice in VOICE_PRESETS else DEFAULT_VOICE
    lang_code = VOICE_LANG_CODES.get(
        VOICE_PRESETS.get(voice, {}).get("language", "American English"), "a"
    )

    start = time.monotonic()

    # Kokoro pipeline generates audio
    audio_chunks = []
    try:
        # Update lang_code on the pipeline
        _tts_pipeline.lang_code = lang_code
        for _, _, audio in _tts_pipeline(req.text, voice=voice, speed=req.speed):
            if audio is not None:
                audio_chunks.append(audio.cpu().numpy() if hasattr(audio, 'cpu') else np.array(audio))
    except Exception as e:
        log.error(f"Kokoro TTS failed: {e}")
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {str(e)}")

    if not audio_chunks:
        raise HTTPException(status_code=500, detail="TTS produced no audio")

    combined = np.concatenate(audio_chunks)
    elapsed = time.monotonic() - start
    _tts_last_used = time.monotonic()

    log.info(f"TTS: {len(req.text)} chars -> {len(combined)} samples in {elapsed:.1f}s")

    buf = io.BytesIO()
    sf.write(buf, combined, TTS_SAMPLE_RATE, format="WAV", subtype="PCM_16")

    return Response(
        content=buf.getvalue(),
        media_type="audio/wav",
        headers={
            "X-Generation-Time": f"{elapsed:.2f}",
            "X-Voice": voice,
            "X-Sample-Rate": str(TTS_SAMPLE_RATE),
        },
    )


# ── FastAPI App ──────────────────────────────────────────────

async def _idle_unload_loop():
    while True:
        await asyncio.sleep(30)
        now = time.monotonic()
        if _idle_timeout > 0:
            if _tts_loaded and not _tts_loading and _tts_last_used > 0 and (now - _tts_last_used) > _idle_timeout:
                log.info("TTS idle timeout, unloading")
                _unload_tts()
            if _stt_loaded and not _stt_loading and _stt_last_used > 0 and (now - _stt_last_used) > _idle_timeout:
                log.info("STT idle timeout, unloading")
                _unload_stt()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _ready
    _ready = True
    log.info(f"Audio sidecar (CUDA) ready on port {os.environ.get('PORT', '5006')}")
    idle_task = asyncio.create_task(_idle_unload_loop())
    try:
        yield
    finally:
        idle_task.cancel()
        _ready = False


app = FastAPI(title="Audio Sidecar (CUDA)", lifespan=lifespan)


@app.get("/health", response_model=HealthResponse)
async def health():
    is_loading = _tts_loading or _stt_loading
    status = "loading" if is_loading else ("ok" if _ready else "starting")
    return HealthResponse(
        status=status,
        ready=_ready and not is_loading,
        tts_loaded=_tts_loaded,
        stt_loaded=_stt_loaded,
        tts_loading=_tts_loading,
        stt_loading=_stt_loading,
        tts_model=_tts_model_name,
        stt_model=_stt_model_name,
        voice_count=len(VOICE_PRESETS),
        active_engine=_active_engine,
    )


@app.get("/voices")
async def list_voices():
    voices = []
    for voice_id, meta in VOICE_PRESETS.items():
        voices.append({
            "id": voice_id,
            "language": meta["language"],
            "gender": meta["gender"],
            "style": meta["style"],
        })
    return {
        "voices": voices,
        "default": DEFAULT_VOICE,
        "model": _tts_model_name,
        "sample_rate": TTS_SAMPLE_RATE,
    }


@app.post("/switch_engine")
async def switch_engine(req: SwitchEngineRequest):
    global _active_engine
    if req.engine == _active_engine:
        return {"engine": _active_engine, "status": "already_loaded"}

    log.info(f"Switching TTS engine: {_active_engine} -> {req.engine}")

    if req.engine == "sovits":
        if _tts_loaded:
            _unload_tts()

    _active_engine = req.engine
    return {"engine": _active_engine, "status": "switched"}


@app.post("/tts", response_class=Response)
async def synthesize(req: TTSRequest):
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    try:
        return await _synthesize_kokoro(req)
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"TTS synthesis failed: {e}")
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {str(e)}")


@app.post("/f5tts", response_class=Response)
async def synthesize_f5tts(req: F5TTSRequest):
    """F5-TTS endpoint. Currently not available on CUDA -- returns 501."""
    raise HTTPException(
        status_code=501,
        detail="F5-TTS is not yet available on the CUDA backend. Use /tts with Kokoro instead.",
    )


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(audio: UploadFile = File(...)):
    global _stt_last_used

    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _stt_loading:
        raise HTTPException(status_code=409, detail="STT model is currently loading")

    content_type = audio.content_type or ""
    filename = audio.filename or "audio"
    valid_types = {
        "audio/wav", "audio/x-wav", "audio/wave",
        "audio/mpeg", "audio/mp3",
        "audio/webm",
        "audio/mp4", "audio/m4a", "audio/x-m4a",
        "audio/ogg", "audio/flac",
    }
    valid_extensions = {".wav", ".mp3", ".webm", ".m4a", ".ogg", ".flac", ".mp4"}

    ext = os.path.splitext(filename)[1].lower()
    if content_type not in valid_types and ext not in valid_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported audio format: {content_type or ext}",
        )

    if not _stt_loaded:
        log.info("Lazy-loading STT model for first transcription ...")
        _load_stt()

    assert _stt_model is not None

    tmp_path = None
    try:
        audio_bytes = await audio.read()
        suffix = ext if ext else ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        log.info(f"Transcribing: {filename} ({len(audio_bytes)} bytes)")
        start = time.monotonic()

        segments, info = _stt_model.transcribe(tmp_path, beam_size=5)

        # Collect segments
        parsed_segments = []
        text_parts = []
        for segment in segments:
            parsed_segments.append({
                "start": round(segment.start, 2),
                "end": round(segment.end, 2),
                "text": segment.text.strip(),
            })
            text_parts.append(segment.text.strip())

        text = " ".join(text_parts)
        language = info.language or ""
        duration = parsed_segments[-1]["end"] if parsed_segments else 0.0

        elapsed = time.monotonic() - start
        _stt_last_used = time.monotonic()

        log.info(f"Transcribed in {elapsed:.1f}s: {len(text)} chars, {len(parsed_segments)} segments")

        return TranscribeResponse(
            text=text,
            language=language,
            segments=parsed_segments,
            duration_seconds=round(duration, 2),
        )
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Transcription failed: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@app.post("/unload")
async def unload_model(model: str = "all"):
    result: dict[str, str] = {}
    if model in ("tts", "all"):
        if _tts_loaded:
            _unload_tts()
            result["tts"] = "unloaded"
        else:
            result["tts"] = "not_loaded"
    if model in ("stt", "all"):
        if _stt_loaded:
            _unload_stt()
            result["stt"] = "unloaded"
        else:
            result["stt"] = "not_loaded"
    return result


# ── Entrypoint ─────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Audio sidecar CUDA")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5006")))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
