"""
SadTalker Talking-Head Sidecar — FastAPI (CUDA)

Generates a talking-head video from a single portrait image + audio.
Replaces the LTX video + LatentSync lipsync two-step pipeline with
a single SadTalker call that preserves face identity natively.

CLI equivalent:
    python inference.py --source_image photo.png --driven_audio audio.wav \
        --enhancer gfpgan --still --preprocess crop --size 512

HTTP API:
    POST /generate   — Submit an async talking-head generation job
    POST /generate-sync — Synchronous generation (returns video directly)
    GET  /health     — Readiness probe
    GET  /status     — Current worker state
    POST /unload     — Free VRAM

Port: 5011 (default)
"""

import argparse
import asyncio
import base64
import gc
import json
import logging
import os
import re
import shutil
import sys
import tempfile
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Optional
from urllib.request import Request, urlopen
from urllib.error import URLError

from fastapi import FastAPI, HTTPException, Header
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, field_validator
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("sadtalker-sidecar")


# ── Security Utilities ───────────────────────────────────────

_JOB_ID_RE = re.compile(r"^[a-fA-F0-9\-]{1,64}$")


def _validate_job_id(job_id: str) -> str:
    if not _JOB_ID_RE.match(job_id):
        raise ValueError(f"Invalid job_id format: {job_id!r}")
    return job_id


def _post_to_callback(endpoint_url: str, data: bytes, timeout: int = 30) -> None:
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
SADTALKER_DIR = os.environ.get(
    "SADTALKER_DIR",
    os.path.expanduser("~/.openzigs/models/SadTalker"),
)
AUTH_TOKEN: Optional[str] = os.environ.get("SADTALKER_SECRET_TOKEN")
CALLBACK_URL: str = os.environ.get("CALLBACK_URL", "http://localhost:3000/api/queue/complete")
PROGRESS_URL: str = os.environ.get("PROGRESS_URL", "http://localhost:3000/api/queue/progress")
MODEL_IDLE_TIMEOUT = float(os.environ.get("SADTALKER_MODEL_IDLE_TIMEOUT", "300"))

# SadTalker inference parameters
DEFAULT_SIZE = int(os.environ.get("SADTALKER_SIZE", "512"))
DEFAULT_PREPROCESS = os.environ.get("SADTALKER_PREPROCESS", "crop")
DEFAULT_ENHANCER = os.environ.get("SADTALKER_ENHANCER", "gfpgan")
DEFAULT_STILL = os.environ.get("SADTALKER_STILL", "true").lower() == "true"


def _resolve_device() -> str:
    if env_device := os.environ.get("SADTALKER_DEVICE"):
        return env_device
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
    except ImportError:
        pass
    return "cpu"


DEVICE = _resolve_device()


# ── State ────────────────────────────────────────────────────

app = FastAPI(title="SadTalker Talking-Head Sidecar (CUDA)", version="1.0.0")

worker_state = {
    "is_busy": False,
    "current_job_id": None,
    "models_loaded": False,
}

job_progress: dict[str, dict] = {}
MAX_STORED_JOBS = 50

_last_job_time: float = 0.0
_idle_timer_task: Optional[asyncio.Task] = None

# SadTalker model instances (loaded lazily)
_preprocess_model = None
_audio_to_coeff = None
_animate_from_coeff = None
_sadtalker_paths = None


def _post_job_cleanup() -> None:
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
    if not AUTH_TOKEN:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    token = authorization.removeprefix("Bearer ").strip()
    if token != AUTH_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid token")


# ── Model Management ─────────────────────────────────────────

def _load_models():
    """Load SadTalker models into GPU memory."""
    global _preprocess_model, _audio_to_coeff, _animate_from_coeff, _sadtalker_paths

    logger.info("Loading SadTalker models on %s...", DEVICE)

    # Add SadTalker to Python path
    if SADTALKER_DIR not in sys.path:
        sys.path.insert(0, SADTALKER_DIR)

    from src.utils.preprocess import CropAndExtract
    from src.test_audio2coeff import Audio2Coeff
    from src.facerender.animate import AnimateFromCoeff
    from src.utils.init_path import init_path

    checkpoint_dir = os.path.join(SADTALKER_DIR, "checkpoints")
    config_dir = os.path.join(SADTALKER_DIR, "src", "config")

    _sadtalker_paths = init_path(
        checkpoint_dir, config_dir, DEFAULT_SIZE, False, DEFAULT_PREPROCESS
    )

    _preprocess_model = CropAndExtract(_sadtalker_paths, DEVICE)
    _audio_to_coeff = Audio2Coeff(_sadtalker_paths, DEVICE)
    _animate_from_coeff = AnimateFromCoeff(_sadtalker_paths, DEVICE)

    worker_state["models_loaded"] = True
    logger.info("SadTalker models loaded on %s (size=%d)", DEVICE, DEFAULT_SIZE)


