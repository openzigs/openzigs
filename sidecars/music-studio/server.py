"""
Music Studio Worker Sidecar — FastAPI
Issue #388 / #403: Orchestrates the 3-stage voice2voice pipeline:
  1. Stem separation (Demucs v4)      → extract_vocals.py
  2. Voice conversion (Seed-VC)        → apply_seedvc.py
  3. Final mixdown (pydub)             → mix_audio.py

HTTP API:
  POST /generate       — Submit a voice2voice job (returns 202)
  GET  /health         — Health check + busy status
  GET  /status/{job_id} — Poll job status and progress

Port: 5010 (default)
"""

import asyncio
import base64
import gc
import json
import logging
import os
import tempfile
import time
import traceback
import re as _re
from pathlib import Path
from typing import Any, Optional
from urllib.request import Request, urlopen
from urllib.error import URLError

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
import shutil
import uuid
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("music-studio-sidecar")


# ── Security Utilities ───────────────────────────────────────

_SHARED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared")
if _SHARED_DIR not in sys.path:
    sys.path.insert(0, _SHARED_DIR)
from callback_validator import validate_callback_url  # type: ignore[import-not-found]  # noqa: E402


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


def _safe_urlopen(url: str, data: bytes | None = None, timeout: int = 30) -> None:
    """urlopen wrapper that validates the URL first (SSRF protection)."""
    validate_callback_url(url)
    # Issue #1089 — sign callbacks with HMAC + timestamp.
    import sys as _sys
    _shared = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared")
    if _shared not in _sys.path:
        _sys.path.insert(0, _shared)
    from signed_callback import signed_headers as _sh  # type: ignore[import-not-found]
    _cb_secret = os.getenv("CALLBACK_SECRET") or None
    headers = _sh(_cb_secret, data or b"", "rvc", legacy_bearer=True)
    req = Request(url, data=data, headers=headers, method="POST")
    urlopen(req, timeout=timeout)


# ── Configuration ────────────────────────────────────────────

GALLERY_DIR = os.environ.get(
    "GALLERY_DIR",
    os.path.expanduser("~/.openzigs/gallery"),
)

VOICE_REFS_DIR = os.environ.get(
    "VOICE_REFS_DIR",
    os.path.expanduser("~/.openzigs/voice-references"),
)

AUTH_TOKEN: Optional[str] = os.environ.get("MUSIC_STUDIO_AUTH_TOKEN")


def _resolve_device() -> str:
    """Auto-detect compute device.

    Priority:
      1. MUSIC_STUDIO_DEVICE env var (explicit override)
      2. MPS on Apple Silicon (if torch is installed and MPS is available)
      3. CPU fallback
    """
    if env_device := os.environ.get("MUSIC_STUDIO_DEVICE"):
        return env_device
    try:
        import torch
        if torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


DEVICE = _resolve_device()

# Enable CPU fallback for MPS ops not yet fully supported by Metal kernels.
# Without this, certain Demucs / Seed-VC ops will raise a NotImplementedError
# instead of gracefully falling back to CPU.
if DEVICE == "mps":
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

# ── State ────────────────────────────────────────────────────

app = FastAPI(title="Music Studio Sidecar", version="1.0.0")

worker_state = {
    "is_busy": False,
    "current_job_id": None,
    "loaded_model": None,
}

# Job progress tracking: job_id → { stage, progress, message, status, result }
job_progress: dict[str, dict] = {}
MAX_STORED_JOBS = 50

# Idle tracking — updated after every job completion.
_last_job_time: float = 0.0
_idle_timeout = float(os.environ.get("MUSIC_STUDIO_IDLE_TIMEOUT", "0"))


def _post_job_cleanup() -> None:
    """Free PyTorch cached memory and run Python GC after each job.

    Demucs loads its model per-call (not cached between jobs), so there is no
    persistent model to unload.  Running gc + MPS/CUDA cache flush ensures
    any leftover tensor memory is returned to the OS promptly.
    """
    global _last_job_time
    _last_job_time = time.monotonic()
    try:
        import torch
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass
    gc.collect()


def cleanup_old_jobs():
    """Remove oldest finished jobs if we exceed the limit."""
    finished = [
        (jid, info) for jid, info in job_progress.items()
        if info.get("status") in ("complete", "failed")
    ]
    finished.sort(key=lambda x: x[1].get("completed_at", 0))
    while len(finished) > MAX_STORED_JOBS:
        oldest_id = finished.pop(0)[0]
        job_progress.pop(oldest_id, None)


# ── Request Models ───────────────────────────────────────────

