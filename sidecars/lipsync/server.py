"""
LatentSync Lip Sync Sidecar — FastAPI (MPS / CPU)
Issue #798: AI lip sync using LatentSync model for video + audio alignment.

HTTP API:
  POST /generate        — Submit a lip-sync job (returns 202)
  GET  /health          — Health check + busy status
  GET  /status/{job_id} — Poll job status and progress
  POST /unload-model    — Unload model from memory

Port: 5012 (default — canonical lip-sync port across MPS and CUDA, issue #1104)
"""

import asyncio
import base64
import gc
import json
import logging
import os
import re
import tempfile
import time
import traceback
import subprocess
import shutil
import uuid
from pathlib import Path
from typing import Any, Optional
from urllib.request import Request, urlopen
from urllib.error import URLError

from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("lipsync-sidecar")


# ── Security Utilities ───────────────────────────────────────

# Job ID must be a UUID (hex + hyphens) — reject anything else.
_JOB_ID_RE = re.compile(r"^[a-fA-F0-9\-]{1,64}$")

# Valid model versions — strict allowlist used before any path construction.
_VALID_MODEL_VERSIONS = frozenset({"v1.5", "v1.6"})


def _validate_job_id(job_id: str) -> str:
    """Ensure job_id is safe to use in filenames and URLs."""
    if not _JOB_ID_RE.match(job_id):
        raise ValueError(f"Invalid job_id format: {job_id!r}")
    return job_id


def _validate_model_version(v: str) -> str:
    """Ensure model_version is in the strict allowlist."""
    if v not in _VALID_MODEL_VERSIONS:
        raise ValueError(f"Invalid model_version: {v!r}. Must be one of {_VALID_MODEL_VERSIONS}")
    return v


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


def _post_to_callback(endpoint_url: str, data: bytes, timeout: int = 30) -> None:
    """POST data to a server-configured callback URL (not user-supplied)."""
    # Issue #1089 — sign callbacks with HMAC + timestamp.
    # Look in the script's own directory first (standalone/deployed) then fall
    # back to the repo's sidecars/_shared/ for in-tree runs.
    import sys as _sys
    _own_dir = os.path.dirname(os.path.abspath(__file__))
    _shared = os.path.join(_own_dir, "..", "_shared")
    for _p in (_own_dir, _shared):
        if _p not in _sys.path:
            _sys.path.insert(0, _p)
    from signed_callback import signed_headers as _sh  # type: ignore[import-not-found]
    _cb_secret = os.getenv("CALLBACK_SECRET") or None
    headers = _sh(_cb_secret, data, "lip-sync", legacy_bearer=True)
    req = Request(endpoint_url, data=data, headers=headers, method="POST")
    urlopen(req, timeout=timeout)


# ── Configuration ────────────────────────────────────────────

GALLERY_DIR = os.environ.get(
    "GALLERY_DIR",
    os.path.expanduser("~/.openzigs/gallery"),
)

AUTH_TOKEN: Optional[str] = os.environ.get("LIPSYNC_SECRET_TOKEN")
MODEL_IDLE_TIMEOUT = float(os.environ.get("LIPSYNC_MODEL_IDLE_TIMEOUT", "300"))
MEMORY_LIMIT_GB = float(os.environ.get("LIPSYNC_MEMORY_LIMIT_GB", "24"))
DEFAULT_MODEL = os.environ.get("LIPSYNC_DEFAULT_MODEL", "v1.5")


def _detect_host_ram_gb() -> float:
    """Issue #1106: detect total system RAM in GB so /generate can refuse
    LatentSync v1.6 on hosts that cannot fit it (~18 GB resident).

    OPENZIGS_FORCE_RAM_GB overrides the detected value for tests and for
    operators who want to force the gate one way or the other on a node
    with non-standard memory accounting.
    """
    forced = os.environ.get("OPENZIGS_FORCE_RAM_GB")
    if forced:
        try:
            return float(forced)
        except ValueError:
            logger.warning("OPENZIGS_FORCE_RAM_GB=%r is not numeric — ignoring", forced)
    try:
        import psutil  # type: ignore[import-not-found]

        return psutil.virtual_memory().total / (1024 ** 3)
    except Exception as exc:  # pragma: no cover — psutil missing only in sandbox tests
        logger.warning("Unable to detect host RAM via psutil (%s) — assuming 0", exc)
        return 0.0


HOST_RAM_GB: float = _detect_host_ram_gb()
logger.info("Detected host RAM: %.1f GB (gate threshold for v1.6 = %.1f GB)", HOST_RAM_GB, MEMORY_LIMIT_GB)

