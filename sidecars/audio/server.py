"""
Audio Sidecar — Local Speech-to-Text & Text-to-Speech Server
Issue #261: FastAPI wrapper around lightning-whisper-mlx (STT) and mlx-audio (TTS).
Issue #269: Swappable TTS Engines — Kokoro (Engine A) and GPT-SoVITS (Engine B).
Issue #313: Engine C — F5-TTS (f5-tts-mlx) for emotion-driven voice cloning.
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

    CI ENFORCEMENT: grep -r "import sqlite3" sidecars/audio/ and
    grep -r "import agent_tasks" sidecars/audio/
    must both return no matches. Any addition must be code-reviewed.

Features:
    - Lazy loading: No models loaded at startup — loads on first request
    - Independent STT/TTS lifecycle: Each model loads/unloads independently
    - Auto-unload: Models unloaded after configurable idle timeout to reclaim RAM
    - 24kHz WAV output for TTS (Kokoro model, 54 voice presets) — Engine A
    - Engine B: GPT-SoVITS via HTTP proxy for high-fidelity voice cloning
    - Engine C: F5-TTS via f5-tts-mlx for emotion-driven voice cloning
    - POST /switch_engine — swap engines with mutex (prevents double-load)
    - POST /f5tts — emotion-aware TTS with multiple reference clips
    - Segment-level timestamps from STT (Whisper distil-large-v3)

Usage:
    cd sidecars/audio
    pip install -r requirements.txt          # Base (Kokoro + GPT-SoVITS)
    pip install -r requirements-mac.txt      # + F5-TTS (Apple Silicon)
    python server.py [--port 5006] [--host 127.0.0.1]
    # For Engine B (GPT-SoVITS), start the GPT-SoVITS server separately
    # then pass --sovits-url http://127.0.0.1:9880

Endpoints:
    POST /tts              — Synthesize speech (Kokoro or GPT-SoVITS based on active engine)
    POST /f5tts            — Synthesize speech with F5-TTS (emotion tags + multi-reference)
    POST /transcribe       — Transcribe audio file to text (accepts multipart upload)
    GET  /voices           — List available TTS voice presets
    GET  /health           — Readiness probe (returns model + engine status)
    POST /unload           — Unload one or all models to free RAM
    POST /switch_engine    — Switch active TTS engine ("kokoro" | "sovits" | "f5tts")
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
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal, Optional

import subprocess
import tempfile
import ipaddress

import httpx
import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

# ── Logging ────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("audio-sidecar")


# ── Security Utilities ─────────────────────────────────────────

def safe_join(base_dir: str, user_path: str) -> str:
    """Safely join a base directory with a user-supplied path component.

    Resolves symlinks and ensures the result stays under base_dir.
    Raises ValueError on path traversal attempts.
    """
    base = os.path.realpath(base_dir)
    joined = os.path.realpath(os.path.join(base, user_path))
    if not joined.startswith(base + os.sep) and joined != base:
        raise ValueError(f"Path traversal blocked: {user_path}")
    return joined


def validate_file_path(file_path: str) -> str:
    """Validate that a file path is safe to use in subprocess calls.

    Ensures the path exists, is a regular file, and doesn't contain
    null bytes or other dangerous characters.
    """
    if "\x00" in file_path:
        raise ValueError("Path contains null bytes")
    resolved = os.path.realpath(file_path)
    if not os.path.isfile(resolved):
        raise ValueError(f"Not a valid file: {file_path}")
    return resolved

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
_idle_timeout: float = 300.0  # seconds before auto-unload (0 = disabled)
_ready: bool = False
_tts_model_name: str = DEFAULT_TTS_MODEL
_stt_model_name: str = DEFAULT_STT_MODEL

# ── Engine State (Issue #269) ──────────────────────────────────
# "kokoro" = Engine A (MLX Kokoro, always-on, ~1 GB RAM)
# "sovits" = Engine B (GPT-SoVITS HTTP proxy, on-demand, 6-10 GB RAM)
# "f5tts"  = Engine C (F5-TTS MLX, on-demand, ~2 GB RAM)
_ENGINE_STATE_FILE = Path.home() / ".openzigs" / "engine-state.json"


def _load_persisted_engine() -> Literal["kokoro", "sovits", "f5tts"]:
    """Load the last active engine from disk. Falls back to 'kokoro'."""
    try:
        data = json.loads(_ENGINE_STATE_FILE.read_text())
        engine = data.get("active_engine", "kokoro")
        if engine in ("kokoro", "sovits", "f5tts"):
            return engine
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return "kokoro"


def _save_persisted_engine(engine: str) -> None:
    """Persist the active engine to disk."""
    try:
        _ENGINE_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _ENGINE_STATE_FILE.write_text(json.dumps({"active_engine": engine}))
    except OSError as e:
        log.warning(f"Could not persist engine state: {e}")


_active_engine: Literal["kokoro", "sovits", "f5tts"] = _load_persisted_engine()
_sovits_url: str = DEFAULT_SOVITS_URL
_engine_switch_lock: asyncio.Lock | None = None  # Initialized in lifespan

# Cached F5-TTS clips for /tts routing when f5tts is active.
# Set automatically from the last /f5tts call, or explicitly via /f5tts/set-active-clips.
_f5tts_cached_clips: list[dict] | None = None


def _load_persisted_clips() -> list[dict] | None:
    """Load cached F5-TTS clips from engine state file."""
    try:
        data = json.loads(_ENGINE_STATE_FILE.read_text())
        clips = data.get("f5tts_clips")
        if isinstance(clips, list) and len(clips) > 0:
            return clips
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return None


def _save_persisted_clips(clips: list[dict] | None) -> None:
    """Persist cached F5-TTS clips to engine state file."""
    try:
        data: dict = {}
        try:
            data = json.loads(_ENGINE_STATE_FILE.read_text())
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass
        if clips is not None:
            data["f5tts_clips"] = clips
        elif "f5tts_clips" in data:
            del data["f5tts_clips"]
        _ENGINE_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _ENGINE_STATE_FILE.write_text(json.dumps(data))
    except OSError as e:
        log.warning(f"Could not persist f5tts clips: {e}")


_f5tts_cached_clips = _load_persisted_clips()

# ── F5-TTS State (Engine C) ───────────────────────────────────
_f5tts_model: Any = None
_f5tts_loaded: bool = False
_f5tts_loading: bool = False
_f5tts_last_used: float = 0.0
F5TTS_SAMPLE_RATE = 24000
DEFAULT_F5TTS_MODEL = "lucasnewman/f5-tts-mlx"


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


def _load_f5tts() -> float:
    """Load the F5-TTS model. Returns time taken in seconds."""
    global _f5tts_model, _f5tts_loaded, _f5tts_loading, _f5tts_last_used

    if _f5tts_loaded:
        return 0.0

    _f5tts_loading = True
    try:
        start = time.monotonic()
        log.info(f"Loading F5-TTS model '{DEFAULT_F5TTS_MODEL}' ...")

        from f5_tts_mlx.generate import F5TTS
        _f5tts_model = F5TTS.from_pretrained(DEFAULT_F5TTS_MODEL)

        elapsed = time.monotonic() - start
        _f5tts_loaded = True
        _f5tts_last_used = time.monotonic()
        log.info(f"F5-TTS model loaded in {elapsed:.1f}s")
        return elapsed
    except ImportError:
        log.error("f5-tts-mlx is not installed. Install with: pip install f5-tts-mlx")
        raise
    except Exception as e:
        log.error(f"Failed to load F5-TTS model: {e}")
        raise
    finally:
        _f5tts_loading = False


def _unload_f5tts() -> None:
    """Unload F5-TTS model and free memory."""
    global _f5tts_model, _f5tts_loaded

    if _f5tts_model is not None:
        log.info("Unloading F5-TTS model ...")
        del _f5tts_model
        _f5tts_model = None
        gc.collect()
        try:
            import mlx.core
            mlx.core.metal.clear_cache()
            log.info("MLX Metal cache cleared (F5-TTS)")
        except Exception:
            pass
        log.info("F5-TTS model unloaded")
    _f5tts_loaded = False


def _convert_to_24khz_mono_wav(input_path: str) -> tuple[str, bool]:
    """Convert any audio file to 24kHz mono WAV for F5-TTS.

    Also trims to F5TTS_MAX_REF_AUDIO_SECONDS to prevent excessive generation
    time with long reference audio.

    Returns (path_to_use, is_temp). If is_temp is True the caller must
    delete the file after use.
    """
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
    except Exception as e:
        log.warning(f"[Engine C] Audio conversion failed ({e}), using original file")
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return input_path, False


# ── Emotion Tag Parsing ────────────────────────────────────────
# F5-TTS emotion tags use parenthesis syntax: (Excited), (Whisper), etc.
# Text is split at these markers and each segment is synthesized with
# the corresponding reference audio clip.

_EMOTION_TAG_RE = re.compile(r"\(([A-Za-z][A-Za-z0-9_ ]{0,30})\)")

# Sentence splitter for long text — avoids upstream f5-tts-mlx duration
# variable shadowing bug in multi-sentence generate() loop.
# Defense-in-depth: uses a smarter split function instead of a simple regex
# to avoid splitting at abbreviation dots (e.g. "A.I.", "U.S.A.").
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?;:])\s+")


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences, avoiding splits at abbreviation dots.

    Uses the standard sentence-split regex but then re-joins fragments
    that were incorrectly split at single-letter abbreviation boundaries
    (e.g. "U.S.A. is great" should not split between "U." and "S.").
    """
    # First pass: naive split on sentence-ending punctuation + whitespace
    raw_parts = [s.strip() for s in _SENTENCE_SPLIT_RE.split(text) if s.strip()]
    if len(raw_parts) <= 1:
        return raw_parts

    # Second pass: re-join fragments that look like abbreviation splits.
    # A fragment ending with a single uppercase letter followed by the
    # previous part ending in a dot suggests an abbreviation was split.
    merged: list[str] = [raw_parts[0]]
    for part in raw_parts[1:]:
        prev = merged[-1]
        # If the previous fragment ends with a single uppercase letter + dot
        # and this fragment starts with an uppercase letter + dot (or is short),
        # it's likely a split abbreviation — rejoin.
        if (
            re.search(r"\b[A-Z]\.$", prev)
            and re.match(r"^[A-Z]\.", part)
        ):
            merged[-1] = prev + " " + part
        else:
            merged.append(part)
    return merged

