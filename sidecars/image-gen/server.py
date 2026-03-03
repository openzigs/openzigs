"""
Image Generation Sidecar — MFLUX Native MLX Server
Issue #257: FastAPI wrapper around MFLUX for native Apple Silicon image generation.
Uses MLX (Apple's ML framework) for optimal Metal GPU utilization — 10-18x faster
than PyTorch MPS for FLUX-family models on Apple Silicon.

Features:
    - Lazy loading: No model loaded at startup — loads on first request
    - Runtime model switching: POST /model to switch between models
    - Auto-unload: Model unloaded after idle timeout to reclaim RAM
    - Native MLX quantization (4/8-bit) via MFLUX

Usage:
    cd sidecars/image-gen
    pip install -r requirements.txt
    python server.py [--port 5005] [--host 127.0.0.1]

Endpoints:
    POST /generate           — Generate an image from a text prompt (with optional LoRA)
    POST /generate-controlnet — Generate with ControlNet conditioning (Canny/Depth)
    POST /train              — Start DreamBooth LoRA training
    GET  /train-status       — Check training job status
    POST /model              — Load or switch the active model
    POST /unload             — Unload the current model to free RAM
    GET  /health             — Readiness probe (returns model status)
    GET  /models             — List available models
"""

from __future__ import annotations

import argparse
import base64
import gc
import io
import json
import logging
import os
import random
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException, Depends, Header
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel, Field

# ── Token Authentication ───────────────────────────────────────
# When FLUXQ_SECRET_TOKEN is set, all mutating endpoints require
# Authorization: Bearer <token>.  Health/models remain public.
_secret_token: Optional[str] = os.environ.get("FLUXQ_SECRET_TOKEN") or None


def verify_token(authorization: Optional[str] = Header(None)) -> None:
    """Dependency that checks the Bearer token if a secret is configured."""
    if _secret_token is None:
        return  # No token configured — open access (local-only mode)
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Expected 'Bearer <token>' format")
    import hmac
    if not hmac.compare_digest(parts[1], _secret_token):
        raise HTTPException(status_code=403, detail="Invalid token")


# ── Logging ────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("image-gen-sidecar")

# ── Model Registry ────────────────────────────────────────────
# MFLUX model keys map to the constructor + config used by the mflux library.
# Each entry holds enough info to instantiate the right MFLUX class.
MODEL_REGISTRY: dict[str, dict] = {
    "flux-schnell": {
        "mflux_alias": "schnell",
        "default_steps": 4,
        "default_guidance": 0.0,
        "recommended_width": 1024,
        "recommended_height": 576,
        "description": "FLUX.1 schnell — 4-step distilled via MFLUX (native MLX)",
    },
    "flux-dev": {
        "mflux_alias": "dev",
        "default_steps": 25,
        "default_guidance": 3.5,
        "recommended_width": 1024,
        "recommended_height": 576,
        "description": "FLUX.1 dev — high-quality guidance-distilled via MFLUX",
    },
    "flux-kontext": {
        "mflux_alias": "dev-kontext",
        "model_class": "kontext",
        "default_steps": 20,
        "default_guidance": 2.5,
        "recommended_width": 1024,
        "recommended_height": 1024,
        "description": "FLUX.1 Kontext — text-guided semantic image editing via MFLUX",
    },
}

# ── Global State ───────────────────────────────────────────────
_model: Any = None                  # MFLUX model instance
_model_name: Optional[str] = None   # None = no model loaded
_ready: bool = False                # True once server is accepting requests
_model_loaded: bool = False         # True when a model is in memory
_loading: bool = False              # True while a model load is underway
_last_used: float = 0.0            # monotonic time of last generation
_idle_timeout: float = 0.0         # seconds before auto-unload (0 = disabled)
_default_model: str = "flux-schnell"
_preload_at_startup: bool = False
_quantization: Optional[int] = 4    # MLX quantization bits: 4, 8, or None
_generating: bool = False           # True while an async background generation is running
_active_lora_paths: list[str] = []  # Currently loaded LoRA adapter paths

# ── Job Result Store ───────────────────────────────────────────
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
        # Evict oldest entries if over cap
        while len(_job_results) > _MAX_STORED_RESULTS:
            oldest = next(iter(_job_results))
            del _job_results[oldest]


def _create_mflux_model(model_key: str, lora_paths: Optional[list[str]] = None, lora_scales: Optional[list[float]] = None) -> Any:
    """Instantiate an MFLUX model for the given registry key, optionally with LoRA adapters."""
    spec = MODEL_REGISTRY[model_key]
    model_class = spec.get("model_class", "txt2img")

    start = time.monotonic()

    # Build LoRA kwargs if provided
    lora_kwargs: dict[str, Any] = {}
    if lora_paths:
        # Validate all paths exist
        for lp in lora_paths:
            if not os.path.isfile(lp):
                raise ValueError(f"LoRA file not found: {lp}")
        lora_kwargs["lora_paths"] = lora_paths
        if lora_scales:
            lora_kwargs["lora_scales"] = lora_scales

    if model_class == "kontext":
        from mflux.models.flux.variants.kontext.flux_kontext import Flux1Kontext

        log.info(f"Loading MFLUX Kontext model (quantize={_quantization}) ...")
        model = Flux1Kontext(quantize=_quantization)
    else:
        from mflux.models.flux.variants.txt2img.flux import Flux1

        alias = spec["mflux_alias"]
        lora_info = f", lora={len(lora_paths)} adapters" if lora_paths else ""
        log.info(f"Loading MFLUX model '{model_key}' (alias={alias}, quantize={_quantization}{lora_info}) ...")
        model = Flux1.from_name(alias, quantize=_quantization, **lora_kwargs)

    elapsed = time.monotonic() - start
    log.info(f"MFLUX model '{model_key}' ready in {elapsed:.1f}s "
             f"(quantize={_quantization})")
    return model


# ── Model lifecycle helpers ────────────────────────────────────