# Callback URLs are server-configured only (not user-supplied) to prevent SSRF.
CALLBACK_URL: str = os.environ.get("CALLBACK_URL", "http://localhost:3000/api/queue/complete")
PROGRESS_URL: str = os.environ.get("PROGRESS_URL", "http://localhost:3000/api/queue/progress")


def _resolve_device() -> str:
    """Auto-detect compute device."""
    if env_device := os.environ.get("LIPSYNC_DEVICE"):
        return env_device
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


DEVICE = _resolve_device()

if DEVICE == "mps":
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


# ── State ────────────────────────────────────────────────────

app = FastAPI(title="LatentSync Lip Sync Sidecar", version="1.0.0")

worker_state = {
    "is_busy": False,
    "current_job_id": None,
    "loaded_model": None,
    "model_version": None,
}

job_progress: dict[str, dict] = {}
MAX_STORED_JOBS = 50

_last_job_time: float = 0.0
_idle_timer_task: Optional[asyncio.Task] = None
_pipeline = None


def _post_job_cleanup() -> None:
    """Free PyTorch cached memory and run Python GC after each job."""
    global _last_job_time
    _last_job_time = time.monotonic()
    try:
        import torch

        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    gc.collect()


def cleanup_old_jobs():
    """Remove oldest finished jobs if we exceed the limit."""
    finished = [
        (jid, info)
        for jid, info in job_progress.items()
        if info.get("status") in ("complete", "failed")
    ]
    finished.sort(key=lambda x: x[1].get("completed_at", 0))
    while len(finished) > MAX_STORED_JOBS:
        oldest_id = finished.pop(0)[0]
        job_progress.pop(oldest_id, None)


# ── Auth Dependency ──────────────────────────────────────────


async def verify_auth(authorization: Optional[str] = Header(default=None)):
    """Verify Bearer token on mutating endpoints."""
    if not AUTH_TOKEN:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    token = authorization.removeprefix("Bearer ").strip()
    if token != AUTH_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid token")


# ── Model Management ─────────────────────────────────────────


def _load_pipeline(model_version: str = "v1.5"):
    """Load LatentSync pipeline into memory."""
    global _pipeline
    logger.info("Loading LatentSync %s pipeline on %s...", model_version, DEVICE)

    try:
        import torch
        from latentsync.pipeline import LatentSyncPipeline
    except ImportError:
        logger.warning("LatentSync not installed — using subprocess fallback mode")
        _pipeline = None
        worker_state["loaded_model"] = "subprocess"
        worker_state["model_version"] = model_version
        return

    # Inline validation with string literals to break CodeQL taint chain.
    if model_version == "v1.5":
        safe_version, config_name, ckpt_name = "v1.5", "latentsync_unet_v1.5.yaml", "latentsync_unet_v1.5.pt"
    elif model_version == "v1.6":
        safe_version, config_name, ckpt_name = "v1.6", "latentsync_unet_v1.6.yaml", "latentsync_unet_v1.6.pt"
    else:
        raise ValueError(f"Unsupported model_version: {model_version!r}")
    latentsync_dir = os.path.realpath(
        os.environ.get(
            "LATENTSYNC_DIR",
            str(Path.home() / ".openzigs" / "models" / "latentsync"),
        )
    )
    config_path = os.path.join(latentsync_dir, "configs", config_name)
    ckpt_path = os.path.join(latentsync_dir, "checkpoints", ckpt_name)

    if not os.path.exists(config_path) or not os.path.exists(ckpt_path):
        logger.warning(
            "Model files not found at %s — will use subprocess fallback", latentsync_dir
        )
        _pipeline = None
        worker_state["loaded_model"] = "subprocess"
        worker_state["model_version"] = safe_version
        return

    _pipeline = LatentSyncPipeline.from_pretrained(
        config_path=config_path,
        checkpoint_path=ckpt_path,
        device=DEVICE,
    )
    worker_state["loaded_model"] = f"latentsync-{safe_version}"
    worker_state["model_version"] = safe_version
    logger.info("LatentSync %s loaded on %s", safe_version, DEVICE)


def _unload_model() -> None:
    """Unload the model from memory."""
    global _pipeline
    if _pipeline is not None:
        del _pipeline
        _pipeline = None
    worker_state["loaded_model"] = None
    worker_state["model_version"] = None
    try:
        import torch

        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    gc.collect()
    logger.info("LatentSync model unloaded")


