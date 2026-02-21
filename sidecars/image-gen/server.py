"""
Image Generation Sidecar — Local Diffusion Server
Issue #257: FastAPI wrapper around HuggingFace diffusers for local image generation.
Optimized for Apple Silicon (MPS) with 4-bit quantization (optimum-quanto).

Features:
    - Lazy loading: No model loaded at startup — loads on first request
    - Runtime model switching: POST /model to switch between models
    - Auto-unload: Model unloaded after idle timeout to reclaim RAM
    - 4-bit quantization for FLUX via optimum-quanto

Usage:
    cd sidecars/image-gen
    pip install -r requirements.txt
    python server.py [--port 5005] [--host 127.0.0.1]

Endpoints:
    POST /generate   — Generate an image from a text prompt
    POST /model      — Load or switch the active model
    POST /unload     — Unload the current model to free RAM
    GET  /health     — Readiness probe (returns model status)
    GET  /models     — List available models
"""

from __future__ import annotations

import argparse
import gc
import io
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from typing import Optional

import torch
from diffusers import (
    DiffusionPipeline,
    FluxPipeline,
    StableDiffusionXLPipeline,
)
from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.responses import Response
from optimum.quanto import freeze, quantize, qint4, qint8
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

# report whether HuggingFace token is available (useful for debugging gated-repo errors)
_hf_token = os.environ.get("HF_TOKEN")
if _hf_token:
    # mask all but first/last 4 chars
    masked = f"{_hf_token[:4]}...{_hf_token[-4:]}"
    log.info(f"HF_TOKEN present: {masked}")
else:
    log.info("HF_TOKEN not set")

# ── MPS Memory Config ─────────────────────────────────────────
# On Apple Silicon the MPS backend defaults to a high-watermark ratio
# that caps allocations well below physical+swap capacity.  Disabling
# it lets macOS manage unified memory natively via swap, which is
# essential for large models like FLUX (~24 GB bf16) on 24 GB Macs.
if torch.backends.mps.is_available():
    os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")

# ── Model Registry ────────────────────────────────────────────
MODEL_REGISTRY: dict[str, dict] = {
    "flux": {
        "repo_id": "black-forest-labs/FLUX.1-schnell",
        "loader": FluxPipeline,
        "default_steps": 4,
        "default_guidance": 0.0,
        "recommended_width": 1024,
        "recommended_height": 576,
        "description": "Flux.1 schnell — 4-step distilled, fast inference",
    },
    "sdxl-turbo": {
        "repo_id": "stabilityai/sdxl-turbo",
        "loader": StableDiffusionXLPipeline,
        "default_steps": 4,
        "default_guidance": 0.0,
        "recommended_width": 512,
        "recommended_height": 512,
        "description": "SDXL Turbo — 4-step distilled, native 512x512",
    },
}

# ── Global State ───────────────────────────────────────────────
_pipeline: Optional[DiffusionPipeline] = None
_device: str = "cpu"
_model_name: Optional[str] = None   # None = no model loaded
_ready: bool = False                # True once server is accepting requests
_model_loaded: bool = False         # True when a model is in memory
_loading: bool = False              # True while a model load is underway
_last_used: float = 0.0            # monotonic time of last generation
_idle_timeout: float = 0.0         # seconds before auto-unload (0 = disabled)
_default_model: str = "sdxl-turbo"  # model to use on first request if none specified
_preload_at_startup: bool = False     # True when --preload flag is used


def resolve_device() -> str:
    """Detect the best available device, preferring Apple Silicon MPS."""
    if torch.backends.mps.is_available():
        log.info("Apple Silicon MPS detected — using Metal acceleration")
        return "mps"
    if torch.cuda.is_available():
        log.info("CUDA detected — using GPU acceleration")
        return "cuda"
    log.warning("No GPU detected — falling back to CPU (this will be slow)")
    return "cpu"


