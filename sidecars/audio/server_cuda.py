"""
Audio Sidecar -- CUDA/PyTorch Backend
Drop-in replacement for the MLX audio sidecar using faster-whisper (STT),
Kokoro PyTorch (TTS Engine A), and F5-TTS (TTS Engine C, voice cloning) on NVIDIA GPUs.

Engine A: Kokoro (19 preset voices, 24kHz, ~1 GB VRAM)
Engine C: F5-TTS  (voice cloning from 3-10s reference clip, 24kHz, 4-6 GB VRAM)
         Same model as f5-tts-mlx on Mac, different PyTorch backend.

Platform split:
    Apple Silicon (MPS): server.py + f5-tts-mlx      (requires Metal / MLX)
    NVIDIA CUDA:         server_cuda.py + f5-tts      (requires CUDA 11.8+)

Endpoints:
    POST /tts              -- Synthesize speech (Kokoro or F5-TTS if ref_audio_path given)
    POST /f5tts            -- F5-TTS multi-clip voice cloning (emotion tags supported)
    POST /transcribe       -- Transcribe audio to text
    GET  /voices           -- List voice presets
    GET  /health           -- Readiness probe
    POST /switch_engine    -- Switch TTS engine (kokoro | f5tts)
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
import re
import subprocess
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

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("audio-sidecar-cuda")

# ── Lazy imports ───────────────────────────────────────────────────────────────
torch = None

# ── Voice Presets ──────────────────────────────────────────────────────────────
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

# ── Global State ───────────────────────────────────────────────────────────────
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

# ── F5-TTS State (Engine C — CUDA/PyTorch) ────────────────────────────────────
_f5tts_model: Any = None
_f5tts_loaded: bool = False
_f5tts_loading: bool = False
_f5tts_last_used: float = 0.0
_f5tts_lock: asyncio.Lock = asyncio.Lock()   # serialize CUDA inference — concurrent calls crash
F5TTS_SAMPLE_RATE = 24000
F5TTS_MAX_REF_AUDIO_SECONDS = 15.0
DEFAULT_F5TTS_MODEL = "F5TTS_v1_Base"   # downloads SWivid/F5-TTS from HuggingFace automatically
_F5TTS_MIN_WPS = 2.0            # words/sec floor (conservative narration pace)
_F5TTS_PAD_SEC = 1.0            # padding seconds for max-duration estimate


# ── Model Lifecycle ────────────────────────────────────────────────────────────

def _ensure_torch():
    global torch
    if torch is None:
        import torch as _torch
        torch = _torch
        # Enable cuDNN autotuner — picks fastest convolution algorithm for fixed input sizes
        if _torch.cuda.is_available():
            _torch.backends.cudnn.benchmark = True


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
    """Load Kokoro TTS pipeline on CUDA (Engine A)."""
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


def _load_f5tts() -> float:
    """Load F5-TTS model on CUDA (Engine C). Returns seconds taken."""
    global _f5tts_model, _f5tts_loaded, _f5tts_loading, _f5tts_last_used

    if _f5tts_loaded:
        return 0.0

    _f5tts_loading = True
    try:
        start = time.monotonic()
        log.info(f"Loading F5-TTS model '{DEFAULT_F5TTS_MODEL}' (CUDA/PyTorch) ...")
        try:
            from f5_tts.api import F5TTS
            _f5tts_model = F5TTS(model=DEFAULT_F5TTS_MODEL, device="cuda")
        except ImportError:
            log.error("f5-tts is not installed. Run: pip install f5-tts")
            raise
        elapsed = time.monotonic() - start
        _f5tts_loaded = True
        _f5tts_last_used = time.monotonic()
        log.info(f"F5-TTS model loaded in {elapsed:.1f}s")
        return elapsed
    except Exception as e:
        log.error(f"Failed to load F5-TTS model: {e}")
        raise
    finally:
        _f5tts_loading = False


def _unload_tts():
    global _tts_pipeline, _tts_loaded
    if _tts_pipeline is not None:
        del _tts_pipeline
        _tts_pipeline = None
    _tts_loaded = False
    _clear_vram()
    log.info("TTS (Kokoro) unloaded")


def _unload_stt():
    global _stt_model, _stt_loaded
    if _stt_model is not None:
        del _stt_model
        _stt_model = None
    _stt_loaded = False
    _clear_vram()
    log.info("STT model unloaded")


def _unload_f5tts():
    global _f5tts_model, _f5tts_loaded
    if _f5tts_model is not None:
        log.info("Unloading F5-TTS model ...")
        del _f5tts_model
        _f5tts_model = None
    _f5tts_loaded = False
    _clear_vram()
    log.info("F5-TTS (Engine C) unloaded")


def _clear_vram():
    gc.collect()
    _ensure_torch()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


# ── Request/Response Models ────────────────────────────────────────────────────

class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice: str = Field(default=DEFAULT_VOICE)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    format: str = Field(default="wav", pattern=r"^(wav|mp3)$")
    # F5-TTS voice cloning (optional — triggers Engine C when provided)
    ref_audio_path: Optional[str] = None   # filesystem path to reference WAV
    ref_text: Optional[str] = None         # transcript of reference audio


class F5TTSClip(BaseModel):
    ref_audio: str       # base64-encoded reference audio
    ref_text: str        # transcript of reference audio
    gen_text: str        # text to synthesize for this clip
    emotion: str = "Regular"
    remove_silence: bool = True


class F5TTSRequest(BaseModel):
    text: str = Field(default="", max_length=5000)
    clips: list[F5TTSClip] = Field(default_factory=list)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    nfe_step: int = Field(default=16, ge=4, le=64)
    cfg_strength: float = Field(default=2.0, ge=0.5, le=5.0)
    sway_sampling_coef: float = Field(default=-1.0)
    seed: Optional[int] = None


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
    f5tts_engine: str = "f5-tts (CUDA/PyTorch)"


# ── F5-TTS Utilities ───────────────────────────────────────────────────────────

_EMOTION_TAG_RE = re.compile(r"\(([A-Za-z][A-Za-z0-9_ ]{0,30})\)")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?;:])\s+")


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences, avoiding splits at abbreviation dots."""
    raw_parts = [s.strip() for s in _SENTENCE_SPLIT_RE.split(text) if s.strip()]
    if len(raw_parts) <= 1:
        return raw_parts
    merged: list[str] = [raw_parts[0]]
    for part in raw_parts[1:]:
        prev = merged[-1]
        if re.search(r"\b[A-Z]\.$", prev) and re.match(r"^[A-Z]\.", part):
            merged[-1] = prev + " " + part
        else:
            merged.append(part)
    return merged