async def _idle_timer():
    """Background task that unloads the model after idle timeout."""
    while True:
        await asyncio.sleep(60)
        if MODEL_IDLE_TIMEOUT <= 0:
            continue
        if worker_state["is_busy"] or worker_state["loaded_model"] is None:
            continue
        if _last_job_time > 0 and (time.monotonic() - _last_job_time) > MODEL_IDLE_TIMEOUT:
            logger.info("Model idle for %.0fs — unloading", MODEL_IDLE_TIMEOUT)
            _unload_model()


# ── Request Models ───────────────────────────────────────────


class LipSyncRequest(BaseModel):
    job_id: str = Field(..., pattern=r"^[a-fA-F0-9\-]{1,64}$")
    video_path: Optional[str] = None
    audio_path: Optional[str] = None
    video_data: Optional[str] = None  # base64-encoded video
    audio_data: Optional[str] = None  # base64-encoded audio
    inference_steps: int = Field(default=20, ge=1, le=100)
    guidance_scale: float = Field(default=1.5, ge=0.0, le=10.0)
    enable_deepcache: bool = True
    model_version: str = Field(default="v1.5", pattern=r"^v1\.[56]$")

    @field_validator("video_path", "audio_path", mode="before")
    @classmethod
    def _validate_paths(cls, v: Any) -> Any:
        if v is not None:
            s = str(v)
            if "\x00" in s or ".." in s:
                raise ValueError(f"Invalid path: {v}")
        return v


# ── Processing ───────────────────────────────────────────────


def report_progress(
    job_id: str,
    stage: str,
    progress: float,
    message: str,
):
    """Update local progress state and POST to the server-configured progress URL."""
    job_progress[job_id] = {
        **job_progress.get(job_id, {}),
        "stage": stage,
        "progress": progress,
        "message": message,
        "status": "processing",
    }
    if PROGRESS_URL:
        try:
            payload = json.dumps(
                {"job_id": job_id, "stage": stage, "progress": progress, "message": message}
            ).encode()
            _post_to_callback(PROGRESS_URL, data=payload)
        except Exception as exc:
            logger.warning("Failed to POST progress for %s: %s", job_id, exc)


def _run_latentsync_subprocess(
    video_path: str,
    audio_path: str,
    output_path: str,
    model_version: str = "v1.5",
    inference_steps: int = 20,
    guidance_scale: float = 1.5,
) -> None:
    """Run LatentSync inference via subprocess (fallback when Python API unavailable)."""
    # Inline validation with string literals to break CodeQL taint chain.
    if model_version == "v1.5":
        safe_version, config_name, ckpt_name = "v1.5", "latentsync_unet_v1.5.yaml", "latentsync_unet_v1.5.pt"
    elif model_version == "v1.6":
        safe_version, config_name, ckpt_name = "v1.6", "latentsync_unet_v1.6.yaml", "latentsync_unet_v1.6.pt"
    else:
        raise ValueError(f"Unsupported model_version: {model_version!r}")
    safe_steps = int(inference_steps)
    safe_scale = float(guidance_scale)
    if not (1 <= safe_steps <= 100):
        raise ValueError(f"inference_steps out of range: {safe_steps}")
    if not (0.0 <= safe_scale <= 10.0):
        raise ValueError(f"guidance_scale out of range: {safe_scale}")

    latentsync_dir = os.path.realpath(
        os.environ.get(
            "LATENTSYNC_DIR",
            str(Path.home() / ".openzigs" / "models" / "latentsync"),
        )
    )
    inference_script = os.path.join(latentsync_dir, "inference.py")
    if not os.path.exists(inference_script):
        raise FileNotFoundError(f"LatentSync inference.py not found at {inference_script}")

    config_path = os.path.join(latentsync_dir, "configs", config_name)
    ckpt_path = os.path.join(latentsync_dir, "checkpoints", ckpt_name)

    # All arguments are validated and path-safe; no shell=True
    cmd = [
        "python",
        inference_script,
        "--config_path", config_path,
        "--checkpoint_path", ckpt_path,
        "--video_path", video_path,
        "--audio_path", audio_path,
        "--output_path", output_path,
        "--inference_steps", str(safe_steps),
        "--guidance_scale", str(safe_scale),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)  # noqa: S603
    if result.returncode != 0:
        raise RuntimeError(f"LatentSync inference failed: {result.stderr[-1000:]}")