class GenerateRequest(BaseModel):
    job_id: str
    source_asset_id: Optional[str] = None
    source_path: Optional[str] = None
    # Seed-VC: reference audio path instead of trained model
    voice_reference_id: Optional[str] = None
    voice_reference_path: Optional[str] = None
    # Legacy RVC field — ignored, kept for backward compat
    voice_model: str = "default"
    pitch_shift: int = 0
    diffusion_steps: int = Field(default=30, ge=4, le=200)
    f0_condition: bool = True  # True=singing (44.1kHz), False=speech (22kHz)
    vocal_volume: float = Field(default=1.0, ge=0.0, le=5.0)
    instrumental_volume: float = Field(default=1.0, ge=0.0, le=5.0)
    output_format: str = "wav"
    callback_url: Optional[str] = None
    progress_url: Optional[str] = None

    @field_validator("source_path", "voice_reference_path", mode="before")
    @classmethod
    def _validate_paths(cls, v: Any) -> Any:
        if v is not None:
            s = str(v)
            if "\x00" in s or ".." in s:
                raise ValueError(f"Invalid path: {v}")
        return v

    @field_validator("source_asset_id", "voice_reference_id", mode="before")
    @classmethod
    def _validate_ids(cls, v: Any) -> Any:
        if v is not None:
            s = str(v)
            if "\x00" in s or ".." in s or "/" in s or "\\" in s:
                raise ValueError(f"Invalid asset/reference ID: {v}")
        return v


# ── Pipeline ─────────────────────────────────────────────────

def report_progress(
    job_id: str,
    stage: str,
    progress: float,
    message: str,
    progress_url: Optional[str] = None,
):
    """Update local progress state and POST to the progress webhook."""
    job_progress[job_id] = {
        **job_progress.get(job_id, {}),
        "stage": stage,
        "progress": progress,
        "message": message,
        "status": "processing",
    }

    if progress_url:
        try:
            data = json.dumps({
                "job_id": job_id,
                "stage": stage,
                "progress": progress,
                "message": message,
            }).encode()
            _safe_urlopen(progress_url, data=data, timeout=5)
        except (URLError, OSError, ValueError) as e:
            logger.debug(f"Progress webhook failed: {e}")


def resolve_source_path(source_asset_id: Optional[str], source_path: Optional[str]) -> str:
    """Resolve the source audio file path from asset ID or direct path."""
    if source_path:
        p = Path(source_path)
        # Block path traversal
        resolved = p.resolve()
        if ".." in source_path or "\x00" in source_path:
            raise ValueError(f"Invalid source path: {source_path}")
        if not resolved.exists():
            raise FileNotFoundError(f"Source file not found: {source_path}")
        return str(resolved)

    if source_asset_id:
        # Look for the asset in the gallery directory
        gallery = Path(GALLERY_DIR)
        # Asset files are named with their job_id — use safe_join to prevent traversal
        for ext in [".wav", ".mp3", ".flac", ".m4a", ".ogg", ".mp4"]:
            candidate = safe_join(str(gallery), f"{source_asset_id}{ext}")
            if os.path.exists(candidate):
                return candidate
        # Also try matching files that contain the asset ID
        for f in gallery.iterdir():
            if source_asset_id in f.stem and f.suffix in (".wav", ".mp3", ".flac", ".m4a"):
                return str(f)
        raise FileNotFoundError(
            f"No audio file found for asset {source_asset_id} in {gallery}"
        )

    raise ValueError("Either source_asset_id or source_path is required")


def resolve_voice_reference(req: GenerateRequest) -> str:
    """Resolve voice reference audio path from ID or direct path."""
    if req.voice_reference_path:
        p = Path(req.voice_reference_path)
        resolved = p.resolve()
        if ".." in req.voice_reference_path or "\x00" in req.voice_reference_path:
            raise ValueError(f"Invalid reference path: {req.voice_reference_path}")
        if not resolved.exists():
            raise FileNotFoundError(f"Reference file not found: {req.voice_reference_path}")
        return str(resolved)

    if req.voice_reference_id:
        ref_dir = safe_join(VOICE_REFS_DIR, req.voice_reference_id)
        audio_file = os.path.join(ref_dir, "audio.wav")
        if os.path.exists(audio_file):
            return audio_file
        # Try any audio file in the reference directory
        for ext in [".wav", ".mp3", ".m4a", ".ogg", ".webm"]:
            candidates = list(Path(ref_dir).glob(f"*{ext}"))
            if candidates:
                return str(candidates[0])
        raise FileNotFoundError(
            f"No audio found for voice reference {req.voice_reference_id}"
        )

    raise ValueError("Either voice_reference_id or voice_reference_path is required")