def _unload_model() -> None:
    """Unload the current model and free memory."""
    global _model, _model_name, _model_loaded, _active_lora_paths

    if _model is not None:
        model = _model_name or "unknown"
        log.info(f"Unloading model '{model}' to free memory ...")
        del _model
        _model = None
        gc.collect()
        # MLX holds a Metal memory pool that Python GC knows nothing about.
        # clear_cache() flushes it so unified memory is actually returned to the OS.
        try:
            import mlx.core as mx
            mx.metal.clear_cache()
            log.info(f"MLX Metal cache cleared (active={mx.metal.get_active_memory()//1024//1024}MB, cache={mx.metal.get_cache_memory()//1024//1024}MB)")
        except Exception as e:
            log.warning(f"Could not clear MLX Metal cache: {e}")
        log.info(f"Model '{model}' unloaded")

    _model_loaded = False
    _model_name = None
    _active_lora_paths = []


def _load_model(model_key: str, lora_paths: Optional[list[str]] = None, lora_scales: Optional[list[float]] = None) -> float:
    """Load a model, unloading any existing one first.

    Returns the time taken to load in seconds (0.0 if already loaded).
    """
    global _model, _model_name, _model_loaded, _loading, _last_used, _active_lora_paths

    # If LoRA paths changed, need to reload even if same model
    if _model_loaded and _model_name == model_key and (lora_paths or []) == (_active_lora_paths or []):
        return 0.0  # Already loaded with same config

    _loading = True
    try:
        if _model_loaded:
            _unload_model()

        start = time.monotonic()
        _model = _create_mflux_model(model_key, lora_paths=lora_paths, lora_scales=lora_scales)
        elapsed = time.monotonic() - start
        _model_name = model_key
        _model_loaded = True
        _active_lora_paths = lora_paths or []
        _last_used = time.monotonic()
        return elapsed
    finally:
        _loading = False


async def _idle_unload_loop() -> None:
    """Background task: periodically check for idle timeout and unload."""
    import asyncio

    while True:
        await asyncio.sleep(30)
        if (
            _idle_timeout > 0
            and _model_loaded
            and not _loading
            and _last_used > 0
            and (time.monotonic() - _last_used) > _idle_timeout
        ):
            idle_secs = time.monotonic() - _last_used
            log.info(
                f"Model idle for {idle_secs:.0f}s (threshold={_idle_timeout:.0f}s) "
                f"— auto-unloading to free RAM"
            )
            _unload_model()


