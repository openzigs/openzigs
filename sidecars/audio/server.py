"""
Audio Sidecar — Local Speech-to-Text & Text-to-Speech Server
Issue #261: FastAPI wrapper around lightning-whisper-mlx (STT) and mlx-audio (TTS).
Issue #269: Swappable TTS Engines — Kokoro (Engine A) and GPT-SoVITS (Engine B).
Optimized for Apple Silicon (MPS) with lazy model loading and idle auto-unload.

ISOLATION CONTRACT (Issue #271):
    This sidecar is a strict "text-in / audio-out" endpoint.
    It MUST NOT import or connect to:
      - Task engine / agent_tasks table
      - MCP tool registry or tool execution loop
      - SQLite or any database (no: import sqlite3, no DB connections)
      - Node.js IPC channels or agent orchestration layers
    It accepts only: { text: str, ...TTS params } → returns audio/wav
    It is deployable as a completely standalone process with zero
    knowledge of the OpenZigs Agent system.

    CI ENFORCEMENT: grep -r "import sqlite3\|import agent_tasks" sidecars/audio/
    must return no matches. Any addition must be code-reviewed.

Features:
    - Lazy loading: No models loaded at startup — loads on first request
    - Independent STT/TTS lifecycle: Each model loads/unloads independently
    - Auto-unload: Models unloaded after configurable idle timeout to reclaim RAM
    - 24kHz WAV output for TTS (Kokoro model, 54 voice presets) — Engine A
    - Engine B: GPT-SoVITS via HTTP proxy for high-fidelity voice cloning
    - POST /switch_engine — swap engines with mutex (prevents double-load)
    - Segment-level timestamps from STT (Whisper distil-large-v3)

Usage:
    cd sidecars/audio
    pip install -r requirements.txt
    python server.py [--port 5006] [--host 127.0.0.1]
    # For Engine B (GPT-SoVITS), start the GPT-SoVITS server separately
    # then pass --sovits-url http://127.0.0.1:9880

Endpoints:
    POST /tts              — Synthesize speech (Kokoro or GPT-SoVITS based on active engine)
    POST /transcribe       — Transcribe audio file to text (accepts multipart upload)
    GET  /voices           — List available TTS voice presets
    GET  /health           — Readiness probe (returns model + engine status)
    POST /unload           — Unload one or all models to free RAM
    POST /switch_engine    — Switch active TTS engine ("kokoro" | "sovits")
"""

from __future__ import annotations

import argparse
import asyncio
import gc
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Literal, Optional

import httpx
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
log = logging.getLogger("audio-sidecar")

# ── Voice Presets ──────────────────────────────────────────────
VOICE_PRESETS: dict[str, dict] = {
    # American English — Female
    "af_heart":  {"language": "American English", "gender": "Female", "style": "Warm, expressive"},
    "af_bella":  {"language": "American English", "gender": "Female", "style": "Calm, collected"},
    "af_nova":   {"language": "American English", "gender": "Female", "style": "Bright, energetic"},
    "af_sarah":  {"language": "American English", "gender": "Female", "style": "Soft, gentle"},
    "af_sky":    {"language": "American English", "gender": "Female", "style": "Clear, airy"},
    # American English — Male
    "am_adam":   {"language": "American English", "gender": "Male",   "style": "Deep, authoritative"},
    "am_echo":   {"language": "American English", "gender": "Male",   "style": "Smooth, resonant"},
    "am_liam":   {"language": "American English", "gender": "Male",   "style": "Casual, friendly"},
    "am_michael":{"language": "American English", "gender": "Male",   "style": "Professional, clear"},
    # British English — Female
    "bf_alice":  {"language": "British English",  "gender": "Female", "style": "Refined, posh"},
    "bf_emma":   {"language": "British English",  "gender": "Female", "style": "Natural, warm"},
    "bf_lily":   {"language": "British English",  "gender": "Female", "style": "Light, expressive"},
    # British English — Male
    "bm_daniel": {"language": "British English",  "gender": "Male",   "style": "Deep, broadcast"},
    "bm_george": {"language": "British English",  "gender": "Male",   "style": "Classic, distinguished"},
    "bm_lewis":  {"language": "British English",  "gender": "Male",   "style": "Modern, conversational"},
    # Japanese
    "jf_alpha":  {"language": "Japanese",         "gender": "Female", "style": "Clear, natural"},
    "jm_kumo":   {"language": "Japanese",         "gender": "Male",   "style": "Calm, measured"},
    # Chinese
    "zf_xiaobei":{"language": "Chinese",          "gender": "Female", "style": "Bright, friendly"},
    "zm_yunxi":  {"language": "Chinese",          "gender": "Male",   "style": "Smooth, professional"},
}