def run_pipeline(req: GenerateRequest):
    """Execute the 3-stage voice2voice pipeline synchronously."""
    from extract_vocals import extract_vocals
    from apply_seedvc import apply_seedvc
    from mix_audio import mix_audio

    job_id = req.job_id
    progress_url = req.progress_url

    with tempfile.TemporaryDirectory(prefix=f"v2v-{job_id}-") as tmpdir:
        # ── Stage 1: Stem Separation ──
        report_progress(job_id, "stem_separation", 0, "Starting stem separation...", progress_url)

        source_path = resolve_source_path(req.source_asset_id, req.source_path)
        stems_dir = os.path.join(tmpdir, "stems")

        stems = extract_vocals(
            input_path=source_path,
            output_dir=stems_dir,
            device=DEVICE,
        )

        report_progress(job_id, "stem_separation", 100, "Stem separation complete", progress_url)

        # ── Stage 2: Voice Conversion (Seed-VC) ──
        report_progress(job_id, "voice_conversion", 0, "Starting Seed-VC voice conversion...", progress_url)

        reference_path = resolve_voice_reference(req)
        converted_path = os.path.join(tmpdir, "converted_vocals.wav")
        apply_seedvc(
            input_path=stems["vocals"],
            output_path=converted_path,
            reference_path=reference_path,
            pitch_shift=req.pitch_shift,
            diffusion_steps=req.diffusion_steps,
            f0_condition=req.f0_condition,
            device=DEVICE,
        )

        report_progress(job_id, "voice_conversion", 100, "Voice conversion complete", progress_url)

        # ── Stage 3: Final Mixdown ──
        report_progress(job_id, "mixdown", 0, "Starting mixdown...", progress_url)

        output_ext = "mp3" if req.output_format == "mp3" else "wav"
        output_path = os.path.join(tmpdir, f"final_mix.{output_ext}")

        mix_audio(
            vocals_path=converted_path,
            instrumental_path=stems["no_vocals"],
            output_path=output_path,
            vocal_volume=req.vocal_volume,
            instrumental_volume=req.instrumental_volume,
            output_format=req.output_format,
        )

        report_progress(job_id, "mixdown", 100, "Mixdown complete", progress_url)

        # Copy output to gallery dir (avoids base64-encoding multi-MB files)
        os.makedirs(GALLERY_DIR, exist_ok=True)
        gallery_filename = f"{job_id}.{output_ext}"
        gallery_path = os.path.join(GALLERY_DIR, gallery_filename)
        shutil.copy2(output_path, gallery_path)
        file_size = os.path.getsize(gallery_path)

        media_type = "audio/mpeg" if output_ext == "mp3" else "audio/wav"

        return {
            "file_path": gallery_path,
            "media_type": media_type,
            "metadata": {
                "voice_model": req.voice_model,
                "pitch_shift": req.pitch_shift,
                "output_format": req.output_format,
                "file_size": file_size,
            },
        }


async def process_job(req: GenerateRequest):
    """Run the pipeline in a background thread and POST results via callback."""
    job_id = req.job_id

    try:
        worker_state["is_busy"] = True
        worker_state["current_job_id"] = job_id
        worker_state["loaded_model"] = req.voice_model

        job_progress[job_id] = {
            "stage": "queued",
            "progress": 0,
            "message": "Job accepted",
            "status": "processing",
            "started_at": time.time(),
        }

        # Run pipeline in thread pool to avoid blocking the event loop
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, run_pipeline, req)

        job_progress[job_id] = {
            **job_progress[job_id],
            "stage": "complete",
            "progress": 100,
            "message": "Pipeline complete",
            "status": "complete",
            "completed_at": time.time(),
        }

        # POST result to callback (file-based — only sends path, not content)
        if req.callback_url:
            try:
                data = json.dumps({
                    "job_id": job_id,
                    "status": "complete",
                    "file_path": result["file_path"],
                    "media_type": result["media_type"],
                    "metadata": result["metadata"],
                }).encode()
                _safe_urlopen(req.callback_url, data=data, timeout=30)
                logger.info(f"Callback sent for job {job_id}")
            except (URLError, OSError, ValueError) as e:
                logger.error(f"Callback failed for job {job_id}: {e}")

    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        logger.error(f"Pipeline failed for job {job_id}: {error_msg}")
        logger.error(traceback.format_exc())

        job_progress[job_id] = {
            **job_progress.get(job_id, {}),
            "stage": "failed",
            "progress": 0,
            "message": error_msg,
            "status": "failed",
            "completed_at": time.time(),
        }

        # POST failure to callback
        if req.callback_url:
            try:
                data = json.dumps({
                    "job_id": job_id,
                    "status": "failed",
                    "error": error_msg,
                }).encode()
                _safe_urlopen(req.callback_url, data=data, timeout=10)
            except (URLError, OSError, ValueError):
                pass

    finally:
        worker_state["is_busy"] = False
        worker_state["current_job_id"] = None
        cleanup_old_jobs()
        _post_job_cleanup()


