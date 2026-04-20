"""
LatentSync Lip Sync Sidecar — FastAPI (CUDA / Windows+Linux)
Issue #798: CUDA variant of the lip-sync sidecar for Windows and Linux.

Differences from server.py (MPS):
  - Uses CUDA for GPU acceleration
  - Default port 5010
  - xformers memory-efficient attention
  - Half-precision (float16) inference

HTTP API: Same as MPS variant.
Port: 5010 (default)
"""

import asyncio
import base64
import gc
import json
import logging
import os
import re
import sys
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
logger = logging.getLogger("lipsync-sidecar-cuda")


# ── Error Sanitisation (sub-issue #905) ──────────────────────

def _sanitize_runtime_error(exc: BaseException, max_len: int = 240) -> str:
    """Return a client-safe error string.

    Strips absolute file paths (POSIX + Windows), CUDA pointer addresses,
    and traceback-style frame markers from the exception text. Preserves the
    final, human-readable message line so callers still get useful debugging
    output without leaking on-disk structure or internal state.
    """
    raw = str(exc) if exc is not None else ""
    if not raw:
        return f"{type(exc).__name__}"
    # Take only the last non-empty line — exception messages with `__cause__`
    # frequently include a stack-like prefix.
    last_line = ""
    for line in reversed(raw.strip().splitlines()):
        if line.strip():
            last_line = line.strip()
            break
    if not last_line:
        last_line = raw.strip()
    # Strip POSIX paths (`/foo/bar/baz`) and Windows paths (`C:\foo\bar\baz`)
    # but keep the basename so error context is preserved.
    last_line = re.sub(r"(/[^\s:]+/|[A-Za-z]:\\[^\s:]+\\)", "", last_line)
    # Strip pointer addresses commonly emitted by CUDA / torch.
    last_line = re.sub(r"0x[0-9a-fA-F]{6,}", "0x…", last_line)
    if len(last_line) > max_len:
        last_line = last_line[:max_len] + "…"
    return last_line or type(exc).__name__


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
    """Safely join paths, preventing traversal."""
    base = os.path.realpath(base_dir)
    joined = os.path.realpath(os.path.join(base, user_path))
    if not joined.startswith(base + os.sep) and joined != base:
        raise ValueError(f"Path traversal blocked: {user_path}")
    return joined


def _post_to_callback(endpoint_url: str, data: bytes, timeout: int = 30) -> None:
    """POST data to a server-configured callback URL (not user-supplied)."""
    headers = {"Content-Type": "application/json"}
    _cb_secret = os.getenv("CALLBACK_SECRET") or None
    if _cb_secret:
        headers["Authorization"] = f"Bearer {_cb_secret}"
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

# Callback URLs are server-configured only (not user-supplied) to prevent SSRF.
CALLBACK_URL: str = os.environ.get("CALLBACK_URL", "http://localhost:3000/api/queue/complete")
PROGRESS_URL: str = os.environ.get("PROGRESS_URL", "http://localhost:3000/api/queue/progress")


def _resolve_device() -> str:
    """Auto-detect CUDA device."""
    if env_device := os.environ.get("LIPSYNC_DEVICE"):
        return env_device
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except ImportError:
        pass
    return "cpu"


DEVICE = _resolve_device()

# Enable cuDNN autotuner for faster convolutions when CUDA is available
if DEVICE == "cuda":
    try:
        import torch as _torch_init
        _torch_init.backends.cudnn.benchmark = True
    except Exception:
        pass


# ── State ────────────────────────────────────────────────────

app = FastAPI(title="LatentSync Lip Sync Sidecar (CUDA)", version="1.0.0")

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
    """Free CUDA cached memory and run Python GC after each job."""
    global _last_job_time
    _last_job_time = time.monotonic()
    try:
        import torch

        if torch.cuda.is_available():
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
    """Load LatentSync pipeline into CUDA memory with float16."""
    global _pipeline
    logger.info("Loading LatentSync %s pipeline on %s (float16)...", model_version, DEVICE)

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
        safe_version = "v1.5"
        config_name = "configs/unet/stage2.yaml"
    elif model_version == "v1.6":
        safe_version = "v1.6"
        config_name = "configs/unet/stage2_512.yaml"
    else:
        raise ValueError(f"Unsupported model_version: {model_version!r}")
    latentsync_dir = os.path.realpath(
        os.environ.get(
            "LATENTSYNC_DIR",
            str(Path.home() / ".openzigs" / "models" / "latentsync"),
        )
    )
    config_path = os.path.join(latentsync_dir, config_name)
    ckpt_path = os.path.join(latentsync_dir, "checkpoints", "latentsync_unet.pt")

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
        dtype=torch.float16,
    )
    worker_state["loaded_model"] = f"latentsync-{safe_version}"
    worker_state["model_version"] = safe_version
    logger.info("LatentSync %s loaded on %s (float16)", safe_version, DEVICE)


def _unload_model() -> None:
    """Unload the model from CUDA memory."""
    global _pipeline
    if _pipeline is not None:
        del _pipeline
        _pipeline = None
    worker_state["loaded_model"] = None
    worker_state["model_version"] = None
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    gc.collect()
    logger.info("LatentSync model unloaded (CUDA)")