DEFAULT_VOICE = "af_heart"
DEFAULT_TTS_MODEL = "mlx-community/Kokoro-82M-bf16"
DEFAULT_STT_MODEL = "distil-large-v3"
DEFAULT_SOVITS_URL = "http://127.0.0.1:9880"
TTS_SAMPLE_RATE = 24000

# ── Language code mapping ──────────────────────────────────────
VOICE_LANG_CODES: dict[str, str] = {
    "American English": "a",
    "British English": "b",
    "Japanese": "j",
    "Chinese": "z",
}

# ── Global State ───────────────────────────────────────────────
_tts_model = None
_stt_model = None
_tts_loaded: bool = False
_stt_loaded: bool = False
_tts_loading: bool = False
_stt_loading: bool = False
_tts_last_used: float = 0.0
_stt_last_used: float = 0.0
_idle_timeout: float = 0.0  # seconds before auto-unload (0 = disabled)
_ready: bool = False
_tts_model_name: str = DEFAULT_TTS_MODEL
_stt_model_name: str = DEFAULT_STT_MODEL

# ── Engine State (Issue #269) ──────────────────────────────────
# "kokoro" = Engine A (MLX Kokoro, always-on, ~1 GB RAM)
# "sovits" = Engine B (GPT-SoVITS HTTP proxy, on-demand, 6-10 GB RAM)
_active_engine: Literal["kokoro", "sovits"] = "kokoro"
_sovits_url: str = DEFAULT_SOVITS_URL
_engine_switch_lock: asyncio.Lock | None = None  # Initialized in lifespan


# ── Model Lifecycle ─────────────────────────────────────────────

def _load_tts() -> float:
    """Load the TTS (Kokoro) model. Returns time taken in seconds."""
    global _tts_model, _tts_loaded, _tts_loading, _tts_last_used

    if _tts_loaded:
        return 0.0

    _tts_loading = True
    try:
        start = time.monotonic()
        log.info(f"Loading TTS model '{_tts_model_name}' ...")

        from mlx_audio.tts.utils import load_model
        _tts_model = load_model(_tts_model_name)

        elapsed = time.monotonic() - start
        _tts_loaded = True
        _tts_last_used = time.monotonic()
        log.info(f"TTS model loaded in {elapsed:.1f}s")
        return elapsed
    except Exception as e:
        log.error(f"Failed to load TTS model: {e}")
        raise
    finally:
        _tts_loading = False