# ── Endpoints ────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Health check — also returns busy status for queue master polling."""
    idle_secs = (time.monotonic() - _last_job_time) if _last_job_time > 0 else None
    return {
        "status": "ok",
        "is_busy": worker_state["is_busy"],
        "loaded_model": worker_state["loaded_model"],
        "current_job_id": worker_state["current_job_id"],
        "device": DEVICE,
        "idle_seconds": round(idle_secs, 1) if idle_secs is not None else None,
        "idle_timeout": _idle_timeout if _idle_timeout > 0 else None,
    }


@app.post("/generate", status_code=202)
async def generate(req: GenerateRequest):
    """
    Submit a voice2voice pipeline job.
    Returns 202 immediately; results are POSTed to callback_url.
    """
    if worker_state["is_busy"]:
        raise HTTPException(
            status_code=409,
            detail=f"Worker busy with job {worker_state['current_job_id']}",
        )

    # Validate source exists before accepting
    try:
        resolve_source_path(req.source_asset_id, req.source_path)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Validate voice reference exists
    try:
        resolve_voice_reference(req)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Fire and forget — job runs in background
    asyncio.create_task(process_job(req))

    return {
        "job_id": req.job_id,
        "status": "accepted",
        "message": "Voice2voice pipeline started",
    }


@app.get("/status/{job_id}")
async def job_status(job_id: str):
    """Get the current progress of a job."""
    if job_id not in job_progress:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    return {
        "job_id": job_id,
        **job_progress[job_id],
    }


@app.get("/models")
async def list_models():
    """List available voice references (Seed-VC — zero-shot, no trained models)."""
    refs_dir = Path(VOICE_REFS_DIR)
    if not refs_dir.exists():
        return {"models": [], "voice_references": []}

    references = []
    for d in refs_dir.iterdir():
        if d.is_dir():
            audio_file = d / "audio.wav"
            meta_file = d / "metadata.json"
            if audio_file.exists():
                meta = {}
                if meta_file.exists():
                    try:
                        meta = json.loads(meta_file.read_text())
                    except (json.JSONDecodeError, OSError):
                        pass
                references.append({
                    "id": d.name,
                    "name": meta.get("name", d.name),
                    "duration": meta.get("duration", 0),
                    "created": meta.get("created", ""),
                    "path": str(d),
                })

    # Return both for backward compat (models=[]) and new format
    return {"models": [], "voice_references": references}


# ── Voice Reference CRUD ─────────────────────────────────────

class VoiceReferenceUpload(BaseModel):
    """Metadata for a newly uploaded voice reference."""
    name: str = "Untitled"


@app.get("/voice-references")
async def list_voice_references():
    """List all saved voice reference clips."""
    refs_dir = Path(VOICE_REFS_DIR)
    if not refs_dir.exists():
        return {"references": []}

    references = []
    for d in sorted(refs_dir.iterdir()):
        if not d.is_dir():
            continue
        audio_file = d / "audio.wav"
        meta_file = d / "metadata.json"
        if not audio_file.exists():
            continue
        meta = {}
        if meta_file.exists():
            try:
                meta = json.loads(meta_file.read_text())
            except (json.JSONDecodeError, OSError):
                pass
        references.append({
            "id": d.name,
            "name": meta.get("name", d.name),
            "duration": meta.get("duration", 0),
            "sample_rate": meta.get("sample_rate", 0),
            "created": meta.get("created", ""),
        })

    return {"references": references}


@app.post("/voice-references")
async def upload_voice_reference(
    name: str = "Untitled",
    file: bytes = None,
):
    """Upload a new voice reference audio clip.

    Accepts raw audio bytes in the request body.
    The audio is validated (1-30s), converted to WAV 44.1kHz mono,
    and saved with a unique ID.
    """
    from fastapi import UploadFile, File as FastAPIFile, Form
    # This endpoint is called via multipart in practice;
    # see the /voice-references/upload endpoint below for the full impl.
    raise HTTPException(status_code=400, detail="Use /voice-references/upload")


from fastapi import UploadFile, File as FastAPIFile, Form