def _unload_models() -> None:
    global _preprocess_model, _audio_to_coeff, _animate_from_coeff, _sadtalker_paths

    _preprocess_model = None
    _audio_to_coeff = None
    _animate_from_coeff = None
    _sadtalker_paths = None

    worker_state["models_loaded"] = False
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    gc.collect()
    logger.info("SadTalker models unloaded")


async def _idle_timer():
    while True:
        await asyncio.sleep(60)
        if MODEL_IDLE_TIMEOUT <= 0:
            continue
        if worker_state["is_busy"] or not worker_state["models_loaded"]:
            continue
        if _last_job_time > 0 and (time.monotonic() - _last_job_time) > MODEL_IDLE_TIMEOUT:
            logger.info("SadTalker idle for %.0fs — unloading", MODEL_IDLE_TIMEOUT)
            _unload_models()


# ── Request Models ───────────────────────────────────────────

_VALID_PREPROCESS = frozenset({"crop", "extcrop", "resize", "full", "extfull"})
_VALID_ENHANCERS = frozenset({"gfpgan", "RestoreFormer", ""})
_VALID_SIZES = frozenset({256, 512})


class TalkingHeadRequest(BaseModel):
    job_id: str = Field(..., pattern=r"^[a-fA-F0-9\-]{1,64}$")
    # Image: base64 or path
    image_data: Optional[str] = None
    image_path: Optional[str] = None
    # Audio: base64 or path
    audio_data: Optional[str] = None
    audio_path: Optional[str] = None
    # SadTalker parameters
    size: int = Field(default=512, description="Face render size: 256 or 512")
    preprocess: str = Field(default="crop", description="crop|extcrop|resize|full|extfull")
    enhancer: str = Field(default="gfpgan", description="gfpgan|RestoreFormer|empty for none")
    still_mode: bool = Field(default=True, description="Reduce head motion for more natural result")
    expression_scale: float = Field(default=1.0, ge=0.1, le=3.0)
    pose_style: int = Field(default=0, ge=0, le=45)
    # Callback
    callback_url: Optional[str] = None
    progress_url: Optional[str] = None

    @field_validator("size")
    @classmethod
    def _validate_size(cls, v: int) -> int:
        if v not in _VALID_SIZES:
            raise ValueError(f"size must be 256 or 512, got {v}")
        return v

    @field_validator("preprocess")
    @classmethod
    def _validate_preprocess(cls, v: str) -> str:
        if v not in _VALID_PREPROCESS:
            raise ValueError(f"preprocess must be one of {_VALID_PREPROCESS}")
        return v

    @field_validator("enhancer")
    @classmethod
    def _validate_enhancer(cls, v: str) -> str:
        if v and v not in _VALID_ENHANCERS:
            raise ValueError(f"enhancer must be one of {_VALID_ENHANCERS}")
        return v

    @field_validator("image_path", "audio_path", mode="before")
    @classmethod
    def _validate_paths(cls, v: Any) -> Any:
        if v is not None:
            s = str(v)
            if "\x00" in s or ".." in s:
                raise ValueError(f"Invalid path: {v}")
        return v


# ── Core Inference ───────────────────────────────────────────

