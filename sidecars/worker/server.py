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
import hmac
import io
import logging
import os
import resource
import subprocess
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import httpx
import ipaddress
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("m2pro-worker")


# ── Security Utilities ───────────────────────────────────────

def validate_callback_url(url: str) -> str:
    """Validate that a callback URL is safe.

    Allows http/https to private-network and loopback hosts (required for
    LAN sidecar→primary callbacks).  Blocks metadata endpoints and
    non-HTTP schemes.
    """
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"URL scheme must be http or https, got: {parsed.scheme}")
    hostname = parsed.hostname or ""
    if not hostname:
        raise ValueError("URL must have a hostname")
    _blocked = {"metadata.google.internal", "metadata.google.com",
                "169.254.169.254"}  # cloud metadata endpoints
    if hostname.lower() in _blocked:
        raise ValueError(f"Blocked metadata hostname: {hostname}")
    return url


# ── Constants ────────────────────────────────────────────────

MAX_VIDEO_FRAMES = 97  # 4 seconds at 24fps
MAX_VIDEO_DURATION_SEC = 4
DEFAULT_FPS = 24
DEFAULT_WIDTH = 768
DEFAULT_HEIGHT = 512
MAX_WIDTH = 1024
MAX_HEIGHT = 768
MAX_PIXELS = MAX_WIDTH * MAX_HEIGHT  # cap total pixel area
DEFAULT_MODEL_REPO = os.getenv("LTX_MODEL_REPO", "AITRADER/ltx2-distilled-4bit-mlx")
DEFAULT_TEXT_ENCODER_REPO = os.getenv("LTX_TEXT_ENCODER_REPO") or "mlx-community/gemma-3-12b-it-qat-4bit"

# Memory limits (bytes).  On a 32 GB M2 Pro the process RSS stays elevated
# after generation due to MLX weight caching, so allow up to 28 GB.
# macOS + OS overhead is ~4 GB, leaving headroom before swap.
MEMORY_LIMIT_GB = float(os.getenv("LTX_MEMORY_LIMIT_GB", "28"))
MEMORY_LIMIT_BYTES = int(MEMORY_LIMIT_GB * 1024 ** 3)
MODEL_IDLE_TIMEOUT_SEC = int(os.getenv("LTX_MODEL_IDLE_TIMEOUT", "300"))  # 5 min

# When LTX_SECRET_TOKEN is set, mutating endpoints require
# Authorization: Bearer <token>.  Health/status remain public.
_secret_token: Optional[str] = os.getenv("LTX_SECRET_TOKEN") or None

# When CALLBACK_SECRET is set, outgoing callback POSTs include
# Authorization: Bearer <secret> so the openzigs server can verify them.
_callback_secret: Optional[str] = os.getenv("CALLBACK_SECRET") or None


def _callback_auth_headers() -> dict[str, str]:
    """Build Authorization header for outgoing callback POSTs."""
    if _callback_secret:
        return {"Authorization": f"Bearer {_callback_secret}"}
    return {}


def verify_token(authorization: Optional[str] = Header(None)) -> None:
    """Validate Bearer token on protected endpoints."""
    if _secret_token is None:
        return  # auth disabled
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid Authorization format")
    if not hmac.compare_digest(parts[1], _secret_token):
        raise HTTPException(status_code=403, detail="Invalid token")


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
        self._last_job_time: float = 0.0

    async def set_busy(self, busy: bool):
        async with self._lock:
            self.is_busy = busy

    async def get_status(self) -> dict:
        async with self._lock:
            return {"is_busy": self.is_busy, "loaded_model": self.loaded_model}

state = WorkerState()

# ── Job Result Store ─────────────────────────────────────────
# In-memory ring buffer of completed/failed job results.  When the callback
# POST fails (e.g. "No route to host"), QueueMaster can poll GET /job-result/{id}
# to pick up the result instead.  Capped at _MAX_STORED_RESULTS entries.
import threading as _threading
_MAX_STORED_RESULTS = 100
_job_results: dict[str, dict] = {}       # job_id → payload (same shape as callback body)
_job_results_lock = _threading.Lock()