@app.post("/voice-references/upload")
async def upload_voice_reference_multipart(
    file: UploadFile = FastAPIFile(...),
    name: str = Form("Untitled"),
):
    """Upload a voice reference audio file (multipart form data)."""
    import soundfile as sf
    import librosa
    import numpy as np

    refs_dir = Path(VOICE_REFS_DIR)
    refs_dir.mkdir(parents=True, exist_ok=True)

    ref_id = str(uuid.uuid4())
    ref_dir = refs_dir / ref_id
    ref_dir.mkdir(parents=True, exist_ok=True)

    # Save uploaded file temporarily
    tmp_path = ref_dir / f"upload{Path(file.filename or 'audio.wav').suffix}"
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:  # 50MB limit
        shutil.rmtree(str(ref_dir), ignore_errors=True)
        raise HTTPException(status_code=400, detail="File too large (max 50MB)")
    tmp_path.write_bytes(content)

    try:
        # Load and validate audio
        audio, sr = librosa.load(str(tmp_path), sr=44100, mono=True)
        duration = len(audio) / sr

        if duration < 1.0:
            raise HTTPException(
                status_code=400,
                detail=f"Audio too short ({duration:.1f}s). Minimum 1 second."
            )
        if duration > 30.0:
            # Trim to 30 seconds
            logger.warning(f"Reference audio {duration:.1f}s exceeds 30s, trimming")
            audio = audio[:int(30.0 * sr)]
            duration = 30.0

        # Trim silence from edges
        trimmed, _ = librosa.effects.trim(audio, top_db=30)
        if len(trimmed) / sr >= 1.0:
            audio = trimmed
            duration = len(audio) / sr

        # Normalize volume
        peak = np.max(np.abs(audio))
        if peak > 0:
            audio = audio * (0.95 / peak)

        # Save as WAV
        audio_path = ref_dir / "audio.wav"
        sf.write(str(audio_path), audio, sr)

        # Save metadata
        import time as _time
        metadata = {
            "name": name,
            "duration": round(duration, 2),
            "sample_rate": sr,
            "created": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
        }
        (ref_dir / "metadata.json").write_text(json.dumps(metadata, indent=2))

        # Clean up temp upload
        if tmp_path.exists() and tmp_path.name != "audio.wav":
            tmp_path.unlink()

        return {
            "id": ref_id,
            "name": name,
            "duration": round(duration, 2),
            "sample_rate": sr,
            "created": metadata["created"],
        }

    except HTTPException:
        raise
    except Exception as e:
        shutil.rmtree(str(ref_dir), ignore_errors=True)
        raise HTTPException(
            status_code=400,
            detail=f"Failed to process audio: {e}"
        )


@app.get("/voice-references/{ref_id}")
async def get_voice_reference(ref_id: str):
    """Get metadata for a specific voice reference."""
    ref_dir = safe_join(VOICE_REFS_DIR, ref_id)
    meta_file = os.path.join(ref_dir, "metadata.json")
    if not os.path.isdir(ref_dir) or not os.path.isfile(meta_file):
        raise HTTPException(status_code=404, detail="Voice reference not found")

    meta = json.loads(Path(meta_file).read_text())
    return {"id": ref_id, **meta}


@app.get("/voice-references/{ref_id}/audio")
async def get_voice_reference_audio(ref_id: str):
    """Stream the voice reference audio file."""
    from fastapi.responses import FileResponse
    audio_path = os.path.join(safe_join(VOICE_REFS_DIR, ref_id), "audio.wav")
    if not os.path.exists(audio_path):
        raise HTTPException(status_code=404, detail="Voice reference audio not found")
    return FileResponse(audio_path, media_type="audio/wav")


@app.patch("/voice-references/{ref_id}")
async def update_voice_reference(ref_id: str, name: str = None):
    """Update voice reference metadata (e.g. rename)."""
    ref_dir = safe_join(VOICE_REFS_DIR, ref_id)
    meta_file = os.path.join(ref_dir, "metadata.json")
    if not os.path.isdir(ref_dir) or not os.path.isfile(meta_file):
        raise HTTPException(status_code=404, detail="Voice reference not found")

    meta = json.loads(Path(meta_file).read_text())
    if name is not None:
        meta["name"] = name
    Path(meta_file).write_text(json.dumps(meta, indent=2))
    return {"id": ref_id, **meta}


@app.delete("/voice-references/{ref_id}")
async def delete_voice_reference(ref_id: str):
    """Delete a voice reference."""
    ref_dir = Path(VOICE_REFS_DIR) / ref_id
    if not ref_dir.exists():
        raise HTTPException(status_code=404, detail="Voice reference not found")
    shutil.rmtree(str(ref_dir), ignore_errors=True)
    return {"deleted": ref_id}


# ── Remix Lab Endpoints ──────────────────────────────────────
# Issue #389: Smart Remix Lab — 6-stem analysis, instrument
# replacement, smart mix, and auto-mastering.

REMIX_DIR = os.environ.get(
    "REMIX_DIR",
    os.path.expanduser("~/.openzigs/remix"),
)


