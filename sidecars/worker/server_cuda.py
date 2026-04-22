"""
Video Generation Worker -- CUDA/PyTorch Backend
Drop-in replacement for the MLX video worker using HuggingFace diffusers
on NVIDIA GPUs. Same HTTP API contract as the Apple Silicon version.

Supports:
  - LTX-Video 0.9.7 13B (distilled & dev) via LTXConditionPipeline
  - LTX-Video 0.9.6 2B (distilled & dev) via LTXPipeline
  - Legacy LTX-Video 2B v0.9 via LTXPipeline

Audio generation is NOT supported on CUDA — only the MLX backend (Apple Silicon)
supports synchronized audio via the LTX-2-dev-bf16 model.

VRAM-Aware Frame Limiting:
  - Automatically caps frame count based on available VRAM to prevent OOM errors.
  - 12GB GPUs (RTX 3060): Max ~57 frames (2.3s) with 13B, ~121 frames (5s) with 2B.
  - 16GB GPUs: Max ~97 frames (4s) with 13B.
  - 24GB+ GPUs: Full 161 frames (6.7s) with any model.
  - For longer videos, use LTX_MODEL_KEY=ltxv-2b-096-distilled.

Endpoints:
    POST /generate          -- Async video generation (returns 202, POSTs callback)
    GET  /status            -- Worker busy state
    GET  /health            -- Readiness probe
    GET  /job-result/{id}   -- Poll for async job result
    GET  /models            -- List available models
    GET  /memory            -- VRAM diagnostics
    GET  /limits            -- VRAM-based generation limits per model
    POST /last-frame        -- Extract last frame from video (for segment chaining)

Port: 5007 (default)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import gc
import hmac
import io
import json
import logging
import math
import os
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import ipaddress
import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

# ── Logging ────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("video-worker-cuda")

# ── Lazy imports ───────────────────────────────────────────────
torch = None

# ── Model Registry ────────────────────────────────────────────
# Models optimized for different VRAM budgets. 12GB GPUs (RTX 3060/3080)
# use model_cpu_offload to swap components; 24GB+ GPUs keep everything on device.
VIDEO_MODEL_REGISTRY: dict[str, dict] = {
    "ltxv-13b-097-distilled": {
        "hf_id": "Lightricks/LTX-Video-0.9.7-distilled",
        "pipeline_class": "LTXConditionPipeline",
        "default_steps": 7,
        "default_guidance": 1.0,
        "description": "LTX-Video 13B distilled — fast, high quality (7 steps, no CFG)",
        "vram_gb": 12,
        "tier": "medium",
        "min_vram_gb": 12,
    },
    "ltxv-13b-097-dev": {
        "hf_id": "Lightricks/LTX-Video-0.9.7-dev",
        "pipeline_class": "LTXConditionPipeline",
        "default_steps": 30,
        "default_guidance": 3.0,
        "description": "LTX-Video 13B dev — highest quality (30 steps, CFG-guided)",
        "vram_gb": 16,
        "tier": "high",
        "min_vram_gb": 16,
    },
    "ltxv-2b-096-distilled": {
        "hf_id": "Lightricks/LTX-Video-0.9.6-distilled",
        "pipeline_class": "LTXPipeline",
        "default_steps": 4,
        "default_guidance": 0.0,
        "description": "LTX-Video 2B distilled — real-time, low VRAM (4 steps)",
        "vram_gb": 8,
        "tier": "low",
        "min_vram_gb": 8,
    },
    "ltxv-2b-legacy": {
        "hf_id": "Lightricks/LTX-Video",
        "pipeline_class": "LTXPipeline",
        "default_steps": 20,
        "default_guidance": 0.0,
        "description": "LTX-Video 2B v0.9 — legacy baseline",
        "vram_gb": 8,
        "tier": "low",
        "min_vram_gb": 8,
    },
    # WS1-B (#926): LTX-2 22B distilled with native synchronized audio.
    # Requires LTX_ALLOW_AUDIO=1 and pooled VRAM >= 24 GB to load.
    "ltxv-2-22b-distilled": {
        "hf_id": "Lightricks/LTX-Video-2-22B-distilled",
        "pipeline_class": "LTXConditionPipeline",
        "default_steps": 8,
        "default_guidance": 1.0,
        "description": "LTX-Video 2 22B distilled — synchronized audio, dual-GPU recommended",
        "vram_gb": 24,
        "tier": "ultra",
        "min_vram_gb": 24,
        "synchronized_audio": True,
    },
}

# ── Constants ──────────────────────────────────────────────────
DEFAULT_MODEL_KEY = os.getenv("LTX_MODEL_KEY") or "ltxv-13b-097-distilled"
# Legacy env var support: if LTX_MODEL_REPO is set but LTX_MODEL_KEY is not,
# look up the repo in the registry or use it as a raw HF ID.
_legacy_repo = os.getenv("LTX_MODEL_REPO")
if _legacy_repo and not os.getenv("LTX_MODEL_KEY"):
    _match = next((k for k, v in VIDEO_MODEL_REGISTRY.items() if v["hf_id"] == _legacy_repo), None)
    if _match:
        DEFAULT_MODEL_KEY = _match
    else:
        # Custom repo — inject into registry as legacy entry
        VIDEO_MODEL_REGISTRY["custom"] = {
            "hf_id": _legacy_repo,
            "pipeline_class": "LTXPipeline",
            "default_steps": 20,
            "default_guidance": 0.0,
            "description": f"Custom model: {_legacy_repo}",
            "vram_gb": 12,
        }
        DEFAULT_MODEL_KEY = "custom"
DEFAULT_MODEL_REPO = VIDEO_MODEL_REGISTRY.get(DEFAULT_MODEL_KEY, {}).get("hf_id", "Lightricks/LTX-Video-0.9.7-distilled")
DEFAULT_WIDTH = int(os.getenv("LTX_DEFAULT_WIDTH", "768"))
DEFAULT_HEIGHT = int(os.getenv("LTX_DEFAULT_HEIGHT", "512"))
DEFAULT_FPS = int(os.getenv("LTX_DEFAULT_FPS", "24"))
MAX_VIDEO_FRAMES = int(os.getenv("LTX_MAX_FRAMES", "161"))
MAX_WIDTH = int(os.getenv("LTX_MAX_WIDTH", "1280"))
MAX_HEIGHT = int(os.getenv("LTX_MAX_HEIGHT", "720"))
MAX_PIXELS = MAX_WIDTH * MAX_HEIGHT
MODEL_IDLE_TIMEOUT_SEC = int(os.getenv("MODEL_IDLE_TIMEOUT", "300"))

# ── WS2-A (#927): Dual-GPU LTX sharding configuration ──────────
# All env vars below are documented in `sidecars/worker/.env.example` and
# `docs/MULTI_GPU.md`. Defaults are conservative and will silently fall back
# to single-GPU mode on systems with <2 CUDA devices or insufficient pooled
# VRAM.
#
# LTX_POOLING_MODE values:
#   "off"     -> never pool; existing single-GPU path
#   "manual"  -> always attempt sharding even on a single GPU (will fail
#               clearly if conditions not met). Useful for tests.
#   "auto"    -> detect device_count >= 2 and pooled VRAM >= LTX_POOLING_MIN_VRAM_GB,
#               otherwise transparently fall back. THIS IS THE DEFAULT.
LTX_POOLING_MODE: str = os.getenv("LTX_POOLING_MODE", "auto").strip().lower()
if LTX_POOLING_MODE not in ("off", "manual", "auto"):
    logger.warning(
        f"LTX_POOLING_MODE='{LTX_POOLING_MODE}' is not recognised; falling back to 'auto'"
    )
    LTX_POOLING_MODE = "auto"

# Per-component device overrides. Heaviest module (transformer) defaults to
# cuda:1 because the 13B FLUX text encoder + VAE typically share cuda:0 with
# the OS / display.
LTX_TRANSFORMER_DEVICE: str = os.getenv("LTX_TRANSFORMER_DEVICE", "cuda:1").strip()
LTX_ENCODER_DEVICE: str = os.getenv("LTX_ENCODER_DEVICE", "cuda:0").strip()
LTX_VAE_DEVICE: str = os.getenv("LTX_VAE_DEVICE", "cuda:0").strip()
# Minimum pooled VRAM in GB to enable auto-pooling (sum of all visible cards).
LTX_POOLING_MIN_VRAM_GB: int = int(os.getenv("LTX_POOLING_MIN_VRAM_GB", "18"))
# Hard override on max frames regardless of VRAM tier (escape hatch).
LTX_MAX_FRAMES_OVERRIDE: int = int(os.getenv("LTX_MAX_FRAMES_OVERRIDE", "0"))
# Allow LTX-2 / LTX-2.3 native synchronized audio. Off by default because the
# weights are large and require pooled VRAM to fit.
LTX_ALLOW_AUDIO: bool = os.getenv("LTX_ALLOW_AUDIO", "0").strip() in ("1", "true", "True")

# ── VRAM-Based Frame Limits ────────────────────────────────────
# Empirically derived safe frame counts for different VRAM budgets.
# These are conservative to avoid OOM in the middle of generation.
# Format: (model_category, vram_tier): max_frames
# Note: Actual VRAM is often ~1GB less than advertised (driver/OS reserve),
# so we use lower thresholds (e.g., 10GB threshold for 12GB cards).
VRAM_FRAME_LIMITS: dict[tuple[str, int], int] = {
    # 13B models require more VRAM per frame
    ("13b", 22): 161,   # 24GB+ GPUs: full capacity
    ("13b", 14): 97,    # 16GB GPUs: ~4 seconds at 24fps
    ("13b", 10): 57,    # 12GB GPUs: ~2.3 seconds at 24fps (RTX 3060)
    ("13b", 6): 25,     # 8GB GPUs: ~1 second (not recommended)
    # WS2-A (#927): pooled (dual-GPU) tiers — sum of all visible cards.
    # The transformer is sharded onto cuda:1 leaving ~full VRAM for activations.
    ("13b", 24): 161,   # 2x 12 GB pooled = 24 GB tier
    ("13b", 32): 201,   # 2x 16 GB pooled or 1x 32 GB
    ("13b", 48): 257,   # 2x 24 GB or pro cards
    # 2B models are much lighter
    ("2b", 22): 161,
    ("2b", 14): 161,
    ("2b", 10): 121,    # 12GB: ~5 seconds
    ("2b", 6): 81,      # 8GB: ~3.3 seconds
    ("2b", 24): 161,    # pooled 2B is already maxed
    # WS1-B (#926): LTX-2 22B distilled with synchronized audio.
    ("22b", 22): 121,   # single 24 GB
    ("22b", 24): 161,   # pooled 24 GB (2x 12)
    ("22b", 32): 201,
    ("22b", 48): 257,
}


def _is_pooling_active() -> bool:
    """Return True iff dual-GPU sharding should be used for this load.

    Honors LTX_POOLING_MODE (off/manual/auto) and LTX_POOLING_MIN_VRAM_GB.
    """
    _ensure_torch()
    if LTX_POOLING_MODE == "off":
        return False
    if not torch.cuda.is_available():
        return False
    device_count = torch.cuda.device_count()
    if LTX_POOLING_MODE == "manual":
        return device_count >= 2
    # auto
    if device_count < 2:
        return False
    pooled = _get_pooled_vram_gb()
    return pooled >= LTX_POOLING_MIN_VRAM_GB


def _get_pooled_vram_gb() -> int:
    """Sum of total VRAM (GB, rounded down) across all visible CUDA devices."""
    _ensure_torch()
    if not torch.cuda.is_available():
        return 0
    total_bytes = 0
    for i in range(torch.cuda.device_count()):
        try:
            _, total = torch.cuda.mem_get_info(i)
            total_bytes += total
        except Exception:
            # mem_get_info per-device requires fairly recent torch; on older
            # builds, fall back to props.
            try:
                props = torch.cuda.get_device_properties(i)
                total_bytes += getattr(props, "total_memory", 0)
            except Exception:
                pass
    return int(total_bytes / 1024**3)


def _get_vram_gb() -> int:
    """Get total VRAM in GB (rounded down).

    When pooling is active this returns the *pooled* total so that the frame
    limit picker upgrades to the dual-GPU tier automatically. When pooling is
    inactive it returns the primary device's VRAM, preserving legacy behaviour.
    """
    _ensure_torch()
    if torch.cuda.is_available():
        if _is_pooling_active():
            return _get_pooled_vram_gb()
        _, total = torch.cuda.mem_get_info()
        return int(total / 1024**3)
    return 12  # Assume 12GB if detection fails


def _get_max_frames_for_model(model_key: str) -> int:
    """Calculate max safe frames based on model size and available VRAM."""
    if LTX_MAX_FRAMES_OVERRIDE > 0:
        return LTX_MAX_FRAMES_OVERRIDE
    vram_gb = _get_vram_gb()
    if "22b" in model_key or "ltxv-2" in model_key:
        category = "22b"
    elif "13b" in model_key:
        category = "13b"
    else:
        category = "2b"

    # Find the matching or next-lower VRAM tier (pooled tiers first when active).
    tiers = [48, 32, 24, 22, 14, 10, 6]
    for tier in tiers:
        if vram_gb >= tier:
            limit = VRAM_FRAME_LIMITS.get((category, tier))
            if limit:
                return limit

    # Fallback: very conservative for unknown configs
    if category == "22b":
        return 49
    return 25 if category == "13b" else 57


def _recommend_model_for_duration(duration_sec: float, fps: int = 24) -> str:
    """Recommend the best model for a given video duration based on available VRAM."""
    target_frames = int(duration_sec * fps)
    vram_gb = _get_vram_gb()

    # Try 13B first (higher quality)
    if target_frames <= _get_max_frames_for_model("ltxv-13b-097-distilled"):
        return "ltxv-13b-097-distilled"

    # Fall back to 2B for longer videos
    if target_frames <= _get_max_frames_for_model("ltxv-2b-096-distilled"):
        return "ltxv-2b-096-distilled"

    # Beyond our limits — use 2B and let it clamp
    return "ltxv-2b-096-distilled"


# ── Security ───────────────────────────────────────────────────
_secret_token: Optional[str] = os.environ.get("M2_PRO_WORKER_TOKEN") or None
_callback_secret: Optional[str] = os.environ.get("CALLBACK_SECRET") or None


def _callback_auth_headers() -> dict[str, str]:
    if _callback_secret:
        return {"Authorization": f"Bearer {_callback_secret}"}
    return {}


def verify_token(authorization: Optional[str] = Header(None)) -> None:
    if _secret_token is None:
        return
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid Authorization format")
    if not hmac.compare_digest(parts[1], _secret_token):
        raise HTTPException(status_code=403, detail="Invalid token")


def validate_callback_url(url: str) -> str:
    """Validate a sidecar callback URL and return a reconstructed safe URL.

    The worker sidecar only ever calls back to the OpenZigs orchestrator on the
    same host, so the allowlist is intentionally narrow:

    * Only ``http`` / ``https`` schemes are accepted.
    * Only loopback hosts (``localhost``, ``127.0.0.0/8``, ``::1``) and
      ``*.local`` mDNS names are accepted, plus RFC1918 private ranges for
      Docker-bridge call-backs.
    * Cloud metadata endpoints (``169.254.169.254``, ``fd00:ec2::254``),
      link-local ranges and IPv4-mapped-IPv6 addresses are rejected outright.

    The returned URL is **reconstructed** from the validated components rather
    than the original tainted input, so CodeQL's ``py/full-ssrf`` flow
    analysis recognises the function as a sanitizer (#904 / #935).
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("URL scheme must be http or https")
    host = (parsed.hostname or "").strip("[]")
    if not host:
        raise ValueError("URL must have a hostname")

    # Hard-deny well-known cloud metadata endpoints regardless of how the
    # caller spells them.
    METADATA_HOSTS = {
        "169.254.169.254",      # AWS / Azure / OpenStack
        "100.100.100.200",      # Alibaba Cloud
        "fd00:ec2::254",        # AWS IPv6 metadata
        "metadata.google.internal",
        "metadata.goog",
    }
    if host.lower() in METADATA_HOSTS:
        raise ValueError("Callback URL host blocked (metadata endpoint)")

    accepted = False
    if host in ("localhost", "127.0.0.1", "::1"):
        accepted = True
    else:
        try:
            addr = ipaddress.ip_address(host)
        except ValueError:
            # Hostname (not an IP literal). Allow only mDNS `.local` names.
            if host.endswith(".local"):
                accepted = True
            else:
                raise ValueError("Callback URL host not allowed")
        else:
            # Unwrap IPv4-mapped IPv6.
            if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
                addr = addr.ipv4_mapped
                if str(addr) in METADATA_HOSTS:
                    raise ValueError("Callback URL host blocked (mapped metadata endpoint)")
            if addr.is_link_local or addr.is_multicast or addr.is_unspecified:
                raise ValueError("Callback URL host not allowed")
            if addr.is_loopback or addr.is_private:
                accepted = True

    if not accepted:
        raise ValueError("Callback URL host not allowed")

    # Reconstruct the URL from validated parts (breaks CodeQL taint chain).
    port = f":{parsed.port}" if parsed.port else ""
    path = parsed.path or "/"
    query = f"?{parsed.query}" if parsed.query else ""
    return f"{parsed.scheme}://{host}{port}{path}{query}"


def _is_safe_callback_url(url: str) -> bool:
    try:
        validate_callback_url(url)
        return True
    except ValueError:
        return False


# ── WS2-B (#928) hardening: containment for subprocess paths ──

import re as _re
import pathlib as _pathlib

_DEFAULT_RENDER_ROOT = os.path.expanduser("~/.openzigs/renders")
_ALLOWED_SUBPROCESS_ROOTS: tuple[_pathlib.Path, ...] = tuple(
    _pathlib.Path(p).resolve()
    for p in (
        os.getenv("WORKER_RENDER_ROOT", _DEFAULT_RENDER_ROOT),
        tempfile.gettempdir(),
    )
)
_JOB_ID_RE = _re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _safe_subprocess_path(p: str) -> str:
    """Confine a path that will be passed as an ffmpeg/ffprobe argv to one
    of our render or temp roots (CodeQL py/path-injection +
    py/command-line-injection sanitizer using pathlib + relative_to())."""
    if not isinstance(p, str) or not p:
        raise ValueError("Path must be a non-empty string")
    candidate = _pathlib.Path(p).resolve()
    for root in _ALLOWED_SUBPROCESS_ROOTS:
        try:
            candidate.relative_to(root)
            return str(candidate)
        except ValueError:
            continue
    raise ValueError("Subprocess path is outside the allowed roots")


def _safe_job_id(jid: str) -> str:
    if not isinstance(jid, str) or not _JOB_ID_RE.match(jid):
        raise ValueError("job_id must match ^[A-Za-z0-9_-]{1,128}$")
    return jid


# ── Worker State ─────────────────────────────────────────────

class WorkerState:
    def __init__(self):
        self.is_busy: bool = False
        self.loaded_model: Optional[str] = None
        self._lock = asyncio.Lock()
        self._pipeline = None
        self._model_name: Optional[str] = None
        self._last_job_time: float = 0.0

    async def set_busy(self, busy: bool):
        async with self._lock:
            self.is_busy = busy

    async def get_status(self) -> dict:
        async with self._lock:
            return {"is_busy": self.is_busy, "loaded_model": self.loaded_model}


state = WorkerState()

# ── Job store ──────────────────────────────────────────────────
_MAX_STORED_RESULTS = 100
_job_results: dict[str, dict] = {}
_job_results_lock = threading.Lock()


def _store_result(job_id: str, payload: dict) -> None:
    with _job_results_lock:
        _job_results[job_id] = payload
        while len(_job_results) > _MAX_STORED_RESULTS:
            oldest = next(iter(_job_results))
            del _job_results[oldest]


# ── VRAM Management ──────────────────────────────────────────

def _ensure_torch():
    global torch
    if torch is None:
        import torch as _torch
        torch = _torch
        # Enable cuDNN autotuner — picks fastest conv algorithm for fixed input sizes
        if _torch.cuda.is_available():
            _torch.backends.cudnn.benchmark = True


def clear_vram():
    _ensure_torch()
    gc.collect()
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()


def unload_model():
    if state._pipeline is not None:
        del state._pipeline
        state._pipeline = None
        state._model_name = None
        clear_vram()
        logger.info("Model unloaded and VRAM cleared")


def get_memory_info() -> dict:
    _ensure_torch()
    if torch.cuda.is_available():
        free, total = torch.cuda.mem_get_info()
        return {
            "vram_total_gb": round(total / 1024**3, 1),
            "vram_free_gb": round(free / 1024**3, 1),
            "vram_used_gb": round((total - free) / 1024**3, 1),
        }
    return {}


# ── Video Generation ─────────────────────────────────────────

def _clamp_resolution(width: int, height: int) -> tuple[int, int]:
    w = min(width, MAX_WIDTH)
    h = min(height, MAX_HEIGHT)
    if w * h > MAX_PIXELS:
        scale = (MAX_PIXELS / (w * h)) ** 0.5
        w = int(w * scale)
        h = int(h * scale)
    w = max(w // 32 * 32, 64)
    h = max(h // 32 * 32, 64)
    return w, h


def _snap_frames(num_frames: int) -> int:
    if num_frames < 9:
        return 9
    n = round((num_frames - 1) / 8)
    return max(1 + 8 * n, 9)


def _encode_video(input_path: str, output_path: str, fps: int, has_audio: bool = False):
    """Re-encode with libx264 (NVENC fallback if available)."""
    audio_args = ["-c:a", "aac", "-b:a", "192k"] if has_audio else ["-an"]

    # Try NVENC first for hardware acceleration
    cmd_nvenc = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-c:v", "h264_nvenc",
        "-b:v", "8M",
        "-fps_mode", "cfr",
        "-r", str(fps),
        "-pix_fmt", "yuv420p",
        *audio_args,
        "-movflags", "+faststart",
        output_path,
    ]
    result = subprocess.run(cmd_nvenc, capture_output=True, text=True, timeout=120)
    if result.returncode == 0:
        return

    logger.info("NVENC not available, falling back to libx264")
    cmd_x264 = [
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
    subprocess.run(cmd_x264, capture_output=True, text=True, timeout=120, check=True)


def generate_video_ltx2(request: "GenerateRequest") -> bytes:
    """Generate video using LTX-Video via diffusers on CUDA.

    Supports both legacy LTXPipeline (2B models) and the newer
    LTXConditionPipeline (13B 0.9.7 models).

    Automatically limits frame count based on available VRAM to prevent OOM.
    """
    _ensure_torch()

    fps = request.fps or DEFAULT_FPS
    width, height = _clamp_resolution(request.width, request.height)

    # Resolve which model to load
    model_key = DEFAULT_MODEL_KEY
    if request.model_repo:
        # Check if it matches a known registry entry by HF ID
        match = next((k for k, v in VIDEO_MODEL_REGISTRY.items() if v["hf_id"] == request.model_repo), None)
        if match:
            model_key = match

    # Apply VRAM-aware frame limit BEFORE snapping
    vram_max_frames = _get_max_frames_for_model(model_key)
    requested_frames = min(request.num_frames, MAX_VIDEO_FRAMES)

    if requested_frames > vram_max_frames:
        vram_gb = _get_vram_gb()
        logger.warning(
            f"Requested {requested_frames} frames exceeds VRAM limit ({vram_gb}GB) for {model_key}. "
            f"Capping to {vram_max_frames} frames (~{vram_max_frames / fps:.1f}s at {fps}fps). "
            f"For longer videos, use LTX_MODEL_KEY=ltxv-2b-096-distilled or add more VRAM."
        )
        requested_frames = vram_max_frames

    num_frames = _snap_frames(requested_frames)
    logger.info(f"Resolved params: {width}x{height}, {num_frames} frames, {fps} fps (VRAM: {_get_vram_gb()}GB)")

    spec = VIDEO_MODEL_REGISTRY.get(model_key)
    if not spec:
        raise ValueError(f"Unknown model key: {model_key}")

    hf_id = spec["hf_id"]
    pipeline_class_name = spec["pipeline_class"]

    # Determine whether we need the img2video variant for legacy 2B models
    need_i2v = (
        pipeline_class_name == "LTXPipeline"
        and request.type == "img2video"
        and request.init_image
    )
    # Cache key includes the i2v variant so we reload when switching modes
    effective_key = f"{model_key}:i2v" if need_i2v else model_key

    # Load model if needed
    if state._pipeline is None or state._model_name != effective_key:
        unload_model()
        logger.info(f"Loading video model '{effective_key}' ({hf_id}) on CUDA with model_cpu_offload...")

        if pipeline_class_name == "LTXConditionPipeline":
            from diffusers import LTXConditionPipeline
            pipe = LTXConditionPipeline.from_pretrained(
                hf_id,
                torch_dtype=torch.bfloat16,
            )
        elif need_i2v:
            from diffusers import LTXImageToVideoPipeline
            pipe = LTXImageToVideoPipeline.from_pretrained(
                hf_id,
                torch_dtype=torch.float16,
            )
        else:
            from diffusers import LTXPipeline
            pipe = LTXPipeline.from_pretrained(
                hf_id,
                torch_dtype=torch.float16,
            )

        pooling_active = _is_pooling_active()
        if pooling_active:
            # WS2-A (#927): manual dual-GPU sharding.
            #
            # Tavily research 2026-04-22 confirms diffusers `LTXConditionPipeline`
            # and `LTXPipeline` continue to support per-component `.to(device)`
            # placement on releases 0.30.x through current main, and that this
            # is the recommended pattern over `device_map="auto"` (which is
            # documented as experimental and incompatible with `.to()` /
            # `enable_model_cpu_offload` mode-switching without an explicit
            # `reset_device_map()` call).
            #
            # Sources:
            #   https://huggingface.co/docs/diffusers/main/tutorials/inference_with_big_models
            #   https://discuss.huggingface.co/t/using-second-gpu/23453
            #
            # The pipeline `__call__` keeps activations on the transformer's
            # device and tolerates encoder/VAE living on a different CUDA index.
            try:
                if hasattr(pipe, "transformer") and pipe.transformer is not None:
                    pipe.transformer.to(LTX_TRANSFORMER_DEVICE)
                if hasattr(pipe, "text_encoder") and pipe.text_encoder is not None:
                    pipe.text_encoder.to(LTX_ENCODER_DEVICE)
                if hasattr(pipe, "vae") and pipe.vae is not None:
                    pipe.vae.to(LTX_VAE_DEVICE)
                logger.info(
                    f"[ws2a] Dual-GPU sharding active: transformer={LTX_TRANSFORMER_DEVICE} "
                    f"encoder={LTX_ENCODER_DEVICE} vae={LTX_VAE_DEVICE} pooled_vram={_get_pooled_vram_gb()}GB"
                )
            except Exception as exc:
                logger.warning(
                    f"[ws2a] Sharding placement failed ({exc}); falling back to model_cpu_offload."
                )
                pooling_active = False
        if not pooling_active:
            pipe.enable_model_cpu_offload()
        pipe.enable_attention_slicing()
        # Enable VAE tiling for 12GB GPUs — reduces VRAM during decode
        if hasattr(pipe, "vae") and hasattr(pipe.vae, "enable_tiling"):
            pipe.vae.enable_tiling()
        state._pipeline = pipe
        state._model_name = effective_key
        state.loaded_model = hf_id
        logger.info(f"Model '{effective_key}' ready (CUDA model-level offload + VAE tiling)")

    generator = torch.Generator("cpu").manual_seed(
        request.seed if request.seed is not None else int(time.time()) % (2**32)
    )

    steps = request.num_inference_steps or spec["default_steps"]
    guidance = request.cfg_scale if request.cfg_scale is not None else spec["default_guidance"]

    # Generate video frames — different API for LTXConditionPipeline vs LTXPipeline
    if pipeline_class_name == "LTXConditionPipeline":
        # 0.9.7 pipeline: uses conditions kwarg, supports bfloat16, decode_timestep
        kwargs: dict[str, Any] = {
            "conditions": None,
            "prompt": request.prompt,
            "negative_prompt": request.negative_prompt or "worst quality, inconsistent motion, blurry, jittery, distorted",
            "width": width,
            "height": height,
            "num_frames": num_frames,
            "num_inference_steps": steps,
            "guidance_scale": guidance,
            "decode_timestep": 0.05,
            "decode_noise_scale": 0.025,
            "generator": generator,
            "output_type": "pil",
        }

        # img2video conditioning
        if request.init_image and request.type == "img2video":
            from diffusers.pipelines.ltx.pipeline_ltx_condition import LTXVideoCondition
            from diffusers.utils import export_to_video, load_image, load_video
            img_bytes = base64.b64decode(request.init_image)
            from PIL import Image as PILImage
            img = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
            # Compress image through video codec as recommended by Lightricks
            with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                tmp_path = tmp.name
            export_to_video([img], tmp_path, fps=fps)
            video_cond = load_video(tmp_path)
            os.unlink(tmp_path)
            condition = LTXVideoCondition(video=video_cond, frame_index=0)
            kwargs["conditions"] = [condition]

        with torch.inference_mode():
            result = state._pipeline(**kwargs)
        frames = result.frames[0]
    else:
        # Legacy 2B LTXPipeline / LTXImageToVideoPipeline
        if need_i2v:
            # img2video: decode init_image and pass as 'image' kwarg
            img_bytes = base64.b64decode(request.init_image)
            from PIL import Image as PILImage
            img = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
            with torch.inference_mode():
                result = state._pipeline(
                    image=img,
                    prompt=request.prompt,
                    negative_prompt=request.negative_prompt or "worst quality, inconsistent motion, blurry, jittery, distorted",
                    width=width,
                    height=height,
                    num_frames=num_frames,
                    num_inference_steps=steps,
                    generator=generator,
                )
        else:
            with torch.inference_mode():
                result = state._pipeline(
                    prompt=request.prompt,
                    negative_prompt=request.negative_prompt or "worst quality, inconsistent motion, blurry, jittery, distorted",
                    width=width,
                    height=height,
                    num_frames=num_frames,
                    num_inference_steps=steps,
                    generator=generator,
                )
        frames = result.frames[0]

    with tempfile.TemporaryDirectory() as tmpdir:
        raw_path = os.path.join(tmpdir, "raw.mp4")
        final_path = os.path.join(tmpdir, "output.mp4")

        from diffusers.utils import export_to_video
        export_to_video(frames, raw_path, fps=fps)

        raw_size = os.path.getsize(raw_path) if os.path.exists(raw_path) else 0
        logger.info(f"Raw video: {raw_size:,} bytes, re-encoding...")

        _encode_video(raw_path, final_path, fps)

        return Path(final_path).read_bytes()


# ── Progress Reporting ───────────────────────────────────────

_last_progress_time: float = 0.0
_PROGRESS_THROTTLE_SEC: float = 0.5


async def _report_progress(
    job_id: str, progress_url: Optional[str],
    stage: str, progress: int, message: str = "",
) -> None:
    global _last_progress_time
    if not progress_url:
        return
    if not _is_safe_callback_url(progress_url):
        return
    safe_url = validate_callback_url(progress_url)  # re-validate to bind the safe value
    now = time.monotonic()
    if now - _last_progress_time < _PROGRESS_THROTTLE_SEC:
        return
    _last_progress_time = now
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(safe_url, json={
                "job_id": job_id, "stage": stage,
                "progress": progress, "message": message,
            }, headers=_callback_auth_headers())
    except Exception as e:
        logger.debug(f"Progress report failed (non-fatal): {e}")


# ── Async Job Runner ────────────────────────────────────────

async def run_generation_job(request: "GenerateRequest"):
    start = time.time()
    try:
        await state.set_busy(True)
        logger.info(f"Starting job {request.job_id} ({request.type})")

        await _report_progress(request.job_id, request.progress_url, "Initializing", 0, "Loading model...")

        if request.type in ("txt2video", "img2video"):
            await _report_progress(request.job_id, request.progress_url, "Generating", 10, "Generating video...")
            media_bytes = await asyncio.get_event_loop().run_in_executor(
                None, generate_video_ltx2, request
            )
            media_type = "video/mp4"
        else:
            raise ValueError(f"Unsupported job type: {request.type}")

        elapsed = time.time() - start
        logger.info(f"Job {request.job_id} done in {elapsed:.1f}s ({len(media_bytes)} bytes)")

        await _report_progress(request.job_id, request.progress_url, "Encoding", 80, "Encoding...")

        media_b64 = base64.b64encode(media_bytes).decode("ascii")

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
                "model": state.loaded_model or DEFAULT_MODEL_REPO,
                "pipeline": request.pipeline,
                "duration": round(min(request.num_frames, MAX_VIDEO_FRAMES) / request.fps, 2),
            },
        }

        validated_url = validate_callback_url(request.callback_url)
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(validated_url, json=payload, headers=_callback_auth_headers())
            logger.info(f"Webhook callback: {resp.status_code}")

        _store_result(request.job_id, payload)
        await _report_progress(request.job_id, request.progress_url, "Complete", 100, "Video delivered")

    except Exception as e:
        elapsed = time.time() - start
        error_str = str(e)
        logger.error(f"Job {request.job_id} failed after {elapsed:.1f}s: {error_str}")

        # Check for CUDA errors that require a device reset
        if "CUDA error" in error_str or "out of memory" in error_str.lower():
            logger.warning("CUDA error detected — resetting GPU state")
            try:
                _ensure_torch()
                if state._pipeline is not None:
                    del state._pipeline
                    state._pipeline = None
                    state._model_name = None
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    torch.cuda.synchronize()
                    # Full device reset for "unknown error" type failures
                    torch.cuda.reset_peak_memory_stats()
                logger.info("CUDA state reset complete")
            except Exception as reset_err:
                logger.error(f"CUDA reset failed: {reset_err}")

            # Add helpful error context for OOM-style failures
            vram_gb = _get_vram_gb()
            model_max = _get_max_frames_for_model(DEFAULT_MODEL_KEY)
            error_str = (
                f"{error_str}\n\n"
                f"Your GPU has {vram_gb}GB VRAM. Max safe frames for {DEFAULT_MODEL_KEY}: {model_max}. "
                f"Try reducing frame count, resolution, or switch to LTX_MODEL_KEY=ltxv-2b-096-distilled."
            )

        error_payload = {"job_id": request.job_id, "status": "failed", "error": error_str}
        _store_result(request.job_id, error_payload)
        try:
            validated_url = validate_callback_url(request.callback_url)
            async with httpx.AsyncClient(timeout=30.0) as client:
                await client.post(validated_url, json=error_payload, headers=_callback_auth_headers())
        except Exception as we:
            logger.error(f"Failed to send error webhook: {we}")
    finally:
        await state.set_busy(False)
        state._last_job_time = time.time()
        unload_model()
        state.loaded_model = None
        logger.info(f"Post-job VRAM: {get_memory_info()}")


# ── Request/Response Models ──────────────────────────────────

class GenerateRequest(BaseModel):
    job_id: str
    type: str = "txt2video"
    prompt: str
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT
    num_frames: int = Field(default=MAX_VIDEO_FRAMES, le=MAX_VIDEO_FRAMES)
    fps: int = DEFAULT_FPS
    model: str = "ltx-2"
    callback_url: str
    init_image: Optional[str] = None
    seed: Optional[int] = None
    pipeline: str = "distilled"
    negative_prompt: Optional[str] = None
    cfg_scale: Optional[float] = None
    num_inference_steps: Optional[int] = None
    audio: bool = False
    tiling: str = Field(default="auto", pattern=r"^(auto|none|default|aggressive|conservative)$")
    model_repo: Optional[str] = Field(default=None, max_length=200, pattern=r"^[A-Za-z0-9_\-]+/[A-Za-z0-9_\-\.]+$")
    enhance_prompt: bool = False
    image_strength: float = Field(default=1.0, ge=0.0, le=1.0)
    progress_url: Optional[str] = None


class StatusResponse(BaseModel):
    is_busy: bool
    loaded_model: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    worker: str
    loaded_model: Optional[str] = None


# ── FastAPI App ──────────────────────────────────────────────

async def _idle_model_reaper():
    while True:
        await asyncio.sleep(60)
        if (
            state._model_name is not None
            and not state.is_busy
            and state._last_job_time > 0
            and (time.time() - state._last_job_time) > MODEL_IDLE_TIMEOUT_SEC
        ):
            logger.info(f"Model idle for >{MODEL_IDLE_TIMEOUT_SEC}s, unloading")
            unload_model()
            state.loaded_model = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Defer torch/CUDA import to first use — importing torch at startup can
    # trigger ld.so assertion failures in WSL2 environments where the dynamic
    # linker state is fragile during process init.  CUDA info will be logged
    # on first generation request instead.
    logger.info("Video Worker (CUDA) starting up (torch import deferred)")
    reaper = asyncio.create_task(_idle_model_reaper())
    yield
    reaper.cancel()
    logger.info("Video Worker shutting down")
    unload_model()


app = FastAPI(title="Video Worker (CUDA)", version="1.0.0", lifespan=lifespan)


@app.get("/status", response_model=StatusResponse)
async def get_status():
    return await state.get_status()


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(status="ok", worker="cuda-worker", loaded_model=state.loaded_model)


@app.get("/job-result/{job_id}")
async def get_job_result(job_id: str):
    with _job_results_lock:
        result = _job_results.pop(job_id, None)
    if result is None:
        raise HTTPException(status_code=404, detail="No result for this job")
    return result


@app.get("/memory")
async def memory_endpoint():
    info = get_memory_info()
    return {
        **info,
        "model_loaded": state._model_name,
        "is_busy": state.is_busy,
        "max_frames_13b": _get_max_frames_for_model("ltxv-13b-097-distilled"),
        "max_frames_2b": _get_max_frames_for_model("ltxv-2b-096-distilled"),
    }


@app.get("/gpu-info")
async def gpu_info_endpoint():
    """Report which CUDA device this sidecar is bound to (Issue #884)."""
    _ensure_torch()
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


@app.get("/limits")
async def limits_endpoint():
    """Return VRAM-based generation limits for this GPU."""
    vram_gb = _get_vram_gb()
    fps = DEFAULT_FPS
    return {
        "vram_total_gb": vram_gb,
        "default_model": DEFAULT_MODEL_KEY,
        "models": {
            model_key: {
                "max_frames": _get_max_frames_for_model(model_key),
                "max_duration_sec": round(_get_max_frames_for_model(model_key) / fps, 1),
                "vram_required_gb": spec.get("vram_gb", 12),
            }
            for model_key, spec in VIDEO_MODEL_REGISTRY.items()
        },
        "recommendation": _recommend_model_for_duration(4.0, fps),
        "tip": f"For videos longer than {_get_max_frames_for_model(DEFAULT_MODEL_KEY) / fps:.1f}s, "
               f"use LTX_MODEL_KEY=ltxv-2b-096-distilled or reduce resolution.",
    }


class LastFrameRequest(BaseModel):
    video_base64: str = Field(..., description="Base64-encoded MP4 video")


@app.post("/last-frame")
async def extract_last_frame(req: LastFrameRequest):
    """Extract the last frame from a video for segment chaining.

    Used by multi-segment orchestration to chain segments via img2video.
    """
    import subprocess
    import tempfile

    try:
        video_bytes = base64.b64decode(req.video_base64)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64: {e}")

    with tempfile.TemporaryDirectory() as tmpdir:
        video_path = os.path.join(tmpdir, "input.mp4")
        frame_path = os.path.join(tmpdir, "lastframe.png")

        with open(video_path, "wb") as f:
            f.write(video_bytes)

        # Extract last frame using ffmpeg
        cmd = [
            "ffmpeg", "-y",
            "-sseof", "-0.1",  # Seek to 0.1s before end
            "-i", video_path,
            "-update", "1",
            "-q:v", "2",
            frame_path,
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"ffmpeg failed: {result.stderr[:500]}",
            )

        if not os.path.exists(frame_path):
            raise HTTPException(status_code=500, detail="Failed to extract frame")

        with open(frame_path, "rb") as f:
            frame_bytes = f.read()

        frame_b64 = base64.b64encode(frame_bytes).decode("ascii")
        return {"frame_base64": frame_b64}


@app.get("/models")
async def list_models():
    models = []
    for key, spec in VIDEO_MODEL_REGISTRY.items():
        models.append({
            "id": key,
            "repo": spec["hf_id"],
            "name": spec["description"],
            "pipeline_class": spec["pipeline_class"],
            "default_steps": spec["default_steps"],
            "default_guidance": spec["default_guidance"],
            "vram_gb": spec["vram_gb"],
            "is_default": key == DEFAULT_MODEL_KEY,
            "synchronized_audio": bool(spec.get("synchronized_audio", False)),
        })
    return {
        "models": models,
        "default_key": DEFAULT_MODEL_KEY,
        "default_repo": DEFAULT_MODEL_REPO,
        # Audio is supported on CUDA only when the active model carries
        # synchronized audio weights AND the runtime allows it.
        "audio_supported": (
            LTX_ALLOW_AUDIO
            and any(spec.get("synchronized_audio") for spec in VIDEO_MODEL_REGISTRY.values())
            and _get_pooled_vram_gb() >= 24
        ),
    }


@app.get("/capabilities")
async def capabilities():
    """WS2-C (#929) — Runtime capability report.

    Surfaces detected dual-GPU sharding state, max-frame tier, available
    audio modes, and the env-var configuration that drove the decisions.
    Consumed by the admin UI (`ui/app/admin/models/`) so users can see
    what their hardware is actually capable of without reading logs.
    """
    _ensure_torch()
    cuda_available = bool(torch.cuda.is_available())
    device_count = torch.cuda.device_count() if cuda_available else 0
    pooled_vram = _get_pooled_vram_gb() if cuda_available else 0
    pooling_active = _is_pooling_active()
    per_device = []
    if cuda_available:
        for i in range(device_count):
            try:
                free, total = torch.cuda.mem_get_info(i)
                per_device.append({
                    "index": i,
                    "name": torch.cuda.get_device_name(i),
                    "total_gb": int(total / 1024**3),
                    "free_gb": int(free / 1024**3),
                })
            except Exception as exc:
                # Avoid leaking stack traces to external callers
                # (CodeQL py/stack-trace-exposure). Log internally instead.
                logger.warning(f"[capabilities] mem_get_info({i}) failed: {exc}")
                per_device.append({"index": i, "error": "device_query_failed"})

    audio_modes = ["off"]
    # Post-processing v2a path is always available when the v2a sidecar is
    # configured; the sidecar URL is owned by the orchestrator, not us.
    audio_modes.append("auto")
    if (
        LTX_ALLOW_AUDIO
        and pooled_vram >= 24
        and any(spec.get("synchronized_audio") for spec in VIDEO_MODEL_REGISTRY.values())
    ):
        audio_modes.append("native")

    return {
        "cuda_available": cuda_available,
        "device_count": device_count,
        "pooled_vram_gb": pooled_vram,
        "per_device": per_device,
        "pooling": {
            "mode": LTX_POOLING_MODE,
            "active": pooling_active,
            "transformer_device": LTX_TRANSFORMER_DEVICE if pooling_active else None,
            "encoder_device": LTX_ENCODER_DEVICE if pooling_active else None,
            "vae_device": LTX_VAE_DEVICE if pooling_active else None,
            "min_vram_gb": LTX_POOLING_MIN_VRAM_GB,
        },
        "max_frames": {
            key: _get_max_frames_for_model(key)
            for key in VIDEO_MODEL_REGISTRY.keys()
        },
        "audio_modes": audio_modes,
        "env": {
            "LTX_POOLING_MODE": LTX_POOLING_MODE,
            "LTX_TRANSFORMER_DEVICE": LTX_TRANSFORMER_DEVICE,
            "LTX_ENCODER_DEVICE": LTX_ENCODER_DEVICE,
            "LTX_VAE_DEVICE": LTX_VAE_DEVICE,
            "LTX_POOLING_MIN_VRAM_GB": LTX_POOLING_MIN_VRAM_GB,
            "LTX_MAX_FRAMES_OVERRIDE": LTX_MAX_FRAMES_OVERRIDE,
            "LTX_ALLOW_AUDIO": LTX_ALLOW_AUDIO,
        },
    }


@app.post("/unload", dependencies=[Depends(verify_token)])
async def unload():
    """Unload the current model and free VRAM.
    Used by QueueMaster for cross-sidecar VRAM coordination
    (e.g., LTX worker ↔ LatentSync lipsync handoff).
    """
    if state.is_busy:
        raise HTTPException(status_code=409, detail="Worker is busy, cannot unload")
    prev = state.loaded_model
    unload_model()
    state.loaded_model = None
    return {"status": "unloaded", "previous_model": prev}


@app.post("/generate", status_code=202, dependencies=[Depends(verify_token)])
async def generate(request: GenerateRequest):
    if state.is_busy:
        raise HTTPException(status_code=409, detail="Worker is busy with another job")

    # Audio gating (#926, #927):
    #
    #   - On the CUDA backend, only `ltxv-2-22b-distilled` carries native
    #     synchronized audio weights.
    #   - It is gated behind LTX_ALLOW_AUDIO=1 and pooled VRAM >= 24 GB so
    #     it never silently OOMs a 12 GB single-card host.
    #   - All other models still reject audio outright, matching legacy
    #     behaviour.
    if request.audio:
        model_spec = VIDEO_MODEL_REGISTRY.get(request.model, {})
        synchronized_audio_supported = bool(model_spec.get("synchronized_audio"))
        pooled_vram = _get_pooled_vram_gb()
        if not synchronized_audio_supported:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Audio generation is not supported by model '{request.model}' on CUDA. "
                    "Only 'ltxv-2-22b-distilled' carries synchronized audio weights, "
                    "or post-process via the v2a sidecar (audio='auto')."
                ),
            )
        if not LTX_ALLOW_AUDIO:
            raise HTTPException(
                status_code=400,
                detail=(
                    "LTX-2 synchronized audio is disabled. Set LTX_ALLOW_AUDIO=1 "
                    "to enable. See docs/MULTI_GPU.md for VRAM requirements."
                ),
            )
        if pooled_vram < 24:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"LTX-2 synchronized audio requires >=24 GB pooled VRAM "
                    f"(detected {pooled_vram} GB). Use audio='auto' to dispatch "
                    "the v2a sidecar instead, or add a second GPU."
                ),
            )

    asyncio.create_task(run_generation_job(request))
    logger.info(f"Job {request.job_id} accepted")
    return {"status": "accepted", "job_id": request.job_id}


