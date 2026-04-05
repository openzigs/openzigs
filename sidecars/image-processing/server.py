"""
Image Processing Sidecar — Real-ESRGAN upscaling + rembg background removal.
Issues #767 (upscaling) and #769 (background removal).

FastAPI server providing AI-powered image processing on Apple Silicon.
Designed to be launched as a sidecar process alongside the main OpenZigs server.

Usage:
    cd sidecars/image-processing
    pip install -r requirements.txt
    python server.py [--port 5010] [--host 127.0.0.1]

Endpoints:
    POST /upscale            — Upscale image using Real-ESRGAN
    POST /remove-background  — Remove background using rembg
    GET  /health             — Readiness probe
"""

from __future__ import annotations

import argparse
import base64
import io
import logging
import os
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("image-processing-sidecar")

_callback_secret: Optional[str] = os.getenv("CALLBACK_SECRET") or None

app = FastAPI(title="Image Processing Sidecar", version="1.0.0")

# Lazy-loaded models
_upscaler = None
_rembg_session = None


# ── Request/Response Models ──────────────────────────────────

class UpscaleRequest(BaseModel):
    image: str = Field(..., description="Base64-encoded image")
    format: str = Field(default="png", description="Image format (png, jpeg, webp)")
    scale: int = Field(default=2, ge=2, le=4, description="Upscale factor (2 or 4)")


class UpscaleResponse(BaseModel):
    image: str = Field(..., description="Base64-encoded upscaled image")
    width: int
    height: int


class RemoveBackgroundRequest(BaseModel):
    image: str = Field(..., description="Base64-encoded image")
    model: str = Field(default="u2net", description="Rembg model name")
    alpha_matting: bool = Field(default=False, description="Enable alpha matting")


class RemoveBackgroundResponse(BaseModel):
    image: str = Field(..., description="Base64-encoded image with background removed")
    width: int
    height: int


# ── Lazy Loaders ─────────────────────────────────────────────

def get_upscaler(scale: int = 2):
    """Lazy-load Real-ESRGAN model."""
    global _upscaler
    try:
        from realesrgan import RealESRGANer
        from basicsr.archs.rrdbnet_arch import RRDBNet
        import torch

        if _upscaler is None or _upscaler._scale != scale:
            logger.info(f"Loading Real-ESRGAN model (scale={scale})...")
            if scale == 4:
                model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
                model_path = "RealESRGAN_x4plus.pth"
            else:
                model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=2)
                model_path = "RealESRGAN_x2plus.pth"

            _upscaler = RealESRGANer(
                scale=scale,
                model_path=model_path,
                model=model,
                half=False,
            )
            _upscaler._scale = scale
            logger.info("Real-ESRGAN model loaded.")
        return _upscaler
    except ImportError:
        logger.warning("Real-ESRGAN not installed, using Pillow fallback")
        return None


def get_rembg_session(model_name: str = "u2net"):
    """Lazy-load rembg session."""
    global _rembg_session
    try:
        from rembg import new_session
        if _rembg_session is None:
            logger.info(f"Loading rembg model ({model_name})...")
            _rembg_session = new_session(model_name)
            logger.info("rembg model loaded.")
        return _rembg_session
    except ImportError:
        logger.warning("rembg not installed")
        return None


# ── Endpoints ────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "upscaler_loaded": _upscaler is not None,
        "rembg_loaded": _rembg_session is not None,
    }


@app.post("/upscale", response_model=UpscaleResponse)
async def upscale(req: UpscaleRequest):
    """Upscale an image using Real-ESRGAN or Pillow fallback."""
    from PIL import Image
    import numpy as np

    try:
        image_bytes = base64.b64decode(req.image)
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image data: {e}")

    upscaler = get_upscaler(req.scale)
    if upscaler is not None:
        img_np = np.array(img)
        output, _ = upscaler.enhance(img_np, outscale=req.scale)
        result_img = Image.fromarray(output)
    else:
        # Pillow fallback: simple Lanczos resize
        new_w = img.width * req.scale
        new_h = img.height * req.scale
        result_img = img.resize((new_w, new_h), Image.LANCZOS)

    buf = io.BytesIO()
    result_img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    return UpscaleResponse(
        image=b64,
        width=result_img.width,
        height=result_img.height,
    )


@app.post("/remove-background", response_model=RemoveBackgroundResponse)
async def remove_background(req: RemoveBackgroundRequest):
    """Remove background using rembg."""
    from PIL import Image

    try:
        image_bytes = base64.b64decode(req.image)
        img = Image.open(io.BytesIO(image_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image data: {e}")

    try:
        from rembg import remove
        session = get_rembg_session(req.model)
        result_img = remove(
            img,
            session=session,
            alpha_matting=req.alpha_matting,
        )
    except ImportError:
        raise HTTPException(status_code=503, detail="rembg is not installed")

    buf = io.BytesIO()
    result_img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    return RemoveBackgroundResponse(
        image=b64,
        width=result_img.width,
        height=result_img.height,
    )


# ── Main ─────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser(description="Image Processing Sidecar")
    parser.add_argument("--port", type=int, default=5010)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
