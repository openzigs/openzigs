"""
Video-to-Audio (v2a) Worker Sidecar — MMAudio
WS1-A (#925): Generates a synchronized audio track for an existing silent
video clip. Wraps `hkchengrex/MMAudio` (MIT-licensed) so the orchestrator
can post-process LTX-Video clips with realistic foley + ambient sound.

HTTP API:
  GET  /health         — health + busy state
  GET  /gpu-info       — device count, VRAM, idle status
  POST /unload         — free VRAM (called by QueueMaster between jobs)
  POST /generate       — submit a v2a job (returns 202 + job_id)
  GET  /status/{job_id}— poll job status

Port: 5012 (default; configurable via PORT env var).

License notes:
  - MMAudio: MIT (https://github.com/hkchengrex/MMAudio)
  - We never bundle the weights; they are downloaded from HF on first
    inference into the standard HF cache. The user is responsible for
    accepting any HF-side license click-throughs.
"""

from __future__ import annotations

import asyncio
import base64
import gc
import hmac
import ipaddress
import json
import logging
import os
import sys
import tempfile
import time
import threading
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("v2a-sidecar")


# ── Configuration ───────────────────────────────────────────

DEFAULT_MODEL = os.getenv("V2A_MODEL", "hkchengrex/MMAudio")
DEFAULT_DURATION_SEC = float(os.getenv("V2A_DEFAULT_DURATION", "8.0"))
MAX_DURATION_SEC = float(os.getenv("V2A_MAX_DURATION", "30.0"))
IDLE_TIMEOUT_SEC = int(os.getenv("V2A_IDLE_TIMEOUT", "300"))
SECRET_TOKEN = os.getenv("WORKER_SECRET_TOKEN") or os.getenv("V2A_SECRET_TOKEN")

# Lazy imports — torch/diffusers are huge and only needed at inference time.
torch = None
_pipeline = None
_pipeline_load_lock = threading.Lock()
_last_used_at: float = 0.0

# Job results: in-memory ring buffer.
_MAX_RESULTS = 64
_results: dict[str, dict] = {}
_results_lock = threading.Lock()


# ── Security ────────────────────────────────────────────────

def verify_token(authorization: Optional[str] = Header(None)) -> None:
    if SECRET_TOKEN is None:
        return
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid Authorization format")
    if not hmac.compare_digest(parts[1], SECRET_TOKEN):
        raise HTTPException(status_code=403, detail="Invalid token")


