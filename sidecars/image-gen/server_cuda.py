"""
Image Generation Sidecar -- CUDA/PyTorch Backend
Drop-in replacement for the MLX/MFLUX image-gen sidecar using HuggingFace
diffusers on NVIDIA GPUs. Maintains the same HTTP API contract so QueueMaster
and ImageGenService work without changes.

Endpoints (compatible with the MLX version):
    POST /generate           -- Synchronous txt2img (with optional LoRA), returns PNG bytes
    POST /generate-async     -- Async txt2img, returns 202, POSTs callback
    POST /img2img            -- Synchronous img2img
    POST /img2img-async      -- Async img2img, returns 202
    POST /model              -- Switch active model
    POST /unload             -- Free VRAM
    GET  /health             -- Health / readiness probe
    GET  /models             -- List available models
    GET  /job-result/{id}    -- Poll for async job result
    POST /train              -- Start DreamBooth LoRA training
    GET  /train-status       -- Check training job status
    GET  /train-checkpoints  -- List checkpoint files for a character
    POST /train-resume       -- Resume training from a checkpoint
    POST /train-recover      -- Extract adapter from a checkpoint
    POST /train-pause        -- Pause training (not supported on CUDA â€” trains in subprocess)
    POST /train-unpause      -- Unpause training (not supported on CUDA)
    DELETE /train-data       -- Delete training data for a character

Port: 5005 (default)
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
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from typing import Any, Optional
from urllib.parse import urlparse

import urllib.request
import urllib.error
import ipaddress

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

# â”€â”€ Logging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("image-gen-cuda")

# â”€â”€ Lazy imports (torch/diffusers loaded on first use) â”€â”€â”€â”€â”€â”€â”€â”€â”€
torch = None
Image = None

# â”€â”€ Security â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
_secret_token: Optional[str] = os.environ.get("FLUXQ_SECRET_TOKEN") or None
_callback_secret: Optional[str] = os.environ.get("FLUXQ_CALLBACK_SECRET") or None

SIDECAR_VERSION = os.environ.get("SIDECAR_VERSION", "3.4.0-cuda")


def verify_token(authorization: Optional[str] = Header(None)) -> None:
    if _secret_token is None:
        return
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Expected 'Bearer <token>' format")
    import hmac
    if not hmac.compare_digest(parts[1], _secret_token):
        raise HTTPException(status_code=403, detail="Invalid token")


# â”€â”€ Model Registry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
MODEL_REGISTRY: dict[str, dict] = {
    "flux-schnell": {
        "hf_id": "black-forest-labs/FLUX.1-schnell",
        "pipeline_type": "flux",
        "default_steps": 4,
        "default_guidance": 0.0,
        "recommended_width": 1024,
        "recommended_height": 576,
        "description": "FLUX.1 schnell -- 4-step distilled (diffusers/CUDA)",
        "tier": "medium",
        "min_vram_gb": 12,
        "pool_eligible": True,
    },
    "flux-dev": {
        "hf_id": "black-forest-labs/FLUX.1-dev",
        "pipeline_type": "flux",
        "default_steps": 25,
        "default_guidance": 3.5,
        "recommended_width": 1024,
        "recommended_height": 576,
        "description": "FLUX.1 dev -- high-quality guidance-distilled (diffusers/CUDA)",
        "tier": "high",
        "min_vram_gb": 16,
        "pool_eligible": True,
    },
    "sdxl-base": {
        "hf_id": "stabilityai/stable-diffusion-xl-base-1.0",
        "pipeline_type": "sdxl",
        "default_steps": 30,
        "default_guidance": 7.5,
        "recommended_width": 1024,
        "recommended_height": 1024,
        "description": "Stable Diffusion XL 1.0 -- used for LoRA character inference",
        "tier": "low",
        "min_vram_gb": 8,
    },
}

# â”€â”€ Global State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
_pipeline: Any = None
_model_name: Optional[str] = None
_ready: bool = False
_model_loaded: bool = False
_loading: bool = False
_last_used: float = 0.0
_idle_timeout: float = 0.0
_default_model: str = os.getenv("FLUX_DEFAULT_MODEL", "flux-dev")
_generating: bool = False
_active_lora_paths: list[str] = []  # Currently loaded LoRA adapter paths

# ── Multi-GPU pooling (advisory; opt-in only) ───────────────────────────
# IMAGE_GEN_POOLING_MODE values:
#   "off"          (default) — single CUDA device + enable_model_cpu_offload()
#   "manual-flux"  Pool VRAM across all visible CUDA devices for FLUX models:
#                  text encoders + VAE on cuda:0, transformer on cuda:1.
#                  Removes the CPU↔GPU page-fault tax on hosts with ≥2 same-arch
#                  cards; OOMs gracefully on single-card hosts (sidecar falls
#                  back to cpu_offload and logs a warning).
#
# CRITICAL: when pooling is on, start-cuda-sidecars.sh sets CUDA_VISIBLE_DEVICES=0,1
# (instead of pinning to one card) so torch sees both devices.
_POOLING_MODE: str = os.getenv("IMAGE_GEN_POOLING_MODE", "off").strip().lower()
if _POOLING_MODE not in ("off", "manual-flux"):
    log.warning(
        f"IMAGE_GEN_POOLING_MODE='{_POOLING_MODE}' is not recognised; falling back to 'off'",
    )
    _POOLING_MODE = "off"
_pooled_active: bool = False  # True after a successful pooled load — for /gpu-info reporting

# â”€â”€ Persistent Training & LoRA Directories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
_TRAINING_BASE_DIR = os.path.join(os.path.expanduser("~"), ".openzigs", "training")
_LORAS_DIR = os.path.join(os.path.expanduser("~"), ".openzigs", "loras")

# Training state
_training: bool = False
_train_process: Any = None
_train_error: Optional[str] = None
_train_output_dir: Optional[str] = None

# â”€â”€ Job store â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
_MAX_STORED_RESULTS = 100
_job_results: dict[str, dict] = {}
_job_results_lock = threading.Lock()


def _store_result(job_id: str, payload: dict) -> None:
    with _job_results_lock:
        _job_results[job_id] = payload
        while len(_job_results) > _MAX_STORED_RESULTS:
            oldest = next(iter(_job_results))
            del _job_results[oldest]


# â”€â”€ Security Utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def safe_join(base_dir: str, user_path: str) -> str:
    """Safely join a base directory with a user-supplied path component."""
    base = os.path.realpath(base_dir)
    joined = os.path.realpath(os.path.join(base, user_path))
    if not joined.startswith(base + os.sep) and joined != base:
        raise ValueError(f"Path traversal blocked: {user_path}")
    return joined


def _sanitize_path(user_path: str) -> str:
    s = str(user_path)
    if "\x00" in s:
        raise ValueError("Path contains null bytes")
    normed = os.path.normpath(s)
    if ".." in normed.split(os.sep):
        raise ValueError(f"Path traversal detected: {user_path}")
    return normed


def _get_training_dir(character_id: str) -> str:
    """Return persistent training directory for a character."""
    if os.sep in character_id or "/" in character_id or "\\" in character_id or ".." in character_id:
        raise ValueError(f"Invalid character ID: {character_id}")
    d = safe_join(_TRAINING_BASE_DIR, character_id)
    os.makedirs(d, exist_ok=True)
    return d


def _sanitize_train_error(err: Optional[str]) -> Optional[str]:
    """Strip file paths and stack traces from training errors before returning to clients."""
    if not err:
        return err
    # Take only the last line (the actual error message) to avoid leaking paths/stack frames
    lines = err.strip().splitlines()
    last_line = lines[-1].strip() if lines else ""
    # Remove absolute path prefixes
    import re
    return re.sub(r"(/[^\s:]+/|[A-Z]:\\[^\s:]+\\)", "", last_line) if last_line else "Training failed"


# â”€â”€ Model Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _ensure_torch():
    global torch, Image
    if torch is None:
        import torch as _torch
        torch = _torch
        # Enable cuDNN autotuner — picks fastest conv algorithm for fixed input sizes
        if _torch.cuda.is_available():
            _torch.backends.cudnn.benchmark = True
    if Image is None:
        from PIL import Image as _Image
        Image = _Image


def _unload_model() -> None:
    global _pipeline, _model_name, _model_loaded, _active_lora_paths, _pooled_active
    if _pipeline is not None:
        model_name = _model_name or "unknown"
        log.info(f"Unloading model '{model_name}' to free VRAM ...")
        del _pipeline
        _pipeline = None
        gc.collect()
        _ensure_torch()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
            vram_free = torch.cuda.mem_get_info()[0] / 1024**3
            log.info(f"VRAM freed. Available: {vram_free:.1f} GB")
        log.info(f"Model '{model_name}' unloaded")
    _model_loaded = False
    _model_name = None
    _active_lora_paths = []
    _pooled_active = False


def _load_model(model_key: str, lora_paths: Optional[list[str]] = None,
                lora_scales: Optional[list[float]] = None) -> float:
    global _pipeline, _model_name, _model_loaded, _loading, _last_used, _active_lora_paths

    # If same model and same LoRA config, skip reload
    if _model_loaded and _model_name == model_key and (lora_paths or []) == (_active_lora_paths or []):
        return 0.0

    _loading = True
    try:
        if _model_loaded:
            _unload_model()

        _ensure_torch()

        spec = MODEL_REGISTRY[model_key]
        hf_id = spec["hf_id"]
        pipeline_type = spec.get("pipeline_type", "flux")
        lora_info = f", lora={len(lora_paths)} adapters" if lora_paths else ""
        log.info(f"Loading '{model_key}' ({hf_id}, type={pipeline_type}) on CUDA with model_cpu_offload{lora_info} ...")

        start = time.monotonic()

        if pipeline_type == "sdxl":
            from diffusers import StableDiffusionXLPipeline
            pipe = StableDiffusionXLPipeline.from_pretrained(
                hf_id,
                torch_dtype=torch.float16,
                variant="fp16",
                use_safetensors=True,
            )
        else:
            from diffusers import FluxPipeline
            pipe = FluxPipeline.from_pretrained(
                hf_id,
                torch_dtype=torch.float16,
            )

        # Load LoRA adapters BEFORE enable_model_cpu_offload().
        # CPU offload installs accelerate hooks on existing model components;
        # PEFT layers added afterward won't get those hooks and stay on CPU,
        # causing "tensors on different devices" errors during the forward pass.
        #
        # IMPORTANT: Always use pipe.load_lora_weights() — NEVER PeftModel.from_pretrained().
        # PeftModel wraps the UNet directly, but enable_model_cpu_offload() hooks bypass
        # PEFT's LoRA layers during forward pass, producing zero LoRA influence.
        # pipe.load_lora_weights() registers adapters at the pipeline level where
        # cpu_offload hooks can see them.
        if lora_paths:
            for i, lp in enumerate(lora_paths):
                if not os.path.isfile(lp):
                    raise ValueError(f"LoRA file not found: {lp}")
                adapter_name = f"lora_{i}"
                scale = (lora_scales[i] if lora_scales and i < len(lora_scales) else 1.0)
                adapter_dir = os.path.dirname(lp)

                # Inspect key format to determine if conversion is needed
                from safetensors.torch import load_file as _load_sf
                raw_weights = _load_sf(lp)
                is_peft_format = any(k.startswith("base_model.model.") for k in raw_weights.keys())

                if is_peft_format:
                    # Convert PEFT keys (base_model.model.X) to diffusers format (unet.X)
                    import tempfile as _tmpmod
                    from safetensors.torch import save_file as _save_sf
                    converted = {}
                    for k, v in raw_weights.items():
                        new_key = k.replace("base_model.model.", "unet.")
                        converted[new_key] = v
                    tmp_path = os.path.join(adapter_dir, f".tmp_converted_{i}.safetensors")
                    _save_sf(converted, tmp_path)
                    try:
                        pipe.load_lora_weights(
                            adapter_dir,
                            weight_name=os.path.basename(tmp_path),
                            adapter_name=adapter_name,
                        )
                    finally:
                        if os.path.exists(tmp_path):
                            os.remove(tmp_path)
                    del raw_weights, converted
                    log.info(f"Loaded LoRA adapter '{adapter_name}' from {lp} (PEFT->diffusers converted, scale={scale})")
                else:
                    del raw_weights
                    pipe.load_lora_weights(
                        adapter_dir,
                        weight_name=os.path.basename(lp),
                        adapter_name=adapter_name,
                    )
                    log.info(f"Loaded LoRA adapter '{adapter_name}' from {lp} (diffusers native, scale={scale})")

                # Track for bulk activation below
                if not hasattr(pipe, '_loaded_adapter_info'):
                    pipe._loaded_adapter_info = []
                pipe._loaded_adapter_info.append((adapter_name, scale))

        # Activate ALL loaded adapters at once via pipeline-level set_adapters.
        # This is the ONLY reliable way to activate adapters with cpu_offload.
        if hasattr(pipe, '_loaded_adapter_info') and pipe._loaded_adapter_info:
            all_names = [a[0] for a in pipe._loaded_adapter_info]
            all_scales = [a[1] for a in pipe._loaded_adapter_info]
            try:
                pipe.set_adapters(all_names, adapter_weights=all_scales)
                log.info(f"Activated {len(all_names)} LoRA adapter(s) via pipeline: {list(zip(all_names, all_scales))}")
            except Exception as e:
                log.warning(f"pipeline.set_adapters failed: {e} — generation will proceed without LoRA")
            del pipe._loaded_adapter_info

        # Enable CPU offload AFTER all LoRA adapters are loaded so accelerate
        # hooks are installed on the fully-assembled model (base + LoRA layers).
        #
        # Multi-GPU pooling (opt-in): when IMAGE_GEN_POOLING_MODE=manual-flux
        # AND we are loading a FLUX pipeline AND \u22652 CUDA devices are visible,
        # split the components by hand instead of using cpu_offload. The
        # transformer (~12 GB fp16) goes to cuda:1 and the text encoders + VAE
        # (~6 GB total) stay on cuda:0. FluxPipeline's __call__ already moves
        # latents between components on each step, so cross-device dispatch is
        # safe — the inter-GPU traffic per step is small (just the prompt embed
        # tensor, ~tens of KB on PCIe).
        spec_for_pool = MODEL_REGISTRY.get(model_key, {})
        global _pooled_active
        _pooled_active = False
        use_pooling = (
            _POOLING_MODE == "manual-flux"
            and pipeline_type == "flux"
            and spec_for_pool.get("pool_eligible", False)
            and torch.cuda.is_available()
            and torch.cuda.device_count() >= 2
        )
        if _POOLING_MODE == "manual-flux" and not use_pooling:
            log.warning(
                f"IMAGE_GEN_POOLING_MODE=manual-flux requested but conditions not met "
                f"(pipeline_type={pipeline_type}, pool_eligible={spec_for_pool.get('pool_eligible', False)}, "
                f"device_count={torch.cuda.device_count() if torch.cuda.is_available() else 0}); "
                f"falling back to cpu_offload"
            )
        if use_pooling:
            try:
                # Place text encoders + VAE on cuda:0, transformer on cuda:1.
                # All forward passes will use the per-component .device for
                # input tensors automatically inside FluxPipeline.
                pipe.text_encoder.to("cuda:0")
                pipe.text_encoder_2.to("cuda:0")
                pipe.vae.to("cuda:0")
                pipe.transformer.to("cuda:1")
                # Tiling shaves VAE peak — keep on for safety on 12 GB cards.
                pipe.enable_attention_slicing()
                if hasattr(pipe, "vae") and hasattr(pipe.vae, "enable_tiling"):
                    pipe.vae.enable_tiling()
                _pooled_active = True
                log.info(
                    "Pooled FLUX placement active: text_encoder+text_encoder_2+vae → cuda:0, "
                    "transformer → cuda:1 (no cpu_offload)"
                )
            except Exception as e:
                log.warning(
                    f"Pooled placement failed ({e}); falling back to cpu_offload"
                )
                pipe.enable_model_cpu_offload()
                pipe.enable_attention_slicing()
                _pooled_active = False
        else:
            pipe.enable_model_cpu_offload()
            pipe.enable_attention_slicing()

        elapsed = time.monotonic() - start
        _pipeline = pipe
        _model_name = model_key
        _model_loaded = True
        _active_lora_paths = lora_paths or []
        _last_used = time.monotonic()
        log.info(f"Model '{model_key}' ready in {elapsed:.1f}s (CUDA model-level offload)")
        return elapsed
    finally:
        _loading = False


async def _idle_unload_loop() -> None:
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
            log.info(f"Model idle for {idle_secs:.0f}s -- auto-unloading")
            _unload_model()


# â”€â”€ Callback helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _is_safe_callback_url(url: str) -> bool:
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
            return False
    except Exception:
        return False


def _post_callback(job_id: str, callback_url: Optional[str], payload: dict) -> None:
    _store_result(job_id, payload)
    if not callback_url:
        log.info(f"[async] Result for job {job_id} stored (no callback)")
        return
    if not _is_safe_callback_url(callback_url):
        log.warning(f"[async] Blocked unsafe callback URL: {callback_url}")
        return
    body = json.dumps(payload).encode("utf-8")
    max_retries = 3
    for attempt in range(1, max_retries + 1):
        headers = {"Content-Type": "application/json"}
        if _callback_secret:
            headers["Authorization"] = f"Bearer {_callback_secret}"
        req = urllib.request.Request(callback_url, data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                log.info(f"[async] Callback for job {job_id} delivered: HTTP {resp.status}")
                return
        except urllib.error.HTTPError as e:
            log.error(f"[async] Callback job {job_id} HTTP error: {e.code}")
            return
        except Exception as e:
            log.error(f"[async] Callback job {job_id} attempt {attempt}/{max_retries}: {e}")
            if attempt < max_retries:
                time.sleep(2 ** attempt)
    log.error(f"[async] Callback for job {job_id} PERMANENTLY FAILED")


# â”€â”€ Generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _detect_lora_architecture(lora_paths: Optional[list[str]]) -> Optional[str]:
    """Read training_metadata.json next to a LoRA adapter to detect its architecture.

    Looks adapters up under the constant `_LORAS_DIR` so the directory passed to
    open()/os.path.join is filesystem-derived (untainted), satisfying CodeQL.
    """
    if not lora_paths:
        return None
    loras_root = os.path.realpath(_LORAS_DIR)
    if not os.path.isdir(loras_root):
        return None
    # Build the set of basenames the caller is asking about — used only for
    # equality comparison, never in path construction.
    requested_basenames = {os.path.basename(p) for p in lora_paths if p}
    char_prefixes = {
        b.replace("_adapter.safetensors", "").replace("_lora.safetensors", "")
        for b in requested_basenames
    }
    try:
        for entry in os.listdir(loras_root):
            full = os.path.join(loras_root, entry)
            if entry in requested_basenames and os.path.isfile(full):
                meta_path = os.path.join(loras_root, "training_metadata.json")
                if os.path.isfile(meta_path):
                    try:
                        import json
                        with open(meta_path) as f:
                            return json.load(f).get("architecture")
                    except Exception:
                        pass
            for prefix in char_prefixes:
                relocated_meta_name = f"{prefix}_training_metadata.json"
                if entry == relocated_meta_name:
                    relocated_meta = os.path.join(loras_root, entry)
                    try:
                        import json
                        with open(relocated_meta) as f:
                            return json.load(f).get("architecture")
                    except Exception:
                        pass
    except OSError:
        return None
    return None


def _generate_image(prompt: str, model_key: str, width: int, height: int,
                    steps: Optional[int], guidance: float, seed: int,
                    lora_paths: Optional[list[str]] = None,
                    lora_scales: Optional[list[float]] = None) -> "Image.Image":
    _ensure_torch()

    # Auto-switch to SDXL when LoRA adapters are SDXL-trained
    effective_model = model_key
    if lora_paths:
        lora_arch = _detect_lora_architecture(lora_paths)
        if lora_arch == "sdxl" and MODEL_REGISTRY.get(model_key, {}).get("pipeline_type") != "sdxl":
            effective_model = "sdxl-base"
            # Override generation params — the originals were for a different architecture
            # (e.g. flux-schnell uses steps=4, guidance=0.0 which is useless for SDXL)
            target_spec = MODEL_REGISTRY[effective_model]
            steps = target_spec["default_steps"]
            guidance = target_spec["default_guidance"]
            log.info(f"Auto-switching from '{model_key}' to '{effective_model}' for SDXL LoRA adapter (steps={steps}, guidance={guidance})")

    # Reload if model or LoRA config changed
    needs_reload = not _model_loaded or _model_name != effective_model
    if not needs_reload and lora_paths:
        needs_reload = (lora_paths or []) != (_active_lora_paths or [])
    if needs_reload:
        _load_model(effective_model, lora_paths=lora_paths, lora_scales=lora_scales)

    spec = MODEL_REGISTRY[effective_model]
    actual_steps = steps or spec["default_steps"]
    w = (width // 16) * 16
    h = (height // 16) * 16

    log.info(f"Generating: {w}x{h} steps={actual_steps} seed={seed} model={effective_model}")
    generator = torch.Generator("cpu").manual_seed(seed)

    # For multi-subject prompts with LoRA, use cross_attention_kwargs to scale
    # the LoRA contribution at forward-pass time. This works with cpu_offload
    # unlike per-component set_adapters.
    call_kwargs: dict = dict(
        prompt=prompt,
        width=w,
        height=h,
        num_inference_steps=actual_steps,
        guidance_scale=guidance,
        generator=generator,
    )

    # Detect multi-subject cues in the prompt and add composition helpers
    import re
    multi_cues = re.compile(
        r'\b(another|other|two|three|second|both|together with|alongside'
        r'|chasing|playing with|next to|beside|with a|and a)\b', re.IGNORECASE
    )
    if lora_paths and _active_lora_paths and multi_cues.search(prompt):
        # Scale down LoRA influence at forward-pass level for multi-subject
        call_kwargs["cross_attention_kwargs"] = {"scale": 0.6}
        # Negative prompt to discourage single-subject collapse
        call_kwargs["negative_prompt"] = "solo, single subject, only one animal, monochrome, blurry"
        log.info(f"Multi-subject detected: applying cross_attention_kwargs scale=0.6 + negative_prompt")

    with torch.inference_mode():
        result = _pipeline(**call_kwargs)
    return result.images[0]


def _bg_generate(
    job_id: str, callback_url: Optional[str],
    prompt: str, model_key: str,
    width: int, height: int,
    steps: Optional[int], guidance: float, seed: int,
    lora_paths: Optional[list[str]] = None,
    lora_scales: Optional[list[float]] = None,
) -> None:
    global _last_used, _generating
    _generating = True
    try:
        start = time.monotonic()
        pil_image = _generate_image(prompt, model_key, width, height, steps, guidance, seed,
                                    lora_paths=lora_paths, lora_scales=lora_scales)
        elapsed = time.monotonic() - start
        _last_used = time.monotonic()
        log.info(f"[async] generate done in {elapsed:.1f}s job={job_id}")
        buf = io.BytesIO()
        pil_image.save(buf, format="PNG", optimize=True)
        media_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        _post_callback(job_id, callback_url, {
            "job_id": job_id,
            "status": "complete",
            "media_base64": media_b64,
            "media_type": "image/png",
            "metadata": {
                "model": _model_name or model_key,
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
    job_id: str, callback_url: Optional[str],
    prompt: str, model_key: str, source_path: str,
    strength: float, width: int, height: int,
    steps: Optional[int], guidance: float, seed: int,
) -> None:
    global _last_used, _generating
    _generating = True
    try:
        _ensure_torch()

        if not _model_loaded or _model_name != model_key:
            _load_model(model_key)

        spec = MODEL_REGISTRY[model_key]
        pipeline_type = spec.get("pipeline_type", "flux")
        actual_steps = steps or spec["default_steps"]
        w = (width // 16) * 16
        h = (height // 16) * 16

        init_image = Image.open(source_path).convert("RGB").resize((w, h))
        generator = torch.Generator("cpu").manual_seed(seed)

        # Build an img2img pipeline from the loaded components (no re-download).
        # from_pipe() shares UNet/VAE/encoders — only the scheduler wrapper changes.
        if pipeline_type == "sdxl":
            from diffusers import StableDiffusionXLImg2ImgPipeline
            img2img_pipe = StableDiffusionXLImg2ImgPipeline.from_pipe(_pipeline)
        else:
            from diffusers import FluxImg2ImgPipeline
            img2img_pipe = FluxImg2ImgPipeline.from_pipe(_pipeline)

        start = time.monotonic()
        with torch.inference_mode():
            result = img2img_pipe(
                prompt=prompt,
                image=init_image,
                strength=strength,
                width=w,
                height=h,
                num_inference_steps=actual_steps,
                guidance_scale=guidance,
                generator=generator,
            )
        elapsed = time.monotonic() - start
        _last_used = time.monotonic()

        buf = io.BytesIO()
        result.images[0].save(buf, format="PNG", optimize=True)
        media_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        _post_callback(job_id, callback_url, {
            "job_id": job_id,
            "status": "complete",
            "media_base64": media_b64,
            "media_type": "image/png",
            "metadata": {
                "model": _model_name or model_key,
                "generation_time": f"{elapsed:.2f}s",
                "seed": str(seed),
            },
        })
    except Exception as e:
        log.error(f"[async] img2img failed job={job_id}: {e}")
        _post_callback(job_id, callback_url, {"job_id": job_id, "status": "failed", "error": str(e)})
    finally:
        _generating = False
        # Clean up temp file
        try:
            if source_path and os.path.isfile(source_path) and source_path.startswith(tempfile.gettempdir()):
                os.unlink(source_path)
        except Exception:
            pass


# â”€â”€ Pydantic models â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)
    model: Optional[str] = None
    width: int = Field(default=1024, ge=256, le=2048)
    height: int = Field(default=1024, ge=256, le=2048)
    steps: Optional[int] = Field(default=None, ge=1, le=50)
    guidance_scale: Optional[float] = Field(default=None, ge=0.0, le=20.0)
    seed: Optional[int] = None
    lora_paths: Optional[list[str]] = Field(default=None, description="Paths to LoRA adapter .safetensors files")
    lora_scales: Optional[list[float]] = Field(default=None, description="Scale factor for each LoRA adapter")

    @field_validator("lora_paths", mode="before")
    @classmethod
    def _validate_lora_paths(cls, v: Any) -> Any:
        if v is None:
            return v
        for p in v:
            if "\x00" in p or ".." in p:
                raise ValueError(f"Invalid LoRA path: {p}")
        return v


class AsyncGenerateRequest(GenerateRequest):
    job_id: str
    callback_url: Optional[str] = None


class Img2ImgRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)
    image: Optional[str] = None
    image_path: Optional[str] = None
    model: Optional[str] = None
    strength: Optional[float] = Field(default=0.8, ge=0.01, le=1.0)
    image_strength: Optional[float] = Field(default=None, ge=0.01, le=1.0)
    width: int = Field(default=1024, ge=256, le=2048)
    height: int = Field(default=1024, ge=256, le=2048)
    steps: Optional[int] = Field(default=None, ge=1, le=50)
    guidance_scale: Optional[float] = Field(default=None, ge=0.0, le=20.0)
    seed: Optional[int] = None

    @field_validator("image_path", mode="before")
    @classmethod
    def _validate_image_path(cls, v: Any) -> Any:
        if v is None:
            return v
        if "\x00" in v:
            raise ValueError("Path contains null bytes")
        normed = os.path.normpath(v)
        if ".." in normed.split(os.sep):
            raise ValueError("Path traversal detected in image_path")
        return normed


class AsyncImg2ImgRequest(Img2ImgRequest):
    job_id: str
    callback_url: Optional[str] = None


class ModelRequest(BaseModel):
    model: str


class HealthResponse(BaseModel):
    status: str
    model: Optional[str] = None
    device: str
    ready: bool
    model_loaded: bool = False
    is_busy: bool = False
    recommended_width: int = 1024
    recommended_height: int = 576
    available_models: list[str] = []
    version: str = SIDECAR_VERSION


class ModelResponse(BaseModel):
    model: str
    device: str
    load_time_seconds: float
    quantized: str


# â”€â”€ FastAPI app â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _ready, _idle_timeout, _default_model
    _idle_timeout = float(os.environ.get("IDLE_TIMEOUT", "0"))
    _default_model = os.environ.get("DEFAULT_MODEL", "flux-schnell")
    preload = os.environ.get("PRELOAD_MODEL", "").lower() in ("1", "true", "yes")

    if preload and _default_model in MODEL_REGISTRY:
        log.info(f"Pre-loading model '{_default_model}' ...")
        _load_model(_default_model)

    _ready = True
    log.info(f"Image-gen CUDA sidecar ready on port {os.environ.get('PORT', '5005')}")

    import asyncio
    idle_task = asyncio.create_task(_idle_unload_loop())
    try:
        yield
    finally:
        idle_task.cancel()
        _ready = False

app = FastAPI(title="Image Generation Sidecar (CUDA)", lifespan=lifespan)


@app.get("/job-result/{job_id}")
async def get_job_result(job_id: str):
    with _job_results_lock:
        result = _job_results.pop(job_id, None)
    if result is None:
        raise HTTPException(status_code=404, detail="No result for this job")
    return result


@app.get("/health", response_model=HealthResponse)
async def health():
    spec = MODEL_REGISTRY.get(_model_name or _default_model, {})
    status = "loading" if _loading else ("ok" if _ready else "starting")
    return HealthResponse(
        status=status,
        model=_model_name,
        device="cuda",
        ready=_ready and not _loading,
        model_loaded=_model_loaded,
        is_busy=_generating,
        recommended_width=spec.get("recommended_width", 1024),
        recommended_height=spec.get("recommended_height", 576),
        available_models=list(MODEL_REGISTRY.keys()),
        version=SIDECAR_VERSION,
    )


@app.get("/status")
async def status():
    vram_info = {}
    if torch is not None and torch.cuda.is_available():
        try:
            free, total = torch.cuda.mem_get_info()
            vram_info = {
                "vram_total_gb": round(total / 1024**3, 1),
                "vram_free_gb": round(free / 1024**3, 1),
                "vram_used_gb": round((total - free) / 1024**3, 1),
            }
        except Exception:
            pass
    return {
        "is_busy": _generating or _loading,
        "loaded_model": _model_name,
        "device": "cuda",
        "ready": _ready,
        **vram_info,
    }


@app.get("/gpu-info")
async def gpu_info_endpoint():
    """Report which CUDA device(s) this sidecar is bound to (Issue #884) plus
    pooling state for the multi-GPU advisory in /api/system/gpu."""
    _ensure_torch()
    if not torch.cuda.is_available():
        return {
            "available": False,
            "cuda_visible": os.environ.get("CUDA_VISIBLE_DEVICES", ""),
            "pooling_mode": _POOLING_MODE,
            "pooled_active": False,
        }
    idx = torch.cuda.current_device()
    free, total = torch.cuda.mem_get_info(idx)
    devices = []
    for d in range(torch.cuda.device_count()):
        d_free, d_total = torch.cuda.mem_get_info(d)
        devices.append({
            "index": d,
            "name": torch.cuda.get_device_name(d),
            "total_mb": int(d_total / 1024**2),
            "free_mb": int(d_free / 1024**2),
        })
    return {
        "available": True,
        "device_index": idx,
        "device_name": torch.cuda.get_device_name(idx),
        "device_count": torch.cuda.device_count(),
        "total_mb": int(total / 1024**2),
        "free_mb": int(free / 1024**2),
        "cuda_visible": os.environ.get("CUDA_VISIBLE_DEVICES", ""),
        "pooling_mode": _POOLING_MODE,
        "pooled_active": _pooled_active,
        "devices": devices,
    }


@app.get("/models")
async def list_models():
    models = []
    for key, spec in MODEL_REGISTRY.items():
        models.append({
            "key": key,
            "description": spec["description"],
            "recommended_width": spec["recommended_width"],
            "recommended_height": spec["recommended_height"],
            "default_steps": spec["default_steps"],
            "tier": spec.get("tier"),
            "min_vram_gb": spec.get("min_vram_gb"),
            "pool_eligible": spec.get("pool_eligible", False),
            "loaded": _model_loaded and _model_name == key,
        })
    return {
        "models": models,
        "active": _model_name,
        "device": "cuda",
        "pooling_mode": _POOLING_MODE,
        "pooled_active": _pooled_active,
    }


@app.post("/model", response_model=ModelResponse, dependencies=[Depends(verify_token)])
async def switch_model(req: ModelRequest):
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading:
        raise HTTPException(status_code=409, detail="A model is currently being loaded")
    if req.model not in MODEL_REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown model: {req.model}")

    elapsed = _load_model(req.model)
    return ModelResponse(model=req.model, device="cuda", load_time_seconds=round(elapsed, 1), quantized="fp16")


@app.post("/unload", dependencies=[Depends(verify_token)])
async def unload():
    if not _model_loaded:
        return {"status": "no_model_loaded"}
    model = _model_name
    _unload_model()
    return {"status": "unloaded", "model": model}


@app.post("/generate", response_class=Response, dependencies=[Depends(verify_token)])
async def generate(req: GenerateRequest):
    global _last_used
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading:
        raise HTTPException(status_code=409, detail="A model is currently being loaded")

    # Stop any active training to free VRAM before inference
    _stop_training_for_inference()

    requested_model = req.model or (_model_name if _model_loaded else _default_model)
    if requested_model not in MODEL_REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown model: {requested_model}")

    spec = MODEL_REGISTRY[requested_model]
    guidance = req.guidance_scale if req.guidance_scale is not None else spec["default_guidance"]
    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)

    start = time.monotonic()
    pil_image = _generate_image(req.prompt, requested_model, req.width, req.height, req.steps, guidance, seed,
                                lora_paths=req.lora_paths, lora_scales=req.lora_scales)
    elapsed = time.monotonic() - start
    _last_used = time.monotonic()
    log.info(f"Generated in {elapsed:.1f}s")

    buf = io.BytesIO()
    pil_image.save(buf, format="PNG", optimize=True)

    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={
            "X-Generation-Time": f"{elapsed:.2f}",
            "X-Model": _model_name or requested_model,
            "X-Seed": str(seed),
        },
    )


@app.post("/generate-async", status_code=202, dependencies=[Depends(verify_token)])
async def generate_async(req: AsyncGenerateRequest, background_tasks: BackgroundTasks):
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading or _generating:
        raise HTTPException(status_code=409, detail="Server is busy")

    # Stop any active training to free VRAM
    _stop_training_for_inference()

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
        req.lora_paths, req.lora_scales,
    )
    log.info(f"[async] generate job={req.job_id} accepted")
    return {"job_id": req.job_id, "status": "accepted"}


@app.post("/img2img", response_class=Response, dependencies=[Depends(verify_token)])
async def img2img(req: Img2ImgRequest):
    global _last_used
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading:
        raise HTTPException(status_code=409, detail="A model is currently being loaded")

    _ensure_torch()
    requested_model = req.model or (_model_name if _model_loaded else _default_model)
    if requested_model not in MODEL_REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown model: {requested_model}")

    # Decode source image
    if req.image:
        try:
            img_bytes = base64.b64decode(req.image, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid base64 image")
        if len(img_bytes) > 20 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Image exceeds 20 MB")
        init_image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    elif req.image_path:
        if not os.path.isfile(req.image_path):
            raise HTTPException(status_code=400, detail=f"File not found: {req.image_path}")
        init_image = Image.open(req.image_path).convert("RGB")
    else:
        raise HTTPException(status_code=422, detail="Provide 'image' or 'image_path'")

    spec = MODEL_REGISTRY[requested_model]
    actual_steps = req.steps or spec["default_steps"]
    guidance = req.guidance_scale if req.guidance_scale is not None else spec["default_guidance"]
    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)
    strength = req.strength if req.strength is not None else (
        req.image_strength if req.image_strength is not None else 0.8
    )

    w = (req.width // 16) * 16
    h = (req.height // 16) * 16
    init_image = init_image.resize((w, h))

    if not _model_loaded or _model_name != requested_model:
        _load_model(requested_model)

    # Build an img2img pipeline from the loaded components (no re-download).
    spec = MODEL_REGISTRY[requested_model]
    pipeline_type = spec.get("pipeline_type", "flux")
    if pipeline_type == "sdxl":
        from diffusers import StableDiffusionXLImg2ImgPipeline
        img2img_pipe = StableDiffusionXLImg2ImgPipeline.from_pipe(_pipeline)
    else:
        from diffusers import FluxImg2ImgPipeline
        img2img_pipe = FluxImg2ImgPipeline.from_pipe(_pipeline)

    generator = torch.Generator("cpu").manual_seed(seed)
    start = time.monotonic()
    with torch.inference_mode():
        result = img2img_pipe(
            prompt=req.prompt,
            image=init_image,
            strength=strength,
            width=w,
            height=h,
            num_inference_steps=actual_steps,
            guidance_scale=guidance,
            generator=generator,
        )
    elapsed = time.monotonic() - start
    _last_used = time.monotonic()

    buf = io.BytesIO()
    result.images[0].save(buf, format="PNG", optimize=True)

    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={
            "X-Generation-Time": f"{elapsed:.2f}",
            "X-Model": _model_name or requested_model,
            "X-Seed": str(seed),
        },
    )


@app.post("/img2img-async", status_code=202, dependencies=[Depends(verify_token)])
async def img2img_async(req: AsyncImg2ImgRequest, background_tasks: BackgroundTasks):
    if not _ready:
        raise HTTPException(status_code=503, detail="Server not ready")
    if _loading or _generating:
        raise HTTPException(status_code=409, detail="Server is busy")

    _ensure_torch()
    tmp_path: Optional[str] = None
    if req.image:
        try:
            img_bytes = base64.b64decode(req.image, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid base64 image")
        if len(img_bytes) > 20 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Image exceeds 20 MB")
        suffix = ".jpg" if img_bytes[:3] == b"\xff\xd8\xff" else ".png"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(img_bytes)
        tmp.close()
        tmp_path = tmp.name
    elif req.image_path:
        if not os.path.isfile(req.image_path):
            raise HTTPException(status_code=400, detail=f"File not found: {req.image_path}")
        tmp_path = req.image_path
    else:
        raise HTTPException(status_code=422, detail="Provide 'image' or 'image_path'")

    requested_model = req.model or (_model_name if _model_loaded else _default_model)
    if requested_model not in MODEL_REGISTRY:
        if tmp_path and tmp_path != req.image_path:
            os.unlink(tmp_path)
        raise HTTPException(status_code=400, detail=f"Unknown model: {requested_model}")

    spec = MODEL_REGISTRY[requested_model]
    strength = req.strength if req.strength is not None else (
        req.image_strength if req.image_strength is not None else 0.8
    )
    guidance = req.guidance_scale if req.guidance_scale is not None else spec["default_guidance"]
    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)

    background_tasks.add_task(
        _bg_img2img,
        req.job_id, req.callback_url,
        req.prompt, requested_model, tmp_path, strength,
        req.width, req.height, req.steps, guidance, seed,
    )
    return {"job_id": req.job_id, "status": "accepted"}



# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# LoRA TRAINING ENDPOINTS (DreamBooth via diffusers + PEFT on CUDA)
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

def _stop_training_for_inference() -> bool:
    """If a training job is running, kill it to free VRAM for inference.
    Returns True if training was stopped."""
    global _training, _train_process, _train_error
    if not _training or _train_process is None:
        return False

    pid = _train_process.pid
    log.warning(f"[train] Stopping training (pid={pid}) to free VRAM for inference. Resume from checkpoint when ready.")
    try:
        _train_process.terminate()
        try:
            _train_process.wait(timeout=10)
        except Exception:
            _train_process.kill()
            _train_process.wait(timeout=5)
    except Exception as e:
        log.error(f"[train] Failed to stop training process: {e}")

    _training = False
    _train_process = None
    _train_error = "Training stopped to free VRAM for image generation. Resume from checkpoint when ready."
    gc.collect()
    _ensure_torch()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return True


def _find_trained_lora(dir_path: str) -> Optional[str]:
    """Find a trained .safetensors LoRA adapter in the output directory."""
    try:
        for root, _dirs, files in os.walk(dir_path):
            for f in files:
                if f.endswith(".safetensors") and "adapter" in f.lower():
                    return os.path.join(root, f)
        # Check for any safetensors file if none have "adapter" in name
        for root, _dirs, files in os.walk(dir_path):
            for f in files:
                if f.endswith(".safetensors"):
                    return os.path.join(root, f)
    except Exception as e:
        log.error(f"[train] Error finding LoRA adapter: {e}")
    return None


def _relocate_adapter(character_id: str, search_dir: str) -> Optional[str]:
    """Move adapter .safetensors + training_metadata.json + adapter_config.json to permanent ~/.openzigs/loras/ directory.

    The walk is rooted at `_TRAINING_BASE_DIR` (a module-level constant) so all
    paths fed to filesystem sinks are filesystem-derived rather than tainted by
    the user-supplied `search_dir` argument. The original `search_dir` is only
    used for an equality comparison against entries discovered via os.walk().
    """
    # Constant-root walk: enumerate every entry in _TRAINING_BASE_DIR, match the
    # requested character directory by equality only, and use filesystem-derived
    # paths exclusively for any sink. character_id never flows into os.path.join.
    del search_dir
    requested = os.path.basename(character_id or "")
    if not requested or requested in (".", "..") or "/" in requested or "\\" in requested:
        return None
    training_root = os.path.realpath(_TRAINING_BASE_DIR)
    if not os.path.isdir(training_root):
        return None
    matched_root: Optional[str] = None
    try:
        for entry in os.listdir(training_root):
            if entry == requested:
                candidate = os.path.join(training_root, entry)
                if os.path.isdir(candidate):
                    matched_root = candidate
                    break
    except OSError:
        return None
    if matched_root is None:
        return None
    for actual_root, _dirs, files in os.walk(matched_root):
        for f in files:
            if f.endswith(".safetensors") and "adapter" in f.lower():
                src = os.path.join(actual_root, f)
                os.makedirs(_LORAS_DIR, exist_ok=True)
                # Use the matched directory entry (filesystem-derived) as the
                # filename prefix so no user-tainted value reaches a path sink.
                prefix = os.path.basename(matched_root)
                dest = os.path.join(_LORAS_DIR, f"{prefix}_adapter.safetensors")
                shutil.move(src, dest)
                log.info(f"[train-data] Relocated adapter {src} -> {dest}")
                # Also copy training metadata (needed to detect architecture at inference)
                meta_src = os.path.join(actual_root, "training_metadata.json")
                if os.path.isfile(meta_src):
                    meta_dest = os.path.join(_LORAS_DIR, f"{prefix}_training_metadata.json")
                    shutil.copy(meta_src, meta_dest)
                    log.info(f"[train-data] Copied training metadata -> {meta_dest}")
                # Copy PEFT adapter_config.json (needed for direct PEFT loading at inference)
                config_src = os.path.join(actual_root, "adapter_config.json")
                if os.path.isfile(config_src):
                    config_dest = os.path.join(_LORAS_DIR, f"{prefix}_adapter_config.json")
                    shutil.copy(config_src, config_dest)
                    log.info(f"[train-data] Copied adapter config -> {config_dest}")
                return dest
    return None


# â”€â”€ Training Request/Response Models â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class TrainPhotoItem(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded image data")
    filename: str = Field(..., description="Original filename")
    prompt: str = Field(..., description="Caption / prompt for this image")


class TrainRequest(BaseModel):
    train_config_path: Optional[str] = Field(None, description="Path to local config JSON")
    train_config: Optional[dict] = Field(None, description="Inline training config")
    photos: Optional[list[TrainPhotoItem]] = Field(None, description="Base64 training photos")
    character_id: Optional[str] = Field(None, description="Character ID for organizing output")

    @field_validator("character_id", mode="before")
    @classmethod
    def _validate_character_id(cls, v: Any) -> Any:
        if v is not None:
            s = str(v)
            if "\x00" in s or ".." in s or "/" in s or "\\" in s:
                raise ValueError(f"Invalid character ID: {v}")
        return v


class TrainResponse(BaseModel):
    status: str
    message: str
    output_dir: Optional[str] = None


class ResumeTrainRequest(BaseModel):
    checkpoint_path: str = Field(..., description="Path to checkpoint file")


class DeleteTrainDataRequest(BaseModel):
    character_id: str

    @field_validator("character_id", mode="before")
    @classmethod
    def _validate_character_id(cls, v: Any) -> Any:
        s = str(v)
        if "\x00" in s or ".." in s or "/" in s or "\\" in s:
            raise ValueError(f"Invalid character ID: {v}")
        return v


class RecoverTrainRequest(BaseModel):
    character_id: str
    checkpoint_path: Optional[str] = None

    @field_validator("character_id", mode="before")
    @classmethod
    def _validate_character_id(cls, v: Any) -> Any:
        s = str(v)
        if "\x00" in s or ".." in s or "/" in s or "\\" in s:
            raise ValueError(f"Invalid character ID: {v}")
        return v


def _materialize_network_training(req: TrainRequest) -> tuple[str, str]:
    """Write base64 photos to disk and generate training config.
    Returns (data_dir, output_dir)."""
    from PIL import Image as PILImage

    char_id = req.character_id or "unknown"
    train_dir = _get_training_dir(char_id)
    data_dir = os.path.join(train_dir, "data")
    if os.path.isdir(data_dir):
        shutil.rmtree(data_dir)
    os.makedirs(data_dir, exist_ok=True)

    cfg = req.train_config or {}
    max_dim = int(cfg.get("max_image_dim", 720))

    for i, photo in enumerate(req.photos or []):
        safe_stem = f"{i:04d}"
        photo_path = os.path.join(data_dir, f"{safe_stem}.jpg")
        txt_path = os.path.join(data_dir, f"{safe_stem}.txt")
        img_bytes = base64.b64decode(photo.image_base64, validate=True)
        try:
            pil_img = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
            w, h = pil_img.size
            if max(w, h) > max_dim:
                scale = max_dim / max(w, h)
                new_w = int(w * scale) // 16 * 16
                new_h = int(h * scale) // 16 * 16
                pil_img = pil_img.resize((new_w, new_h), PILImage.LANCZOS)
                log.info(f"[train] Resized {safe_stem}.jpg from {w}x{h} â†’ {new_w}x{new_h}")
            pil_img.save(photo_path, format="JPEG", quality=95)
        except Exception as e:
            log.warning(f"[train] PIL conversion failed for photo {i}: {e}")
            with open(photo_path, "wb") as f:
                f.write(img_bytes)
        with open(txt_path, "w") as f:
            f.write(photo.prompt)

    output_dir = os.path.join(train_dir, "output")
    os.makedirs(output_dir, exist_ok=True)
    log.info(f"[train] Materialized {len(req.photos or [])} photos to {data_dir}")
    return data_dir, output_dir


def _bg_train(data_dir: str, output_dir: str, cfg: dict) -> None:
    """Background task: run DreamBooth LoRA training via SDXL (fits 12 GB GPU at 1024px)."""
    global _training, _train_process, _train_error, _train_output_dir

    try:
        trigger_word = cfg.get("trigger_word", "TOK")
        num_epochs = int(cfg.get("num_epochs", 10))
        steps_per_epoch = len([f for f in os.listdir(data_dir) if f.endswith((".jpg", ".jpeg", ".png"))])
        max_train_steps = num_epochs * steps_per_epoch
        learning_rate = float(cfg.get("learning_rate", 1e-4))
        lora_rank = int(cfg.get("lora_rank", 16))  # default 16 for SDXL (was 8 for FLUX)

        # Use SDXL training script — trains at 1024px on 12 GB VRAM
        train_script = os.path.join(os.path.dirname(__file__), "train_dreambooth_lora_sdxl_cuda.py")

        # Build command
        cmd = [
            sys.executable, train_script,
            "--pretrained_model_name_or_path", "stabilityai/stable-diffusion-xl-base-1.0",
            "--instance_data_dir", data_dir,
            "--output_dir", output_dir,
            "--instance_prompt", f"a photo of {trigger_word} {cfg.get('class_noun', 'subject')}",  # class noun from training config
            "--resolution", "1024",
            "--train_batch_size", "1",
            "--gradient_accumulation_steps", "1",
            "--learning_rate", str(learning_rate),
            "--lr_scheduler", "constant",
            "--lr_warmup_steps", "0",
            "--max_train_steps", str(max_train_steps),
            "--rank", str(lora_rank),
            "--mixed_precision", "fp16",
            "--seed", "42",
            "--use_8bit_adam",
        ]

        log.info(f"[train] Starting DreamBooth LoRA training: {' '.join(cmd)}")
        _train_process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        last_lines: list[str] = []
        assert _train_process.stdout is not None
        for line in _train_process.stdout:
            line = line.rstrip()
            if line:
                log.info(f"[dreambooth] {line}")
                last_lines.append(line)
                if len(last_lines) > 30:
                    last_lines.pop(0)

        _train_process.wait()
        rc = _train_process.returncode

        if rc == 0:
            log.info("[train] DreamBooth training completed successfully")
            # Find the trained model
            lora_path = _find_trained_lora(output_dir)
            if lora_path:
                log.info(f"[train] Trained LoRA saved at: {lora_path}")
        else:
            err_msg = "\n".join(last_lines[-10:]) if last_lines else f"exit code {rc}"
            _train_error = err_msg
            log.error(f"[train] Training failed: {err_msg}")

    except Exception as e:
        _train_error = str(e)
        log.error(f"[train] Training error: {e}")
    finally:
        _training = False
        _train_process = None
        gc.collect()
        _ensure_torch()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


@app.post("/train", response_model=TrainResponse, dependencies=[Depends(verify_token)])
async def train_lora(req: TrainRequest, background_tasks: BackgroundTasks):
    """Start LoRA DreamBooth training."""
    global _training, _train_error, _train_output_dir

    if _training:
        raise HTTPException(status_code=409, detail="A training job is already in progress")

    # Unload inference model to free VRAM
    if _model_loaded:
        log.info("[train] Unloading inference model for training")
        _unload_model()

    if not req.train_config or not req.photos:
        raise HTTPException(status_code=400, detail="Provide 'train_config' + 'photos'")

    try:
        data_dir, output_dir = _materialize_network_training(req)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to materialize training data: {e}")

    _training = True
    _train_error = None
    _train_output_dir = output_dir

    background_tasks.add_task(_bg_train, data_dir, output_dir, req.train_config)

    log.info(f"[train] Started LoRA training for character {req.character_id}")
    return TrainResponse(status="accepted", message="Training started", output_dir=output_dir)


@app.get("/train-status")
async def train_status(character_id: Optional[str] = None):
    """Check training status."""
    lora_path = None
    checkpoint_count = 0

    search_dirs = []
    if _train_output_dir:
        search_dirs.append(_train_output_dir)
    if character_id:
        char_dir = _get_training_dir(character_id)
        output_subdir = os.path.join(char_dir, "output")
        for d in (char_dir, output_subdir):
            if os.path.isdir(d) and d not in search_dirs:
                search_dirs.append(d)

    for search_dir in search_dirs:
        try:
            for root, _dirs, files in os.walk(search_dir):
                for f in files:
                    if "checkpoint" in f.lower():
                        checkpoint_count += 1
        except Exception:
            pass
        if not _training and lora_path is None:
            lora_path = _find_trained_lora(search_dir)

    # Also check permanent loras dir
    if lora_path is None and character_id:
        relocated = safe_join(_LORAS_DIR, f"{character_id}_adapter.safetensors")
        if os.path.isfile(relocated):
            lora_path = relocated

    return {
        "training": _training,
        "paused": False,  # Pause not supported on CUDA
        "process_alive": _train_process is not None and _train_process.poll() is None if _train_process else False,
        "error": _sanitize_train_error(_train_error),
        "output_dir": _train_output_dir,
        "lora_path": lora_path,
        "checkpoint_count": checkpoint_count,
    }


@app.get("/train-checkpoints", dependencies=[Depends(verify_token)])
async def list_train_checkpoints(character_id: str):
    """List checkpoint files for a character."""
    train_dir = _get_training_dir(character_id)
    checkpoints: list[dict] = []
    try:
        for root, _dirs, files in os.walk(train_dir):
            for f in files:
                if "checkpoint" in f.lower() or f.endswith(".safetensors"):
                    full_path = os.path.join(root, f)
                    try:
                        size = os.path.getsize(full_path)
                    except OSError:
                        size = 0
                    checkpoints.append({"path": full_path, "name": f, "size": size})
    except Exception:
        pass
    checkpoints.sort(key=lambda c: c["name"], reverse=True)
    return {"character_id": character_id, "checkpoints": checkpoints, "train_dir": train_dir}


@app.post("/train-resume", response_model=TrainResponse, dependencies=[Depends(verify_token)])
async def resume_train_lora(req: ResumeTrainRequest, background_tasks: BackgroundTasks):
    """Resume training from a checkpoint (placeholder â€” full implementation varies by framework)."""
    global _training, _train_error, _train_output_dir

    if _training:
        raise HTTPException(status_code=409, detail="A training job is already in progress")

    if not os.path.exists(req.checkpoint_path):
        raise HTTPException(status_code=400, detail=f"Checkpoint not found: {req.checkpoint_path}")

    # For now, just mark as an error â€” diffusers DreamBooth doesn't have native resume
    # This is a compatibility stub
    return TrainResponse(
        status="error",
        message="Resume from checkpoint not yet supported on CUDA. Re-run training from scratch.",
        output_dir=None,
    )


@app.post("/train-recover", dependencies=[Depends(verify_token)])
async def recover_trained_lora(req: RecoverTrainRequest):
    """Extract a LoRA adapter from a checkpoint and save it permanently."""
    persistent_dir = _get_training_dir(req.character_id)
    output_dir = os.path.join(persistent_dir, "output")

    lora_path = _find_trained_lora(output_dir) if os.path.isdir(output_dir) else None

    if not lora_path:
        lora_path = _find_trained_lora(persistent_dir)

    if not lora_path:
        raise HTTPException(status_code=404, detail=f"No trained LoRA found for {req.character_id}")

    # Relocate to permanent location
    dest = safe_join(_LORAS_DIR, f"{req.character_id}_adapter.safetensors")
    os.makedirs(_LORAS_DIR, exist_ok=True)
    shutil.copy(lora_path, dest)
    log.info(f"[train-recover] Copied {lora_path} -> {dest}")

    return {"lora_path": dest, "source": lora_path}


@app.post("/train-pause", dependencies=[Depends(verify_token)])
async def pause_training():
    """Pause is not supported on CUDA (subprocess-based training)."""
    return {"ok": False, "message": "Pause not supported on CUDA training"}


@app.post("/train-unpause", dependencies=[Depends(verify_token)])
async def unpause_training():
    """Unpause is not supported on CUDA."""
    return {"ok": False, "message": "Unpause not supported on CUDA training"}


@app.delete("/train-data", dependencies=[Depends(verify_token)])
async def delete_train_data(req: DeleteTrainDataRequest):
    """Delete training data for a character."""
    removed_paths = []
    relocated_lora = None
    persistent_dir = safe_join(_TRAINING_BASE_DIR, req.character_id)

    if os.path.isdir(persistent_dir):
        relocated_lora = _relocate_adapter(req.character_id, persistent_dir)
        try:
            shutil.rmtree(persistent_dir)
            removed_paths.append(persistent_dir)
            log.info(f"[train-data] Removed {persistent_dir}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to remove {persistent_dir}: {e}")

    if removed_paths:
        return {"removed": True, "paths": removed_paths, "lora_path": relocated_lora}
    return {"removed": False, "reason": f"No training data found for {req.character_id}"}


# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# END TRAINING ENDPOINTS
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•


# â”€â”€ Entrypoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Image-gen CUDA sidecar")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5005")))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