async def process_lipsync_job(req: LipSyncRequest) -> None:
    """Run the lip-sync pipeline for a single job."""
    job_id = req.job_id
    tmpdir = None

    try:
        worker_state["is_busy"] = True
        worker_state["current_job_id"] = job_id
        job_progress[job_id] = {"status": "processing", "stage": "init", "progress": 0}

        tmpdir = tempfile.mkdtemp(prefix="lipsync_")

        # ── Resolve video input ──
        report_progress(job_id, "input", 0.1, "Preparing video input")
        if req.video_data:
            video_file = os.path.join(tmpdir, "input_video.mp4")
            with open(video_file, "wb") as f:
                f.write(base64.b64decode(req.video_data))
        elif req.video_path:
            # Lookup via os.listdir() so the path component comes from the
            # filesystem (trusted source), not from user input.
            requested_video = os.path.basename(req.video_path)
            src_video = None
            for entry in os.listdir(GALLERY_DIR):
                if entry == requested_video:
                    src_video = os.path.join(GALLERY_DIR, entry)
                    break
            if src_video is None:
                raise FileNotFoundError(f"Video not found: {requested_video}")
            video_file = os.path.join(tmpdir, "input_video.mp4")
            shutil.copy2(src_video, video_file)
        else:
            raise ValueError("Either video_data or video_path is required")

        # ── Resolve audio input ──
        report_progress(job_id, "input", 0.2, "Preparing audio input")
        if req.audio_data:
            audio_file = os.path.join(tmpdir, "input_audio.wav")
            with open(audio_file, "wb") as f:
                f.write(base64.b64decode(req.audio_data))
        elif req.audio_path:
            # Lookup via os.listdir() so the path component comes from the
            # filesystem (trusted source), not from user input.
            requested_audio = os.path.basename(req.audio_path)
            src_audio = None
            for entry in os.listdir(GALLERY_DIR):
                if entry == requested_audio:
                    src_audio = os.path.join(GALLERY_DIR, entry)
                    break
            if src_audio is None:
                raise FileNotFoundError(f"Audio not found: {requested_audio}")
            audio_file = os.path.join(tmpdir, "input_audio.wav")
            shutil.copy2(src_audio, audio_file)
        else:
            raise ValueError("Either audio_data or audio_path is required")

        output_path = os.path.join(tmpdir, "output_lipsync.mp4")

        # ── Load model if needed ──
        report_progress(job_id, "model", 0.3, "Loading model")
        if worker_state.get("model_version") != req.model_version:
            _unload_model()
            _load_pipeline(req.model_version)

        # ── Run inference ──
        report_progress(job_id, "inference", 0.4, "Running lip-sync inference")

        if _pipeline is not None:
            _pipeline(
                video_path=video_file,
                audio_path=audio_file,
                output_path=output_path,
                num_inference_steps=req.inference_steps,
                guidance_scale=req.guidance_scale,
                enable_deepcache=req.enable_deepcache,
            )
        else:
            _run_latentsync_subprocess(
                video_path=video_file,
                audio_path=audio_file,
                output_path=output_path,
                model_version=req.model_version,
                inference_steps=req.inference_steps,
                guidance_scale=req.guidance_scale,
            )

        report_progress(job_id, "finalize", 0.9, "Finalizing output")

        if not os.path.exists(output_path):
            raise RuntimeError("LatentSync produced no output file")

        # ── Copy to gallery (uuid.uuid4 ensures zero user input in path) ──
        os.makedirs(GALLERY_DIR, exist_ok=True)
        output_id = str(uuid.uuid4())
        final_filename = f"lipsync_{output_id}.mp4"
        final_path = os.path.join(GALLERY_DIR, final_filename)
        shutil.copy2(output_path, final_path)

        result_url = f"/gallery/{final_filename}"

        job_progress[job_id] = {
            "status": "complete",
            "progress": 1.0,
            "stage": "done",
            "message": "Lip-sync complete",
            "result_url": result_url,
            "completed_at": time.time(),
        }
        cleanup_old_jobs()

        # ── Callback (server-configured URL, not user-supplied) ──
        if CALLBACK_URL:
            try:
                cb_payload = json.dumps(
                    {
                        "job_id": job_id,
                        "status": "complete",
                        "result_url": result_url,
                        "result_metadata": json.dumps(
                            {
                                "model_version": req.model_version,
                                "inference_steps": req.inference_steps,
                                "guidance_scale": req.guidance_scale,
                            }
                        ),
                    }
                ).encode()
                _post_to_callback(CALLBACK_URL, data=cb_payload)
            except Exception as exc:
                logger.error("Callback failed for %s: %s", job_id, exc)

        logger.info("Job %s complete → %s", job_id, result_url)

    except Exception as exc:
        tb = traceback.format_exc()
        logger.error("Job %s failed: %s\n%s", job_id, exc, tb)
        job_progress[job_id] = {
            "status": "failed",
            "error": str(exc)[:500],
            "completed_at": time.time(),
        }
        if CALLBACK_URL:
            try:
                err_payload = json.dumps(
                    {"job_id": job_id, "status": "failed", "error": str(exc)[:500]}
                ).encode()
                _post_to_callback(CALLBACK_URL, data=err_payload)
            except Exception:
                pass
    finally:
        worker_state["is_busy"] = False
        worker_state["current_job_id"] = None
        _post_job_cleanup()
        if tmpdir and os.path.exists(tmpdir):
            shutil.rmtree(tmpdir, ignore_errors=True)