def load_pipeline(model_key: str, device: str) -> DiffusionPipeline:
    """Load and optimize the diffusion pipeline for the target device.

    Apple Silicon uses unified memory shared between CPU and MPS, so
    CPU-offload buys nothing — it just adds bookkeeping overhead in the
    same physical RAM.  For FLUX (~24 GB bf16) on 24 GB Macs we apply
    4-bit quantization via optimum-quanto to compress the transformer
    from ~24 GB to ~6 GB, leaving ample headroom for inference.

    Quantization strategy (FLUX on MPS):
      1. Load pipeline to MPS in bfloat16 (native weight format).
      2. Quantize transformer weights to int4 in-place (exclude proj_out).
      3. Quantize T5 text encoder weights to int8 in-place.
      4. GC + MPS cache clear to reclaim freed bf16 memory.

    SDXL Turbo is small enough (~3 GB) to skip quantization entirely.
    """
    if model_key not in MODEL_REGISTRY:
        raise ValueError(f"Unknown model: {model_key}. Available: {list(MODEL_REGISTRY)}")

    spec = MODEL_REGISTRY[model_key]
    repo_id = spec["repo_id"]
    loader_cls = spec["loader"]

    log.info(f"Loading model '{model_key}' ({repo_id}) ...")
    start = time.monotonic()

    # ── Dtype selection ────────────────────────────────────────
    # FLUX weights are natively bfloat16 — matching that avoids
    # conversion overhead and is natively supported on Apple M-series.
    # SDXL Turbo: float16 produces NaN on MPS (Apple Silicon) due to
    # limited fp16 precision in some Metal shader paths — the diffusion
    # UNet outputs NaN which the image_processor casts to 0 → all-black
    # images.  float32 fixes this (confirmed via test_pipeline.py).
    # We still load the fp16 variant checkpoint (smaller download) and
    # upcast to float32 automatically.
    if device == "cpu":
        dtype = torch.float32
    elif model_key == "flux":
        dtype = torch.bfloat16  # native weight format, M-series HW support
    elif device == "mps":
        dtype = torch.float32  # fp16 → NaN on MPS for SDXL-family models
    else:
        dtype = torch.float16

    # Some repos (e.g. FLUX.1-schnell) do not publish a "fp16" variant
    # path, so we only request that variant for models that ship one.
    # For MPS we use float32 dtype but still load fp16 variant files
    # (PyTorch upcasts automatically, saving ~5 GB download).
    pretrained_kwargs: dict = {
        "torch_dtype": dtype,
        "use_safetensors": True,
    }
    if model_key == "sdxl-turbo":
        pretrained_kwargs["variant"] = "fp16"

    # Pass HF token explicitly for gated repos (e.g. FLUX.1-schnell)
    hf_token = os.environ.get("HF_TOKEN") or None
    if hf_token:
        pretrained_kwargs["token"] = hf_token

    # ── Load and quantize strategy ─────────────────────────────
    # For FLUX on MPS: load to CPU, quantize there (bf16→int4/int8),
    # then move each component to MPS individually.  This avoids:
    #   1. The 33 GB MPS allocator bloat from loading bf16 to MPS first
    #   2. The slow pipe.to("mps") on the entire quantized pipeline
    # Peak MPS ≈ 10 GB (quantized weights only).  Per-component move
    # takes ~2s per quantized layer but we log progress.
    needs_quantization = model_key == "flux" and device in ("mps", "cuda")

    if needs_quantization:
        log.info("Loading to CPU for quantization ...")
        pipe = loader_cls.from_pretrained(repo_id, **pretrained_kwargs)
        load_elapsed = time.monotonic() - start
        log.info(f"Pipeline loaded to CPU in {load_elapsed:.1f}s (dtype={dtype})")

        # ── Quantize on CPU ────────────────────────────────────
        quant_start = time.monotonic()
        log.info("Quantizing transformer to int4 (excluding proj_out) ...")
        quantize(pipe.transformer, weights=qint4, exclude="proj_out")
        freeze(pipe.transformer)
        gc.collect()
        log.info(f"Transformer quantized in {time.monotonic() - quant_start:.1f}s")

        if hasattr(pipe, "text_encoder_2") and pipe.text_encoder_2 is not None:
            te_start = time.monotonic()
            log.info("Quantizing T5 text encoder to int8 ...")
            quantize(pipe.text_encoder_2, weights=qint8)
            freeze(pipe.text_encoder_2)
            gc.collect()
            log.info(f"Text encoder quantized in {time.monotonic() - te_start:.1f}s")

        # ── Move components to device one by one ───────────────
        # For quantized components (transformer, text_encoder_2), move
        # each direct child submodule individually.  Calling .to() on the
        # whole quantized module triggers an extremely slow recursive path
        # in quanto's QTensor (~37 min for the transformer).  Moving
        # children individually is ~2s per large layer and gives progress.
        move_start = time.monotonic()

        def _move_submodules(module, label: str) -> None:
            """Move a quantized module to *device* child-by-child."""
            children = list(module.named_children())
            total = len(children)
            for idx, (name, child) in enumerate(children, 1):
                child.to(device)
            # Move any remaining direct parameters / buffers that
            # aren't nested inside a child submodule.
            for key, p in module._parameters.items():
                if p is not None and p.device.type != device:
                    module._parameters[key] = p.to(device)
            for key, b in module._buffers.items():
                if b is not None and b.device.type != device:
                    module._buffers[key] = b.to(device)
            log.info(f"  {label}: moved {total} children to {device}")

        components = [
            ("text_encoder", "CLIP text encoder", False),
            ("vae", "VAE", False),
            ("transformer", "Transformer (quantized int4)", True),
            ("text_encoder_2", "T5 text encoder (quantized int8)", True),
        ]
        for attr, label, quantized in components:
            comp = getattr(pipe, attr, None)
            if comp is not None and hasattr(comp, "to"):
                comp_start = time.monotonic()
                log.info(f"Moving {label} to {device} ...")
                if quantized:
                    _move_submodules(comp, label)
                else:
                    comp.to(device)
                gc.collect()
                log.info(f"  {label} moved in {time.monotonic() - comp_start:.1f}s")

        gc.collect()
        if device == "mps":
            torch.mps.empty_cache()
        log.info(f"All components moved to {device} in {time.monotonic() - move_start:.1f}s")
    else:
        pipe = loader_cls.from_pretrained(repo_id, **pretrained_kwargs)
        pipe = pipe.to(device)
        load_elapsed = time.monotonic() - start
        log.info(f"Pipeline loaded to {device} in {load_elapsed:.1f}s (dtype={dtype})")

    # ── Memory optimizations ───────────────────────────────────
    # Attention slicing splits the QKV computation into chunks,
    # dramatically reducing peak memory during the attention pass.
    pipe.enable_attention_slicing()

    # VAE tiling + slicing lets the decoder work on large images
    # without allocating the full latent tensor at once.
    if hasattr(pipe, "vae"):
        pipe.vae.enable_slicing()
        pipe.vae.enable_tiling()

    if device == "mps":
        pipe.set_progress_bar_config(disable=True)
    elif device == "cuda":
        try:
            pipe.enable_xformers_memory_efficient_attention()
        except Exception:
            pass  # attention_slicing already active

    elapsed = time.monotonic() - start
    log.info(f"Model ready in {elapsed:.1f}s (device={device}, dtype={dtype}, "
             f"quantized={'int4' if model_key == 'flux' else 'none'})")

    return pipe