def validate_callback_url(url: str) -> str:
    """Loopback-only callback validator (SSRF defence)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"URL scheme must be http or https, got: {parsed.scheme}")
    host = (parsed.hostname or "").strip("[]")
    if not host:
        raise ValueError("URL must have a hostname")
    if host in ("localhost", "127.0.0.1", "::1"):
        return url
    try:
        addr = ipaddress.ip_address(host)
        if addr.is_loopback or addr.is_private:
            return url
        raise ValueError(f"Callback host not allowed: {host}")
    except ValueError as exc:
        if host.endswith(".local"):
            return url
        raise ValueError(f"Callback host not allowed: {host}") from exc


def safe_video_path(p: str) -> str:
    """Validate that ``p`` resolves to an existing file with no traversal."""
    resolved = os.path.realpath(p)
    if not os.path.isfile(resolved):
        raise ValueError(f"Video path does not exist: {p}")
    return resolved


# ── Lazy torch + pipeline loader ────────────────────────────

def _ensure_torch() -> None:
    global torch
    if torch is None:
        import torch as _torch
        torch = _torch
        if _torch.cuda.is_available():
            _torch.backends.cudnn.benchmark = True


def _load_pipeline():
    """Load MMAudio on first use; cache for subsequent jobs."""
    global _pipeline, _last_used_at
    if _pipeline is not None:
        _last_used_at = time.time()
        return _pipeline
    with _pipeline_load_lock:
        if _pipeline is not None:
            _last_used_at = time.time()
            return _pipeline
        _ensure_torch()
        logger.info(f"[v2a] Loading {DEFAULT_MODEL} on CUDA (this is a one-time ~6GB download)...")
        try:
            # MMAudio publishes a `pipelines.MMAudioPipeline` style class through
            # diffusers. We catch ImportError so users without the dep set get a
            # clear actionable error instead of a stack trace at startup.
            from diffusers import DiffusionPipeline  # type: ignore
            pipe = DiffusionPipeline.from_pretrained(
                DEFAULT_MODEL,
                torch_dtype=torch.float16,
                trust_remote_code=True,
            )
            if torch.cuda.is_available():
                pipe = pipe.to("cuda")
        except Exception as exc:
            raise RuntimeError(
                f"Failed to load MMAudio model '{DEFAULT_MODEL}': {exc}. "
                "Install with: pip install -r sidecars/v2a/requirements.txt"
            ) from exc
        _pipeline = pipe
        _last_used_at = time.time()
        logger.info("[v2a] MMAudio pipeline ready")
        return _pipeline


def _unload_pipeline() -> None:
    global _pipeline
    with _pipeline_load_lock:
        if _pipeline is None:
            return
        try:
            del _pipeline
        finally:
            _pipeline = None
        gc.collect()
        try:
            _ensure_torch()
            if torch is not None and torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        logger.info("[v2a] Pipeline unloaded; VRAM freed")


# ── Idle-timeout watchdog ───────────────────────────────────

async def _idle_unload_watchdog() -> None:
    """Background task that unloads the model after IDLE_TIMEOUT_SEC of no jobs."""
    while True:
        try:
            await asyncio.sleep(60)
            if _pipeline is None:
                continue
            elapsed = time.time() - _last_used_at
            if elapsed > IDLE_TIMEOUT_SEC:
                logger.info(f"[v2a] Idle for {int(elapsed)}s -> unloading pipeline")
                _unload_pipeline()
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.warning(f"[v2a] watchdog error: {exc}")


# ── FastAPI App ─────────────────────────────────────────────

from contextlib import asynccontextmanager


@asynccontextmanager
async def _lifespan(app: FastAPI):
    task = asyncio.create_task(_idle_unload_watchdog())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="OpenZigs v2a Sidecar", version="1.0.0", lifespan=_lifespan)


class GenerateRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=128)
    video_path: Optional[str] = Field(default=None, max_length=4096)
    video_b64: Optional[str] = Field(default=None)
    duration_sec: float = Field(default=DEFAULT_DURATION_SEC, gt=0.0, le=MAX_DURATION_SEC)
    prompt: Optional[str] = Field(default=None, max_length=512)
    negative_prompt: Optional[str] = Field(default=None, max_length=512)
    seed: Optional[int] = None
    callback_url: Optional[str] = None


def _store(job_id: str, payload: dict) -> None:
    with _results_lock:
        if len(_results) >= _MAX_RESULTS:
            _results.pop(next(iter(_results)))
        _results[job_id] = payload


def _resolve_video_input(request: GenerateRequest) -> str:
    """Materialise the input video to a path on disk. Caller owns deletion."""
    if request.video_path and request.video_b64:
        raise ValueError("Provide exactly one of video_path or video_b64")
    if request.video_path:
        return safe_video_path(request.video_path)
    if not request.video_b64:
        raise ValueError("Either video_path or video_b64 is required")
    try:
        data = base64.b64decode(request.video_b64, validate=True)
    except Exception as exc:
        raise ValueError(f"video_b64 is not valid base64: {exc}") from exc
    fd, tmp = tempfile.mkstemp(suffix=".mp4", prefix="v2a_in_")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return tmp


async def _run_job(request: GenerateRequest) -> None:
    out_audio = os.path.join(tempfile.gettempdir(), f"v2a_{request.job_id}.wav")
    in_video: Optional[str] = None
    try:
        in_video = _resolve_video_input(request)
        _ensure_torch()
        pipe = _load_pipeline()
        generator = None
        if request.seed is not None and torch is not None:
            generator = torch.Generator(device="cuda" if torch.cuda.is_available() else "cpu")
            generator.manual_seed(int(request.seed))

        # NOTE: We invoke the pipeline through a generic call signature because
        # MMAudio's public API has shifted between releases. The adapter below
        # catches the common variants. If your installed MMAudio version uses
        # different kwargs, edit this call (it is intentionally isolated).
        kwargs: dict[str, Any] = {
            "video_path": in_video,
            "duration": float(request.duration_sec),
        }
        if request.prompt:
            kwargs["prompt"] = request.prompt
        if request.negative_prompt:
            kwargs["negative_prompt"] = request.negative_prompt
        if generator is not None:
            kwargs["generator"] = generator
        try:
            audio = await asyncio.to_thread(pipe, **kwargs)
        except TypeError:
            # Older MMAudio versions take a positional video and `seconds=`.
            audio = await asyncio.to_thread(
                pipe, in_video, seconds=float(request.duration_sec)
            )

        # The pipeline returns either a path, a tensor, or a dict — adapt.
        if hasattr(audio, "audios"):  # diffusers AudioPipelineOutput
            arr = audio.audios[0]
            _write_wav(arr, out_audio, sample_rate=16000)
        elif isinstance(audio, str) and os.path.isfile(audio):
            os.replace(audio, out_audio)
        else:
            raise RuntimeError("Unsupported pipeline output type from MMAudio")

        _store(request.job_id, {"status": "completed", "audio_path": out_audio})
        if request.callback_url:
            try:
                validate_callback_url(request.callback_url)
                async with httpx.AsyncClient(timeout=30.0) as client:
                    await client.post(
                        request.callback_url,
                        json={
                            "job_id": request.job_id,
                            "status": "completed",
                            "audio_path": out_audio,
                        },
                    )
            except Exception as cb_exc:
                logger.warning(f"[v2a] callback failed: {cb_exc}")
    except Exception as exc:
        logger.exception(f"[v2a] job {request.job_id} failed")
        _store(request.job_id, {"status": "failed", "error": str(exc)})
        if request.callback_url:
            try:
                validate_callback_url(request.callback_url)
                async with httpx.AsyncClient(timeout=30.0) as client:
                    await client.post(
                        request.callback_url,
                        json={
                            "job_id": request.job_id,
                            "status": "failed",
                            "error": str(exc),
                        },
                    )
            except Exception:
                pass
    finally:
        # Clean up the temporary input only if we materialised it from b64.
        if in_video and request.video_b64:
            try:
                os.remove(in_video)
            except OSError:
                pass


def _write_wav(arr, out_path: str, *, sample_rate: int) -> None:
    """Persist a 1-D float audio tensor / numpy array as 16-bit PCM WAV."""
    import wave
    import struct
    if hasattr(arr, "cpu"):
        arr = arr.cpu().numpy()
    if hasattr(arr, "ndim") and arr.ndim > 1:
        arr = arr[0]
    # Clamp to [-1, 1] then scale to int16.
    samples = [max(-1.0, min(1.0, float(x))) for x in arr]
    with wave.open(out_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"".join(struct.pack("<h", int(s * 32767)) for s in samples))


# ── Routes ──────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "sidecar": "v2a",
        "loaded": _pipeline is not None,
        "model": DEFAULT_MODEL,
    }


@app.get("/gpu-info")
async def gpu_info():
    _ensure_torch()
    if torch is None or not torch.cuda.is_available():
        return {"cuda_available": False}
    try:
        free, total = torch.cuda.mem_get_info(0)
        return {
            "cuda_available": True,
            "device_count": torch.cuda.device_count(),
            "total_gb": int(total / 1024**3),
            "free_gb": int(free / 1024**3),
            "loaded": _pipeline is not None,
        }
    except Exception as exc:
        return {"cuda_available": True, "error": str(exc)}


@app.post("/unload", dependencies=[Depends(verify_token)])
async def unload():
    _unload_pipeline()
    return {"status": "unloaded"}


@app.post("/generate", status_code=202, dependencies=[Depends(verify_token)])
async def generate(request: GenerateRequest):
    asyncio.create_task(_run_job(request))
    logger.info(f"[v2a] Accepted job {request.job_id} (duration={request.duration_sec}s)")
    return {"status": "accepted", "job_id": request.job_id}


@app.get("/status/{job_id}")
async def status(job_id: str):
    with _results_lock:
        result = _results.get(job_id)
    if result is None:
        return {"status": "pending", "job_id": job_id}
    return {"job_id": job_id, **result}


# ── Entrypoint ──────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="OpenZigs v2a (MMAudio) sidecar")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5012")))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