def _run_sadtalker(
    image_path: str,
    audio_path: str,
    output_dir: str,
    size: int = 512,
    preprocess: str = "crop",
    enhancer: str = "gfpgan",
    still: bool = True,
    expression_scale: float = 1.0,
    pose_style: int = 0,
) -> str:
    """Run SadTalker inference and return the path to the output .mp4."""
    global _preprocess_model, _audio_to_coeff, _animate_from_coeff, _sadtalker_paths

    if not worker_state["models_loaded"]:
        _load_models()

    # Add SadTalker to path for internal imports
    if SADTALKER_DIR not in sys.path:
        sys.path.insert(0, SADTALKER_DIR)
    from src.generate_batch import get_data
    from src.generate_facerender_batch import get_facerender_data

    save_dir = os.path.join(output_dir, "work")
    os.makedirs(save_dir, exist_ok=True)

    first_frame_dir = os.path.join(save_dir, "first_frame_dir")
    os.makedirs(first_frame_dir, exist_ok=True)

    logger.info("SadTalker: 3DMM extraction for source image...")
    first_coeff_path, crop_pic_path, crop_info = _preprocess_model.generate(
        image_path, first_frame_dir, preprocess,
        source_image_flag=True, pic_size=size
    )

    if first_coeff_path is None:
        raise RuntimeError("SadTalker: Could not extract 3DMM coefficients from the source image. "
                           "Ensure the image contains a clearly visible face.")

    logger.info("SadTalker: Audio-to-coefficient generation...")
    batch = get_data(first_coeff_path, audio_path, DEVICE, ref_eyeblink_coeff_path=None, still=still)
    coeff_path = _audio_to_coeff.generate(batch, save_dir, pose_style, None)

    logger.info("SadTalker: Rendering animated face...")
    data = get_facerender_data(
        coeff_path, crop_pic_path, first_coeff_path, audio_path,
        batch_size=2,
        input_yaw_list=None,
        input_pitch_list=None,
        input_roll_list=None,
        expression_scale=expression_scale,
        still_mode=still,
        preprocess=preprocess,
        size=size,
    )

    result = _animate_from_coeff.generate(
        data, save_dir, image_path, crop_info,
        enhancer=enhancer if enhancer else None,
        background_enhancer=None,
        preprocess=preprocess,
        img_size=size,
    )

    # SadTalker outputs to save_dir + ".mp4"
    final_path = os.path.join(output_dir, "output.mp4")
    if os.path.exists(result):
        shutil.move(result, final_path)
    else:
        # Fallback: find the mp4 in save_dir
        for f in Path(save_dir).rglob("*.mp4"):
            shutil.move(str(f), final_path)
            break
        else:
            raise RuntimeError("SadTalker produced no output video")

    # Cleanup working directory
    shutil.rmtree(save_dir, ignore_errors=True)

    return final_path


# ── Endpoints ────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "sidecar": "sadtalker",
        "device": DEVICE,
        "models_loaded": worker_state["models_loaded"],
        "is_busy": worker_state["is_busy"],
    }


@app.get("/status")
async def status():
    return {
        **worker_state,
        "device": DEVICE,
        "sadtalker_dir": SADTALKER_DIR,
        "default_size": DEFAULT_SIZE,
        "default_enhancer": DEFAULT_ENHANCER,
        "jobs": len(job_progress),
    }


@app.post("/unload")
async def unload():
    _unload_models()
    return {"status": "unloaded"}


@app.get("/gpu-info")
async def gpu_info_endpoint():
    """Report which CUDA device this sidecar is bound to (Issue #919).

    Mirrors the audio sidecar's /gpu-info shape so the GPU coordinator
    (#917) and /api/system/gpu have full visibility into the talking-head
    pipeline. Returns 503 when CUDA is not initialized.
    """
    try:
        import torch
    except ImportError:
        raise HTTPException(status_code=503, detail="torch not available")
    if not torch.cuda.is_available():
        raise HTTPException(status_code=503, detail="CUDA not available")
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


@app.post("/generate", status_code=202)
async def generate_async(req: TalkingHeadRequest):
    """Submit an async talking-head job. Result delivered via callback."""
    if worker_state["is_busy"]:
        raise HTTPException(status_code=429, detail="Worker is busy")

    job_id = _validate_job_id(req.job_id)

    job_progress[job_id] = {
        "status": "processing",
        "started_at": time.time(),
        "progress": 0,
    }

    # Launch in background
    asyncio.get_event_loop().run_in_executor(
        None, _process_job, req, job_id
    )

    return {"job_id": job_id, "status": "accepted"}