def _post_callback(job_id: str, callback_url: Optional[str], payload: dict) -> None:
    """POST a job completion (or error) payload to the openzigs callback URL.

    Runs in a thread-pool thread via FastAPI BackgroundTasks, so blocking
    urllib is safe here.  Retries up to 3 times with exponential back-off to
    survive transient network hiccups (e.g. ARP refresh, Wi-Fi roaming).

    When *callback_url* is None or empty the result is only stored in the
    ring buffer for poll-based retrieval — no outbound HTTP request is made.
    """
    # Store result for poll-based retrieval (always, regardless of callback)
    _store_result(job_id, payload)
    if not callback_url:
        log.info(f"[async] Result for job {job_id} stored (no callback URL — polling only)")
        return
    body = json.dumps(payload).encode("utf-8")
    max_retries = 3
    for attempt in range(1, max_retries + 1):
        req = urllib.request.Request(
            callback_url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                log.info(f"[async] Callback for job {job_id} delivered: HTTP {resp.status}")
                return
        except urllib.error.HTTPError as e:
            log.error(f"[async] Callback for job {job_id} HTTP error: {e.code} {e.reason} → {callback_url}")
            return  # HTTP error = server reachable, don't retry
        except Exception as e:
            log.error(f"[async] Callback for job {job_id} attempt {attempt}/{max_retries} failed: {e} → {callback_url}")
            if attempt < max_retries:
                time.sleep(2 ** attempt)  # 2s, 4s
    log.error(f"[async] Callback for job {job_id} PERMANENTLY FAILED after {max_retries} attempts → {callback_url}")


def _bg_generate(
    job_id: str,
    callback_url: Optional[str],
    prompt: str,
    requested_model: str,
    width: int,
    height: int,
    steps: Optional[int],
    guidance: float,
    seed: int,
) -> None:
    """Sync background task: run txt2img and POST callback to openzigs."""
    global _last_used, _generating
    _generating = True
    try:
        if not _model_loaded or _model_name != requested_model:
            log.info(f"[async] Lazy-loading '{requested_model}' for job {job_id}")
            _load_model(requested_model)
        spec = MODEL_REGISTRY[requested_model]
        w = (width // 16) * 16
        h = (height // 16) * 16
        actual_steps = steps or spec["default_steps"]
        log.info(f"[async] generate job={job_id} model={_model_name} {w}x{h} steps={actual_steps} seed={seed}")
        start = time.monotonic()
        result = _model.generate_image(  # type: ignore[union-attr]
            seed=seed, prompt=prompt, num_inference_steps=actual_steps,
            height=h, width=w, guidance=guidance,
        )
        elapsed = time.monotonic() - start
        _last_used = time.monotonic()
        log.info(f"[async] generate done in {elapsed:.1f}s job={job_id}")
        buf = io.BytesIO()
        result.image.save(buf, format="PNG", optimize=True)
        media_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        _post_callback(job_id, callback_url, {
            "job_id": job_id,
            "status": "complete",
            "media_base64": media_b64,
            "media_type": "image/png",
            "metadata": {
                "model": _model_name or requested_model,
                "generation_time": f"{elapsed:.2f}s",
                "seed": str(seed),
            },
        })
    except Exception as e:
        log.error(f"[async] generate failed job={job_id}: {e}")
        _post_callback(job_id, callback_url, {"job_id": job_id, "status": "failed", "error": str(e)})
    finally:
        _generating = False


def _bg_img2img(
    job_id: str,
    callback_url: Optional[str],
    prompt: str,
    requested_model: str,
    source_path: str,
    effective_strength: float,
    width: int,
    height: int,
    steps: Optional[int],
    guidance: float,
    seed: int,
) -> None:
    """Sync background task: run img2img and POST callback to openzigs."""
    global _last_used, _generating
    _generating = True
    try:
        if not _model_loaded or _model_name != requested_model:
            log.info(f"[async] Lazy-loading '{requested_model}' for img2img job {job_id}")
            _load_model(requested_model)
        spec = MODEL_REGISTRY[requested_model]
        w = (width // 16) * 16
        h = (height // 16) * 16
        actual_steps = steps or spec["default_steps"]
        log.info(
            f"[async] img2img job={job_id} model={_model_name} {w}x{h} "
            f"steps={actual_steps} strength={effective_strength} seed={seed}"
        )
        start = time.monotonic()
        result = _model.generate_image(  # type: ignore[union-attr]
            seed=seed, prompt=prompt, num_inference_steps=actual_steps,
            height=h, width=w, guidance=guidance,
            image_path=source_path, image_strength=effective_strength,
        )
        elapsed = time.monotonic() - start
        _last_used = time.monotonic()
        log.info(f"[async] img2img done in {elapsed:.1f}s job={job_id}")
        buf = io.BytesIO()
        result.image.save(buf, format="PNG", optimize=True)
        media_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        _post_callback(job_id, callback_url, {
            "job_id": job_id,
            "status": "complete",
            "media_base64": media_b64,
            "media_type": "image/png",
            "metadata": {
                "model": _model_name or requested_model,
                "generation_time": f"{elapsed:.2f}s",
                "seed": str(seed),
            },
        })
    except Exception as e:
        log.error(f"[async] img2img failed job={job_id}: {e}")
        _post_callback(job_id, callback_url, {"job_id": job_id, "status": "failed", "error": str(e)})
    finally:
        _generating = False
        if os.path.exists(source_path) and tempfile.gettempdir() in source_path:
            try:
                os.unlink(source_path)
            except OSError:
                pass


def _bg_kontext(
    job_id: str,
    callback_url: Optional[str],
    prompt: str,
    source_path: str,
    width: int,
    height: int,
    steps: Optional[int],
    guidance: float,
    seed: int,
) -> None:
    """Sync background task: run Kontext editing and POST callback to openzigs."""
    global _last_used, _generating
    _generating = True
    kontext_key = "flux-kontext"
    try:
        if not _model_loaded or _model_name != kontext_key:
            log.info(f"[async] Loading Kontext model for job {job_id}")
            _load_model(kontext_key)
        spec = MODEL_REGISTRY[kontext_key]
        w = (width // 16) * 16
        h = (height // 16) * 16
        actual_steps = steps or spec["default_steps"]
        log.info(f"[async] kontext job={job_id} {w}x{h} steps={actual_steps} seed={seed}")
        start = time.monotonic()
        result = _model.generate_image(  # type: ignore[union-attr]
            seed=seed, prompt=prompt, num_inference_steps=actual_steps,
            height=h, width=w, guidance=guidance,
            image_path=source_path,
        )
        elapsed = time.monotonic() - start
        _last_used = time.monotonic()
        log.info(f"[async] kontext done in {elapsed:.1f}s job={job_id}")
        buf = io.BytesIO()
        result.image.save(buf, format="PNG", optimize=True)
        media_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        _post_callback(job_id, callback_url, {
            "job_id": job_id,
            "status": "complete",
            "media_base64": media_b64,
            "media_type": "image/png",
            "metadata": {
                "model": "flux-kontext",
                "generation_time": f"{elapsed:.2f}s",
                "seed": str(seed),
            },
        })
    except Exception as e:
        log.error(f"[async] kontext failed job={job_id}: {e}")
        _post_callback(job_id, callback_url, {"job_id": job_id, "status": "failed", "error": str(e)})
    finally:
        _generating = False
        if os.path.exists(source_path) and tempfile.gettempdir() in source_path:
            try:
                os.unlink(source_path)
            except OSError:
                pass


# ── Request / Response Models ──────────────────────────────────
class GenerateRequest(BaseModel):
    """Request body for image generation."""

    prompt: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="Text prompt describing the desired image",
    )
    model: Optional[str] = Field(
        default=None,
        description="Model to use (e.g. 'flux-schnell', 'flux-dev'). "
                    "If different from the loaded model, triggers a model switch.",
    )
    width: int = Field(
        default=1024,
        ge=256,
        le=2048,
        description="Output image width in pixels (must be divisible by 16)",
    )
    height: int = Field(
        default=1024,
        ge=256,
        le=2048,
        description="Output image height in pixels (must be divisible by 16)",
    )
    steps: Optional[int] = Field(
        default=None,
        ge=1,
        le=50,
        description="Number of inference steps (default: model-specific)",
    )
    guidance_scale: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=20.0,
        description="Classifier-free guidance scale (default: model-specific)",
    )
    seed: Optional[int] = Field(
        default=None,
        description="Random seed for reproducibility",
    )
    # LoRA character consistency fields
    lora_paths: Optional[list[str]] = Field(
        default=None,
        description="Paths to LoRA adapter .safetensors files",
    )
    lora_scales: Optional[list[float]] = Field(
        default=None,
        description="Scale factor for each LoRA adapter (default: 1.0 each)",
    )


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    model: Optional[str] = None
    device: str
    ready: bool
    model_loaded: bool = False
    is_busy: bool = False
    recommended_width: int = 1024
    recommended_height: int = 576
    available_models: list[str] = []


class Img2ImgRequest(BaseModel):
    """Request body for image-to-image generation.

    Supply the input image as either:
    - ``image``      — base64-encoded PNG/JPEG bytes (used by ImageGenService / remote callers)
    - ``image_path`` — absolute filesystem path on this server (local/same-machine use)
    Exactly one must be provided.
    """

    prompt: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="Text prompt describing the desired output image",
    )
    image: Optional[str] = Field(
        default=None,
        description="Base64-encoded source image (PNG/JPEG/WebP). Use this when calling from a remote machine.",
    )
    image_path: Optional[str] = Field(
        default=None,
        description="Absolute path to the input image on this server's filesystem. Use for local calls.",
    )
    # 'strength' is the field name ImageGenService sends; 'image_strength' is the alias
    strength: Optional[float] = Field(
        default=None,
        ge=0.01,
        le=1.0,
        description="How much to transform the input (0=no change, 1=ignore input). Alias: image_strength.",
    )
    image_strength: Optional[float] = Field(
        default=None,
        ge=0.01,
        le=1.0,
        description="Alias for 'strength'.",
    )
    model: Optional[str] = Field(
        default=None,
        description="Model to use. Defaults to the currently loaded model or server default.",
    )
    width: int = Field(
        default=1024,
        ge=256,
        le=2048,
        description="Output image width in pixels (must be divisible by 16)",
    )
    height: int = Field(
        default=1024,
        ge=256,
        le=2048,
        description="Output image height in pixels (must be divisible by 16)",
    )
    steps: Optional[int] = Field(
        default=None,
        ge=1,
        le=50,
        description="Number of inference steps (default: model-specific)",
    )
    guidance_scale: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=20.0,
        description="Classifier-free guidance scale (default: model-specific)",
    )
    seed: Optional[int] = Field(
        default=None,
        description="Random seed for reproducibility",
    )


class KontextRequest(BaseModel):
    """Request body for Kontext text-guided image editing.

    Supply the input image as either:
    - ``image``      — base64-encoded PNG/JPEG bytes (remote callers)
    - ``image_path`` — absolute filesystem path on this server (local use)
    At least one must be provided for image editing.
    """

    prompt: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="Editing instruction (e.g. 'Add a woman sitting on the hood of the car')",
    )
    image: Optional[str] = Field(
        default=None,
        description="Base64-encoded source image (PNG/JPEG/WebP).",
    )
    image_path: Optional[str] = Field(
        default=None,
        description="Absolute path to the input image on this server's filesystem.",
    )
    width: int = Field(
        default=1024,
        ge=256,
        le=2048,
        description="Output image width in pixels (must be divisible by 16)",
    )
    height: int = Field(
        default=1024,
        ge=256,
        le=2048,
        description="Output image height in pixels (must be divisible by 16)",
    )
    steps: Optional[int] = Field(
        default=None,
        ge=1,
        le=50,
        description="Number of inference steps (default: 20)",
    )
    guidance: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=20.0,
        description="Guidance scale (default: 2.5). Recommended range: 2.5–4.0.",
    )
    seed: Optional[int] = Field(
        default=None,
        description="Random seed for reproducibility",
    )


class ModelRequest(BaseModel):
    """Request body for model loading/switching."""

    model: str = Field(
        ...,
        description="Model key to load (e.g. 'flux-schnell', 'flux-dev')",
    )


class ModelResponse(BaseModel):
    """Response from model load/switch operations."""

    model: str
    device: str
    load_time_seconds: float
    quantized: str


class AsyncGenerateRequest(GenerateRequest):
    """Extends GenerateRequest with async callback fields."""

    job_id: str = Field(..., description="Job ID echoed in the callback payload")
    callback_url: Optional[str] = Field(None, description="URL to POST the result to on completion (omit to use polling only)")


class AsyncImg2ImgRequest(Img2ImgRequest):
    """Extends Img2ImgRequest with async callback fields."""

    job_id: str = Field(..., description="Job ID echoed in the callback payload")
    callback_url: Optional[str] = Field(None, description="URL to POST the result to on completion (omit to use polling only)")


class AsyncKontextRequest(KontextRequest):
    """Extends KontextRequest with async callback fields."""

    job_id: str = Field(..., description="Job ID echoed in the callback payload")
    callback_url: Optional[str] = Field(None, description="URL to POST the result to on completion (omit to use polling only)")


# ── Lifespan (startup/shutdown) ────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start server in lazy mode — no model loaded until first request."""
    import asyncio

    global _ready

    _ready = True

    if _preload_at_startup:
        log.info(f"Preloading model '{_default_model}' at startup ...")
        elapsed = _load_model(_default_model)
        log.info(f"Model '{_default_model}' preloaded in {elapsed:.1f}s")

    log.info(
        f"Sidecar ready — {'preloaded' if _preload_at_startup else 'lazy'} mode "
        f"({'model loaded' if _model_loaded else 'no model loaded'}, device=mlx, "
        f"default_model={_default_model}, "
        f"idle_timeout={'disabled' if _idle_timeout <= 0 else f'{_idle_timeout:.0f}s'})"
    )

    idle_task = asyncio.create_task(_idle_unload_loop())

    yield

    _ready = False
    idle_task.cancel()
    _unload_model()
    log.info("Sidecar shut down")


# ── FastAPI App ────────────────────────────────────────────────
app = FastAPI(
    title="OpenZigs Image Generation Sidecar",
    description="Local FLUX image generation server powered by MFLUX (native MLX). "
                "Lazy loading, runtime model switching, and auto-unload. "
                "Optimized for Apple Silicon.",
    version="3.0.0",
    lifespan=lifespan,
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


@app.get("/health", response_model=HealthResponse)
async def health():
    """Readiness probe for the sidecar."""
    spec = MODEL_REGISTRY.get(_model_name or _default_model, {})
    status = "loading" if _loading else ("ok" if _ready else "starting")
    return HealthResponse(
        status=status,
        model=_model_name,
        device="mlx",
        ready=_ready and not _loading,
        model_loaded=_model_loaded,
        is_busy=_generating,
        recommended_width=spec.get("recommended_width", 1024),
        recommended_height=spec.get("recommended_height", 576),
        available_models=list(MODEL_REGISTRY.keys()),
    )


@app.get("/models")
async def list_models():
    """List available models and their metadata."""
    models = []
    for key, spec in MODEL_REGISTRY.items():
        models.append({
            "key": key,
            "description": spec["description"],
            "recommended_width": spec["recommended_width"],
            "recommended_height": spec["recommended_height"],
            "default_steps": spec["default_steps"],
            "loaded": _model_loaded and _model_name == key,
        })
    return {"models": models, "active": _model_name, "device": "mlx"}


@app.post("/model", response_model=ModelResponse, dependencies=[Depends(verify_token)])
async def switch_model(req: ModelRequest):
    """Load or switch to a different model at runtime."""
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading:
        raise HTTPException(status_code=409, detail="A model is currently being loaded")
    if req.model not in MODEL_REGISTRY:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown model: {req.model}. Available: {list(MODEL_REGISTRY.keys())}",
        )

    elapsed = _load_model(req.model)
    quantized = str(_quantization) if _quantization else "none"

    if elapsed == 0.0:
        log.info(f"Model '{req.model}' already loaded")
    else:
        log.info(f"Switched to model '{req.model}' in {elapsed:.1f}s")

    return ModelResponse(
        model=req.model,
        device="mlx",
        load_time_seconds=round(elapsed, 1),
        quantized=quantized,
    )


@app.post("/unload", dependencies=[Depends(verify_token)])
async def unload_model():
    """Unload the current model to free RAM."""
    if not _model_loaded:
        return {"status": "no_model_loaded"}
    model = _model_name
    _unload_model()
    return {"status": "unloaded", "model": model}


@app.post("/generate", response_class=Response, dependencies=[Depends(verify_token)])
async def generate(req: GenerateRequest):
    """Generate an image from a text prompt.

    Returns a PNG image as binary response with Content-Type: image/png.
    The model is loaded lazily on first request if not already loaded.
    """
    global _last_used

    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading:
        raise HTTPException(status_code=409, detail="A model is currently being loaded")

    # ── Lazy load / model switch ───────────────────────────────
    requested_model = req.model or (_model_name if _model_loaded else _default_model)
    if requested_model not in MODEL_REGISTRY:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown model: {requested_model}. Available: {list(MODEL_REGISTRY.keys())}",
        )

    # Check if LoRA config changed (requires reload)
    needs_reload = not _model_loaded or _model_name != requested_model
    if not needs_reload and req.lora_paths:
        needs_reload = (req.lora_paths or []) != (_active_lora_paths or [])

    if needs_reload:
        log.info(f"Lazy-loading model '{requested_model}' for generation request ...")
        load_time = _load_model(requested_model, lora_paths=req.lora_paths, lora_scales=req.lora_scales)
        log.info(f"Model '{requested_model}' ready in {load_time:.1f}s")

    assert _model is not None

    # MFLUX requires dimensions divisible by 16
    width = (req.width // 16) * 16
    height = (req.height // 16) * 16

    spec = MODEL_REGISTRY[requested_model]
    steps = req.steps or spec["default_steps"]
    guidance = req.guidance_scale if req.guidance_scale is not None else spec["default_guidance"]
    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)

    log.info(
        f"Generating: prompt='{req.prompt[:80]}...' "
        f"model={_model_name} size={width}x{height} "
        f"steps={steps} guidance={guidance} seed={seed}"
    )
    start = time.monotonic()

    try:
        result = _model.generate_image(
            seed=seed,
            prompt=req.prompt,
            num_inference_steps=steps,
            height=height,
            width=width,
            guidance=guidance,
        )
        # GeneratedImage.image is a PIL.Image.Image
        pil_image = result.image
    except Exception as e:
        log.error(f"Generation failed: {e}")
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(e)}")

    elapsed = time.monotonic() - start
    _last_used = time.monotonic()
    log.info(f"Generated in {elapsed:.1f}s ({width}x{height}, model={_model_name})")

    buf = io.BytesIO()
    pil_image.save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "X-Generation-Time": f"{elapsed:.2f}s",
            "X-Image-Size": f"{width}x{height}",
            "X-Model": _model_name or "unknown",
            "X-Seed": str(seed),
        },
    )