class RemixAnalyzeRequest(BaseModel):
    """Request body for track analysis (stem separation + BPM/key)."""
    job_id: str
    source_path: Optional[str] = None
    source_asset_id: Optional[str] = None
    callback_url: Optional[str] = None
    progress_url: Optional[str] = None
    device: str = "cpu"

    @field_validator("source_path", mode="before")
    @classmethod
    def _validate_source_path(cls, v: Any) -> Any:
        if v is not None:
            s = str(v)
            if "\x00" in s or ".." in s:
                raise ValueError(f"Invalid source path: {v}")
        return v

    @field_validator("source_asset_id", mode="before")
    @classmethod
    def _validate_source_asset_id(cls, v: Any) -> Any:
        if v is not None:
            s = str(v)
            if "\x00" in s or ".." in s or "/" in s or "\\" in s:
                raise ValueError(f"Invalid asset ID: {v}")
        return v


class RemixReplaceStemRequest(BaseModel):
    """Request body for melody-preserving instrument replacement."""
    job_id: str
    source_stem_url: str = Field(
        ..., description="Path to the isolated stem WAV"
    )
    target_instrument_id: str = Field(
        ..., description="Instrument ID (e.g. '80s_analog_synth')"
    )
    original_bpm: Optional[float] = None
    original_key: Optional[str] = None
    callback_url: Optional[str] = None
    progress_url: Optional[str] = None

    @field_validator("source_stem_url", mode="before")
    @classmethod
    def _validate_source_stem_url(cls, v: Any) -> Any:
        s = str(v)
        if "\x00" in s or ".." in s:
            raise ValueError(f"Invalid stem path: {v}")
        return v


class RemixMasterRequest(BaseModel):
    """Request body for final mixdown + auto-mastering."""
    job_id: str
    stem_paths: dict[str, str] = Field(
        ..., description="Mapping: stem_name → WAV file path"
    )
    volumes: dict[str, float] = Field(
        default_factory=dict,
        description="Mapping: stem_name → volume (0.0–2.0)"
    )
    muted: dict[str, bool] = Field(
        default_factory=dict,
        description="Mapping: stem_name → muted boolean"
    )
    vibe: str = Field(
        default="raw",
        description="Vibe preset: punchy_pop, warm_lofi, cinematic_wide, raw"
    )
    skip_mastering: bool = Field(
        default=False,
        description="If true, mix stems only (no auto-mastering). Used for quick save."
    )
    callback_url: Optional[str] = None
    progress_url: Optional[str] = None

    @field_validator("stem_paths", mode="before")
    @classmethod
    def _validate_stem_paths(cls, v: Any) -> Any:
        if isinstance(v, dict):
            for key, path in v.items():
                s = str(path)
                if "\x00" in s or ".." in s:
                    raise ValueError(f"Invalid stem path for {key}: {path}")
        return v


async def _run_remix_analyze(req: RemixAnalyzeRequest):
    """Background task: run 6-stem analysis pipeline."""
    job_id = req.job_id
    try:
        worker_state["is_busy"] = True
        worker_state["current_job_id"] = job_id
        job_progress[job_id] = {
            "stage": "analyzing",
            "progress": 0,
            "message": "Starting track analysis...",
            "status": "processing",
            "started_at": time.time(),
        }

        report_progress(
            job_id, "analyzing", 10,
            "Separating stems and detecting BPM/key...",
            req.progress_url,
        )

        source_path = resolve_source_path(
            req.source_asset_id, req.source_path
        )

        # Run analysis in thread pool
        from analyze_track import analyze_track as _analyze
        loop = asyncio.get_event_loop()

        stems_dir = os.path.join(REMIX_DIR, job_id, "stems")
        os.makedirs(stems_dir, exist_ok=True)

        result = await loop.run_in_executor(
            None, _analyze, source_path, stems_dir,
            "htdemucs_6s", DEVICE,
        )

        report_progress(
            job_id, "complete", 100,
            "Analysis complete",
            req.progress_url,
        )

        job_progress[job_id] = {
            **job_progress[job_id],
            "stage": "complete",
            "progress": 100,
            "message": "Analysis complete",
            "status": "complete",
            "result": result,
            "completed_at": time.time(),
        }

        if req.callback_url:
            try:
                data = json.dumps({
                    "job_id": job_id,
                    "status": "complete",
                    "type": "remix_analyze",
                    **result,
                }).encode()
                _safe_urlopen(req.callback_url, data=data, timeout=30)
            except (URLError, OSError, ValueError) as e:
                logger.error(f"Analyze callback failed: {e}")

    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        logger.error(f"Analyze failed for {job_id}: {error_msg}")
        job_progress[job_id] = {
            **job_progress.get(job_id, {}),
            "stage": "failed",
            "message": error_msg,
            "status": "failed",
            "completed_at": time.time(),
        }
        if req.callback_url:
            try:
                data = json.dumps({
                    "job_id": job_id,
                    "status": "failed",
                    "error": error_msg,
                }).encode()
                _safe_urlopen(req.callback_url, data=data, timeout=10)
            except (URLError, OSError, ValueError):
                pass
    finally:
        worker_state["is_busy"] = False
        worker_state["current_job_id"] = None
        cleanup_old_jobs()
        _post_job_cleanup()