# ── WS2-B (#928): Extended duration via last-frame conditioning ──

class GenerateExtendedRequest(BaseModel):
    """Generate a video longer than the model's per-clip frame ceiling.

    The worker computes ``ceil(target_duration_sec * fps / max_clip_frames)``
    sub-clips, generates them sequentially with the **last frame of clip N**
    used as the ``init_image`` for clip N+1, then concatenates with ffmpeg.
    Optional 4-frame crossfade between clips smooths the seams.
    """

    job_id: str
    prompt: str
    target_duration_sec: float = Field(gt=0.0, le=120.0)
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT
    fps: int = DEFAULT_FPS
    model: str = DEFAULT_MODEL_KEY
    callback_url: str
    seed: Optional[int] = None
    negative_prompt: Optional[str] = None
    cfg_scale: Optional[float] = None
    num_inference_steps: Optional[int] = None
    crossfade: bool = True
    init_image: Optional[str] = None  # base64 — seeds the first clip


@app.post("/generate-extended", status_code=202, dependencies=[Depends(verify_token)])
async def generate_extended(request: GenerateExtendedRequest):
    """Accept an extended-duration job and dispatch it asynchronously.

    The actual stitching loop lives in ``run_extended_generation_job`` which
    reuses ``run_generation_job`` for each sub-clip; that keeps memory
    behaviour identical to the single-clip path and avoids a parallel
    generation code-path that would drift out of sync with #927 sharding.
    """
    if state.is_busy:
        raise HTTPException(status_code=409, detail="Worker is busy with another job")

    # Validate model exists and pick its per-clip ceiling.
    if request.model not in VIDEO_MODEL_REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown model: {request.model}")
    max_clip_frames = _get_max_frames_for_model(request.model)
    target_frames = int(request.target_duration_sec * request.fps)
    num_clips = max(1, math.ceil(target_frames / max_clip_frames))
    if num_clips > 16:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Requested {request.target_duration_sec}s would need "
                f"{num_clips} sub-clips (>16). Reduce duration or use a "
                "model with a higher per-clip frame ceiling."
            ),
        )

    asyncio.create_task(run_extended_generation_job(request, max_clip_frames, num_clips))
    logger.info(
        f"[ws2b] Extended job {request.job_id} accepted "
        f"({request.target_duration_sec}s -> {num_clips} sub-clips of "
        f"{max_clip_frames} frames each)"
    )
    return {
        "status": "accepted",
        "job_id": request.job_id,
        "num_clips": num_clips,
        "max_clip_frames": max_clip_frames,
        "target_frames": target_frames,
    }