F5TTS_MAX_REF_AUDIO_SECONDS = 30.0

# Words-per-second ceiling used to cap F5-TTS duration estimates.
# A comfortable narration pace is ~2.5 words/sec.  We use 2.0 wps
# (slightly slower) as the floor so the model has breathing room,
# then add a fixed pad.  This prevents generate() from creating
# 40+ seconds of audio for a 10-word sentence.
_F5TTS_MIN_WPS = 2.0    # slowest reasonable speech rate
_F5TTS_PAD_SEC = 1.0    # fixed padding per sentence


def _estimate_max_duration(sentence: str) -> float:
    """Return a sane maximum duration (seconds) for a single sentence.

    Based on word count at a conservative speaking rate + padding.
    Minimum 2s so very short sentences still get space.
    """
    words = len(sentence.split())
    return max(2.0, words / _F5TTS_MIN_WPS + _F5TTS_PAD_SEC)


def _trim_trailing_silence(wav_bytes: bytes, threshold_db: float = -40.0,
                           min_trail_sec: float = 0.3) -> bytes:
    """Trim silence/noise from the end of a WAV buffer.

    After F5-TTS overestimates duration, the tail is typically silence
    or low-level hallucination noise.  We find the last sample above
    *threshold_db* and keep only a short fade-out tail after it.
    """
    buf = io.BytesIO(wav_bytes)
    try:
        data, sr = sf.read(buf, dtype="float32")
    except Exception:
        return wav_bytes  # can't parse — return as-is

    if len(data) == 0:
        return wav_bytes

    # Convert threshold from dB to linear amplitude
    threshold = 10.0 ** (threshold_db / 20.0)

    # Find the last sample whose absolute value exceeds the threshold
    above = np.where(np.abs(data) > threshold)[0]
    if len(above) == 0:
        return wav_bytes  # entirely silent — return as-is

    last_sound_idx = int(above[-1])
    # Keep a short tail after the last audible sample for natural decay
    trail_samples = int(sr * min_trail_sec)
    cut_idx = min(last_sound_idx + trail_samples, len(data))

    if cut_idx >= len(data) - int(sr * 0.1):
        return wav_bytes  # nothing meaningful to trim

    trimmed = data[:cut_idx]

    # Apply a quick fade-out to avoid a click at the cut point
    fade_len = min(int(sr * 0.05), len(trimmed))
    if fade_len > 0:
        fade = np.linspace(1.0, 0.0, fade_len, dtype=np.float32)
        trimmed[-fade_len:] *= fade

    out_buf = io.BytesIO()
    sf.write(out_buf, trimmed, sr, format="WAV", subtype="PCM_16")
    return out_buf.getvalue()