def _load_stt() -> float:
    """Load the STT (Whisper) model. Returns time taken in seconds."""
    global _stt_model, _stt_loaded, _stt_loading, _stt_last_used

    if _stt_loaded:
        return 0.0

    _stt_loading = True
    try:
        start = time.monotonic()
        log.info(f"Loading STT model '{_stt_model_name}' ...")

        from lightning_whisper_mlx import LightningWhisperMLX
        _stt_model = LightningWhisperMLX(
            model=_stt_model_name,
            batch_size=12,
            quant=None,
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


def _unload_tts() -> None:
    """Unload TTS model and free memory."""
    global _tts_model, _tts_loaded

    if _tts_model is not None:
        log.info("Unloading TTS model ...")
        del _tts_model
        _tts_model = None
        gc.collect()
        # Clear Apple Silicon MLX metal cache to fully reclaim VRAM
        try:
            import mlx.core
            mlx.core.metal.clear_cache()
            log.info("MLX Metal cache cleared")
        except Exception:
            pass  # Not on Apple Silicon or MLX not available
        log.info("TTS model unloaded")
    _tts_loaded = False


def _unload_stt() -> None:
    """Unload STT model and free memory."""
    global _stt_model, _stt_loaded

    if _stt_model is not None:
        log.info("Unloading STT model ...")
        del _stt_model
        _stt_model = None
        gc.collect()
        log.info("STT model unloaded")
    _stt_loaded = False


async def _idle_unload_loop() -> None:
    """Background task: periodically check for idle timeout and unload models."""
    import asyncio

    while True:
        await asyncio.sleep(30)  # Check every 30 seconds
        if _idle_timeout <= 0:
            continue

        now = time.monotonic()

        # Check TTS idle
        if (
            _tts_loaded
            and not _tts_loading
            and _tts_last_used > 0
            and (now - _tts_last_used) > _idle_timeout
        ):
            idle_secs = now - _tts_last_used
            log.info(
                f"TTS model idle for {idle_secs:.0f}s "
                f"(threshold={_idle_timeout:.0f}s) — auto-unloading"
            )
            _unload_tts()

        # Check STT idle
        if (
            _stt_loaded
            and not _stt_loading
            and _stt_last_used > 0
            and (now - _stt_last_used) > _idle_timeout
        ):
            idle_secs = now - _stt_last_used
            log.info(
                f"STT model idle for {idle_secs:.0f}s "
                f"(threshold={_idle_timeout:.0f}s) — auto-unloading"
            )
            _unload_stt()


# ── Request / Response Models ──────────────────────────────────

class TTSRequest(BaseModel):
    """Request body for text-to-speech synthesis.

    Engine A (Kokoro): uses voice, speed fields.
    Engine B (GPT-SoVITS): uses ref_audio_path, ref_text, ref_language + tuning params.
    """

    text: str = Field(
        ...,
        min_length=1,
        max_length=10000,
        description="Text to synthesize into speech",
    )
    # ── Engine A (Kokoro) parameters ──
    voice: str = Field(
        default=DEFAULT_VOICE,
        description="Voice preset ID (e.g. 'af_heart', 'bm_daniel') — Engine A only",
    )
    speed: float = Field(
        default=1.0,
        ge=0.5,
        le=2.0,
        description="Speaking speed multiplier (0.5–2.0) — Engine A",
    )
    # ── Engine B (GPT-SoVITS) parameters ──
    ref_audio_path: Optional[str] = Field(
        default=None,
        description="Absolute path to the reference audio WAV — Engine B only",
    )
    ref_text: Optional[str] = Field(
        default=None,
        description="Verbatim transcript of the reference audio — Engine B only",
    )
    ref_language: str = Field(
        default="en",
        description="Language code for ref audio and synthesis text — Engine B",
    )
    top_p: float = Field(default=0.8, ge=0.1, le=1.0)
    temperature: float = Field(default=1.0, ge=0.1, le=2.0)
    text_split_method: str = Field(default="cut5")
    speed_factor: float = Field(default=1.0, ge=0.5, le=2.0)
    repetition_penalty: float = Field(default=1.35, ge=1.0, le=2.0)
    top_k: int = Field(default=15, ge=1, le=50)
    sample_steps: int = Field(default=32, ge=1, le=200)


class SwitchEngineRequest(BaseModel):
    """Request body for POST /switch_engine."""

    engine: Literal["kokoro", "sovits"] = Field(
        ...,
        description="Target TTS engine to activate ('kokoro' or 'sovits')",
    )


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    ready: bool
    tts_loaded: bool = False
    stt_loaded: bool = False
    tts_loading: bool = False
    stt_loading: bool = False
    tts_model: str = ""
    stt_model: str = ""
    voice_count: int = 0
    # Engine state (Issue #269)
    active_engine: str = "kokoro"
    engines_available: list[str] = ["kokoro", "sovits"]
    sovits_url: str = ""
    sovits_reachable: bool = False


class TranscribeResponse(BaseModel):
    """Transcription result."""

    text: str
    language: str = ""
    segments: list[dict] = []
    duration_seconds: float = 0.0


# ── Lifespan ────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start server in lazy mode — no models loaded until first request."""
    global _ready, _engine_switch_lock

    _ready = True
    _engine_switch_lock = asyncio.Lock()

    log.info(
        f"Audio sidecar ready — lazy mode "
        f"(TTS={_tts_model_name}, STT={_stt_model_name}, "
        f"idle_timeout={'disabled' if _idle_timeout <= 0 else f'{_idle_timeout:.0f}s'}, "
        f"active_engine={_active_engine}, sovits_url={_sovits_url})"
    )

    idle_task = asyncio.create_task(_idle_unload_loop())

    yield

    _ready = False
    idle_task.cancel()
    _unload_tts()
    _unload_stt()
    log.info("Audio sidecar shut down")


# ── FastAPI App ────────────────────────────────────────────────

app = FastAPI(
    title="OpenZigs Audio Sidecar",
    description=(
        "Local STT (Whisper) and TTS (Kokoro) server with lazy loading "
        "and idle auto-unload. Optimized for Apple Silicon (MPS) via MLX."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthResponse)
async def health():
    """Readiness probe. Returns model load states and active engine status."""
    is_loading = _tts_loading or _stt_loading
    status = "loading" if is_loading else ("ok" if _ready else "starting")

    # Async probe of GPT-SoVITS reachability (non-blocking, 2s timeout)
    sovits_reachable = False
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(f"{_sovits_url}/health")
            sovits_reachable = r.status_code < 400
    except Exception:
        pass

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
        sovits_url=_sovits_url,
        sovits_reachable=sovits_reachable,
    )


@app.get("/voices")
async def list_voices():
    """List all available TTS voice presets with metadata."""
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
    """Switch the active TTS engine atomically.

    Acquires a mutex so only one engine is ever in VRAM at a time.
    Switching to 'sovits' unloads the Kokoro MLX model (clears Metal cache).
    Switching back to 'kokoro' marks Engine A as active; it lazy-loads on the
    next /tts request.

    Returns:
        {"engine": str, "status": "already_loaded" | "switched"}
    """
    global _active_engine

    if _engine_switch_lock is None:
        raise HTTPException(status_code=503, detail="Server not fully initialized")

    async with _engine_switch_lock:
        if req.engine == _active_engine:
            return {"engine": _active_engine, "status": "already_loaded"}

        log.info(f"Switching TTS engine: {_active_engine} → {req.engine}")

        if req.engine == "sovits":
            # Unload Kokoro to free ~1 GB VRAM before GPT-SoVITS tries to load
            if _tts_loaded:
                log.info("Unloading Kokoro (Engine A) before activating Engine B ...")
                _unload_tts()
            # Verify GPT-SoVITS is reachable before committing the switch
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    r = await client.get(f"{_sovits_url}/health")
                    if r.status_code >= 400:
                        raise HTTPException(
                            status_code=502,
                            detail=(
                                f"GPT-SoVITS at {_sovits_url} returned HTTP {r.status_code}. "
                                "Start the GPT-SoVITS server before switching engines."
                            ),
                        )
            except httpx.ConnectError:
                raise HTTPException(
                    status_code=502,
                    detail=(
                        f"Cannot reach GPT-SoVITS at {_sovits_url}. "
                        "Start the GPT-SoVITS server before switching engines."
                    ),
                )
        # else: switching to kokoro — Kokoro lazy-loads on the next /tts request

        _active_engine = req.engine
        log.info(f"Active TTS engine is now: {_active_engine}")
        return {"engine": _active_engine, "status": "switched"}


async def _synthesize_kokoro(req: TTSRequest) -> Response:
    """Synthesize with Engine A (Kokoro MLX). Internal helper."""
    global _tts_last_used

    if _tts_loading:
        raise HTTPException(status_code=409, detail="TTS model is currently loading")

    if req.voice not in VOICE_PRESETS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown voice: {req.voice}. Use GET /voices for available presets.",
        )

    if not _tts_loaded:
        log.info("Lazy-loading Kokoro (Engine A) ...")
        _load_tts()

    assert _tts_model is not None

    voice_meta = VOICE_PRESETS[req.voice]
    lang_code = VOICE_LANG_CODES.get(voice_meta["language"], "a")

    log.info(
        f"[Engine A] Synthesizing: text='{req.text[:80]}...' "
        f"voice={req.voice} speed={req.speed} lang={lang_code}"
    )
    start = time.monotonic()

    audio_chunks: list[np.ndarray] = []
    for result in _tts_model.generate(
        text=req.text,
        voice=req.voice,
        speed=req.speed,
        lang_code=lang_code,
    ):
        chunk = np.array(result.audio, dtype=np.float32)
        if chunk.size > 0:
            audio_chunks.append(chunk)

    if not audio_chunks:
        raise HTTPException(status_code=500, detail="TTS generation returned no audio")

    audio_np = np.concatenate(audio_chunks)
    buf = io.BytesIO()
    sf.write(buf, audio_np, TTS_SAMPLE_RATE, format="WAV", subtype="FLOAT")
    wav_bytes = buf.getvalue()

    elapsed = time.monotonic() - start
    _tts_last_used = time.monotonic()
    duration_s = len(audio_np) / TTS_SAMPLE_RATE

    log.info(f"[Engine A] Synthesized in {elapsed:.1f}s — {len(wav_bytes)} bytes, {duration_s:.1f}s")

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "X-Synthesis-Time": f"{elapsed:.2f}s",
            "X-Audio-Duration": f"{duration_s:.2f}s",
            "X-Voice": req.voice,
            "X-Engine": "kokoro",
            "X-Sample-Rate": str(TTS_SAMPLE_RATE),
        },
    )