async def run_extended_generation_job(
    request: GenerateExtendedRequest,
    max_clip_frames: int,
    num_clips: int,
) -> None:
    """Sequentially generate sub-clips and stitch them with ffmpeg.

    Implementation note: this function intentionally invokes the existing
    ``run_generation_job`` per clip rather than re-entering the diffusion
    pipeline directly. That preserves all the OOM, sharding, and progress
    callback behaviour from the single-clip path. The trade-off is that
    we incur per-clip async overhead, but for jobs measured in seconds-
    of-video this is negligible.
    """
    output_paths: list[str] = []
    last_frame_b64: Optional[str] = request.init_image
    try:
        await state.set_busy(True)
        for clip_idx in range(num_clips):
            clip_job_id = f"{request.job_id}__clip{clip_idx}"
            sub_request = GenerateRequest(
                job_id=clip_job_id,
                type="img2video" if last_frame_b64 else "txt2video",
                prompt=request.prompt,
                width=request.width,
                height=request.height,
                num_frames=max_clip_frames,
                fps=request.fps,
                model=request.model,
                callback_url=request.callback_url,
                init_image=last_frame_b64,
                seed=(request.seed + clip_idx) if request.seed is not None else None,
                negative_prompt=request.negative_prompt,
                cfg_scale=request.cfg_scale,
                num_inference_steps=request.num_inference_steps,
            )
            await run_generation_job(sub_request)
            result = _job_results.get(clip_job_id)
            if not result or "video_path" not in result:
                raise RuntimeError(
                    f"Sub-clip {clip_idx} produced no output (job_id={clip_job_id})"
                )
            output_paths.append(result["video_path"])
            # Extract the final frame for the next clip's seed image.
            if clip_idx < num_clips - 1:
                last_frame_b64 = _extract_last_frame_b64(result["video_path"])

        # Concatenate the produced clips.
        safe_jid = _safe_job_id(request.job_id)
        final_path = os.path.join(
            tempfile.gettempdir(), f"extended_{safe_jid}.mp4"
        )
        _concat_clips(output_paths, final_path, crossfade=request.crossfade, fps=request.fps)
        _store_result(request.job_id, {
            "status": "completed",
            "video_path": final_path,
            "num_clips": num_clips,
            "duration_sec": request.target_duration_sec,
        })
        # Notify orchestrator
        try:
            if request.callback_url:
                safe_url = validate_callback_url(request.callback_url)
                async with httpx.AsyncClient(timeout=30.0) as client:
                    await client.post(
                        safe_url,
                        json={
                            "job_id": safe_jid,
                            "status": "completed",
                            "video_path": final_path,
                            "extended": True,
                        },
                    )
        except Exception as exc:
            logger.warning(f"[ws2b] Callback POST failed: {exc}")
    except Exception as exc:
        logger.exception(f"[ws2b] Extended job {request.job_id} failed")
        # Generic message to external callers; full trace stays in the log
        # (CodeQL py/stack-trace-exposure).
        _store_result(request.job_id, {"status": "failed", "error": "job failed; see worker logs"})
        try:
            if request.callback_url:
                safe_url = validate_callback_url(request.callback_url)
                async with httpx.AsyncClient(timeout=30.0) as client:
                    await client.post(
                        safe_url,
                        json={
                            "job_id": request.job_id,
                            "status": "failed",
                            "error": "job failed; see worker logs",
                        },
                    )
        except Exception:
            pass
    finally:
        await state.set_busy(False)