async def _run_remix_replace(req: RemixReplaceStemRequest):
    """Background task: melody-preserving instrument replacement."""
    job_id = req.job_id
    try:
        worker_state["is_busy"] = True
        worker_state["current_job_id"] = job_id
        job_progress[job_id] = {
            "stage": "replacing",
            "progress": 0,
            "message": "Starting instrument replacement...",
            "status": "processing",
            "started_at": time.time(),
        }

        report_progress(
            job_id, "replacing", 10,
            f"Replacing with {req.target_instrument_id}...",
            req.progress_url,
        )

        from replace_instrument import replace_instrument as _replace
        loop = asyncio.get_event_loop()

        output_dir = os.path.join(REMIX_DIR, job_id)
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(
            output_dir,
            f"replaced_{req.target_instrument_id}.wav"
        )

        await loop.run_in_executor(
            None, _replace,
            req.source_stem_url,
            req.target_instrument_id,
            output_path,
            req.original_bpm,
            req.original_key,
        )

        report_progress(
            job_id, "complete", 100,
            "Replacement complete",
            req.progress_url,
        )

        result = {"replaced_stem_path": output_path}
        job_progress[job_id] = {
            **job_progress[job_id],
            "stage": "complete",
            "progress": 100,
            "message": "Replacement complete",
            "status": "complete",
            "result": result,
            "completed_at": time.time(),
        }

        if req.callback_url:
            try:
                data = json.dumps({
                    "job_id": job_id,
                    "status": "complete",
                    "type": "remix_replace",
                    **result,
                }).encode()
                _safe_urlopen(req.callback_url, data=data, timeout=30)
            except (URLError, OSError, ValueError) as e:
                logger.error(f"Replace callback failed: {e}")

    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        logger.error(f"Replace failed for {job_id}: {error_msg}")
        job_progress[job_id] = {
            **job_progress.get(job_id, {}),
            "stage": "failed",
            "message": error_msg,
            "status": "failed",
            "completed_at": time.time(),
        }
        if req.callback_url:
            try:
                data = json.dumps({
                    "job_id": job_id,
                    "status": "failed",
                    "error": error_msg,
                }).encode()
                _safe_urlopen(req.callback_url, data=data, timeout=10)
            except (URLError, OSError, ValueError):
                pass
    finally:
        worker_state["is_busy"] = False
        worker_state["current_job_id"] = None
        cleanup_old_jobs()
        _post_job_cleanup()