def _split_text_by_emotion(text: str, default_emotion: str = "Regular") -> list[tuple[str, str]]:
    """Split text into (segment_text, emotion_label) pairs."""
    parts: list[tuple[str, str]] = []
    current_emotion = default_emotion
    last_end = 0
    for match in _EMOTION_TAG_RE.finditer(text):
        segment = text[last_end:match.start()].strip()
        if segment:
            parts.append((segment, current_emotion))
        current_emotion = match.group(1)
        last_end = match.end()
    remainder = text[last_end:].strip()
    if remainder:
        parts.append((remainder, current_emotion))
    return parts if parts else [(text.strip(), default_emotion)]


def _estimate_max_duration(sentence: str) -> float:
    """Return a conservative max duration (seconds) for a single sentence."""
    return max(2.0, len(sentence.split()) / _F5TTS_MIN_WPS + _F5TTS_PAD_SEC)


def _convert_to_24khz_mono_wav(input_path: str) -> tuple[str, bool]:
    """Convert audio to 24kHz mono WAV for F5-TTS. Returns (path, is_temp)."""
    fd, tmp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        cmd = [
            "ffmpeg", "-y", "-i", input_path,
            "-ar", "24000", "-ac", "1",
            "-t", str(F5TTS_MAX_REF_AUDIO_SECONDS),
            "-c:a", "pcm_s16le", tmp_path,
        ]
        subprocess.run(cmd, capture_output=True, timeout=30, check=True)
        return tmp_path, True
    except Exception as exc:
        log.warning(f"[Engine C] Audio conversion failed ({exc}), using original")
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return input_path, False