def _extract_last_frame_b64(video_path: str) -> str:
    """Use ffmpeg to grab the last frame as base64-encoded PNG bytes."""
    safe_in = _safe_subprocess_path(video_path)
    out_png = os.path.join(tempfile.gettempdir(), f"lastframe_{int(time.time()*1000)}.png")
    cmd = [
        "ffmpeg", "-y", "-sseof", "-0.1", "-i", safe_in,
        "-update", "1", "-q:v", "1", out_png,
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    with open(out_png, "rb") as f:
        data = f.read()
    try:
        os.remove(out_png)
    except OSError:
        pass
    return base64.b64encode(data).decode("ascii")


def _concat_clips(input_paths: list[str], output_path: str, *, crossfade: bool, fps: int) -> None:
    """Concatenate ``input_paths`` into ``output_path``.

    With ``crossfade=False`` we use the lossless concat demuxer. With
    ``crossfade=True`` we apply a 4-frame xfade between successive clips
    using the filter graph; this re-encodes but smooths discontinuities at
    the seams (#928 acceptance criterion).
    """
    if not input_paths:
        raise ValueError("input_paths cannot be empty")
    # Confine every input path to an allowed root before passing to ffmpeg
    # (CodeQL py/path-injection + py/command-line-injection sanitizer).
    safe_inputs = [_safe_subprocess_path(p) for p in input_paths]
    safe_output = _safe_subprocess_path(os.path.dirname(output_path) or ".")
    # Re-join filename onto the validated directory so the output stays inside.
    safe_out_path = os.path.join(safe_output, os.path.basename(output_path))
    if len(safe_inputs) == 1 or not crossfade:
        list_path = safe_out_path + ".concat.txt"
        with open(list_path, "w", encoding="utf-8") as f:
            for p in safe_inputs:
                # ffmpeg concat list format: posix forward slashes, escaped quotes.
                safe = p.replace("'", "\\'")
                f.write(f"file '{safe}'\n")
        cmd = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path,
            "-c", "copy", safe_out_path,
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
        finally:
            try:
                os.remove(list_path)
            except OSError:
                pass
        return

    # Crossfade variant: chain xfade filters. Duration = 4 frames in seconds.
    xfade_dur = 4.0 / float(max(fps, 1))
    inputs: list[str] = []
    for p in safe_inputs:
        inputs.extend(["-i", p])
    # Build filter graph.
    n = len(safe_inputs)
    parts: list[str] = []
    last_label = "[0:v]"
    cumulative_offset = 0.0
    for i in range(1, n):
        # Need clip duration to set xfade offset.
        clip_dur = _probe_duration(safe_inputs[i - 1])
        cumulative_offset += clip_dur - xfade_dur
        out_label = f"[v{i}]"
        parts.append(
            f"{last_label}[{i}:v]xfade=transition=fade:duration={xfade_dur}:offset={cumulative_offset}{out_label}"
        )
        last_label = out_label
    filter_graph = ";".join(parts)
    cmd = [
        "ffmpeg", "-y", *inputs,
        "-filter_complex", filter_graph,
        "-map", last_label,
        "-pix_fmt", "yuv420p",
        safe_out_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _probe_duration(video_path: str) -> float:
    """Return clip duration in seconds via ffprobe."""
    safe_in = _safe_subprocess_path(video_path)
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", safe_in,
    ]
    out = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return float(out.stdout.strip())


# ── Entrypoint ─────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Video worker CUDA sidecar")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5007")))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