@app.post("/img2img", response_class=Response, dependencies=[Depends(verify_token)])
async def img2img(req: Img2ImgRequest):
    """Transform an existing image guided by a text prompt.

    Supply the source image as either:
    - ``image``      — base64-encoded PNG/JPEG (used by ImageGenService / remote callers)
    - ``image_path`` — absolute filesystem path on this server (local use)

    Returns a PNG image as binary response.
    """
    import os
    import base64
    import tempfile
    global _last_used

    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading:
        raise HTTPException(status_code=409, detail="A model is currently being loaded")

    # ── Resolve source image to a local path ───────────────────
    tmp_file = None
    if req.image:
        # Decode base64 → temp file (MFLUX needs a filesystem path)
        try:
            img_bytes = base64.b64decode(req.image, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail="'image' is not valid base64")
        if len(img_bytes) > 20 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Image exceeds 20 MB limit")
        # Sniff format so MFLUX gets the right extension
        suffix = ".jpg" if img_bytes[:3] == b"\xff\xd8\xff" else ".png"
        tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp_file.write(img_bytes)
        tmp_file.close()
        source_path = tmp_file.name
    elif req.image_path:
        if not os.path.isfile(req.image_path):
            raise HTTPException(status_code=400, detail=f"image_path not found: {req.image_path}")
        source_path = req.image_path
    else:
        raise HTTPException(
            status_code=422,
            detail="Provide either 'image' (base64) or 'image_path' (server filesystem path)",
        )

    # 'strength' (ImageGenService) and 'image_strength' are both accepted
    effective_strength = req.strength if req.strength is not None else (
        req.image_strength if req.image_strength is not None else 0.8
    )

    # ── Lazy load / model switch ───────────────────────────────
    requested_model = req.model or (_model_name if _model_loaded else _default_model)
    if requested_model not in MODEL_REGISTRY:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown model: {requested_model}. Available: {list(MODEL_REGISTRY.keys())}",
        )

    if not _model_loaded or _model_name != requested_model:
        log.info(f"Lazy-loading model '{requested_model}' for img2img request ...")
        load_time = _load_model(requested_model)
        log.info(f"Model '{requested_model}' ready in {load_time:.1f}s")

    assert _model is not None

    width = (req.width // 16) * 16
    height = (req.height // 16) * 16

    spec = MODEL_REGISTRY[requested_model]
    steps = req.steps or spec["default_steps"]
    guidance = req.guidance_scale if req.guidance_scale is not None else spec["default_guidance"]
    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)

    log.info(
        f"img2img: prompt='{req.prompt[:80]}...' "
        f"model={_model_name} size={width}x{height} "
        f"steps={steps} guidance={guidance} seed={seed} "
        f"strength={effective_strength} input={'<base64>' if req.image else source_path}"
    )
    start = time.monotonic()

    try:
        result = _model.generate_image(
            seed=seed,
            prompt=req.prompt,
            num_inference_steps=steps,
            height=height,
            width=width,
            guidance=guidance,
            image_path=source_path,
            image_strength=effective_strength,
        )
        pil_image = result.image
    except Exception as e:
        log.error(f"img2img failed: {e}")
        raise HTTPException(status_code=500, detail=f"img2img failed: {str(e)}")
    finally:
        if tmp_file and os.path.exists(tmp_file.name):
            os.unlink(tmp_file.name)

    elapsed = time.monotonic() - start
    _last_used = time.monotonic()
    log.info(f"img2img done in {elapsed:.1f}s ({width}x{height}, model={_model_name})")

    buf = io.BytesIO()
    pil_image.save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "X-Generation-Time": f"{elapsed:.2f}s",
            "X-Image-Size": f"{width}x{height}",
            "X-Model": _model_name or "unknown",
            "X-Seed": str(seed),
        },
    )