async def _synthesize_sovits(req: TTSRequest) -> Response:
    """Synthesize with Engine B (GPT-SoVITS via HTTP proxy). Internal helper."""
    if not req.ref_audio_path:
        raise HTTPException(
            status_code=400,
            detail="ref_audio_path is required when using GPT-SoVITS (Engine B).",
        )

    payload = {
        "text": req.text,
        "text_lang": req.ref_language,
        "ref_audio_path": req.ref_audio_path,
        "prompt_text": req.ref_text or "",
        "prompt_lang": req.ref_language,
        "top_k": req.top_k,
        "top_p": req.top_p,
        "temperature": req.temperature,
        "text_split_method": req.text_split_method,
        "batch_size": 1,
        "speed_factor": req.speed_factor,
        "repetition_penalty": req.repetition_penalty,
        "sample_steps": req.sample_steps,
        "media_type": "wav",
        "streaming_mode": 0,
    }
    log.info(
        f"[Engine B] Proxying TTS to GPT-SoVITS @ {_sovits_url}: "
        f"text='{req.text[:80]}...' ref={req.ref_audio_path}"
    )
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(f"{_sovits_url}/tts", json=payload)
            r.raise_for_status()

        elapsed = time.monotonic() - start
        log.info(f"[Engine B] GPT-SoVITS responded in {elapsed:.1f}s — {len(r.content)} bytes")

        return Response(
            content=r.content,
            media_type="audio/wav",
            headers={
                "X-Synthesis-Time": f"{elapsed:.2f}s",
                "X-Engine": "sovits",
            },
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=502,
            detail=f"GPT-SoVITS returned HTTP {e.response.status_code}: {e.response.text[:200]}",
        )
    except httpx.ConnectError:
        raise HTTPException(
            status_code=502,
            detail=f"Cannot reach GPT-SoVITS at {_sovits_url}. Is the server running?",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Engine B synthesis failed: {str(e)}")


@app.post("/tts", response_class=Response)
async def synthesize(req: TTSRequest):
    """Synthesize text to speech. Returns WAV audio.

    Routes to the active TTS engine:
    - Engine A (Kokoro): lazy-loaded MLX model, 54 voice presets, 24kHz output
    - Engine B (GPT-SoVITS): HTTP proxy to running GPT-SoVITS instance for voice cloning

    Switch engines via POST /switch_engine.
    """
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")

    try:
        if _active_engine == "sovits":
            return await _synthesize_sovits(req)
        else:
            return await _synthesize_kokoro(req)
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"TTS synthesis failed: {e}")
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {str(e)}")


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(audio: UploadFile = File(...)):
    """Transcribe an audio file to text using Whisper.

    Accepts audio files via multipart upload (wav, mp3, webm, m4a, ogg, flac).
    The STT model (Whisper distil-large-v3) is loaded lazily on first request.

    Returns transcribed text with segment-level timestamps.
    """
    global _stt_last_used

    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _stt_loading:
        raise HTTPException(status_code=409, detail="STT model is currently loading")

    # Validate file type
    content_type = audio.content_type or ""
    filename = audio.filename or "audio"
    valid_types = {
        "audio/wav", "audio/x-wav", "audio/wave",
        "audio/mpeg", "audio/mp3",
        "audio/webm",
        "audio/mp4", "audio/m4a", "audio/x-m4a",
        "audio/ogg",
        "audio/flac",
    }
    valid_extensions = {".wav", ".mp3", ".webm", ".m4a", ".ogg", ".flac", ".mp4"}

    ext = os.path.splitext(filename)[1].lower()
    if content_type not in valid_types and ext not in valid_extensions:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported audio format: {content_type or ext}. "
                f"Accepted: wav, mp3, webm, m4a, ogg, flac"
            ),
        )

    # Lazy load STT model
    if not _stt_loaded:
        log.info("Lazy-loading STT model for first transcription request ...")
        _load_stt()

    assert _stt_model is not None

    # Save uploaded file to a temp path (Whisper needs a file path)
    import tempfile
    tmp_path = None
    try:
        audio_bytes = await audio.read()
        suffix = ext if ext else ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        log.info(f"Transcribing: file='{filename}' size={len(audio_bytes)} bytes")
        start = time.monotonic()

        result = _stt_model.transcribe(audio_path=tmp_path)

        elapsed = time.monotonic() - start
        _stt_last_used = time.monotonic()

        text = result.get("text", "").strip()
        language = result.get("language", "")
        raw_segments = result.get("segments", [])

        # lightning_whisper_mlx returns segments as [start_frames, end_frames, text]
        # lists, not dicts. Convert to dict format with seconds.
        # Frame-to-seconds: frames * HOP_LENGTH(160) / SAMPLE_RATE(16000) = frames * 0.01
        FRAMES_TO_SEC = 0.01
        parsed_segments: list[dict] = []
        for seg in raw_segments:
            if isinstance(seg, (list, tuple)) and len(seg) >= 3:
                parsed_segments.append({
                    "start": round(float(seg[0]) * FRAMES_TO_SEC, 2),
                    "end": round(float(seg[1]) * FRAMES_TO_SEC, 2),
                    "text": str(seg[2]).strip(),
                })
            elif isinstance(seg, dict):
                parsed_segments.append(seg)

        # Calculate approximate audio duration from last segment
        duration = 0.0
        if parsed_segments:
            duration = parsed_segments[-1].get("end", 0.0)

        log.info(
            f"Transcribed in {elapsed:.1f}s — "
            f"{len(text)} chars, {len(parsed_segments)} segments, "
            f"lang={language}, duration={duration:.1f}s"
        )

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
        raise HTTPException(
            status_code=500, detail=f"Transcription failed: {str(e)}"
        )
    finally:
        # Clean up temp file
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@app.post("/unload")
async def unload_model(model: str = "all"):
    """Unload one or all models to free RAM.

    Args:
        model: Which model to unload — 'tts', 'stt', or 'all' (default).
    """
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

    if model not in ("tts", "stt", "all"):
        raise HTTPException(
            status_code=400,
            detail=f"Unknown model: {model}. Use 'tts', 'stt', or 'all'.",
        )

    return {"status": "ok", **result}


