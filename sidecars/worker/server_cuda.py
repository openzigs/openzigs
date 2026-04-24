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
        # CORRECTION (Issue #939 follow-up, verified 2026-04-23):
        # The previously-listed `Lightricks/LTX-Video-0.9.6-distilled` HF
        # repo does NOT exist (HTTP 404 even with a valid token). Lightricks
        # only publishes the 0.9.6-distilled weights as a raw `.safetensors`
        # file inside the umbrella `Lightricks/LTX-Video` repo (intended for
        # ComfyUI), with NO diffusers-layout snapshot. We therefore mark
        # this entry as `unavailable` so the UI/capabilities/generate paths
        # never attempt to load it. Use `ltxv-2b-legacy` (0.9 weights via the
        # umbrella repo) or `ltxv-13b-097-distilled` (real diffusers v0.9.7)
        # instead.
        "hf_id": "Lightricks/LTX-Video-0.9.6-distilled",
        "pipeline_class": "LTXPipeline",
        "default_steps": 4,
        "default_guidance": 0.0,
        "description": "LTX-Video 2B distilled — real-time, low VRAM (4 steps)",
        "vram_gb": 8,
        "tier": "low",
        "min_vram_gb": 8,
        "unavailable": True,
        "unavailable_reason": (
            "Upstream gap: Lightricks does not publish a diffusers-layout HF "
            "repo for 0.9.6-distilled (verified 2026-04-23). Use "
            "`ltxv-2b-legacy` or `ltxv-13b-097-distilled` instead."
        ),
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
    # WS1-B (#926): LTX-2 distilled with native synchronized audio.
    # 2026-04-24 update: this model is now served by the dedicated `ltx2`
    # sidecar on port 5013 (see `sidecars/ltx2/`). The diffusers
    # `LTX2Pipeline` path remains broken upstream (missing
    # `LTX2TextConnectors`/`LTX2Vocoder` symbols), but the **native**
    # `ltx_pipelines.distilled` CLI from the Lightricks/LTX-2 monorepo
    # works end-to-end on a single 12 GB GPU + 32+ GB RAM with
    # `--offload cpu` (validated by `scripts/ltx2_smoke.sh`).
    # The worker no longer attempts to load this model in-process; the
    # orchestrator should route `audio_mode: "native"` to port 5013.
    "ltxv-2-22b-distilled": {
        "hf_id": "Lightricks/LTX-2",
        "pipeline_class": "LTX2Pipeline",
        "default_steps": 8,
        "default_guidance": 1.0,
        "description": "LTX-2 19B distilled — native synchronized audio via the dedicated ltx2 sidecar (port 5013). Not loaded in-process by the worker.",
        "vram_gb": 12,
        "tier": "ultra",
        "min_vram_gb": 6,
        "synchronized_audio": True,
        # `served_by_sidecar` tells callers this model is NOT handled by the
        # worker's in-process generate path; it must be routed to the named
        # sidecar URL. The worker still advertises the model in /capabilities
        # so the UI can offer it, but `generate_video_ltx2()` will refuse it.
        "served_by_sidecar": "http://localhost:5013",
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
# VAE colocates with the transformer by default — VAE decode activations need
# to live next to the transformer output to avoid a cross-device copy of a
# multi-GB latent tensor. (Issue #939 gap A: with VAE on cuda:0 next to
# T5-XXL the VAE decode buffers OOM'd a 12 GB card.)
LTX_VAE_DEVICE: str = os.getenv("LTX_VAE_DEVICE", "cuda:1").strip()
# Minimum pooled VRAM in GB to enable auto-pooling (sum of all visible cards).
LTX_POOLING_MIN_VRAM_GB: int = int(os.getenv("LTX_POOLING_MIN_VRAM_GB", "18"))
# T5-XXL lifecycle on pooled / low-VRAM rigs (Issue #939 gap A):
#   "keep"      -> leave T5 on the encoder device for the whole pipeline call.
#                  Fastest when VRAM is plentiful (>=24 GB per card).
#   "transient" -> manually run encode_prompt(), then move T5 to CPU and
#                  empty_cache() before the transformer pass. Frees ~9.5 GB
#                  on the encoder device so VAE decode buffers fit on 12 GB.
#   "auto"      -> pick "transient" when ANY visible CUDA device has
#                  <= LTX_T5_TRANSIENT_MAX_VRAM_GB total VRAM, else "keep".
LTX_T5_LIFECYCLE: str = os.getenv("LTX_T5_LIFECYCLE", "auto").strip().lower()
if LTX_T5_LIFECYCLE not in ("auto", "keep", "transient"):
    logger.warning(
        f"LTX_T5_LIFECYCLE='{LTX_T5_LIFECYCLE}' is not recognised; falling back to 'auto'"
    )
    LTX_T5_LIFECYCLE = "auto"
LTX_T5_TRANSIENT_MAX_VRAM_GB: int = int(os.getenv("LTX_T5_TRANSIENT_MAX_VRAM_GB", "16"))
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
        except Exception as exc:
            # mem_get_info per-device requires fairly recent torch; on older
            # builds, fall back to props.
            logger.debug("mem_get_info failed for device %d: %s; falling back to get_device_properties", i, exc)
            try:
                props = torch.cuda.get_device_properties(i)
                total_bytes += getattr(props, "total_memory", 0)
            except Exception as inner_exc:
                logger.debug("get_device_properties also failed for device %d: %s; skipping", i, inner_exc)
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


def _resolve_t5_lifecycle() -> str:
    """Return the effective LTX_T5_LIFECYCLE value (`keep` or `transient`).

    "auto" expands to "transient" when **any** visible CUDA device has
    total VRAM <= LTX_T5_TRANSIENT_MAX_VRAM_GB (default 16). The intent is
    that on 12 GB cards (RTX 3060) we always free T5-XXL between encode and
    transformer passes, while on 24 GB+ cards we keep it resident for speed.
    """
    if LTX_T5_LIFECYCLE in ("keep", "transient"):
        return LTX_T5_LIFECYCLE
    _ensure_torch()
    if not torch.cuda.is_available():
        return "transient"
    try:
        for i in range(torch.cuda.device_count()):
            try:
                _, total = torch.cuda.mem_get_info(i)
                if int(total / 1024**3) <= LTX_T5_TRANSIENT_MAX_VRAM_GB:
                    return "transient"
            except Exception:
                # Fall back to device props on older torch builds.
                props = torch.cuda.get_device_properties(i)
                if int(getattr(props, "total_memory", 0) / 1024**3) <= LTX_T5_TRANSIENT_MAX_VRAM_GB:
                    return "transient"
    except Exception as exc:
        logger.debug("[t5-lifecycle] auto-detection failed: %s; defaulting to 'transient'", exc)
        return "transient"
    return "keep"


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

    # Models served by an external sidecar (e.g. ltxv-2-22b-distilled →
    # port 5013) must not be loaded in-process by the worker. The
    # orchestrator should route directly; surface a clear error if it ever
    # forwards such a request to the worker by mistake.
    sidecar_url = spec.get("served_by_sidecar")
    if sidecar_url:
        raise RuntimeError(
            f"Model '{model_key}' is served by an external sidecar at "
            f"{sidecar_url}. Route the request directly to that sidecar "
            "instead of the video worker (the worker does not proxy)."
        )

    hf_id = spec["hf_id"]
    pipeline_class_name = spec["pipeline_class"]

    # Issue #939 gap B: gated HF repos require a token. Fail early with an
    # actionable error rather than letting `from_pretrained()` raise a
    # cryptic 401 deep inside diffusers.
    if spec.get("requires_hf_token") and not (
        os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    ):
        raise RuntimeError(
            f"Model '{model_key}' ({hf_id}) is a gated HuggingFace repo and "
            "requires a logged-in HF token. Either set HF_TOKEN / "
            "HUGGING_FACE_HUB_TOKEN in your environment after accepting the "
            f"license at https://huggingface.co/{hf_id}, or pick a public "
            "model (e.g. LTX_MODEL_KEY=ltxv-13b-097-distilled)."
        )

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

        # Issue #939 gap A: when pooling is active and the T5 lifecycle resolves
        # to "transient", manually run encode_prompt() on the encoder device,
        # move T5 to CPU and free its VRAM before the transformer pass. This
        # is what makes 13B distilled fit on 2× 12 GB pooled.
        pooling_active = _is_pooling_active()
        t5_lifecycle = _resolve_t5_lifecycle() if pooling_active else "keep"
        if pooling_active and t5_lifecycle == "transient" and hasattr(state._pipeline, "encode_prompt"):
            try:
                pipe = state._pipeline
                with torch.inference_mode():
                    encode_out = pipe.encode_prompt(
                        prompt=kwargs["prompt"],
                        negative_prompt=kwargs["negative_prompt"],
                        do_classifier_free_guidance=guidance > 1.0,
                        device=LTX_ENCODER_DEVICE,
                    )
                # encode_prompt returns either a 4-tuple (LTXConditionPipeline)
                # or a 2-tuple (LTXPipeline). Handle both.
                if isinstance(encode_out, tuple) and len(encode_out) >= 2:
                    prompt_embeds = encode_out[0]
                    prompt_attention_mask = encode_out[1] if len(encode_out) > 1 else None
                    negative_prompt_embeds = encode_out[2] if len(encode_out) > 2 else None
                    negative_prompt_attention_mask = encode_out[3] if len(encode_out) > 3 else None
                else:
                    raise RuntimeError(f"Unexpected encode_prompt return shape: {type(encode_out)}")
                # Move T5 off the encoder GPU and reclaim VRAM.
                try:
                    if hasattr(pipe, "text_encoder") and pipe.text_encoder is not None:
                        pipe.text_encoder.to("cpu")
                    gc.collect()
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    logger.info("[t5-lifecycle] T5 encoded; moved to CPU and freed encoder VRAM")
                except Exception as off_exc:
                    logger.warning(f"[t5-lifecycle] T5 offload failed: {off_exc}; continuing")
                # Move embeds to the transformer device for the diffusion pass.
                target_dev = LTX_TRANSFORMER_DEVICE
                prompt_embeds = prompt_embeds.to(target_dev)
                if prompt_attention_mask is not None:
                    prompt_attention_mask = prompt_attention_mask.to(target_dev)
                if negative_prompt_embeds is not None:
                    negative_prompt_embeds = negative_prompt_embeds.to(target_dev)
                if negative_prompt_attention_mask is not None:
                    negative_prompt_attention_mask = negative_prompt_attention_mask.to(target_dev)
                # Swap prompt= for prompt_embeds=.
                kwargs.pop("prompt", None)
                kwargs.pop("negative_prompt", None)
                kwargs["prompt_embeds"] = prompt_embeds
                if prompt_attention_mask is not None:
                    kwargs["prompt_attention_mask"] = prompt_attention_mask
                if negative_prompt_embeds is not None:
                    kwargs["negative_prompt_embeds"] = negative_prompt_embeds
                if negative_prompt_attention_mask is not None:
                    kwargs["negative_prompt_attention_mask"] = negative_prompt_attention_mask
            except Exception as enc_exc:
                logger.warning(
                    f"[t5-lifecycle] transient encode path failed ({enc_exc}); "
                    "falling back to in-pipeline encoding (T5 stays resident)"
                )

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
    # Pooling visibility (Issue #939): log which GPU indices the worker can
    # see and what pooling mode is configured. This makes it obvious in the
    # log whether `WORKER_POOLING_MODE=auto` actually exposed both cards.
    visible = os.environ.get("CUDA_VISIBLE_DEVICES", "<unset>")
    logger.info(
        f"[pooling] CUDA_VISIBLE_DEVICES={visible} "
        f"LTX_POOLING_MODE={LTX_POOLING_MODE} "
        f"transformer={LTX_TRANSFORMER_DEVICE} encoder={LTX_ENCODER_DEVICE} "
        f"vae={LTX_VAE_DEVICE} min_vram_gb={LTX_POOLING_MIN_VRAM_GB} "
        f"allow_audio={LTX_ALLOW_AUDIO}"
    )
    # Issue #939 gap A: surface the resolved T5 lifecycle alongside the
    # chosen device layout so operators can confirm at a glance that the
    # 12 GB-friendly path is active.
    try:
        t5_resolved = _resolve_t5_lifecycle()
    except Exception as exc:
        logger.debug("[t5-lifecycle] startup resolution failed: %s", exc)
        t5_resolved = "unknown"
    logger.info(
        f"[t5-lifecycle] LTX_T5_LIFECYCLE={LTX_T5_LIFECYCLE} resolved={t5_resolved} "
        f"transient_max_vram_gb={LTX_T5_TRANSIENT_MAX_VRAM_GB} "
        f"layout: encode_on={LTX_ENCODER_DEVICE} -> transformer_on={LTX_TRANSFORMER_DEVICE} (vae_on={LTX_VAE_DEVICE})"
    )
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
    """Report CUDA bindings and pooling state (Issue #884, #939).

    Includes per-GPU detail (index/name/vram/free) so the admin UI can
    render a real dual-GPU panel without scraping logs.
    """
    _ensure_torch()
    cuda_visible = os.environ.get("CUDA_VISIBLE_DEVICES", "")
    if not torch.cuda.is_available():
        return {
            "available": False,
            "cuda_visible": cuda_visible,
            "pooling_mode": LTX_POOLING_MODE,
            "pooling_active": False,
            "transformer_device": LTX_TRANSFORMER_DEVICE,
            "encoder_device": LTX_ENCODER_DEVICE,
            "vae_device": LTX_VAE_DEVICE,
            "pooled_vram_gb": 0,
            "gpus": [],
        }
    idx = torch.cuda.current_device()
    free, total = torch.cuda.mem_get_info(idx)
    device_count = torch.cuda.device_count()
    pooling_active = _is_pooling_active()
    pooled_vram = _get_pooled_vram_gb()
    gpus = []
    for i in range(device_count):
        try:
            g_free, g_total = torch.cuda.mem_get_info(i)
            gpus.append({
                "index": i,
                "name": torch.cuda.get_device_name(i),
                "vram_gb": round(g_total / 1024**3, 1),
                "free_gb": round(g_free / 1024**3, 1),
            })
        except Exception as exc:
            logger.warning(f"[gpu-info] mem_get_info({i}) failed: {exc}")
            gpus.append({"index": i, "name": "unknown", "vram_gb": 0, "free_gb": 0})
    return {
        "available": True,
        "device_index": idx,
        "device_name": torch.cuda.get_device_name(idx),
        "device_count": device_count,
        "total_mb": int(total / 1024**2),
        "free_mb": int(free / 1024**2),
        "cuda_visible": cuda_visible,
        "pooling_mode": LTX_POOLING_MODE,
        "pooling_active": pooling_active,
        "transformer_device": LTX_TRANSFORMER_DEVICE if pooling_active else f"cuda:{idx}",
        "encoder_device": LTX_ENCODER_DEVICE if pooling_active else f"cuda:{idx}",
        "vae_device": LTX_VAE_DEVICE if pooling_active else f"cuda:{idx}",
        "pooled_vram_gb": pooled_vram,
        "t5_lifecycle": LTX_T5_LIFECYCLE,
        "t5_lifecycle_resolved": _resolve_t5_lifecycle(),
        "gpus": gpus,
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
            "requires_hf_token": bool(spec.get("requires_hf_token", False)),
            # #939 follow-up (2026-04-23): some entries have known upstream
            # gaps (broken HF repo IDs, missing helper packages). They
            # remain in the registry for documentation/traceability but
            # `unavailable=true` tells the UI to grey them out and 
            # `/generate` will reject them with HTTP 503.
            "unavailable": bool(spec.get("unavailable", False)),
            "unavailable_reason": spec.get("unavailable_reason"),
            # 2026-04-24: when set, the UI/orchestrator must route requests
            # to this URL instead of the worker's in-process generate path.
            "served_by_sidecar": spec.get("served_by_sidecar"),
        })
    # Native synchronized audio is now provided by the dedicated ltx2
    # sidecar (port 5013) for any registry entry carrying both
    # `synchronized_audio` and `served_by_sidecar`. Pooled VRAM is no
    # longer the gate — the sidecar accepts CPU/disk offload on 12 GB+
    # single-GPU hardware. We treat the model as audio-capable whenever
    # LTX_ALLOW_AUDIO is on and at least one available entry advertises it.
    audio_capable = LTX_ALLOW_AUDIO and any(
        spec.get("synchronized_audio") and not spec.get("unavailable")
        for spec in VIDEO_MODEL_REGISTRY.values()
    )
    return {
        "models": models,
        "default_key": DEFAULT_MODEL_KEY,
        "default_repo": DEFAULT_MODEL_REPO,
        "audio_supported": audio_capable,
    }