@app.post("/kontext", response_class=Response, dependencies=[Depends(verify_token)])
async def kontext_edit(req: KontextRequest):
    """Edit an image using FLUX.1 Kontext text-guided editing.

    Kontext can add, remove, or modify objects in an image using natural
    language instructions — unlike img2img which only restyles.

    Supply the source image as either:
    - ``image``      — base64-encoded PNG/JPEG (remote callers)
    - ``image_path`` — filesystem path on this server (local use)

    Returns a PNG image as binary response.
    """
    import os
    import base64
    import tempfile
    global _last_used

    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading:
        raise HTTPException(status_code=409, detail="A model is currently being loaded")

    # ── Resolve source image to a local path ───────────────────
    tmp_file = None
    if req.image:
        try:
            img_bytes = base64.b64decode(req.image, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail="'image' is not valid base64")
        if len(img_bytes) > 20 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Image exceeds 20 MB limit")
        suffix = ".jpg" if img_bytes[:3] == b"\xff\xd8\xff" else ".png"
        tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp_file.write(img_bytes)
        tmp_file.close()
        source_path = tmp_file.name
    elif req.image_path:
        if not os.path.isfile(req.image_path):
            raise HTTPException(status_code=400, detail=f"image_path not found: {req.image_path}")
        source_path = req.image_path
    else:
        raise HTTPException(
            status_code=422,
            detail="Provide either 'image' (base64) or 'image_path' (server filesystem path)",
        )

    # ── Always use flux-kontext model ──────────────────────────
    kontext_key = "flux-kontext"
    if not _model_loaded or _model_name != kontext_key:
        log.info(f"Loading Kontext model for /kontext request ...")
        load_time = _load_model(kontext_key)
        log.info(f"Kontext model ready in {load_time:.1f}s")

    assert _model is not None

    width = (req.width // 16) * 16
    height = (req.height // 16) * 16

    spec = MODEL_REGISTRY[kontext_key]
    steps = req.steps or spec["default_steps"]
    guidance = req.guidance if req.guidance is not None else spec["default_guidance"]
    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)

    log.info(
        f"kontext: prompt='{req.prompt[:80]}...' "
        f"size={width}x{height} steps={steps} guidance={guidance} seed={seed} "
        f"input={'<base64>' if req.image else source_path}"
    )
    start = time.monotonic()

    try:
        result = _model.generate_image(
            seed=seed,
            prompt=req.prompt,
            num_inference_steps=steps,
            height=height,
            width=width,
            guidance=guidance,
            image_path=source_path,
        )
        pil_image = result.image
    except Exception as e:
        log.error(f"kontext failed: {e}")
        raise HTTPException(status_code=500, detail=f"kontext editing failed: {str(e)}")
    finally:
        if tmp_file and os.path.exists(tmp_file.name):
            os.unlink(tmp_file.name)

    elapsed = time.monotonic() - start
    _last_used = time.monotonic()
    log.info(f"kontext done in {elapsed:.1f}s ({width}x{height})")

    buf = io.BytesIO()
    pil_image.save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "X-Generation-Time": f"{elapsed:.2f}s",
            "X-Image-Size": f"{width}x{height}",
            "X-Model": "flux-kontext",
            "X-Seed": str(seed),
        },
    )