def _trim_trailing_silence(wav_bytes: bytes, threshold_db: float = -40.0,
                           min_trail_sec: float = 0.3) -> bytes:
    """Trim silence from the end of a WAV buffer."""
    try:
        data, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")
    except Exception:
        return wav_bytes
    if len(data) == 0:
        return wav_bytes
    threshold = 10.0 ** (threshold_db / 20.0)
    above = np.where(np.abs(data) > threshold)[0]
    if len(above) == 0:
        return wav_bytes
    cut_idx = min(int(above[-1]) + int(sr * min_trail_sec), len(data))
    if cut_idx >= len(data) - int(sr * 0.1):
        return wav_bytes
    trimmed = data[:cut_idx].copy()
    fade_len = min(int(sr * 0.05), len(trimmed))
    if fade_len > 0:
        trimmed[-fade_len:] *= np.linspace(1.0, 0.0, fade_len, dtype=np.float32)
    out = io.BytesIO()
    sf.write(out, trimmed, sr, format="WAV", subtype="PCM_16")
    return out.getvalue()


def _concatenate_wav_bytes(chunks: list[bytes]) -> bytes:
    """Concatenate multiple WAV byte buffers into a single WAV file."""
    if not chunks:
        return b""
    if len(chunks) == 1:
        return chunks[0]
    all_audio: list[np.ndarray] = []
    sample_rate = F5TTS_SAMPLE_RATE
    for chunk in chunks:
        try:
            data, sr = sf.read(io.BytesIO(chunk), dtype="float32")
            sample_rate = sr
            all_audio.append(data)
        except Exception as exc:
            log.warning(f"[Engine C] Failed to read WAV chunk: {exc}")
    if not all_audio:
        return b""
    out = io.BytesIO()
    sf.write(out, np.concatenate(all_audio), sample_rate, format="WAV", subtype="PCM_16")
    return out.getvalue()


async def _synthesize_f5tts_clip(
    gen_text: str,
    ref_file: str,
    ref_text: str,
    nfe_step: int,
    cfg_strength: float,
    sway_sampling_coef: float,
    speed: float,
    seed: Optional[int],
) -> bytes:
    """Run one F5-TTS inference segment. Returns WAV bytes."""
    loop = asyncio.get_event_loop()

    def _run() -> bytes:
        assert _f5tts_model is not None
        _ensure_torch()
        with torch.inference_mode():
            wav, sr, _ = _f5tts_model.infer(
                ref_file=ref_file,
                ref_text=ref_text or "",
                gen_text=gen_text,
                show_info=lambda *a, **k: None,
                progress=None,
                nfe_step=nfe_step,
                cfg_strength=cfg_strength,
                sway_sampling_coef=sway_sampling_coef,
                speed=speed,
                seed=seed,
            )
        buf = io.BytesIO()
        sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue()

    # PyTorch/CUDA is thread-safe — offload blocking inference to thread pool
    return await loop.run_in_executor(None, _run)


# ── Kokoro TTS Synthesis ───────────────────────────────────────────────────────