@app.get("/capabilities")
async def capabilities():
    """Runtime capability report (Issues #929 / #939).

    Flat schema consumed by the admin UI to render a hardware-aware
    capabilities panel and pre-flight validate generation requests.
    `audio_modes` reflects what the *runtime* supports right now:

    * ``off``   — always present.
    * ``auto``  — only when the v2a sidecar (port 5012) responds to /health.
    * ``music`` — only when the music sidecar (port 5009) responds to /health.
    * ``native`` — only when LTX-2 weights are in the registry, LTX_ALLOW_AUDIO=1,
      and pooled VRAM ≥ 24 GB.
    """
    _ensure_torch()
    cuda_available = bool(torch.cuda.is_available())
    device_count = torch.cuda.device_count() if cuda_available else 0
    pooled_vram = _get_pooled_vram_gb() if cuda_available else 0
    pooling_active = _is_pooling_active() if cuda_available else False

    gpus = []
    if cuda_available:
        for i in range(device_count):
            try:
                _free, total = torch.cuda.mem_get_info(i)
                gpus.append({
                    "index": i,
                    "name": torch.cuda.get_device_name(i),
                    "vram_gb": round(total / 1024**3, 1),
                })
            except Exception as exc:
                logger.warning(f"[capabilities] mem_get_info({i}) failed: {exc}")
                gpus.append({"index": i, "name": "unknown", "vram_gb": 0})

    models = []
    for key, spec in VIDEO_MODEL_REGISTRY.items():
        max_frames = _get_max_frames_for_model(key)
        models.append({
            "key": key,
            "max_frames": max_frames,
            "max_seconds_at_24fps": round(max_frames / 24.0, 2),
            "synchronized_audio": bool(spec.get("synchronized_audio", False)),
            "requires_hf_token": bool(spec.get("requires_hf_token", False)),
            "hf_token_present": bool(
                os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
            ),
            # #939 follow-up: see /models for rationale
            "unavailable": bool(spec.get("unavailable", False)),
            "unavailable_reason": spec.get("unavailable_reason"),
        })

    # Best-effort sidecar probes. ``httpx.get`` is sync-friendly here because
    # we wrap it in a tight timeout; we never want this endpoint to block on
    # a slow neighbour.
    audio_modes = ["off"]
    try:
        r = httpx.get("http://localhost:5012/health", timeout=0.5)
        if r.status_code == 200:
            audio_modes.append("auto")
    except Exception:
        pass  # v2a not reachable — omit "auto"
    try:
        r = httpx.get("http://localhost:5009/health", timeout=0.5)
        if r.status_code == 200:
            audio_modes.append("music")
    except Exception:
        pass  # music sidecar not reachable — omit "music"
    if (
        LTX_ALLOW_AUDIO
        and any(
            spec.get("synchronized_audio") and not spec.get("unavailable")
            for spec in VIDEO_MODEL_REGISTRY.values()
        )
    ):
        # 2026-04-24: native audio is now served by the dedicated ltx2
        # sidecar on port 5013 (not by the worker's in-process LTX path).
        # Probe its /health rather than gating on pooled VRAM — the sidecar
        # itself enforces hardware requirements and gracefully degrades.
        try:
            r = httpx.get("http://localhost:5013/health", timeout=0.5)
            if r.status_code == 200 and r.json().get("ready"):
                audio_modes.append("native")
        except Exception:
            pass  # ltx2 sidecar not reachable — omit "native"

    pooling_mode_out = LTX_POOLING_MODE if LTX_POOLING_MODE in ("off", "manual", "auto") else "auto"

    return {
        "gpu_count": device_count,
        "gpus": gpus,
        "pooled_vram_gb": pooled_vram,
        "pooling_active": pooling_active,
        "pooling_mode": pooling_mode_out,
        "transformer_device": LTX_TRANSFORMER_DEVICE,
        "encoder_device": LTX_ENCODER_DEVICE,
        "vae_device": LTX_VAE_DEVICE,
        "t5_lifecycle": LTX_T5_LIFECYCLE,
        "t5_lifecycle_resolved": _resolve_t5_lifecycle() if cuda_available else "transient",
        "models": models,
        "audio_modes": audio_modes,
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

    # #939 follow-up (2026-04-23): reject `unavailable` registry entries
    # before any work begins so callers get a precise actionable reason
    # instead of a cryptic from_pretrained() failure inside diffusers.
    requested_spec = VIDEO_MODEL_REGISTRY.get(request.model, {})
    if requested_spec.get("unavailable"):
        raise HTTPException(
            status_code=503,
            detail=(
                f"Model '{request.model}' is currently unavailable: "
                f"{requested_spec.get('unavailable_reason', 'no reason recorded')}"
            ),
        )

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


# ── Removed: /generate-extended (Issue #939) ──────────────────────
# The orchestrator (`src/queue/queue-master.ts`) handles extended-duration
# decomposition by submitting a sequence of standard /generate jobs with
# `init_image` chained to the prior clip's last frame, then stitching with
# ffmpeg client-side. Worker-side stitching has been removed because it
# duplicated the orchestrator path and was never invoked.
# A follow-up issue tracks moving stitching back into the worker for lower
# IPC overhead if profiling justifies it.
#
# ── Removed: /generate-extended (Issue #939) ──────────────────────
# Worker-side stitching has been removed. The orchestrator
# (`src/queue/queue-master.ts`) decomposes extended-duration jobs into a
# sequence of standard /generate calls, chains the prior clip's last frame
# via the existing /last-frame endpoint, and stitches with ffmpeg client-
# side. The server-side path duplicated that work and was never wired.
# Follow-up: track lower-IPC worker-side stitching as a future enhancement.


# ── Entrypoint ─────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Video worker CUDA sidecar")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5007")))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