async def _idle_timer():
    """Background task that unloads the model after idle timeout."""
    while True:
        await asyncio.sleep(60)
        if MODEL_IDLE_TIMEOUT <= 0:
            continue
        if worker_state["is_busy"] or worker_state["loaded_model"] is None:
            continue
        if _last_job_time > 0 and (time.monotonic() - _last_job_time) > MODEL_IDLE_TIMEOUT:
            logger.info("Model idle for %.0fs — unloading (CUDA)", MODEL_IDLE_TIMEOUT)
            _unload_model()


# ── Request Models ───────────────────────────────────────────


class LipSyncRequest(BaseModel):
    job_id: str = Field(..., pattern=r"^[a-fA-F0-9\-]{1,64}$")
    video_path: Optional[str] = None
    audio_path: Optional[str] = None
    video_data: Optional[str] = None
    audio_data: Optional[str] = None
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
    """Run LatentSync inference via subprocess (fallback)."""
    # Inline validation with string literals to break CodeQL taint chain.
    if model_version == "v1.5":
        safe_version = "v1.5"
        config_name = "configs/unet/stage2.yaml"
    elif model_version == "v1.6":
        safe_version = "v1.6"
        config_name = "configs/unet/stage2_512.yaml"
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
    # LatentSync uses `python -m scripts.inference` from the repo root
    scripts_dir = os.path.join(latentsync_dir, "scripts")
    if not os.path.isdir(scripts_dir):
        raise FileNotFoundError(f"LatentSync scripts/ not found at {latentsync_dir}")

    config_path = os.path.join(latentsync_dir, config_name)
    ckpt_path = os.path.join(latentsync_dir, "checkpoints", "latentsync_unet.pt")

    # All arguments are validated and path-safe; no shell=True
    cmd = [
        sys.executable, "-m", "scripts.inference",
        "--unet_config_path", config_path,
        "--inference_ckpt_path", ckpt_path,
        "--video_path", video_path,
        "--audio_path", audio_path,
        "--video_out_path", output_path,
        "--inference_steps", str(safe_steps),
        "--guidance_scale", str(safe_scale),
        "--enable_deepcache",
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600, cwd=latentsync_dir)  # noqa: S603
    if result.returncode != 0:
        raise RuntimeError(f"LatentSync inference failed: {result.stderr[-1000:]}")


async def process_lipsync_job(req: LipSyncRequest) -> None:
    """Run the lip-sync pipeline for a single job (CUDA)."""
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
        report_progress(job_id, "inference", 0.4, "Running lip-sync inference (CUDA)")

        if _pipeline is not None:
            import torch
            with torch.inference_mode():
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

        logger.info("Job %s complete → %s (CUDA)", job_id, result_url)

    except Exception as exc:
        tb = traceback.format_exc()
        # Sub-issue #905 — log full traceback server-side, return only a
        # sanitized message to the client. `str(exc)[:500]` previously leaked
        # absolute file paths, model internals, and other on-disk structure.
        logger.error("Job %s failed: %s\n%s", job_id, exc, tb)
        safe_error = _sanitize_runtime_error(exc)
        job_progress[job_id] = {
            "status": "failed",
            "error": safe_error,
            "completed_at": time.time(),
        }
        if CALLBACK_URL:
            try:
                err_payload = json.dumps(
                    {"job_id": job_id, "status": "failed", "error": safe_error}
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
    asyncio.create_task(process_lipsync_job(req))
    return {"job_id": req.job_id, "status": "accepted"}


@app.get("/health")
async def health():
    import psutil

    proc = psutil.Process()
    mem = proc.memory_info()
    gpu_info = {}
    try:
        import torch

        if torch.cuda.is_available():
            gpu_info = {
                "gpu_name": torch.cuda.get_device_name(0),
                "gpu_memory_allocated_mb": round(torch.cuda.memory_allocated(0) / 1024 / 1024, 1),
                "gpu_memory_reserved_mb": round(torch.cuda.memory_reserved(0) / 1024 / 1024, 1),
            }
    except Exception:
        pass

    return {
        "status": "ok",
        "busy": worker_state["is_busy"],
        "current_job_id": worker_state["current_job_id"],
        "loaded_model": worker_state["loaded_model"],
        "model_version": worker_state.get("model_version"),
        "device": DEVICE,
        "memory_rss_mb": round(mem.rss / 1024 / 1024, 1),
        **gpu_info,
    }


@app.get("/status/{job_id}")
async def status(job_id: str):
    info = job_progress.get(job_id)
    if not info:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, **info}


@app.get("/gpu-info")
async def gpu_info_endpoint():
    """Report which CUDA device this sidecar is bound to (Issue #884)."""
    try:
        import torch
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
    except Exception as e:
        return {"available": False, "error": str(e)}


@app.post("/unload-model", dependencies=[Depends(verify_auth)])
async def unload_model():
    _unload_model()
    return {"status": "unloaded"}


@app.on_event("startup")
async def startup():
    global _idle_timer_task
    _idle_timer_task = asyncio.create_task(_idle_timer())
    logger.info(
        "LatentSync CUDA sidecar started on %s (idle timeout: %.0fs)", DEVICE, MODEL_IDLE_TIMEOUT
    )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="LatentSync Lip Sync Sidecar (CUDA)")
    parser.add_argument("--port", type=int, default=5010, help="Port to listen on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
