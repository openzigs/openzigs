"""
Audio Sidecar — Local Speech-to-Text & Text-to-Speech Server
Issue #261: FastAPI wrapper around lightning-whisper-mlx (STT) and mlx-audio (TTS).
Optimized for Apple Silicon (MPS) with lazy model loading and idle auto-unload.

Features:
    - Lazy loading: No models loaded at startup — loads on first request
    - Independent STT/TTS lifecycle: Each model loads/unloads independently
    - Auto-unload: Models unloaded after configurable idle timeout to reclaim RAM
    - 24kHz WAV output for TTS (Kokoro model, 54 voice presets)
    - Segment-level timestamps from STT (Whisper distil-large-v3)

Usage:
    cd sidecars/audio
    pip install -r requirements.txt
    python server.py [--port 5006] [--host 127.0.0.1]

Endpoints:
    POST /tts         — Synthesize speech from text (returns WAV audio)
    POST /transcribe  — Transcribe audio file to text (accepts multipart upload)
    GET  /voices      — List available TTS voice presets
    GET  /health      — Readiness probe (returns model status)
    POST /unload      — Unload one or all models to free RAM
"""

from __future__ import annotations

import argparse
import gc
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Optional

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
    """Request body for text-to-speech synthesis."""

    text: str = Field(
        ...,
        min_length=1,
        max_length=10000,
        description="Text to synthesize into speech",
    )
    voice: str = Field(
        default=DEFAULT_VOICE,
        description="Voice preset ID (e.g. 'af_heart', 'bm_daniel')",
    )
    speed: float = Field(
        default=1.0,
        ge=0.5,
        le=2.0,
        description="Speaking speed multiplier (0.5–2.0)",
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
    import asyncio

    global _ready

    _ready = True

    log.info(
        f"Audio sidecar ready — lazy mode "
        f"(TTS={_tts_model_name}, STT={_stt_model_name}, "
        f"idle_timeout={'disabled' if _idle_timeout <= 0 else f'{_idle_timeout:.0f}s'})"
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
    """Readiness probe. Returns model load states."""
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


@app.post("/tts", response_class=Response)
async def synthesize(req: TTSRequest):
    """Synthesize text to speech. Returns 24kHz WAV audio.

    The TTS model (Kokoro-82M) is loaded lazily on first request.
    Subsequent requests reuse the loaded model for fast inference.
    """
    global _tts_last_used

    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _tts_loading:
        raise HTTPException(status_code=409, detail="TTS model is currently loading")

    # Validate voice
    if req.voice not in VOICE_PRESETS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown voice: {req.voice}. Use GET /voices for available presets.",
        )

    # Lazy load TTS model
    if not _tts_loaded:
        log.info("Lazy-loading TTS model for first synthesis request ...")
        _load_tts()

    assert _tts_model is not None

    # Determine language code from voice preset
    voice_meta = VOICE_PRESETS[req.voice]
    lang_code = VOICE_LANG_CODES.get(voice_meta["language"], "a")

    log.info(
        f"Synthesizing: text='{req.text[:80]}...' "
        f"voice={req.voice} speed={req.speed} lang={lang_code}"
    )
    start = time.monotonic()

    try:
        # Generate audio using mlx-audio Kokoro model.
        # The generator can yield multiple chunks (often sentence-sized).
        # Concatenate all chunks so we return the full utterance, not just the last chunk.
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

        # Merge all generated chunks into a single waveform.
        audio_np = np.concatenate(audio_chunks)

        buf = io.BytesIO()
        sf.write(buf, audio_np, TTS_SAMPLE_RATE, format="WAV", subtype="FLOAT")
        wav_bytes = buf.getvalue()

        elapsed = time.monotonic() - start
        _tts_last_used = time.monotonic()
        duration_s = len(audio_np) / TTS_SAMPLE_RATE

        log.info(
            f"Synthesized in {elapsed:.1f}s — "
            f"{len(wav_bytes)} bytes, {duration_s:.1f}s audio"
        )

        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "X-Synthesis-Time": f"{elapsed:.2f}s",
                "X-Audio-Duration": f"{duration_s:.2f}s",
                "X-Voice": req.voice,
                "X-Sample-Rate": str(TTS_SAMPLE_RATE),
            },
        )
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

    args = parser.parse_args()
    _tts_model_name = args.tts_model
    _stt_model_name = args.stt_model
    _idle_timeout = args.idle_timeout

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
