"""
M2 Pro Sidecar Worker — Video/Audio Generation with VRAM Management
Issue #327: Async worker for LTX-2 video generation and F5-TTS audio on Apple Silicon.

Endpoints:
  GET  /status   → { is_busy, loaded_model }
  POST /generate → 202 Accepted (async), sends result via webhook
  GET  /health   → simple health check
"""

import asyncio
import base64
import gc
import io
import logging
import os
import subprocess
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("m2pro-worker")

# ── Constants ────────────────────────────────────────────────

MAX_VIDEO_FRAMES = 97  # 4 seconds at 24fps
MAX_VIDEO_DURATION_SEC = 4
DEFAULT_FPS = 24
DEFAULT_WIDTH = 768
DEFAULT_HEIGHT = 512
DEFAULT_MODEL_REPO = os.getenv("LTX_MODEL_REPO", "AITRADER/ltx2-distilled-8bit-mlx")

# ── Worker State ─────────────────────────────────────────────

class WorkerState:
    """Thread-safe worker state."""
    def __init__(self):
        self.is_busy: bool = False
        self.loaded_model: str | None = None
        self._lock = asyncio.Lock()
        # Cached model objects
        self._pipeline = None
        self._model_name: str | None = None

    async def set_busy(self, busy: bool):
        async with self._lock:
            self.is_busy = busy

    async def get_status(self) -> dict:
        async with self._lock:
            return {"is_busy": self.is_busy, "loaded_model": self.loaded_model}

state = WorkerState()

# ── Request/Response Models ──────────────────────────────────

class GenerateRequest(BaseModel):
    job_id: str
    type: str  # txt2video, img2video, tts
    prompt: str
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT
    num_frames: int = Field(default=MAX_VIDEO_FRAMES, le=MAX_VIDEO_FRAMES)
    fps: int = DEFAULT_FPS
    model: str = "ltx-2"
    callback_url: str
    init_image: str | None = None  # base64 for img2video
    seed: int | None = None

class StatusResponse(BaseModel):
    is_busy: bool
    loaded_model: str | None

class HealthResponse(BaseModel):
    status: str
    worker: str
    loaded_model: str | None

# ── VRAM Manager ─────────────────────────────────────────────

def clear_vram():
    """Explicitly clear Apple Silicon unified memory."""
    try:
        import mlx.core as mx
        mx.metal.clear_cache()
        logger.info("MLX metal cache cleared")
    except ImportError:
        logger.warning("mlx not available, skipping metal cache clear")
    gc.collect()

def unload_model():
    """Tear down any loaded model objects and free VRAM."""
    global state
    if state._pipeline is not None:
        del state._pipeline
        state._pipeline = None
        state._model_name = None
        clear_vram()
        logger.info("Previous model unloaded and VRAM cleared")

# ── Video Generation (LTX-2 via mlx-video or ltx_video) ─────

def generate_video_ltx2(request: GenerateRequest) -> bytes:
    """
    Generate video using LTX-2 distilled 8-bit model on MLX.
    Returns encoded MP4 bytes.
    """
    # Enforce frame limit
    num_frames = min(request.num_frames, MAX_VIDEO_FRAMES)
    fps = request.fps or DEFAULT_FPS

    # Check if we need to swap models
    target_model = "ltx-2"
    if state._model_name != target_model:
        unload_model()
        state.loaded_model = target_model
        state._model_name = target_model
        logger.info(f"Loading LTX-2 model: {DEFAULT_MODEL_REPO}")

    with tempfile.TemporaryDirectory() as tmpdir:
        output_raw = Path(tmpdir) / "raw_video.mp4"
        output_final = Path(tmpdir) / "output.mp4"

        # Try mlx-video first, fall back to ltx_video inference
        try:
            _generate_with_mlx_video(request, num_frames, fps, str(output_raw))
        except ImportError:
            _generate_with_ltx_inference(request, num_frames, fps, str(output_raw))

        # Re-encode with h264_videotoolbox for Apple Silicon hardware encoding
        _encode_with_videotoolbox(str(output_raw), str(output_final), fps)

        return output_final.read_bytes()


def _generate_with_mlx_video(request: GenerateRequest, num_frames: int, fps: int, output_path: str):
    """Generate using the mlx-video Python package."""
    from mlx_video import generate  # type: ignore[import-untyped]

    kwargs: dict = {
        "prompt": request.prompt,
        "model_repo": DEFAULT_MODEL_REPO,
        "width": request.width,
        "height": request.height,
        "num_frames": num_frames,
        "fps": fps,
        "output_path": output_path,
    }

    if request.seed is not None:
        kwargs["seed"] = request.seed

    if request.init_image and request.type == "img2video":
        # Decode init image and save to temp file
        img_bytes = base64.b64decode(request.init_image)
        img_path = output_path.replace(".mp4", "_init.png")
        Path(img_path).write_bytes(img_bytes)
        kwargs["image_path"] = img_path

    generate(**kwargs)


