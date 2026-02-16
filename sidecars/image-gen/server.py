"""
Image Generation Sidecar — Local Diffusion Server
Issue #257: FastAPI wrapper around HuggingFace diffusers for local image generation.
Optimized for Apple Silicon (MPS) with float16 precision.

Usage:
    cd sidecars/image-gen
    pip install -r requirements.txt
    python server.py [--port 5005] [--model flux] [--host 127.0.0.1]

Endpoints:
    POST /generate   — Generate an image from a text prompt
    GET  /health     — Readiness probe (returns model status)
"""

from __future__ import annotations

import argparse
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
    StableDiffusionXLPipeline,
)
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel, Field

# ── Logging ────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("image-gen-sidecar")

# ── Model Registry ────────────────────────────────────────────
MODEL_REGISTRY: dict[str, dict] = {
    "flux": {
        "repo_id": "black-forest-labs/FLUX.1-schnell",
        "loader": DiffusionPipeline,
        "default_steps": 4,
        "default_guidance": 0.0,
        "description": "Flux.1 schnell — 4-step distilled, fast inference",
    },
    "sdxl-turbo": {
        "repo_id": "stabilityai/sdxl-turbo",
        "loader": StableDiffusionXLPipeline,
        "default_steps": 4,
        "default_guidance": 0.0,
        "description": "SDXL Turbo — 4-step distilled, excellent quality",
    },
}

# ── Global State ───────────────────────────────────────────────
_pipeline: Optional[DiffusionPipeline] = None
_device: str = "cpu"
_model_name: str = "flux"
_ready: bool = False


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
    """Load and optimize the diffusion pipeline for the target device."""
    if model_key not in MODEL_REGISTRY:
        raise ValueError(f"Unknown model: {model_key}. Available: {list(MODEL_REGISTRY)}")

    spec = MODEL_REGISTRY[model_key]
    repo_id = spec["repo_id"]
    loader_cls = spec["loader"]

    log.info(f"Loading model '{model_key}' ({repo_id}) ...")
    start = time.monotonic()

    # Determine dtype: float16 for GPU/MPS, float32 for CPU
    dtype = torch.float16 if device != "cpu" else torch.float32

    # Load the pipeline
    # For Flux models, use the generic DiffusionPipeline loader
    # For SDXL Turbo, use the specific loader
    pipe = loader_cls.from_pretrained(
        repo_id,
        torch_dtype=dtype,
        variant="fp16" if dtype == torch.float16 else None,
        use_safetensors=True,
    )

    # Move to device
    pipe = pipe.to(device)

    # Memory optimizations
    if device == "mps":
        # Enable attention slicing for memory efficiency on MPS
        pipe.enable_attention_slicing()
        # MPS-specific: disable progress bar for cleaner logs
        pipe.set_progress_bar_config(disable=True)
    elif device == "cuda":
        # Enable memory efficient attention if available
        try:
            pipe.enable_xformers_memory_efficient_attention()
        except Exception:
            pipe.enable_attention_slicing()

    elapsed = time.monotonic() - start
    log.info(f"Model loaded in {elapsed:.1f}s (device={device}, dtype={dtype})")

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


# ── Request / Response Models ──────────────────────────────────
class GenerateRequest(BaseModel):
    """Request body for image generation."""

    prompt: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="Text prompt describing the desired image",
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
    model: str
    device: str
    ready: bool


# ── Lifespan (startup/shutdown) ────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load and warm up the model on startup."""
    global _pipeline, _device, _model_name, _ready

    _device = resolve_device()
    _pipeline = load_pipeline(_model_name, _device)
    warmup_pipeline(_pipeline, _model_name)
    _ready = True
    log.info(f"Sidecar ready — listening for requests (model={_model_name}, device={_device})")

    yield

    # Cleanup
    _ready = False
    del _pipeline
    if _device == "mps":
        torch.mps.empty_cache()
    elif _device == "cuda":
        torch.cuda.empty_cache()
    log.info("Sidecar shut down")


# ── FastAPI App ────────────────────────────────────────────────
app = FastAPI(
    title="OpenZigs Image Generation Sidecar",
    description="Local diffusion model server optimized for Apple Silicon (MPS)",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthResponse)
async def health():
    """Readiness probe for the sidecar."""
    return HealthResponse(
        status="ok" if _ready else "loading",
        model=_model_name,
        device=_device,
        ready=_ready,
    )


@app.post("/generate", response_class=Response)
async def generate(req: GenerateRequest):
    """Generate an image from a text prompt.

    Returns a PNG image as binary response with Content-Type: image/png.
    """
    if not _ready or _pipeline is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    # Enforce dimensions divisible by 8 (required by diffusion models)
    width = (req.width // 8) * 8
    height = (req.height // 8) * 8

    spec = MODEL_REGISTRY[_model_name]
    steps = req.steps or spec["default_steps"]
    guidance = req.guidance_scale if req.guidance_scale is not None else spec["default_guidance"]

    # Set up generator for reproducible results
    generator = None
    if req.seed is not None:
        generator = torch.Generator(device=_device).manual_seed(req.seed)

    log.info(
        f"Generating: prompt='{req.prompt[:80]}...' "
        f"size={width}x{height} steps={steps} guidance={guidance}"
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
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(e)}")

    elapsed = time.monotonic() - start
    log.info(f"Generated in {elapsed:.1f}s ({width}x{height})")

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
            "X-Model": _model_name,
        },
    )


# ── CLI Entry Point ────────────────────────────────────────────
def main():
    global _model_name

    parser = argparse.ArgumentParser(
        description="OpenZigs Image Generation Sidecar",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python server.py                          # Default: Flux.1 schnell on port 5005
    python server.py --model sdxl-turbo       # Use SDXL Turbo instead
    python server.py --port 5006 --host 0.0.0.0  # Custom bind
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
        default=os.environ.get("IMAGE_GEN_HOST", "127.0.0.1"),
        help="Host to bind to (default: 127.0.0.1, env: IMAGE_GEN_HOST)",
    )
    parser.add_argument(
        "--model",
        choices=list(MODEL_REGISTRY),
        default=os.environ.get("IMAGE_GEN_MODEL", "flux"),
        help="Model to load (default: flux, env: IMAGE_GEN_MODEL)",
    )
    parser.add_argument(
        "--no-warmup",
        action="store_true",
        help="Skip warmup inference on startup",
    )

    args = parser.parse_args()
    _model_name = args.model

    if args.no_warmup:
        # Monkey-patch warmup to no-op
        global warmup_pipeline
        warmup_pipeline = lambda pipe, model_key: None  # noqa: E731

    log.info(f"Starting sidecar: model={args.model}, host={args.host}, port={args.port}")
    log.info(f"PyTorch version: {torch.__version__}")
    log.info(f"MPS available: {torch.backends.mps.is_available()}")
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