async def _synthesize_kokoro(req: TTSRequest) -> Response:
    """Synthesize using Kokoro TTS (PyTorch/CUDA, Engine A)."""
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
    audio_chunks = []
    try:
        _ensure_torch()
        _tts_pipeline.lang_code = lang_code
        with torch.inference_mode():
            for _, _, audio in _tts_pipeline(req.text, voice=voice, speed=req.speed):
                if audio is not None:
                    audio_chunks.append(audio.cpu().numpy() if hasattr(audio, "cpu") else np.array(audio))
    except Exception as exc:
        log.error(f"Kokoro TTS failed: {exc}")
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {str(exc)}")

    if not audio_chunks:
        raise HTTPException(status_code=500, detail="TTS produced no audio")

    combined = np.concatenate(audio_chunks)
    elapsed = time.monotonic() - start
    _tts_last_used = time.monotonic()
    log.info(f"[Engine A] {len(req.text)} chars -> {len(combined)} samples in {elapsed:.1f}s")

    buf = io.BytesIO()
    sf.write(buf, combined, TTS_SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return Response(
        content=buf.getvalue(),
        media_type="audio/wav",
        headers={
            "X-Generation-Time": f"{elapsed:.2f}",
            "X-Voice": voice,
            "X-Sample-Rate": str(TTS_SAMPLE_RATE),
            "X-Engine": "kokoro",
        },
    )


async def _synthesize_tts_with_voice_clone(req: TTSRequest) -> Response:
    """Synthesize via /tts when ref_audio_path is present (Engine C shortcut)."""
    global _f5tts_last_used

    # Look the file up under a fixed allowlist of roots (matches the lipsync
    # sidecar pattern). The directory passed to os.listdir() must be a constant
    # so that CodeQL's taint flow does NOT reach any filesystem sink.
    requested_basename = os.path.basename(req.ref_audio_path or "")
    if (
        not requested_basename
        or requested_basename in (".", "..")
        or "/" in requested_basename
        or "\\" in requested_basename
    ):
        raise HTTPException(status_code=400, detail="Invalid ref_audio_path")

    allowed_roots = [
        os.path.realpath(str(Path.home() / ".openzigs")),
        os.path.realpath(tempfile.gettempdir()),
    ]
    ref_path: Optional[str] = None
    for root in allowed_roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, filenames in os.walk(root):
            for entry in filenames:
                # entry comes from os.walk(root) where root is constant — untainted.
                if entry == requested_basename:
                    ref_path = os.path.join(dirpath, entry)
                    break
            if ref_path is not None:
                break
        if ref_path is not None:
            break
    if ref_path is None or not os.path.isfile(ref_path):
        raise HTTPException(status_code=400, detail="ref_audio_path file not found")

    if _f5tts_loading:
        raise HTTPException(status_code=409, detail="F5-TTS model is currently loading")
    if not _f5tts_loaded:
        log.info("Lazy-loading F5-TTS for /tts voice clone ...")
        _load_f5tts()

    conv_path, is_temp = _convert_to_24khz_mono_wav(ref_path)
    temp_files = [conv_path] if is_temp else []
    try:
        start = time.monotonic()
        _f5tts_last_used = time.monotonic()
        sentences = _split_sentences(req.text) or [req.text.strip()]
        chunks: list[bytes] = []
        for sentence in sentences:
            chunk = await _synthesize_f5tts_clip(
                gen_text=sentence,
                ref_file=conv_path,
                ref_text=req.ref_text or "",
                nfe_step=32,
                cfg_strength=2.0,
                sway_sampling_coef=-1.0,
                speed=req.speed,
                seed=None,
            )
            chunks.append(_trim_trailing_silence(chunk))
            _f5tts_last_used = time.monotonic()
        wav_bytes = _concatenate_wav_bytes(chunks) if len(chunks) > 1 else (chunks[0] if chunks else b"")
        if not wav_bytes:
            raise HTTPException(status_code=500, detail="F5-TTS produced no audio")
        elapsed = time.monotonic() - start
        log.info(f"[Engine C/tts] {len(req.text)} chars in {elapsed:.1f}s")
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "X-Generation-Time": f"{elapsed:.2f}",
                "X-Engine": "f5tts",
                "X-Sample-Rate": str(F5TTS_SAMPLE_RATE),
            },
        )
    finally:
        for tmp in temp_files:
            try:
                os.unlink(tmp)
            except OSError:
                pass


# ── FastAPI App ────────────────────────────────────────────────────────────────

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
            if _f5tts_loaded and not _f5tts_loading and _f5tts_last_used > 0 and (now - _f5tts_last_used) > _idle_timeout:
                log.info("F5-TTS idle timeout, unloading")
                _unload_f5tts()


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