def _process_job(req: TalkingHeadRequest, job_id: str) -> None:
    """Process a talking-head job (runs in thread pool)."""
    worker_state["is_busy"] = True
    worker_state["current_job_id"] = job_id

    tmpdir = None
    try:
        tmpdir = tempfile.mkdtemp(prefix=f"sadtalker_{job_id}_")

        # Write image to disk
        image_path = _resolve_media(
            req.image_data, req.image_path, tmpdir, "source_image.png"
        )
        if not image_path:
            raise ValueError("No image provided (image_data or image_path required)")

        # Write audio to disk
        audio_path = _resolve_media(
            req.audio_data, req.audio_path, tmpdir, "driven_audio.wav"
        )
        if not audio_path:
            raise ValueError("No audio provided (audio_data or audio_path required)")

        # Report progress
        _report_progress(job_id, 10, "Starting SadTalker inference")

        # Run inference
        output_path = _run_sadtalker(
            image_path=image_path,
            audio_path=audio_path,
            output_dir=tmpdir,
            size=req.size,
            preprocess=req.preprocess,
            enhancer=req.enhancer,
            still=req.still_mode,
            expression_scale=req.expression_scale,
            pose_style=req.pose_style,
        )

        _report_progress(job_id, 90, "Saving to gallery")

        # Copy to gallery
        os.makedirs(GALLERY_DIR, exist_ok=True)
        gallery_name = f"sadtalker_{job_id}.mp4"
        gallery_path = os.path.join(GALLERY_DIR, gallery_name)
        shutil.copy2(output_path, gallery_path)

        logger.info("SadTalker job %s complete: %s", job_id, gallery_path)

        # Read result for callback
        with open(gallery_path, "rb") as f:
            video_b64 = base64.b64encode(f.read()).decode()

        job_progress[job_id] = {
            "status": "complete",
            "completed_at": time.time(),
            "file_path": gallery_path,
        }

        # Callback to server
        callback_url = req.callback_url or CALLBACK_URL
        callback_data = json.dumps({
            "job_id": job_id,
            "status": "complete",
            "media_base64": video_b64,
            "media_type": "video/mp4",
            "file_path": gallery_path,
        }).encode()

        try:
            _post_to_callback(callback_url, callback_data, timeout=30)
        except Exception as cb_err:
            logger.warning("Callback failed for job %s: %s", job_id, cb_err)

    except Exception as exc:
        error_msg = f"{type(exc).__name__}: {exc}"
        logger.error("SadTalker job %s failed: %s", job_id, error_msg)
        logger.error(traceback.format_exc())

        job_progress[job_id] = {
            "status": "failed",
            "completed_at": time.time(),
            "error": error_msg,
        }

        # Callback failure
        callback_url = req.callback_url or CALLBACK_URL
        try:
            fail_data = json.dumps({
                "job_id": job_id,
                "status": "failed",
                "error": error_msg,
            }).encode()
            _post_to_callback(callback_url, fail_data, timeout=10)
        except Exception:
            pass

    finally:
        worker_state["is_busy"] = False
        worker_state["current_job_id"] = None
        _post_job_cleanup()
        cleanup_old_jobs()
        if tmpdir and os.path.exists(tmpdir):
            shutil.rmtree(tmpdir, ignore_errors=True)


def _resolve_media(
    b64_data: Optional[str],
    file_path: Optional[str],
    tmpdir: str,
    default_name: str,
) -> Optional[str]:
    """Resolve base64 data or file path to a local file. Returns path or None."""
    if b64_data:
        # Strip data URI prefix if present (e.g. "data:image/jpeg;base64,...")
        raw = b64_data
        if raw.startswith("data:"):
            _, _, raw = raw.partition(",")
        out = os.path.join(tmpdir, default_name)
        with open(out, "wb") as f:
            f.write(base64.b64decode(raw))
        return out
    if file_path and os.path.isfile(file_path):
        return file_path
    return None


def _report_progress(job_id: str, pct: int, message: str) -> None:
    """Best-effort progress report to the server."""
    try:
        data = json.dumps({
            "job_id": job_id,
            "progress": pct,
            "message": message,
        }).encode()
        _post_to_callback(PROGRESS_URL, data, timeout=5)
    except Exception:
        pass


# ── Lifecycle ────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    global _idle_timer_task
    os.makedirs(GALLERY_DIR, exist_ok=True)
    _idle_timer_task = asyncio.create_task(_idle_timer())
    logger.info(
        "SadTalker sidecar started (device=%s, dir=%s, size=%d, enhancer=%s)",
        DEVICE, SADTALKER_DIR, DEFAULT_SIZE, DEFAULT_ENHANCER,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SadTalker Talking-Head Sidecar")
    parser.add_argument("--port", type=int, default=5011)
    parser.add_argument("--host", type=str, default="0.0.0.0")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