def _store_result(job_id: str, payload: dict) -> None:
    """Store a job result for later polling.  Evicts oldest when full."""
    with _job_results_lock:
        _job_results[job_id] = payload
        while len(_job_results) > _MAX_STORED_RESULTS:
            oldest = next(iter(_job_results))
            del _job_results[oldest]

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
    # Quality controls
    pipeline: str = "distilled"  # "distilled", "dev", "dev-two-stage", "dev-two-stage-hq"
    negative_prompt: str | None = None
    cfg_scale: float | None = None  # DEV pipeline only; default 4.5
    num_inference_steps: int | None = None  # DEV pipeline only; default 20
    # LTX Video Engine v2 fields
    audio: bool = False  # Enable synchronized audio generation
    tiling: str = Field(default="auto", pattern=r"^(auto|none|default|aggressive|conservative)$")
    model_repo: str | None = Field(default=None, max_length=200, pattern=r"^[A-Za-z0-9_\-]+/[A-Za-z0-9_\-\.]+$")
    enhance_prompt: bool = False  # Gemma-based prompt enhancement
    image_strength: float = Field(default=1.0, ge=0.0, le=1.0)  # I2V conditioning strength
    progress_url: str | None = None  # URL for real-time progress updates (#762)

class StatusResponse(BaseModel):
    is_busy: bool
    loaded_model: str | None

class HealthResponse(BaseModel):
    status: str
    worker: str
    loaded_model: str | None

# ── Memory Monitoring ────────────────────────────────────────

def get_process_memory_bytes() -> int:
    """Return current RSS of this process in bytes."""
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # macOS: bytes


def get_system_memory_info() -> dict:
    """Return system memory pressure info via vm_stat."""
    try:
        out = subprocess.check_output(["vm_stat"], text=True, timeout=5)
        page_size = 16384  # Apple Silicon default
        stats: dict[str, int] = {}
        for line in out.splitlines():
            if ":" in line:
                key, val = line.split(":", 1)
                val = val.strip().rstrip(".")
                if val.isdigit():
                    stats[key.strip()] = int(val) * page_size
        free = stats.get("Pages free", 0)
        active = stats.get("Pages active", 0)
        inactive = stats.get("Pages inactive", 0)
        wired = stats.get("Pages wired down", 0)
        compressed = stats.get("Pages occupied by compressor", 0)
        purgeable = stats.get("Pages purgeable", 0)
        used = active + wired + compressed
        # macOS keeps "free" near zero; inactive + purgeable pages are
        # instantly reclaimable so include them in available memory.
        available = free + inactive + purgeable
        return {
            "free_gb": round(free / 1024**3, 2),
            "available_gb": round(available / 1024**3, 2),
            "active_gb": round(active / 1024**3, 2),
            "inactive_gb": round(inactive / 1024**3, 2),
            "wired_gb": round(wired / 1024**3, 2),
            "compressed_gb": round(compressed / 1024**3, 2),
            "used_gb": round(used / 1024**3, 2),
            "process_rss_gb": round(get_process_memory_bytes() / 1024**3, 2),
        }
    except Exception as e:
        logger.warning(f"Failed to read vm_stat: {e}")
        return {"process_rss_gb": round(get_process_memory_bytes() / 1024**3, 2)}


def check_memory_budget() -> tuple[bool, str]:
    """Return (ok, reason).  False if we're too close to the memory limit."""
    rss = get_process_memory_bytes()
    if rss > MEMORY_LIMIT_BYTES:
        return False, (
            f"Process RSS {rss / 1024**3:.1f} GB exceeds limit "
            f"{MEMORY_LIMIT_GB:.0f} GB"
        )
    info = get_system_memory_info()
    available_gb = info.get("available_gb", info.get("free_gb", 999))
    if available_gb < 2.0:
        return False, f"System available memory dangerously low ({available_gb:.1f} GB)"
    return True, "ok"


# ── VRAM Manager ─────────────────────────────────────────────

def clear_vram():
    """Aggressively clear Apple Silicon unified memory."""
    try:
        import mlx.core as mx
        mx.clear_cache()
        logger.info("MLX cache cleared")
    except ImportError:
        logger.warning("mlx not available, skipping cache clear")
    # Multiple gc passes to break reference cycles
    gc.collect()
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
    # Also purge any cached modules that hold weight tensors
    mods_to_purge = [k for k in sys.modules if k.startswith(("mlx_video", "ltx_video"))]
    for mod in mods_to_purge:
        del sys.modules[mod]
    if mods_to_purge:
        clear_vram()
        logger.info(f"Purged cached modules: {mods_to_purge}")