# Epic #1115 — standardised sidecar error envelope.
import logging as _logging1115  # noqa: E402
import os as _os1115  # noqa: E402
import sys as _sys1115  # noqa: E402
_OZ_SHARED_DIR_1115 = _os1115.path.join(_os1115.path.dirname(_os1115.path.abspath(__file__)), "..", "_shared")
if _OZ_SHARED_DIR_1115 not in _sys1115.path:
    _sys1115.path.insert(0, _OZ_SHARED_DIR_1115)
from errors import register_error_handlers as _register_error_handlers_1115  # type: ignore[import-not-found]  # noqa: E402
_register_error_handlers_1115(app, logger=_logging1115.getLogger(__name__))


@app.get("/health", response_model=HealthResponse)
async def health():
    is_loading = _tts_loading or _stt_loading
    status = "loading" if is_loading else ("ok" if _ready else "starting")
    _f5tts_pkg_available = False
    try:
        import importlib.util
        _f5tts_pkg_available = importlib.util.find_spec("f5_tts") is not None
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
        f5tts_loaded=_f5tts_loaded,
        f5tts_loading=_f5tts_loading,
        f5tts_available=_f5tts_pkg_available,
        f5tts_engine="f5-tts (CUDA/PyTorch)",
    )


@app.get("/voices")
async def list_voices():
    voices = [
        {"id": vid, "language": meta["language"], "gender": meta["gender"], "style": meta["style"]}
        for vid, meta in VOICE_PRESETS.items()
    ]
    return {"voices": voices, "default": DEFAULT_VOICE, "model": _tts_model_name, "sample_rate": TTS_SAMPLE_RATE}


@app.get("/gpu-info")
async def gpu_info_endpoint():
    """Report which CUDA device this sidecar is bound to (Issue #884)."""
    _ensure_torch()
    if not torch.cuda.is_available():
        return {"available": False, "cuda_visible": os.environ.get("CUDA_VISIBLE_DEVICES", "")}
    idx = torch.cuda.current_device()
    free, total = torch.cuda.mem_get_info(idx)
    return {
        "available": True,
        "device_index": idx,
        "device_name": torch.cuda.get_device_name(idx),
        "device_count": torch.cuda.device_count(),
        "total_mb": int(total / 1024**2),
        "free_mb": int(free / 1024**2),
        "cuda_visible": os.environ.get("CUDA_VISIBLE_DEVICES", ""),
    }


@app.post("/switch_engine")
async def switch_engine(req: SwitchEngineRequest):
    global _active_engine
    if req.engine == _active_engine:
        return {"engine": _active_engine, "status": "already_loaded"}
    log.info(f"Switching engine: {_active_engine} -> {req.engine}")
    # Unload previous engine to free VRAM
    if req.engine == "f5tts":
        if _tts_loaded:
            _unload_tts()
    elif req.engine == "kokoro":
        if _f5tts_loaded:
            _unload_f5tts()
    elif req.engine == "sovits":
        if _tts_loaded:
            _unload_tts()
        if _f5tts_loaded:
            _unload_f5tts()
    _active_engine = req.engine
    return {"engine": _active_engine, "status": "switched"}


@app.post("/tts", response_class=Response)
async def synthesize(req: TTSRequest):
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    try:
        # Route to F5-TTS when a reference audio is provided for voice cloning
        if req.ref_audio_path:
            return await _synthesize_tts_with_voice_clone(req)
        return await _synthesize_kokoro(req)
    except HTTPException:
        raise
    except Exception as exc:
        log.error(f"TTS synthesis failed: {exc}")
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {str(exc)}")