async def _run_remix_master(req: RemixMasterRequest):
    """Background task: smart mix + auto-mastering pipeline."""
    job_id = req.job_id
    try:
        worker_state["is_busy"] = True
        worker_state["current_job_id"] = job_id
        job_progress[job_id] = {
            "stage": "mixing",
            "progress": 0,
            "message": "Starting mix & master...",
            "status": "processing",
            "started_at": time.time(),
        }

        report_progress(
            job_id, "mixing", 10, "Mixing stems...",
            req.progress_url,
        )

        from smart_mix import smart_mix as _mix
        from finalize import finalize as _finalize
        loop = asyncio.get_event_loop()

        output_dir = os.path.join(REMIX_DIR, job_id)
        os.makedirs(output_dir, exist_ok=True)

        mixed_path = os.path.join(output_dir, "mixed.wav")
        await loop.run_in_executor(
            None, _mix,
            req.stem_paths, req.volumes, req.muted,
            req.vibe, mixed_path,
        )

        if req.skip_mastering:
            # Quick mix mode — skip auto-mastering, save mixed output directly
            report_progress(
                job_id, "complete", 100,
                "Quick mix complete",
                req.progress_url,
            )
            master_path = mixed_path
        else:
            report_progress(
                job_id, "mastering", 60,
                "Auto-mastering...",
                req.progress_url,
            )

            master_path = os.path.join(
                output_dir, "remixed_master.wav"
            )
            await loop.run_in_executor(
                None, _finalize,
                mixed_path, master_path, req.vibe,
            )

            report_progress(
                job_id, "complete", 100,
                "Mix & master complete",
                req.progress_url,
            )

        # Copy master to gallery dir (avoids base64-encoding multi-MB files)
        os.makedirs(GALLERY_DIR, exist_ok=True)
        gallery_filename = f"{job_id}.wav"
        gallery_path = os.path.join(GALLERY_DIR, gallery_filename)
        shutil.copy2(master_path, gallery_path)

        result = {
            "master_path": master_path,
            "file_path": gallery_path,
            "media_type": "audio/wav",
        }
        job_progress[job_id] = {
            **job_progress[job_id],
            "stage": "complete",
            "progress": 100,
            "message": "Mix & master complete",
            "status": "complete",
            "result": result,
            "completed_at": time.time(),
        }

        if req.callback_url:
            try:
                data = json.dumps({
                    "job_id": job_id,
                    "status": "complete",
                    "type": "remix_master",
                    "file_path": gallery_path,
                    "media_type": "audio/wav",
                    "metadata": {
                        "vibe": req.vibe,
                    },
                }).encode()
                _safe_urlopen(req.callback_url, data=data, timeout=30)
            except (URLError, OSError, ValueError) as e:
                logger.error(f"Master callback failed: {e}")

    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        logger.error(f"Master failed for {job_id}: {error_msg}")
        job_progress[job_id] = {
            **job_progress.get(job_id, {}),
            "stage": "failed",
            "message": error_msg,
            "status": "failed",
            "completed_at": time.time(),
        }
        if req.callback_url:
            try:
                data = json.dumps({
                    "job_id": job_id,
                    "status": "failed",
                    "error": error_msg,
                }).encode()
                _safe_urlopen(req.callback_url, data=data, timeout=10)
            except (URLError, OSError, ValueError):
                pass
    finally:
        worker_state["is_busy"] = False
        worker_state["current_job_id"] = None
        cleanup_old_jobs()
        _post_job_cleanup()


@app.post("/remix/analyze", status_code=202)
async def remix_analyze(req: RemixAnalyzeRequest):
    """Submit a track analysis job (6-stem split + BPM/key detection).

    Returns 202 immediately; results via callback or polling.
    """
    if worker_state["is_busy"]:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Worker busy with job "
                f"{worker_state['current_job_id']}"
            ),
        )

    try:
        resolve_source_path(req.source_asset_id, req.source_path)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))

    asyncio.create_task(_run_remix_analyze(req))
    return {"job_id": req.job_id, "status": "accepted"}


@app.post("/remix/replace-stem", status_code=202)
async def remix_replace_stem(req: RemixReplaceStemRequest):
    """Submit a melody-preserving instrument replacement job.

    Returns 202 immediately; results via callback or polling.
    """
    if worker_state["is_busy"]:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Worker busy with job "
                f"{worker_state['current_job_id']}"
            ),
        )

    if not os.path.isfile(req.source_stem_url):
        raise HTTPException(
            status_code=400,
            detail=f"Source stem not found: {req.source_stem_url}",
        )

    asyncio.create_task(_run_remix_replace(req))
    return {"job_id": req.job_id, "status": "accepted"}


@app.post("/remix/master", status_code=202)
async def remix_master(req: RemixMasterRequest):
    """Submit a mix & master job.

    Returns 202 immediately; results via callback or polling.
    """
    if worker_state["is_busy"]:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Worker busy with job "
                f"{worker_state['current_job_id']}"
            ),
        )

    # Validate stem paths exist
    for name, path in req.stem_paths.items():
        if not os.path.isfile(path):
            raise HTTPException(
                status_code=400,
                detail=f"Stem '{name}' not found: {path}",
            )

    asyncio.create_task(_run_remix_master(req))
    return {"job_id": req.job_id, "status": "accepted"}


# ── Main ─────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Music Studio Sidecar")
    parser.add_argument("--port", type=int, default=5010, help="Port (default: 5010)")
    parser.add_argument("--host", default="0.0.0.0", help="Host (default: 0.0.0.0)")
    parser.add_argument(
        "--idle-timeout",
        type=float,
        default=float(os.environ.get("MUSIC_STUDIO_IDLE_TIMEOUT", "0")),
        help=(
            "Seconds of inactivity before logging an idle warning "
            "(0 = disabled, env: MUSIC_STUDIO_IDLE_TIMEOUT). "
            "Unlike image-gen/audio, music-studio does not hold models in RAM "
            "between jobs, so this is informational only."
        ),
    )
    args = parser.parse_args()

    _idle_timeout = args.idle_timeout

    logger.info(f"Starting Music Studio sidecar on {args.host}:{args.port}")
    logger.info(f"Gallery dir: {GALLERY_DIR}")
    logger.info(f"Voice references dir: {VOICE_REFS_DIR}")
    logger.info(f"Device: {DEVICE}")

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