# ── Video Generation (LTX-2 via mlx-video or ltx_video) ─────

def _clamp_resolution(width: int, height: int) -> tuple[int, int]:
    """Clamp resolution to MAX_WIDTH/MAX_HEIGHT and pixel budget.
    Dimensions must be divisible by 64 for mlx-video."""
    w = min(width, MAX_WIDTH)
    h = min(height, MAX_HEIGHT)
    # Also enforce total pixel area
    if w * h > MAX_PIXELS:
        scale = (MAX_PIXELS / (w * h)) ** 0.5
        w = int(w * scale)
        h = int(h * scale)
    # Round down to nearest multiple of 64 (mlx-video requirement)
    w = max(w // 64 * 64, 64)
    h = max(h // 64 * 64, 64)
    return w, h


def _snap_frames(num_frames: int) -> int:
    """Snap frame count to nearest valid 8n+1 value (9, 17, 25, 33, ...).
    mlx-video requires num_frames % 8 == 1."""
    if num_frames < 9:
        return 9
    # Round to nearest 8n+1
    n = round((num_frames - 1) / 8)
    return max(1 + 8 * n, 9)


def generate_video_ltx2(request: GenerateRequest) -> bytes:
    """
    Generate video using LTX-2 distilled model on MLX.
    Returns encoded MP4 bytes.
    """
    # Enforce frame limit and snap to valid 8n+1
    num_frames = _snap_frames(min(request.num_frames, MAX_VIDEO_FRAMES))
    fps = request.fps or DEFAULT_FPS

    # Clamp resolution to prevent memory explosion (must be divisible by 64)
    request.width, request.height = _clamp_resolution(request.width, request.height)
    logger.info(f"Resolved generation params: {request.width}x{request.height}, {num_frames} frames")

    # Pre-flight memory check
    ok, reason = check_memory_budget()
    if not ok:
        logger.warning(f"Memory pre-check failed: {reason} — unloading model first")
        unload_model()
        # Re-check after cleanup
        ok2, reason2 = check_memory_budget()
        if not ok2:
            raise MemoryError(f"Insufficient memory even after cleanup: {reason2}")

    # Check if we need to swap models
    target_model = "ltx-2"
    # Audio generation requires the full BF16 model — override the repo when audio is enabled.
    if request.audio and not request.model_repo:
        resolved_repo = "mlx-community/LTX-2-dev-bf16"
        logger.info("Audio requested — forcing model repo: mlx-community/LTX-2-dev-bf16")
    else:
        resolved_repo = request.model_repo or DEFAULT_MODEL_REPO
    if state._model_name != target_model or state.loaded_model != resolved_repo:
        unload_model()
        state.loaded_model = resolved_repo
        state._model_name = target_model
        logger.info(f"Loading LTX-2 model: {resolved_repo}")

    with tempfile.TemporaryDirectory() as tmpdir:
        output_raw = Path(tmpdir) / "raw_video.mp4"
        output_final = Path(tmpdir) / "output.mp4"

        # Try mlx-video first, fall back to ltx_video inference
        try:
            _generate_with_mlx_video(request, num_frames, fps, str(output_raw))
        except ImportError:
            _generate_with_ltx_inference(request, num_frames, fps, str(output_raw))

        raw_size = output_raw.stat().st_size if output_raw.exists() else 0
        logger.info(f"MLX generation complete. Raw video: {raw_size:,} bytes — starting H.264 re-encode...")

        # If audio was requested, verify the generated video actually has an audio stream.
        # generate_video() silently omits audio when the loaded model doesn't support it.
        if request.audio and not _raw_has_audio_stream(str(output_raw)):
            raise RuntimeError(
                "Audio was requested but the generated video contains no audio stream. "
                "Ensure the LTX worker is using mlx-community/LTX-2-dev-bf16 (the full BF16 model). "
                "The Q4 quantized model (AITRADER/ltx2-distilled-4bit-mlx) does not support audio generation."
            )

        # Re-encode with h264_videotoolbox for Apple Silicon hardware encoding
        _encode_with_videotoolbox(str(output_raw), str(output_final), fps, has_audio=request.audio)

        final_size = output_final.stat().st_size if output_final.exists() else 0
        logger.info(f"Re-encode complete: {final_size:,} bytes — reading into memory...")
        result = output_final.read_bytes()
        logger.info(f"Read complete: {len(result):,} bytes — returning to job runner")
        return result


def _generate_with_mlx_video(request: GenerateRequest, num_frames: int, fps: int, output_path: str):
    """Generate using the mlx-video Python package (CharafChnioune fork).

    The CharafChnioune fork performs runtime quantization from BF16 base weights
    instead of using pre-quantized AITRADER snapshots (which cause 'snow'/static).
    """
    try:
        from mlx_video.generate import generate_video, PipelineType  # type: ignore[import-untyped]
    except ImportError:
        # Legacy Blaizzy fork path (kept for backward compatibility)
        from mlx_video.models.ltx_2.generate import generate_video, PipelineType  # type: ignore[import-untyped]

    # Resolve pipeline type via getattr — available variants depend on
    # the installed mlx-video version.  Missing entries (e.g. DEV_TWO_STAGE)
    # gracefully fall back to DISTILLED instead of crashing at dict-build time.
    pipeline_name = request.pipeline.upper().replace("-", "_")
    pipeline_type = getattr(PipelineType, pipeline_name, PipelineType.DISTILLED)
    use_dev = request.pipeline.lower() in ("dev", "dev-two-stage", "dev-two-stage-hq")

    resolved_model_repo = request.model_repo or DEFAULT_MODEL_REPO

    kwargs: dict = {
        "prompt": request.prompt,
        "model_repo": resolved_model_repo,
        "text_encoder_repo": DEFAULT_TEXT_ENCODER_REPO,
        "pipeline": pipeline_type,
        "width": request.width,
        "height": request.height,
        "num_frames": num_frames,
        "fps": fps,
        "output_path": output_path,
        "tiling": request.tiling,
        "audio": request.audio,
        "verbose": True,
        "enhance_prompt": request.enhance_prompt,
        "negative_prompt": request.negative_prompt or "worst quality, inconsistent motion, blurry, jittery, distorted",
    }

    if use_dev:
        kwargs["cfg_scale"] = request.cfg_scale if request.cfg_scale is not None else 4.5
        kwargs["num_inference_steps"] = request.num_inference_steps if request.num_inference_steps is not None else 20

    if request.seed is not None:
        kwargs["seed"] = request.seed

    if request.init_image and request.type == "img2video":
        # Decode init image and save to temp file
        img_bytes = base64.b64decode(request.init_image)
        img_path = output_path.replace(".mp4", "_init.png")
        Path(img_path).write_bytes(img_bytes)
        kwargs["image"] = img_path
        kwargs["image_strength"] = request.image_strength

    generate_video(**kwargs)


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


def _raw_has_audio_stream(path: str) -> bool:
    """Return True if the file at *path* contains at least one audio stream."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "a",
                "-show_entries", "stream=codec_type",
                "-of", "csv=p=0",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return bool(result.stdout.strip())
    except Exception as e:
        logger.warning(f"ffprobe audio-stream check failed: {e}")
        return False


def _encode_with_videotoolbox(input_path: str, output_path: str, fps: int, has_audio: bool = False):
    """Re-encode MP4 using Apple's h264_videotoolbox hardware encoder.
    When has_audio is True, copies the audio stream from the input."""
    audio_args = ["-c:a", "aac", "-b:a", "192k"] if has_audio else ["-an"]
    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-c:v", "h264_videotoolbox",
        "-b:v", "8M",
        "-fps_mode", "cfr",
        "-r", str(fps),
        "-pix_fmt", "yuv420p",
        *audio_args,
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
            *audio_args,
            "-movflags", "+faststart",
            output_path,
        ]
        subprocess.run(cmd_fallback, capture_output=True, text=True, timeout=120, check=True)


# ── Progress Reporting (#762) ────────────────────────────────

_last_progress_time: float = 0.0
_PROGRESS_THROTTLE_SEC: float = 0.5  # Max 2 POSTs/second


def _is_safe_callback_url(url: str) -> bool:
    """Validate that a callback URL targets a private/loopback host (SSRF guard)."""
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        host = parsed.hostname or ""
        if host in ("localhost", "127.0.0.1", "::1"):
            return True
        try:
            addr = ipaddress.ip_address(host)
            return addr.is_private or addr.is_loopback
        except ValueError:
            # Hostname, not IP — allow .local mDNS names (common in LAN setups)
            return host.endswith(".local")
    except Exception:
        return False


async def _report_progress(
    job_id: str,
    progress_url: str | None,
    stage: str,
    progress: int,
    message: str = "",
) -> None:
    """POST a progress update to the Node.js server (throttled to 2/sec)."""
    global _last_progress_time
    if not progress_url:
        return
    if not _is_safe_callback_url(progress_url):
        logger.warning(f"Rejected progress_url with non-private host: {progress_url}")
        return
    now = time.monotonic()
    if now - _last_progress_time < _PROGRESS_THROTTLE_SEC:
        return
    _last_progress_time = now
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(progress_url, json={
                "job_id": job_id,
                "stage": stage,
                "progress": progress,
                "message": message,
            })
    except Exception as e:
        logger.debug(f"Progress report failed (non-fatal): {e}")


# ── Async Job Runner ─────────────────────────────────────────

async def run_generation_job(request: GenerateRequest):
    """Run the generation in background and POST result back via webhook."""
    start = time.time()
    try:
        await state.set_busy(True)
        logger.info(f"Starting job {request.job_id} ({request.type}) callback_url={request.callback_url}")

        # Report initial progress (#762)
        await _report_progress(request.job_id, request.progress_url, "Initializing", 0, "Loading model…")

        # Run CPU/GPU-bound generation in a thread pool
        if request.type in ("txt2video", "img2video"):
            await _report_progress(request.job_id, request.progress_url, "Generating", 10, "Model loaded, generating video…")
            media_bytes = await asyncio.get_event_loop().run_in_executor(
                None, generate_video_ltx2, request
            )
            media_type = "video/mp4"
        else:
            raise ValueError(f"Unsupported job type: {request.type}")

        elapsed = time.time() - start
        logger.info(f"Job {request.job_id} generation done in {elapsed:.1f}s ({len(media_bytes)} bytes)")

        # Report encoding progress (#762)
        await _report_progress(request.job_id, request.progress_url, "Encoding", 80, "Re-encoding with H.264…")

        # Encode + POST result — this can take several seconds for large videos
        logger.info(f"Job {request.job_id} encoding base64 ({len(media_bytes):,} bytes)...")
        media_b64 = base64.b64encode(media_bytes).decode("ascii")
        logger.info(f"Job {request.job_id} base64 ready ({len(media_b64):,} chars), sending callback...")

        # Send result back to Node.js via webhook
        payload = {
            "job_id": request.job_id,
            "status": "complete",
            "media_base64": media_b64,
            "media_type": media_type,
            "metadata": {
                "generation_time": round(elapsed, 2),
                "width": request.width,
                "height": request.height,
                "num_frames": min(request.num_frames, MAX_VIDEO_FRAMES),
                "fps": request.fps,
                "model": request.model_repo or DEFAULT_MODEL_REPO,
                "pipeline": request.pipeline,
                "duration": round(min(request.num_frames, MAX_VIDEO_FRAMES) / request.fps, 2),
                "audio": request.audio,
                "tiling": request.tiling,
                "enhance_prompt": request.enhance_prompt,
            },
        }

        validated_url = validate_callback_url(request.callback_url)
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(validated_url, json=payload, headers=_callback_auth_headers())
            logger.info(f"Webhook callback: {resp.status_code}")

        # Store result for polling fallback regardless of callback success
        _store_result(request.job_id, payload)

        # Report completion progress (#762)
        await _report_progress(request.job_id, request.progress_url, "Complete", 100, "Video delivered")

    except Exception as e:
        elapsed = time.time() - start
        logger.error(f"Job {request.job_id} failed after {elapsed:.1f}s: {e}")

        # Notify failure
        error_payload = {
            "job_id": request.job_id,
            "status": "failed",
            "error": str(e),
        }
        _store_result(request.job_id, error_payload)
        try:
            validated_url = validate_callback_url(request.callback_url)
            async with httpx.AsyncClient(timeout=30.0) as client:
                await client.post(validated_url, json=error_payload, headers=_callback_auth_headers())
        except Exception as webhook_err:
            logger.error(f"Failed to send error webhook: {webhook_err}")

    finally:
        await state.set_busy(False)
        state._last_job_time = time.time()
        # Always unload + clear after generation to prevent memory accumulation
        unload_model()
        state.loaded_model = None
        mem = get_system_memory_info()
        logger.info(f"Post-job memory: RSS={mem.get('process_rss_gb', '?')} GB, "
                    f"system free={mem.get('free_gb', '?')} GB")


# ── FastAPI App ──────────────────────────────────────────────

async def _idle_model_reaper():
    """Background task: unload model if idle for too long."""
    while True:
        await asyncio.sleep(60)  # check every minute
        if (
            state._model_name is not None
            and not state.is_busy
            and state._last_job_time > 0
            and (time.time() - state._last_job_time) > MODEL_IDLE_TIMEOUT_SEC
        ):
            logger.info(
                f"Model idle for >{MODEL_IDLE_TIMEOUT_SEC}s — unloading to reclaim memory"
            )
            unload_model()
            state.loaded_model = None
            mem = get_system_memory_info()
            logger.info(f"After idle unload: RSS={mem.get('process_rss_gb', '?')} GB")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Prevent MLX buffer cache from ballooning into swap (GitHub MLX #3129).
    import mlx.core as mx
    _cache_mb = int(os.environ.get("MLX_CACHE_LIMIT_MB", "512"))
    mx.set_cache_limit(_cache_mb * 1024 * 1024)
    logger.info(f"MLX cache limit set to {_cache_mb}MB")

    # Wire GPU memory to prevent kIOGPUCommandBufferCallbackErrorImpactingInteractivity
    # watchdog on M2 (macOS 15+). MLX docs: "useful on macOS 15.0 or higher".
    # Equivalent to: sudo sysctl iogpu.wired_limit_mb=<mb>
    _wired_mb = int(os.environ.get("MLX_WIRED_LIMIT_MB", "0"))
    if _wired_mb > 0:
        try:
            old_limit = mx.set_wired_limit(_wired_mb * 1024 * 1024)
            logger.info(f"MLX wired limit set to {_wired_mb}MB (was {old_limit // (1024*1024)}MB)")
        except Exception as _e:
            logger.warning(f"MLX wired limit not set: {_e}")

    logger.info("M2 Pro Worker starting up")
    mem = get_system_memory_info()
    logger.info(
        f"Memory budget: {MEMORY_LIMIT_GB:.0f} GB limit, "
        f"system free={mem.get('free_gb', '?')} GB, "
        f"idle timeout={MODEL_IDLE_TIMEOUT_SEC}s"
    )
    reaper = asyncio.create_task(_idle_model_reaper())
    yield
    reaper.cancel()
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


@app.get("/job-result/{job_id}")
async def get_job_result(job_id: str):
    """Poll for a completed job result.  Returns the same payload that would
    have been POSTed to the callback URL.  Returns 404 if the job is unknown
    or still in progress.  The result is deleted after retrieval (ack)."""
    with _job_results_lock:
        result = _job_results.pop(job_id, None)
    if result is None:
        raise HTTPException(status_code=404, detail="No result for this job")
    return result


@app.get("/memory")
async def memory_info():
    """Detailed memory diagnostics endpoint."""
    info = get_system_memory_info()
    ok, reason = check_memory_budget()
    return {
        **info,
        "memory_limit_gb": MEMORY_LIMIT_GB,
        "within_budget": ok,
        "budget_status": reason,
        "model_loaded": state._model_name,
    }


@app.get("/models")
async def list_models():
    """List available LTX model catalog with memory requirements."""
    return {
        "models": [
            {
                "id": "ltx-2-distilled-q4",
                "repo": "AITRADER/ltx2-distilled-4bit-mlx",
                "name": "LTX-2 Distilled Q4",
                "memory_gb": 19,
                "download_gb": 19,
                "version": "2.0",
                "audio": True,
                "pipelines": ["distilled", "dev"],
            },
            {
                "id": "ltx-2.3-distilled-q4",
                "repo": "dgrauet/ltx-2.3-mlx-distilled-q4",
                "name": "LTX-2.3 Distilled Q4",
                "memory_gb": 20,
                "download_gb": 41,
                "version": "2.3",
                "audio": True,
                "pipelines": ["distilled", "dev", "dev-two-stage", "dev-two-stage-hq"],
                "warning": "Large download (~41 GB). Ensure sufficient disk space before selecting.",
            },
        ],
        "default_repo": DEFAULT_MODEL_REPO,
        "memory_limit_gb": MEMORY_LIMIT_GB,
        "valid_pipelines": ["distilled", "dev", "dev-two-stage", "dev-two-stage-hq"],
        "valid_tiling_modes": ["auto", "none", "default", "aggressive", "conservative"],
    }


@app.post("/unload", dependencies=[Depends(verify_token)])
async def unload():
    """Unload the current model and free VRAM.
    Used by QueueMaster for cross-sidecar VRAM coordination."""
    status = await state.get_status()
    if status["is_busy"]:
        raise HTTPException(status_code=409, detail="Worker is busy, cannot unload")
    prev = state.loaded_model
    unload_model()
    state.loaded_model = None
    return {"status": "unloaded", "previous_model": prev}


# Safe directory for video file access — only files within this directory
# (or subdirectories) are permitted for the /last-frame endpoint.
GALLERY_DIR = Path(os.environ.get("GALLERY_DIR", str(Path.home() / ".openzigs" / "gallery"))).resolve()


class LastFrameRequest(BaseModel):
    video_path: str = Field(..., min_length=1, max_length=1024)


@app.post("/last-frame", dependencies=[Depends(verify_token)])
async def extract_last_frame(request: LastFrameRequest):
    """Extract the last frame of a video file as a base64-encoded PNG.
    Used for multi-segment video chaining — segment N's last frame
    becomes segment N+1's init_image for visual continuity.
    """
    video_path = request.video_path
    # Security: resolve path and restrict to gallery directory (path traversal protection)
    vp = Path(video_path).resolve()
    if not vp.is_relative_to(GALLERY_DIR):
        raise HTTPException(status_code=403, detail="Access denied: path outside gallery directory")
    if not vp.exists():
        raise HTTPException(status_code=404, detail="Video file not found")
    if not vp.is_file():
        raise HTTPException(status_code=400, detail="Path is not a regular file")
    # Only allow video files
    suffix = vp.suffix.lower()
    if suffix not in (".mp4", ".mov", ".mkv", ".webm", ".avi"):
        raise HTTPException(status_code=400, detail=f"Unsupported video format: {suffix}")

    try:
        result = subprocess.run(
            [
                "ffmpeg", "-sseof", "-0.1",
                "-i", str(vp),
                "-frames:v", "1",
                "-f", "image2pipe",
                "-vcodec", "png",
                "pipe:1",
            ],
            capture_output=True,
            timeout=30,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")[:500]
            logger.error(f"ffmpeg failed for {vp}: {stderr}")
            raise HTTPException(
                status_code=500,
                detail="Frame extraction failed",
            )
        if not result.stdout:
            raise HTTPException(status_code=500, detail="ffmpeg produced no output")
        image_base64 = base64.b64encode(result.stdout).decode("ascii")
        return {"image_base64": image_base64}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="ffmpeg timed out extracting last frame")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Last frame extraction failed: {str(e)}")


@app.post("/generate", status_code=202, dependencies=[Depends(verify_token)])
async def generate(request: GenerateRequest):
    """
    Accept a generation job. Returns 202 immediately.
    The actual generation runs in the background and results
    are sent via webhook to callback_url.
    """
    status = await state.get_status()
    if status["is_busy"]:
        raise HTTPException(status_code=429, detail="Worker is busy")

    # Audio generation requires mlx-community/LTX-2-dev-bf16 (~87 GB) which
    # will be auto-downloaded on first use.  Reject audio jobs until the
    # operator explicitly opts in by setting LTX_ALLOW_AUDIO=1.
    if request.audio and not os.getenv("LTX_ALLOW_AUDIO", ""):
        raise HTTPException(
            status_code=400,
            detail=(
                "Audio generation is disabled. Set LTX_ALLOW_AUDIO=1 in the worker "
                "environment to enable it (requires ~87 GB additional disk space for "
                "mlx-community/LTX-2-dev-bf16)."
            ),
        )

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