def _generate_with_ltx_inference(request: GenerateRequest, num_frames: int, fps: int, output_path: str):
    """Fallback: Generate using ltx_video inference API."""
    try:
        from ltx_video.inference import infer, InferenceConfig  # type: ignore[import-untyped]

        config_path = os.getenv("LTX_CONFIG_PATH", "configs/ltxv-13b-0.9.8-distilled.yaml")

        kwargs: dict = {
            "pipeline_config": config_path,
            "prompt": request.prompt,
            "height": request.height,
            "width": request.width,
            "num_frames": num_frames,
            "output_path": output_path,
        }

        if request.seed is not None:
            kwargs["seed"] = request.seed

        if request.init_image and request.type == "img2video":
            img_bytes = base64.b64decode(request.init_image)
            img_path = output_path.replace(".mp4", "_init.png")
            Path(img_path).write_bytes(img_bytes)
            kwargs["conditioning_media_paths"] = [img_path]
            kwargs["conditioning_start_frames"] = [0]

        infer(InferenceConfig(**kwargs))
    except ImportError:
        raise ImportError(
            "Neither mlx-video nor ltx_video is installed. "
            "Install one of: pip install mlx-video, or pip install -e '.[inference]' from LTX-Video repo"
        )


def _encode_with_videotoolbox(input_path: str, output_path: str, fps: int):
    """Re-encode MP4 using Apple's h264_videotoolbox hardware encoder."""
    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-c:v", "h264_videotoolbox",
        "-b:v", "8M",
        "-fps_mode", "cfr",
        "-r", str(fps),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        # Fall back to software encoding if VideoToolbox is not available
        logger.warning(f"h264_videotoolbox failed, falling back to libx264: {result.stderr[:200]}")
        cmd_fallback = [
            "ffmpeg", "-y",
            "-i", input_path,
            "-c:v", "libx264",
            "-crf", "23",
            "-preset", "medium",
            "-fps_mode", "cfr",
            "-r", str(fps),
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            output_path,
        ]
        subprocess.run(cmd_fallback, capture_output=True, text=True, timeout=120, check=True)


# ── Async Job Runner ─────────────────────────────────────────

async def run_generation_job(request: GenerateRequest):
    """Run the generation in background and POST result back via webhook."""
    start = time.time()
    try:
        await state.set_busy(True)
        logger.info(f"Starting job {request.job_id} ({request.type})")

        # Run CPU/GPU-bound generation in a thread pool
        if request.type in ("txt2video", "img2video"):
            media_bytes = await asyncio.get_event_loop().run_in_executor(
                None, generate_video_ltx2, request
            )
            media_type = "video/mp4"
        else:
            raise ValueError(f"Unsupported job type: {request.type}")

        elapsed = time.time() - start
        logger.info(f"Job {request.job_id} complete in {elapsed:.1f}s ({len(media_bytes)} bytes)")

        # Send result back to Node.js via webhook
        payload = {
            "job_id": request.job_id,
            "status": "complete",
            "media_base64": base64.b64encode(media_bytes).decode("ascii"),
            "media_type": media_type,
            "metadata": {
                "generation_time": round(elapsed, 2),
                "width": request.width,
                "height": request.height,
                "num_frames": min(request.num_frames, MAX_VIDEO_FRAMES),
                "fps": request.fps,
                "model": DEFAULT_MODEL_REPO,
                "duration": round(min(request.num_frames, MAX_VIDEO_FRAMES) / request.fps, 2),
            },
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(request.callback_url, json=payload)
            logger.info(f"Webhook callback: {resp.status_code}")

    except Exception as e:
        elapsed = time.time() - start
        logger.error(f"Job {request.job_id} failed after {elapsed:.1f}s: {e}")

        # Notify failure
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                await client.post(request.callback_url, json={
                    "job_id": request.job_id,
                    "status": "failed",
                    "error": str(e),
                })
        except Exception as webhook_err:
            logger.error(f"Failed to send error webhook: {webhook_err}")

    finally:
        await state.set_busy(False)
        # Clear VRAM after generation to prevent thermal throttling
        clear_vram()


# ── FastAPI App ──────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("M2 Pro Worker starting up")
    yield
    logger.info("M2 Pro Worker shutting down")
    unload_model()

app = FastAPI(title="M2 Pro Sidecar Worker", version="1.0.0", lifespan=lifespan)


@app.get("/status", response_model=StatusResponse)
async def get_status():
    """Worker status endpoint — used by Queue Master for VRAM-aware routing."""
    return await state.get_status()


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="ok",
        worker="m2-pro",
        loaded_model=state.loaded_model,
    )


@app.post("/generate", status_code=202)
async def generate(request: GenerateRequest):
    """
    Accept a generation job. Returns 202 immediately.
    The actual generation runs in the background and results
    are sent via webhook to callback_url.
    """
    status = await state.get_status()
    if status["is_busy"]:
        raise HTTPException(status_code=429, detail="Worker is busy")

    # Enforce frame limit strictly
    request.num_frames = min(request.num_frames, MAX_VIDEO_FRAMES)

    # Fire and forget the generation task
    asyncio.create_task(run_generation_job(request))

    return {
        "accepted": True,
        "job_id": request.job_id,
        "message": f"Job queued for {request.type} generation ({request.num_frames} frames, {request.fps}fps)",
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("M2_PRO_PORT", "5007"))
    uvicorn.run(app, host="0.0.0.0", port=port)