def warmup_pipeline(pipe: DiffusionPipeline, model_key: str) -> None:
    """Run a single inference pass to pre-warm the pipeline and shader compilation."""
    spec = MODEL_REGISTRY[model_key]
    log.info("Warming up pipeline (first inference compiles MPS shaders) ...")
    start = time.monotonic()
    try:
        # Tiny warmup image at minimal resolution
        _ = pipe(
            prompt="warmup test",
            width=256,
            height=256,
            num_inference_steps=1,
            guidance_scale=0.0,
        ).images[0]
        elapsed = time.monotonic() - start
        log.info(f"Warmup completed in {elapsed:.1f}s")
    except Exception as e:
        log.warning(f"Warmup failed (non-fatal): {e}")


# ── Model lifecycle helpers ────────────────────────────────────

def _unload_model() -> None:
    """Unload the current model and free GPU/system memory."""
    global _pipeline, _model_name, _model_loaded

    if _pipeline is not None:
        model = _model_name or "unknown"
        log.info(f"Unloading model '{model}' to free memory ...")
        del _pipeline
        _pipeline = None
        gc.collect()
        if _device == "mps":
            torch.mps.empty_cache()
        elif _device == "cuda":
            torch.cuda.empty_cache()
        log.info(f"Model '{model}' unloaded")

    _model_loaded = False
    _model_name = None


def _load_model(model_key: str) -> float:
    """Load a model, unloading any existing one first.

    Returns the time taken to load in seconds (0.0 if already loaded).
    """
    global _pipeline, _model_name, _model_loaded, _loading, _last_used

    if _model_loaded and _model_name == model_key:
        return 0.0  # Already loaded

    _loading = True
    try:
        # Unload existing model first
        if _model_loaded:
            _unload_model()

        start = time.monotonic()
        _pipeline = load_pipeline(model_key, _device)
        elapsed = time.monotonic() - start
        _model_name = model_key
        _model_loaded = True
        _last_used = time.monotonic()
        return elapsed
    finally:
        _loading = False