def _split_text_by_emotion(text: str, default_emotion: str = "Regular") -> list[tuple[str, str]]:
    """Split text into (segment_text, emotion_label) pairs.

    Example:
        "Hello! (Excited) Wow, this is great! (Whisper) Keep it secret."
        → [("Hello!", "Regular"), ("Wow, this is great!", "Excited"),
           ("Keep it secret.", "Whisper")]
    """
    parts: list[tuple[str, str]] = []
    current_emotion = default_emotion
    last_end = 0

    for match in _EMOTION_TAG_RE.finditer(text):
        # Text before this emotion tag belongs to the previous emotion
        segment = text[last_end:match.start()].strip()
        if segment:
            parts.append((segment, current_emotion))
        current_emotion = match.group(1)
        last_end = match.end()

    # Remaining text after the last emotion tag
    remaining = text[last_end:].strip()
    if remaining:
        parts.append((remaining, current_emotion))

    return parts if parts else [(text.strip(), default_emotion)]


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

        # Check F5-TTS idle
        if (
            _f5tts_loaded
            and not _f5tts_loading
            and _f5tts_last_used > 0
            and (now - _f5tts_last_used) > _idle_timeout
        ):
            idle_secs = now - _f5tts_last_used
            log.info(
                f"F5-TTS model idle for {idle_secs:.0f}s "
                f"(threshold={_idle_timeout:.0f}s) — auto-unloading"
            )
            _unload_f5tts()


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

    @field_validator("ref_audio_path", mode="before")
    @classmethod
    def _validate_ref_audio_path(cls, v: Any) -> Any:
        if v is not None:
            s = str(v)
            if "\x00" in s or ".." in s:
                raise ValueError(f"Invalid ref_audio_path: {v}")
        return v

    ref_text: Optional[str] = Field(
        default=None,
        description="Verbatim transcript of the reference audio — Engine B only",
    )
    ref_language: str = Field(
        default="en",
        description="Language code for ref audio and synthesis text — Engine B",
    )
    top_p: float = Field(default=0.8, ge=0.1, le=1.0)
    temperature: float = Field(default=0.8, ge=0.1, le=2.0)
    text_split_method: str = Field(default="cut5")
    speed_factor: float = Field(default=1.0, ge=0.5, le=2.0)
    repetition_penalty: float = Field(default=1.35, ge=1.0, le=2.0)
    top_k: int = Field(default=12, ge=1, le=50)
    sample_steps: int = Field(default=32, ge=1, le=200)
    # Quality-enhancing parameters forwarded to GPT-SoVITS
    fragment_interval: float = Field(default=0.25, ge=0.01, le=1.0)
    parallel_infer: bool = Field(default=True)
    split_bucket: bool = Field(default=True)
    batch_threshold: float = Field(default=0.75, ge=0.1, le=1.0)
    seed: int = Field(default=-1)
    super_sampling: bool = Field(default=False)