# ── ControlNet Endpoint ────────────────────────────────────────

class ControlNetRequest(BaseModel):
    """Request body for ControlNet-guided image generation."""

    prompt: str = Field(..., min_length=1, max_length=2000)
    controlnet_image_path: str = Field(..., description="Path to the control image (pose/edge map)")
    controlnet_strength: float = Field(default=0.4, ge=0.0, le=1.0, description="ControlNet influence strength")
    control_type: str = Field(default="canny", description="Control type: 'canny' or 'depth'")
    save_canny: bool = Field(default=False, description="Whether to save the extracted canny edge map")
    model: Optional[str] = Field(default=None)
    width: int = Field(default=1024, ge=256, le=2048)
    height: int = Field(default=1024, ge=256, le=2048)
    steps: Optional[int] = Field(default=None, ge=1, le=50)
    guidance_scale: Optional[float] = Field(default=None, ge=0.0, le=20.0)
    seed: Optional[int] = Field(default=None)
    lora_paths: Optional[list[str]] = Field(default=None)
    lora_scales: Optional[list[float]] = Field(default=None)


@app.post("/generate-controlnet", response_class=Response, dependencies=[Depends(verify_token)])
async def generate_controlnet(req: ControlNetRequest):
    """Generate an image using ControlNet conditioning (Canny edge or Depth).

    The controlnet_image_path should point to a reference image. MFLUX will
    extract Canny edges automatically and condition the generation on them.
    """
    global _last_used

    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading:
        raise HTTPException(status_code=409, detail="A model is currently being loaded")

    if not os.path.isfile(req.controlnet_image_path):
        raise HTTPException(status_code=400, detail=f"Control image not found: {req.controlnet_image_path}")

    requested_model = req.model or (_model_name if _model_loaded else _default_model)
    if requested_model not in MODEL_REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown model: {requested_model}")

    # Reload if model or LoRA config changed
    needs_reload = not _model_loaded or _model_name != requested_model
    if not needs_reload and req.lora_paths:
        needs_reload = (req.lora_paths or []) != (_active_lora_paths or [])
    if needs_reload:
        load_time = _load_model(requested_model, lora_paths=req.lora_paths, lora_scales=req.lora_scales)
        log.info(f"Model '{requested_model}' ready in {load_time:.1f}s")

    assert _model is not None

    width = (req.width // 16) * 16
    height = (req.height // 16) * 16
    spec = MODEL_REGISTRY[requested_model]
    steps = req.steps or spec["default_steps"]
    guidance = req.guidance_scale if req.guidance_scale is not None else spec["default_guidance"]
    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)

    log.info(
        f"ControlNet generate: prompt='{req.prompt[:80]}...' "
        f"control={req.control_type} strength={req.controlnet_strength} "
        f"model={_model_name} size={width}x{height}"
    )
    start = time.monotonic()

    try:
        result = _model.generate_image(
            seed=seed,
            prompt=req.prompt,
            num_inference_steps=steps,
            height=height,
            width=width,
            guidance=guidance,
            controlnet_image_path=req.controlnet_image_path,
            controlnet_strength=req.controlnet_strength,
            controlnet_save_canny=req.save_canny,
        )
        pil_image = result.image
    except Exception as e:
        log.error(f"ControlNet generation failed: {e}")
        raise HTTPException(status_code=500, detail=f"ControlNet generation failed: {str(e)}")

    elapsed = time.monotonic() - start
    _last_used = time.monotonic()
    log.info(f"ControlNet generated in {elapsed:.1f}s ({width}x{height})")

    buf = io.BytesIO()
    pil_image.save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "X-Generation-Time": f"{elapsed:.2f}s",
            "X-Image-Size": f"{width}x{height}",
            "X-Model": _model_name or "unknown",
            "X-Seed": str(seed),
            "X-Control-Type": req.control_type,
            "X-Control-Strength": str(req.controlnet_strength),
        },
    )