async def _idle_unload_loop() -> None:
    """Background task: periodically check for idle timeout and unload."""
    import asyncio

    while True:
        await asyncio.sleep(30)  # Check every 30 seconds
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
        description=(
            "Model to use (e.g. 'flux', 'sdxl-turbo'). "
            "If different from the loaded model, triggers a model switch."
        ),
    )
    negative_prompt: str = Field(
        default="",
        max_length=1000,
        description="Negative prompt (what to avoid in the image)",
    )
    width: int = Field(
        default=1024,
        ge=256,
        le=2048,
        description="Output image width in pixels (must be divisible by 8)",
    )
    height: int = Field(
        default=1024,
        ge=256,
        le=2048,
        description="Output image height in pixels (must be divisible by 8)",
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


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    model: Optional[str] = None
    device: str
    ready: bool
    model_loaded: bool = False
    recommended_width: int = 1024
    recommended_height: int = 576
    available_models: list[str] = []


class ModelRequest(BaseModel):
    """Request body for model loading/switching."""

    model: str = Field(
        ...,
        description="Model key to load (e.g. 'flux', 'sdxl-turbo')",
    )


class ModelResponse(BaseModel):
    """Response from model load/switch operations."""

    model: str
    device: str
    load_time_seconds: float
    quantized: str


# ── Lifespan (startup/shutdown) ────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start server in lazy mode — no model loaded until first request."""
    import asyncio

    global _device, _ready

    _device = resolve_device()
    _ready = True  # Server accepts requests immediately; model loads on demand

    # If --preload was specified, load the model eagerly at startup
    if _preload_at_startup:
        log.info(f"Preloading model '{_default_model}' at startup ...")
        elapsed = _load_model(_default_model)
        log.info(f"Model '{_default_model}' preloaded in {elapsed:.1f}s")

    log.info(
        f"Sidecar ready — {'preloaded' if _preload_at_startup else 'lazy'} mode "
        f"({'model loaded' if _model_loaded else 'no model loaded'}, device={_device}, "
        f"default_model={_default_model}, "
        f"idle_timeout={'disabled' if _idle_timeout <= 0 else f'{_idle_timeout:.0f}s'})"
    )

    # Start idle-unload background task
    idle_task = asyncio.create_task(_idle_unload_loop())

    yield

    # Cleanup
    _ready = False
    idle_task.cancel()
    _unload_model()
    log.info("Sidecar shut down")


# ── FastAPI App ────────────────────────────────────────────────
app = FastAPI(
    title="OpenZigs Image Generation Sidecar",
    description="Local diffusion model server with lazy loading, "
                "runtime model switching, and auto-unload. "
                "Optimized for Apple Silicon (MPS).",
    version="2.0.0",
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthResponse)
async def health():
    """Readiness probe for the sidecar.

    Returns 'ready=true' even when no model is loaded (server accepts
    requests and lazy-loads on demand).  Use 'model_loaded' to check
    whether a model is actually in memory.
    """
    spec = MODEL_REGISTRY.get(_model_name or _default_model, {})
    status = "loading" if _loading else ("ok" if _ready else "starting")
    return HealthResponse(
        status=status,
        model=_model_name,
        device=_device,
        ready=_ready and not _loading,
        model_loaded=_model_loaded,
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
    return {"models": models, "active": _model_name, "device": _device}


@app.post("/model", response_model=ModelResponse, dependencies=[Depends(verify_token)])
async def switch_model(req: ModelRequest):
    """Load or switch to a different model at runtime.

    If the requested model is already loaded, returns immediately.
    Otherwise unloads the current model and loads the new one.
    """
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading:
        raise HTTPException(
            status_code=409, detail="A model is currently being loaded"
        )
    if req.model not in MODEL_REGISTRY:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown model: {req.model}. "
                f"Available: {list(MODEL_REGISTRY.keys())}"
            ),
        )

    elapsed = _load_model(req.model)
    quantized = "int4" if req.model == "flux" else "none"

    if elapsed == 0.0:
        log.info(f"Model '{req.model}' already loaded")
    else:
        log.info(f"Switched to model '{req.model}' in {elapsed:.1f}s")

    return ModelResponse(
        model=req.model,
        device=_device,
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
    Pass 'model' in the request body to select a specific model.
    """
    global _last_used

    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading:
        raise HTTPException(
            status_code=409, detail="A model is currently being loaded"
        )

    # ── Lazy load / model switch ───────────────────────────────
    requested_model = req.model or (
        _model_name if _model_loaded else _default_model
    )
    if requested_model not in MODEL_REGISTRY:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown model: {requested_model}. "
                f"Available: {list(MODEL_REGISTRY.keys())}"
            ),
        )

    if not _model_loaded or _model_name != requested_model:
        log.info(
            f"Lazy-loading model '{requested_model}' for generation request ..."
        )
        load_time = _load_model(requested_model)
        log.info(f"Model '{requested_model}' ready in {load_time:.1f}s")

    assert _pipeline is not None  # Guaranteed after _load_model

    # Enforce dimensions divisible by 8 (required by diffusion models)
    width = (req.width // 8) * 8
    height = (req.height // 8) * 8

    spec = MODEL_REGISTRY[requested_model]
    steps = req.steps or spec["default_steps"]
    guidance = (
        req.guidance_scale
        if req.guidance_scale is not None
        else spec["default_guidance"]
    )

    # Set up generator for reproducible results
    generator = None
    if req.seed is not None:
        generator = torch.Generator(device=_device).manual_seed(req.seed)

    log.info(
        f"Generating: prompt='{req.prompt[:80]}...' "
        f"model={_model_name} size={width}x{height} "
        f"steps={steps} guidance={guidance}"
    )
    start = time.monotonic()

    try:
        # Build kwargs — some models don't support negative_prompt
        gen_kwargs: dict = {
            "prompt": req.prompt,
            "width": width,
            "height": height,
            "num_inference_steps": steps,
            "guidance_scale": guidance,
            "generator": generator,
        }
        if req.negative_prompt and _model_name != "flux":
            gen_kwargs["negative_prompt"] = req.negative_prompt

        result = _pipeline(**gen_kwargs)
        image: Image.Image = result.images[0]  # type: ignore[union-attr]
    except Exception as e:
        log.error(f"Generation failed: {e}")
        raise HTTPException(
            status_code=500, detail=f"Generation failed: {str(e)}"
        )

    elapsed = time.monotonic() - start
    _last_used = time.monotonic()
    log.info(f"Generated in {elapsed:.1f}s ({width}x{height}, model={_model_name})")

    # Convert to PNG bytes
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()

    # Clear MPS cache periodically to prevent OOM
    if _device == "mps":
        torch.mps.empty_cache()

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "X-Generation-Time": f"{elapsed:.2f}s",
            "X-Image-Size": f"{width}x{height}",
            "X-Model": _model_name or "unknown",
        },
    )


# ── CLI Entry Point ────────────────────────────────────────────
def main():
    """Parse CLI args and start the sidecar server."""
    global _default_model, _idle_timeout

    parser = argparse.ArgumentParser(
        description="OpenZigs Image Generation Sidecar",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python server.py                                  # Lazy mode, default sdxl-turbo
    python server.py --default-model flux              # Default to FLUX on first request
    python server.py --preload sdxl-turbo             # Preload SDXL Turbo at startup
    python server.py --idle-timeout 300               # Unload after 5 min idle
    python server.py --port 5006 --host 0.0.0.0       # Custom bind
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
        default=os.environ.get("IMAGE_GEN_MODEL", "sdxl-turbo"),
        help="Default model used on first request (default: sdxl-turbo, env: IMAGE_GEN_MODEL)",
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
        help=(
            "Seconds of inactivity before auto-unloading model "
            "(0 = disabled, env: IMAGE_GEN_IDLE_TIMEOUT)"
        ),
    )

    args = parser.parse_args()
    _default_model = args.default_model
    _idle_timeout = args.idle_timeout

    if args.preload:
        _default_model = args.preload
        _preload_at_startup = True

    # Reload token from env (may have been set after module import)
    global _secret_token
    _secret_token = os.environ.get("FLUXQ_SECRET_TOKEN") or None

    log.info(
        f"Starting sidecar: default_model={_default_model}, "
        f"host={args.host}, port={args.port}, "
        f"auth={'enabled' if _secret_token else 'disabled'}"
    )
    log.info(f"PyTorch version: {torch.__version__}")
    log.info(f"MPS available: {torch.backends.mps.is_available()}")
    log.info(
        f"Idle timeout: "
        f"{'disabled' if _idle_timeout <= 0 else f'{_idle_timeout:.0f}s'}"
    )
    if torch.cuda.is_available():
        log.info(f"CUDA available: {torch.cuda.get_device_name(0)}")

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