class SwitchEngineRequest(BaseModel):
    """Request body for POST /switch_engine."""

    engine: Literal["kokoro", "sovits", "f5tts"] = Field(
        ...,
        description="Target TTS engine to activate ('kokoro', 'sovits', or 'f5tts')",
    )


class F5TTSClip(BaseModel):
    """A single reference audio clip with emotion label for F5-TTS."""

    emotion: str = Field(
        default="Regular",
        min_length=1,
        max_length=32,
        description="Emotion label (e.g. 'Regular', 'Excited', 'Whisper')",
    )
    ref_audio_path: str = Field(
        ...,
        description="Absolute path to the reference audio file",
    )

    @field_validator("ref_audio_path", mode="before")
    @classmethod
    def _validate_ref_audio_path(cls, v: Any) -> Any:
        s = str(v)
        if "\x00" in s or ".." in s:
            raise ValueError(f"Invalid ref_audio_path: {v}")
        return v

    ref_text: str = Field(
        ...,
        min_length=1,
        description="Verbatim transcript of the reference audio (required for duration estimation)",
    )


class F5TTSRequest(BaseModel):
    """Request body for F5-TTS synthesis (Engine C).

    Supports emotion-driven multi-clip voice cloning. Text can contain
    emotion tags like (Excited) or (Whisper) that switch the reference
    audio for each segment.
    """

    text: str = Field(
        ...,
        min_length=1,
        max_length=10000,
        description="Text to synthesize. May contain (EmotionName) tags.",
    )
    clips: list[F5TTSClip] = Field(
        ...,
        min_length=1,
        description="Reference audio clips with emotion labels. Must include at least one 'Regular' clip.",
    )
    # ── F5-TTS generation parameters ──
    steps: int = Field(default=8, ge=1, le=64, description="Diffusion steps")
    method: str = Field(
        default="rk4",
        description="ODE solver method: 'euler', 'midpoint', or 'rk4'",
    )
    cfg_strength: float = Field(
        default=1.0, ge=0.0, le=10.0,
        description="Classifier-free guidance strength (lower = cleaner, higher = more expressive but noisier)",
    )
    sway_sampling_coef: float = Field(
        default=-1.0, ge=-5.0, le=5.0,
        description="Sway sampling coefficient",
    )
    speed: float = Field(
        default=1.0, ge=0.25, le=2.0,
        description=(
            "Speaking speed factor for duration heuristic. "
            "1.0 = natural pace, <1 = slower (more natural for longer text), >1 = faster"
        ),
    )
    seed: Optional[int] = Field(
        default=None,
        description="Random seed for reproducibility",
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
    engines_available: list[str] = ["kokoro", "sovits", "f5tts"]
    sovits_url: str = ""
    sovits_reachable: bool = False
    # F5-TTS state (Engine C)
    f5tts_loaded: bool = False
    f5tts_loading: bool = False
    f5tts_available: bool = False


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
    _unload_f5tts()
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

# Epic #1115 — standardised sidecar error envelope.
import logging as _logging1115  # noqa: E402
import os as _os1115  # noqa: E402
import sys as _sys1115  # noqa: E402
_OZ_SHARED_DIR_1115 = _os1115.path.join(_os1115.path.dirname(_os1115.path.abspath(__file__)), "..", "_shared")
if _OZ_SHARED_DIR_1115 not in _sys1115.path:
    _sys1115.path.insert(0, _OZ_SHARED_DIR_1115)
from errors import register_error_handlers as _register_error_handlers_1115  # type: ignore[import-not-found]  # noqa: E402
_register_error_handlers_1115(app, logger=_logging1115.getLogger(__name__))


async def _probe_sovits(url: str, timeout_seconds: float = 2.0) -> bool:
    """Return True when GPT-SoVITS is reachable over HTTP.

    Probe /docs because api_v2.py does not expose /health.
    """
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.get(f"{url}/docs")
            return response.status_code < 500
    except Exception:
        return False


@app.get("/health", response_model=HealthResponse)
async def health():
    """Readiness probe. Returns model load states and active engine status."""
    is_loading = _tts_loading or _stt_loading or _f5tts_loading
    status = "loading" if is_loading else ("ok" if _ready else "starting")

    # Async probe of GPT-SoVITS reachability (non-blocking, 2s timeout)
    sovits_reachable = await _probe_sovits(_sovits_url, timeout_seconds=2.0)

    # Check if f5-tts-mlx is installed
    f5tts_available = False
    try:
        import f5_tts_mlx  # noqa: F401
        f5tts_available = True
    except ImportError:
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
        f5tts_loaded=_f5tts_loaded,
        f5tts_loading=_f5tts_loading,
        f5tts_available=f5tts_available,
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
    Switching to 'f5tts' unloads Kokoro; F5-TTS lazy-loads on next /f5tts request.
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
            # Unload Kokoro + F5-TTS to free VRAM before GPT-SoVITS
            if _tts_loaded:
                log.info("Unloading Kokoro (Engine A) before activating Engine B ...")
                _unload_tts()
            if _f5tts_loaded:
                log.info("Unloading F5-TTS (Engine C) before activating Engine B ...")
                _unload_f5tts()
            # Verify GPT-SoVITS is reachable before committing the switch
            if not await _probe_sovits(_sovits_url, timeout_seconds=5.0):
                raise HTTPException(
                    status_code=502,
                    detail=(
                        f"Cannot reach GPT-SoVITS at {_sovits_url}. "
                        "Start the GPT-SoVITS server before switching engines."
                    ),
                )
        elif req.engine == "f5tts":
            # Verify f5-tts-mlx is installed
            try:
                import f5_tts_mlx  # noqa: F401
            except ImportError:
                raise HTTPException(
                    status_code=400,
                    detail="f5-tts-mlx is not installed. Install with: pip install f5-tts-mlx",
                )
            # Unload Kokoro to free VRAM; F5-TTS lazy-loads on next request
            if _tts_loaded:
                log.info("Unloading Kokoro (Engine A) before activating Engine C ...")
                _unload_tts()
        else:
            # Switching to kokoro — unload F5-TTS if loaded
            if _f5tts_loaded:
                log.info("Unloading F5-TTS (Engine C) before activating Engine A ...")
                _unload_f5tts()

        _active_engine = req.engine
        _save_persisted_engine(_active_engine)
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
    sf.write(buf, audio_np, TTS_SAMPLE_RATE, format="WAV", subtype="PCM_16")
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


# GPT-SoVITS hard constraint: reference audio must be 3-10 seconds.
# Trim to 9s (not 10) because GPT-SoVITS uses an exclusive upper bound.
_SOVITS_REF_MAX_SECONDS = 9


def _probe_audio_duration(file_path: str) -> float | None:
    """Return audio duration in seconds using ffprobe, or None on failure."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                file_path,
            ],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return None
        duration = float(result.stdout.strip())
        return duration if duration > 0 else None
    except Exception:
        return None


def _trim_audio_to_max(file_path: str, max_seconds: float) -> tuple[str, bool]:
    """Ensure reference audio is WAV format and within max_seconds.

    Non-WAV files (webm, ogg, mp3, etc.) are always converted to WAV via ffmpeg.
    Files exceeding max_seconds are trimmed to the first max_seconds.

    Returns (path_to_use, is_temp). If is_temp is True the caller must
    delete the file after use.
    """
    # Validate file path before passing to subprocess
    file_path = validate_file_path(file_path)
    is_wav = file_path.lower().endswith(".wav")
    duration = _probe_audio_duration(file_path)
    needs_trim = duration is not None and duration > max_seconds

    # WAV files within the limit can be used directly
    if is_wav and not needs_trim:
        return file_path, False

    action = []
    if not is_wav:
        action.append("converting to WAV")
    if needs_trim:
        action.append(f"trimming {duration:.1f}s → {max_seconds}s")
    log.info(f"[Engine B] Preparing ref audio: {', '.join(action)}")

    fd, tmp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        cmd = ["ffmpeg", "-y", "-i", file_path]
        if needs_trim:
            cmd += ["-t", str(max_seconds)]
        cmd += ["-c:a", "pcm_s16le", "-ar", "44100", "-ac", "1", tmp_path]
        subprocess.run(cmd, capture_output=True, timeout=30, check=True)
        return tmp_path, True
    except Exception as e:
        log.warning(f"[Engine B] Audio preparation failed ({e}), using original file")
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return file_path, False


async def _synthesize_sovits(req: TTSRequest) -> Response:
    """Synthesize with Engine B (GPT-SoVITS via HTTP proxy). Internal helper."""
    if not req.ref_audio_path:
        raise HTTPException(
            status_code=400,
            detail="ref_audio_path is required when using GPT-SoVITS (Engine B).",
        )

    # Auto-trim long reference audio to satisfy GPT-SoVITS 3-10s constraint
    ref_path, is_temp = _trim_audio_to_max(req.ref_audio_path, _SOVITS_REF_MAX_SECONDS)

    payload = {
        "text": req.text,
        "text_lang": req.ref_language,
        "ref_audio_path": ref_path,
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
        "fragment_interval": req.fragment_interval,
        "parallel_infer": req.parallel_infer,
        "split_bucket": req.split_bucket,
        "batch_threshold": req.batch_threshold,
        "seed": req.seed,
        "super_sampling": req.super_sampling,
        "media_type": "wav",
        "streaming_mode": 0,
    }
    log.info(
        f"[Engine B] Proxying TTS to GPT-SoVITS @ {_sovits_url}: "
        f"text='{req.text[:80]}...' ref={ref_path}"
        f"{' (trimmed)' if is_temp else ''}"
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
    finally:
        if is_temp:
            try:
                os.unlink(ref_path)
            except OSError:
                pass


@app.post("/f5tts", response_class=Response)
async def synthesize_f5tts(req: F5TTSRequest):
    """Synthesize text to speech using F5-TTS (Engine C).

    Supports emotion-driven multi-clip voice cloning. Text can contain
    emotion tags like (Excited) that cause the engine to switch reference
    audio clips mid-stream. Each segment is generated separately and the
    resulting WAV buffers are concatenated.

    Returns 24kHz mono WAV audio.
    """
    global _f5tts_last_used

    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _f5tts_loading:
        raise HTTPException(status_code=409, detail="F5-TTS model is currently loading")

    # Validate at least one "Regular" clip exists
    clip_map: dict[str, F5TTSClip] = {}
    for clip in req.clips:
        clip_map[clip.emotion] = clip
    if "Regular" not in clip_map:
        raise HTTPException(
            status_code=400,
            detail="At least one clip with emotion='Regular' is required.",
        )

    # Lazy load F5-TTS model
    if not _f5tts_loaded:
        log.info("Lazy-loading F5-TTS (Engine C) ...")
        _load_f5tts()

    assert _f5tts_model is not None

    # Split text by emotion tags
    segments = _split_text_by_emotion(req.text, default_emotion="Regular")
    log.info(
        f"[Engine C] Synthesizing {len(segments)} segment(s): "
        f"text='{req.text[:80]}...' emotions={[s[1] for s in segments]}"
    )

    start = time.monotonic()
    wav_chunks: list[bytes] = []
    temp_files: list[str] = []

    try:
        from f5_tts_mlx.generate import generate

        # Mark as in-use BEFORE generation starts so the idle monitor
        # doesn't unload the model during a long synthesis run.
        _f5tts_last_used = time.monotonic()

        for segment_text, emotion_label in segments:
            if not segment_text.strip():
                continue

            # Find the matching clip; fall back to Regular
            clip = clip_map.get(emotion_label, clip_map["Regular"])

            # Convert reference audio to 24kHz mono WAV (capped at 10s)
            ref_path, ref_is_temp = _convert_to_24khz_mono_wav(clip.ref_audio_path)
            if ref_is_temp:
                temp_files.append(ref_path)

            # Split segment into individual sentences to avoid the upstream
            # f5-tts-mlx duration variable shadowing bug in the multi-sentence
            # loop of generate(). By passing one sentence at a time,
            # is_single_generation=True and the bug is bypassed.
            sentences = _split_sentences(segment_text)
            if not sentences:
                sentences = [segment_text.strip()]

            log.info(
                f"[Engine C] Segment ({emotion_label}): {len(sentences)} sentence(s)"
            )

            for sentence in sentences:
                # Generate to a temp output file
                fd, out_path = tempfile.mkstemp(suffix=".wav")
                os.close(fd)
                temp_files.append(out_path)

                # Cap the duration so F5-TTS doesn't over-generate.
                # estimate_duration uses ref-audio pace which can wildly
                # over-shoot for slow reference clips, producing hallucinated
                # gibberish after the real speech ends.
                max_dur = _estimate_max_duration(sentence)
                log.info(
                    f"[Engine C] Sentence ({len(sentence.split())} words, "
                    f"max {max_dur:.1f}s): '{sentence[:60]}...'"
                    if len(sentence) > 60
                    else f"[Engine C] Sentence ({len(sentence.split())} words, "
                    f"max {max_dur:.1f}s): '{sentence}'"
                )

                # NOTE: generate() is synchronous and blocks the event loop,
                # but MLX Metal is NOT thread-safe so we cannot use to_thread().
                generate(
                    generation_text=sentence,
                    duration=max_dur,
                    ref_audio_path=ref_path,
                    ref_audio_text=clip.ref_text,
                    steps=req.steps,
                    method=req.method,
                    cfg_strength=req.cfg_strength,
                    sway_sampling_coef=req.sway_sampling_coef,
                    speed=req.speed,
                    seed=req.seed,
                    output_path=out_path,
                )

                # Refresh timestamp after each sentence to prevent idle unload
                _f5tts_last_used = time.monotonic()

                # Read the generated WAV and trim trailing silence/hallucination
                with open(out_path, "rb") as f:
                    raw_wav = f.read()
                wav_chunks.append(_trim_trailing_silence(raw_wav))

        if not wav_chunks:
            raise HTTPException(status_code=500, detail="F5-TTS generation produced no audio")

        # Concatenate WAV chunks
        if len(wav_chunks) == 1:
            wav_bytes = wav_chunks[0]
        else:
            wav_bytes = _concatenate_wav_bytes(wav_chunks)

        elapsed = time.monotonic() - start
        _f5tts_last_used = time.monotonic()

        # Cache clips for /tts routing when f5tts is the active engine
        _cache_f5tts_clips(req.clips)

        log.info(
            f"[Engine C] Synthesized in {elapsed:.1f}s — "
            f"{len(wav_bytes)} bytes, {len(segments)} segment(s)"
        )

        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "X-Synthesis-Time": f"{elapsed:.2f}s",
                "X-Engine": "f5tts",
                "X-Sample-Rate": str(F5TTS_SAMPLE_RATE),
                "X-Segments": str(len(segments)),
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"[Engine C] F5-TTS synthesis failed: {e}")
        raise HTTPException(status_code=500, detail=f"F5-TTS synthesis failed: {str(e)}")
    finally:
        for tmp in temp_files:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def _cache_f5tts_clips(clips: list[F5TTSClip]) -> None:
    """Cache F5-TTS clips for /tts routing and persist to disk."""
    global _f5tts_cached_clips
    clip_dicts = [c.model_dump() for c in clips]
    _f5tts_cached_clips = clip_dicts
    _save_persisted_clips(clip_dicts)
    log.info(f"[Engine C] Cached {len(clip_dicts)} clip(s) for /tts routing")


@app.post("/f5tts/set-active-clips")
async def set_f5tts_active_clips(req: dict):
    """Set the cached F5-TTS clips used when /tts routes to f5tts.

    Called by the admin API when switching to f5tts or updating the active profile.
    Body: { clips: [{ emotion, ref_audio_path, ref_text }, ...] }
    """
    clips_raw = req.get("clips", [])
    if not isinstance(clips_raw, list) or len(clips_raw) == 0:
        raise HTTPException(status_code=400, detail="clips array is required and must be non-empty")
    try:
        clips = [F5TTSClip(**c) for c in clips_raw]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid clip data: {e}")
    has_regular = any(c.emotion == "Regular" for c in clips)
    if not has_regular:
        raise HTTPException(status_code=400, detail="At least one clip with emotion='Regular' is required")
    _cache_f5tts_clips(clips)
    return {"status": "ok", "clips_cached": len(clips)}


def _concatenate_wav_bytes(chunks: list[bytes]) -> bytes:
    """Concatenate multiple WAV byte buffers into a single WAV file.

    Applies a short crossfade between adjacent chunks to eliminate boundary
    clicks/pops caused by waveform discontinuities at splice points.
    """
    if len(chunks) == 0:
        return b""
    if len(chunks) == 1:
        return chunks[0]

    # Read all audio data using soundfile
    all_audio: list[np.ndarray] = []
    sample_rate = F5TTS_SAMPLE_RATE

    for chunk in chunks:
        buf = io.BytesIO(chunk)
        try:
            data, sr = sf.read(buf, dtype="float32")
            sample_rate = sr
            all_audio.append(data)
        except Exception as e:
            log.warning(f"[Engine C] Failed to read WAV chunk: {e}")
            continue

    if not all_audio:
        return chunks[0]

    # Crossfade between adjacent chunks to avoid boundary artifacts.
    # 20ms (~480 samples at 24kHz) is enough to smooth discontinuities
    # without audibly blurring word boundaries.
    crossfade_samples = min(int(sample_rate * 0.02), 480)
    combined = all_audio[0]
    for i in range(1, len(all_audio)):
        nxt = all_audio[i]
        overlap = min(crossfade_samples, len(combined), len(nxt))
        if overlap > 0:
            fade_out = np.linspace(1.0, 0.0, overlap, dtype=np.float32)
            fade_in = np.linspace(0.0, 1.0, overlap, dtype=np.float32)
            # Blend the overlapping region
            blended = combined[-overlap:] * fade_out + nxt[:overlap] * fade_in
            combined = np.concatenate([combined[:-overlap], blended, nxt[overlap:]])
        else:
            combined = np.concatenate([combined, nxt])

    out_buf = io.BytesIO()
    sf.write(out_buf, combined, sample_rate, format="WAV", subtype="PCM_16")
    return out_buf.getvalue()


@app.post("/tts", response_class=Response)
async def synthesize(req: TTSRequest):
    """Synthesize text to speech. Returns WAV audio.

    Routes to the active TTS engine:
    - Engine A (Kokoro): lazy-loaded MLX model, 54 voice presets, 24kHz output
    - Engine B (GPT-SoVITS): HTTP proxy to running GPT-SoVITS instance for voice cloning
    - Engine C (F5-TTS): emotion-driven voice cloning using cached clips

    Switch engines via POST /switch_engine.
    """
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")

    try:
        if _active_engine == "sovits":
            return await _synthesize_sovits(req)
        elif _active_engine == "f5tts":
            return await _synthesize_f5tts_via_cached_clips(req)
        else:
            return await _synthesize_kokoro(req)
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"TTS synthesis failed: {e}")
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {str(e)}")


async def _synthesize_f5tts_via_cached_clips(req: TTSRequest) -> Response:
    """Route a /tts request to F5-TTS using cached clips."""
    if not _f5tts_cached_clips:
        raise HTTPException(
            status_code=400,
            detail=(
                "F5-TTS is the active engine but no voice profile clips are cached. "
                "Use the Voice Lab to test an F5-TTS profile first, or switch to kokoro/sovits."
            ),
        )
    # Build an F5TTSRequest from the TTSRequest + cached clips
    f5_req = F5TTSRequest(
        text=req.text,
        clips=[F5TTSClip(**c) for c in _f5tts_cached_clips],
        speed=req.speed,
    )
    return await synthesize_f5tts(f5_req)


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
        model: Which model to unload — 'tts', 'stt', 'f5tts', or 'all' (default).
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

    if model in ("f5tts", "all"):
        if _f5tts_loaded:
            _unload_f5tts()
            result["f5tts"] = "unloaded"
        else:
            result["f5tts"] = "not_loaded"

    if model not in ("tts", "stt", "f5tts", "all"):
        raise HTTPException(
            status_code=400,
            detail=f"Unknown model: {model}. Use 'tts', 'stt', 'f5tts', or 'all'.",
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
        default=float(os.environ.get("AUDIO_IDLE_TIMEOUT", "300")),
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