# ── Training Endpoint ──────────────────────────────────────────

class TrainRequest(BaseModel):
    """Request body for DreamBooth LoRA training via mflux-train."""

    train_config_path: str = Field(..., description="Path to the training config JSON file")


class TrainResponse(BaseModel):
    """Response from the training endpoint."""

    status: str
    message: str


# Training state
_training: bool = False
_train_process: Any = None


@app.post("/train", response_model=TrainResponse, dependencies=[Depends(verify_token)])
async def train_lora(req: TrainRequest, background_tasks: BackgroundTasks):
    """Start LoRA DreamBooth training using mflux-train.

    Fires off the training subprocess in the background.
    Poll GET /train-status for progress.
    """
    global _training

    if _training:
        raise HTTPException(status_code=409, detail="A training job is already in progress")

    if not os.path.isfile(req.train_config_path):
        raise HTTPException(status_code=400, detail=f"Config file not found: {req.train_config_path}")

    # Validate config JSON
    try:
        with open(req.train_config_path, "r") as f:
            config = json.load(f)
        if "examples" not in config:
            raise HTTPException(status_code=400, detail="Training config must contain 'examples' array")
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON in config: {e}")

    _training = True
    background_tasks.add_task(_bg_train, req.train_config_path)

    log.info(f"[train] Started LoRA training with config: {req.train_config_path}")
    return TrainResponse(status="accepted", message="Training started in background")


@app.get("/train-status")
async def train_status():
    """Check the status of the current training job."""
    return {
        "training": _training,
        "process_alive": _train_process is not None and _train_process.poll() is None if _train_process else False,
    }


def _bg_train(config_path: str) -> None:
    """Background task: run mflux-train subprocess."""
    import subprocess

    global _training, _train_process
    try:
        log.info(f"[train] Spawning mflux-train --train-config {config_path}")
        _train_process = subprocess.Popen(
            ["mflux-train", "--train-config", config_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        stdout, stderr = _train_process.communicate()
        rc = _train_process.returncode

        if rc == 0:
            log.info(f"[train] Training completed successfully")
            if stdout:
                log.info(f"[train] stdout: {stdout.decode()[-500:]}")
        else:
            log.error(f"[train] Training failed with exit code {rc}")
            if stderr:
                log.error(f"[train] stderr: {stderr.decode()[-500:]}")
    except Exception as e:
        log.error(f"[train] Training error: {e}")
    finally:
        _training = False
        _train_process = None
        # Reclaim VRAM after training
        gc.collect()
        try:
            import mlx.core as mx
            mx.metal.clear_cache()
        except Exception:
            pass


@app.post("/generate-async", status_code=202, dependencies=[Depends(verify_token)])
async def generate_async(req: AsyncGenerateRequest, background_tasks: BackgroundTasks):
    """Async txt2img — returns 202 immediately, POSTs result to callback_url.

    Callback payload: ``{ job_id, media_base64, media_type, metadata }``
    or ``{ job_id, error }`` on failure. Same format as the LTX-2 video worker.
    """
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading or _generating:
        raise HTTPException(status_code=409, detail="Server is busy with another generation")
    requested_model = req.model or (_model_name if _model_loaded else _default_model)
    if requested_model not in MODEL_REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown model: {requested_model}")
    spec = MODEL_REGISTRY[requested_model]
    guidance = req.guidance_scale if req.guidance_scale is not None else spec["default_guidance"]
    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)
    background_tasks.add_task(
        _bg_generate,
        req.job_id, req.callback_url,
        req.prompt, requested_model,
        req.width, req.height, req.steps, guidance, seed,
    )
    log.info(f"[async] generate job={req.job_id} accepted, callback={req.callback_url}")
    return {"job_id": req.job_id, "status": "accepted"}


@app.post("/img2img-async", status_code=202, dependencies=[Depends(verify_token)])
async def img2img_async(req: AsyncImg2ImgRequest, background_tasks: BackgroundTasks):
    """Async img2img — returns 202 immediately, POSTs result to callback_url.

    Source image is decoded and validated synchronously before returning 202
    so validation errors surface inline rather than silently in the callback.
    """
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading or _generating:
        raise HTTPException(status_code=409, detail="Server is busy with another generation")
    tmp_path: Optional[str] = None
    if req.image:
        try:
            img_bytes = base64.b64decode(req.image, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail="'image' is not valid base64")
        if len(img_bytes) > 20 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Image exceeds 20 MB limit")
        suffix = ".jpg" if img_bytes[:3] == b"\xff\xd8\xff" else ".png"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(img_bytes)
        tmp.close()
        tmp_path = tmp.name
    elif req.image_path:
        if not os.path.isfile(req.image_path):
            raise HTTPException(status_code=400, detail=f"image_path not found: {req.image_path}")
        tmp_path = req.image_path
    else:
        raise HTTPException(status_code=422, detail="Provide 'image' (base64) or 'image_path'")
    requested_model = req.model or (_model_name if _model_loaded else _default_model)
    if requested_model not in MODEL_REGISTRY:
        if tmp_path and tmp_path != req.image_path:
            os.unlink(tmp_path)
        raise HTTPException(status_code=400, detail=f"Unknown model: {requested_model}")
    spec = MODEL_REGISTRY[requested_model]
    effective_strength = req.strength if req.strength is not None else (
        req.image_strength if req.image_strength is not None else 0.8
    )
    guidance = req.guidance_scale if req.guidance_scale is not None else spec["default_guidance"]
    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)
    background_tasks.add_task(
        _bg_img2img,
        req.job_id, req.callback_url,
        req.prompt, requested_model, tmp_path, effective_strength,
        req.width, req.height, req.steps, guidance, seed,
    )
    log.info(f"[async] img2img job={req.job_id} accepted, callback={req.callback_url}")
    return {"job_id": req.job_id, "status": "accepted"}