@app.post("/f5tts", response_class=Response)
async def synthesize_f5tts(req: F5TTSRequest):
    """F5-TTS multi-clip voice cloning (Engine C — CUDA/PyTorch).

    Accepts one or more reference clips (base64 audio + transcript + gen_text).
    Each clip's gen_text is synthesized using the corresponding reference voice.
    Returns 24kHz mono WAV.
    """
    global _f5tts_last_used

    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _f5tts_loading:
        raise HTTPException(status_code=409, detail="F5-TTS model is currently loading")
    if not req.clips:
        raise HTTPException(status_code=400, detail="At least one clip is required")

    if not _f5tts_loaded:
        log.info("Lazy-loading F5-TTS (Engine C, CUDA) ...")
        _load_f5tts()

    # Serialize F5-TTS inference — concurrent CUDA calls with different tensor
    # sizes cause "Sizes of tensors must match" crashes.
    if _f5tts_lock.locked():
        raise HTTPException(status_code=409, detail="F5-TTS is busy with another request")

    async with _f5tts_lock:
        return await _run_f5tts_inference(req)


async def _run_f5tts_inference(req: F5TTSRequest) -> Response:
    """Actual F5-TTS inference, always called under _f5tts_lock."""
    global _f5tts_last_used

    start = time.monotonic()
    wav_chunks: list[bytes] = []
    temp_files: list[str] = []

    try:
        _f5tts_last_used = time.monotonic()

        for clip in req.clips:
            import base64
            try:
                ref_bytes = base64.b64decode(clip.ref_audio)
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid base64 in ref_audio")

            fd, raw_path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            temp_files.append(raw_path)
            with open(raw_path, "wb") as fh:
                fh.write(ref_bytes)

            conv_path, is_temp = _convert_to_24khz_mono_wav(raw_path)
            if is_temp:
                temp_files.append(conv_path)

            sentences = _split_sentences(clip.gen_text or req.text) or [(clip.gen_text or req.text).strip()]
            for sentence in sentences:
                if not sentence.strip():
                    continue
                chunk = await _synthesize_f5tts_clip(
                    gen_text=sentence,
                    ref_file=conv_path,
                    ref_text=clip.ref_text,
                    nfe_step=req.nfe_step,
                    cfg_strength=req.cfg_strength,
                    sway_sampling_coef=req.sway_sampling_coef,
                    speed=req.speed,
                    seed=req.seed,
                )
                wav_chunks.append(_trim_trailing_silence(chunk) if clip.remove_silence else chunk)
                _f5tts_last_used = time.monotonic()

        if not wav_chunks:
            raise HTTPException(status_code=500, detail="F5-TTS produced no audio")

        wav_bytes = _concatenate_wav_bytes(wav_chunks) if len(wav_chunks) > 1 else wav_chunks[0]
        elapsed = time.monotonic() - start
        log.info(f"[Engine C] {len(req.clips)} clip(s), {len(wav_chunks)} sentence(s) in {elapsed:.1f}s — {len(wav_bytes)} bytes")

        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "X-Synthesis-Time": f"{elapsed:.2f}s",
                "X-Engine": "f5tts-cuda",
                "X-Sample-Rate": str(F5TTS_SAMPLE_RATE),
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        import traceback
        log.error(f"[Engine C] F5-TTS synthesis failed: {exc}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"F5-TTS synthesis failed: {str(exc)}")
    finally:
        for tmp in temp_files:
            try:
                os.unlink(tmp)
            except OSError:
                pass


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
        duration = parsed_segments[-1]["end"] if parsed_segments else 0.0
        elapsed = time.monotonic() - start
        _stt_last_used = time.monotonic()
        log.info(f"Transcribed in {elapsed:.1f}s: {len(text)} chars, {len(parsed_segments)} segments")

        return TranscribeResponse(
            text=text,
            language=info.language or "",
            segments=parsed_segments,
            duration_seconds=round(duration, 2),
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.error(f"Transcription failed: {exc}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(exc)}")
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
    if model in ("f5tts", "all"):
        if _f5tts_loaded:
            _unload_f5tts()
            result["f5tts"] = "unloaded"
        else:
            result["f5tts"] = "not_loaded"
    return result


# ── Entrypoint ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Audio sidecar CUDA")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5006")))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