# ── CLI Entry Point ────────────────────────────────────────────

def main():
    """Parse CLI args and start the audio sidecar server."""
    global _idle_timeout, _tts_model_name, _stt_model_name

    parser = argparse.ArgumentParser(
        description="OpenZigs Audio Sidecar (STT + TTS)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python server.py                              # Lazy mode, default models
    python server.py --idle-timeout 300            # Unload after 5 min idle
    python server.py --port 5007 --host 0.0.0.0   # Custom bind
    python server.py --stt-model large-v3          # Use full Whisper large-v3
        """,
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("AUDIO_PORT", "5006")),
        help="Port to listen on (default: 5006, env: AUDIO_PORT)",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("AUDIO_HOST", "127.0.0.1"),
        help="Host to bind to (default: 127.0.0.1, env: AUDIO_HOST)",
    )
    parser.add_argument(
        "--tts-model",
        default=os.environ.get(
            "AUDIO_TTS_MODEL", DEFAULT_TTS_MODEL
        ),
        help=f"TTS model (default: {DEFAULT_TTS_MODEL})",
    )
    parser.add_argument(
        "--stt-model",
        default=os.environ.get("AUDIO_STT_MODEL", DEFAULT_STT_MODEL),
        help=f"STT model (default: {DEFAULT_STT_MODEL})",
    )
    parser.add_argument(
        "--idle-timeout",
        type=float,
        default=float(os.environ.get("AUDIO_IDLE_TIMEOUT", "0")),
        help=(
            "Seconds of inactivity before auto-unloading models "
            "(0 = disabled, env: AUDIO_IDLE_TIMEOUT)"
        ),
    )
    parser.add_argument(
        "--sovits-url",
        default=os.environ.get("AUDIO_SOVITS_URL", DEFAULT_SOVITS_URL),
        help=(
            f"Base URL of the GPT-SoVITS server — Engine B (default: {DEFAULT_SOVITS_URL}, "
            "env: AUDIO_SOVITS_URL)"
        ),
    )

    args = parser.parse_args()
    _tts_model_name = args.tts_model
    _stt_model_name = args.stt_model
    _idle_timeout = args.idle_timeout
    _sovits_url = args.sovits_url.rstrip("/")

    log.info(
        f"Starting audio sidecar: TTS={_tts_model_name}, STT={_stt_model_name}, "
        f"host={args.host}, port={args.port}"
    )
    log.info(
        f"Idle timeout: "
        f"{'disabled' if _idle_timeout <= 0 else f'{_idle_timeout:.0f}s'}"
    )

    import uvicorn

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="info",
        access_log=True,
    )


if __name__ == "__main__":
    main()