@app.post("/kontext-async", status_code=202, dependencies=[Depends(verify_token)])
async def kontext_async(req: AsyncKontextRequest, background_tasks: BackgroundTasks):
    """Async Kontext editing — returns 202 immediately, POSTs result to callback_url."""
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading or _generating:
        raise HTTPException(status_code=409, detail="Server is busy with another generation")
    tmp_path: Optional[str] = None
    if req.image:
        try:
            img_bytes = base64.b64decode(req.image, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail="'image' is not valid base64")
        if len(img_bytes) > 20 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Image exceeds 20 MB limit")
        suffix = ".jpg" if img_bytes[:3] == b"\xff\xd8\xff" else ".png"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(img_bytes)
        tmp.close()
        tmp_path = tmp.name
    elif req.image_path:
        if not os.path.isfile(req.image_path):
            raise HTTPException(status_code=400, detail=f"image_path not found: {req.image_path}")
        tmp_path = req.image_path
    else:
        raise HTTPException(status_code=422, detail="Provide 'image' (base64) or 'image_path'")
    spec = MODEL_REGISTRY["flux-kontext"]
    guidance = req.guidance if req.guidance is not None else spec["default_guidance"]
    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)
    background_tasks.add_task(
        _bg_kontext,
        req.job_id, req.callback_url,
        req.prompt, tmp_path,
        req.width, req.height, req.steps, guidance, seed,
    )
    log.info(f"[async] kontext job={req.job_id} accepted, callback={req.callback_url}")
    return {"job_id": req.job_id, "status": "accepted"}


# ── CLI Entry Point ────────────────────────────────────────────
def main():
    """Parse CLI args and start the sidecar server."""
    global _default_model, _idle_timeout, _quantization, _preload_at_startup

    parser = argparse.ArgumentParser(
        description="OpenZigs Image Generation Sidecar (MFLUX / native MLX)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python server.py                                    # Lazy mode, default flux-schnell
    python server.py --default-model flux-dev           # Default to FLUX.1 dev
    python server.py --preload flux-schnell             # Preload at startup
    python server.py --quantization 8                   # 8-bit quantization
    python server.py --idle-timeout 300                 # Unload after 5 min idle
    python server.py --port 5006 --host 0.0.0.0        # Custom bind
        """,
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("IMAGE_GEN_PORT", "5005")),
        help="Port to listen on (default: 5005, env: IMAGE_GEN_PORT)",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("IMAGE_GEN_HOST", "0.0.0.0"),
        help="Host to bind to (default: 0.0.0.0, env: IMAGE_GEN_HOST)",
    )
    parser.add_argument(
        "--default-model",
        choices=list(MODEL_REGISTRY),
        default=os.environ.get("IMAGE_GEN_MODEL", "flux-schnell"),
        help="Default model used on first request (default: flux-schnell, env: IMAGE_GEN_MODEL)",
    )
    parser.add_argument(
        "--preload",
        choices=list(MODEL_REGISTRY),
        default=None,
        help="Preload a model at startup instead of lazy-loading",
    )
    parser.add_argument(
        "--idle-timeout",
        type=float,
        default=float(os.environ.get("IMAGE_GEN_IDLE_TIMEOUT", "0")),
        help="Seconds of inactivity before auto-unloading model "
             "(0 = disabled, env: IMAGE_GEN_IDLE_TIMEOUT)",
    )
    parser.add_argument(
        "--quantization",
        choices=["4", "8", "none"],
        default=os.environ.get("MFLUX_QUANTIZATION", "4"),
        help="MLX quantization bits: 4 (smallest), 8 (faster matmuls), none (full precision). Default: 4",
    )

    args = parser.parse_args()
    _default_model = args.default_model
    _idle_timeout = args.idle_timeout
    _quantization = None if args.quantization == "none" else int(args.quantization)

    if args.preload:
        _default_model = args.preload
        _preload_at_startup = True

    global _secret_token
    _secret_token = os.environ.get("FLUXQ_SECRET_TOKEN") or None

    log.info(
        f"Starting sidecar: default_model={_default_model}, "
        f"host={args.host}, port={args.port}, "
        f"quantization={_quantization}, engine=mflux/mlx, "
        f"auth={'enabled' if _secret_token else 'disabled'}"
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