# ── Endpoints ────────────────────────────────────────────────


@app.post("/generate", status_code=202, dependencies=[Depends(verify_auth)])
async def generate(req: LipSyncRequest):
    if worker_state["is_busy"]:
        raise HTTPException(status_code=409, detail="Worker is busy")
    # Issue #1106: refuse v1.6 on hosts that cannot fit it (~18 GB resident).
    # 16 GB MacBooks must downgrade to v1.5 (~8 GB) or run remotely on a
    # 32 GB / GPU node. We surface 507 (Insufficient Storage) so the queue
    # master can route to a remote worker instead of dispatching here.
    if req.model_version == "v1.6" and HOST_RAM_GB < MEMORY_LIMIT_GB:
        return JSONResponse(
            status_code=507,
            content={
                "error": "insufficient_unified_memory",
                "message": (
                    f"LatentSync v1.6 requires ~{MEMORY_LIMIT_GB:.0f} GB of unified memory; "
                    f"this host has {HOST_RAM_GB:.1f} GB. Re-submit with model_version=\"v1.5\" "
                    f"or route the job to a 32 GB / GPU worker."
                ),
                "host_ram_gb": round(HOST_RAM_GB, 2),
                "required_gb": MEMORY_LIMIT_GB,
            },
        )
    asyncio.create_task(process_lipsync_job(req))
    return {"job_id": req.job_id, "status": "accepted"}


@app.get("/health")
async def health():
    import psutil

    proc = psutil.Process()
    mem = proc.memory_info()
    return {
        "status": "ok",
        "busy": worker_state["is_busy"],
        "current_job_id": worker_state["current_job_id"],
        "loaded_model": worker_state["loaded_model"],
        "model_version": worker_state.get("model_version"),
        "device": DEVICE,
        "memory_rss_mb": round(mem.rss / 1024 / 1024, 1),
    }


@app.get("/capabilities")
async def capabilities():
    """Apple Silicon (MPS/PyTorch) capability report for the admin Models page."""
    total_gb = 0.0
    free_gb = 0.0
    try:
        import psutil
        vm = psutil.virtual_memory()
        total_gb = round(vm.total / (1024 ** 3), 1)
        free_gb = round(vm.available / (1024 ** 3), 1)
    except Exception:
        pass
    return {
        "cuda_available": False,
        "device_count": 1,
        "pooled_vram_gb": total_gb,
        "per_device": [
            {
                "index": 0,
                "name": "Apple Silicon GPU (Metal / MPS)",
                "total_gb": int(total_gb),
                "free_gb": int(free_gb),
            }
        ],
        "pooling": {
            "mode": "unified",
            "active": True,
            "device": DEVICE,
        },
        "max_ram_gb_v1_5": 8,
        "max_ram_gb_v1_6": 18,
        "available_models": ["v1.5", "v1.6"],
        "host_ram_gb": HOST_RAM_GB,
        "env": {
            "WORKER": "mac-mini",
            "BACKEND": "mps",
            "DEFAULT_MODEL": DEFAULT_MODEL,
        },
    }


@app.get("/status/{job_id}")
async def status(job_id: str):
    info = job_progress.get(job_id)
    if not info:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, **info}


@app.post("/unload-model", dependencies=[Depends(verify_auth)])
async def unload_model():
    _unload_model()
    return {"status": "unloaded"}


@app.on_event("startup")
async def startup():
    global _idle_timer_task
    _idle_timer_task = asyncio.create_task(_idle_timer())
    logger.info("LatentSync sidecar started on %s (idle timeout: %.0fs)", DEVICE, MODEL_IDLE_TIMEOUT)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="LatentSync Lip Sync Sidecar")
    parser.add_argument("--port", type=int, default=5012, help="Port to listen on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
