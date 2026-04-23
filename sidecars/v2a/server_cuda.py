"""
Video-to-Audio (v2a) Worker Sidecar â€” MMAudio
WS1-A (#925) / Issue #939 gap D rewrite.

Generates a synchronized audio track for an existing silent video clip
by wrapping `hkchengrex/MMAudio` (MIT-licensed). The orchestrator's
QueueMaster awaits this sidecar's `/generate` response synchronously and
persists ``audio_status: "failed"`` on any non-200 â€” so this server MUST
return clear, actionable errors when the model is missing rather than
silently accepting a job it can't run.

History (read this before changing the loader):
  Pre-2026-04-23 versions used ``diffusers.DiffusionPipeline.from_pretrained(
  "hkchengrex/MMAudio", trust_remote_code=True)``. That repo has no
  ``model_index.json``, so that loader has *never* succeeded at runtime â€”
  the orchestrator's old fire-and-forget call masked the failure. This
  module now uses the upstream `mmaudio` package's documented loader from
  https://github.com/hkchengrex/MMAudio (`demo.py`).

  If the `mmaudio` package fails to import (e.g., Windows users without
  flash-attn / WSL host without the optional dep), the server still
  starts and the `/generate` endpoint returns HTTP 503 with an
  actionable installation hint. That is the documented graceful-degrade
  contract: the orchestrator marks the job ``audio_status: "failed"``
  with a clear error, and the silent-fail bug never returns.

HTTP API:
  GET  /health         â€” health + busy state + mmaudio import status
  GET  /gpu-info       â€” device count, VRAM, idle status
  POST /unload         â€” free VRAM (called by QueueMaster between jobs)
  POST /generate       â€” submit a v2a job (returns 202 + job_id when MMAudio
                          is available; 503 with `error` field otherwise so
                          the orchestrator can persist audio_status=failed)
  GET  /status/{job_id}â€” poll job status

Port: 5012 (default; configurable via PORT env var).

License notes:
  - MMAudio: MIT (https://github.com/hkchengrex/MMAudio)
  - Weights are downloaded automatically by the upstream package on first
    use into the standard MMAudio cache directory.
"""

from __future__ import annotations

import asyncio
import base64
import gc
import hmac
import logging
import os
import pathlib
import re
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


# â”€â”€ Configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

# Variant matching the upstream `all_model_cfg` keys: small_16k, small_44k,
# medium_44k, large_44k, large_44k_v2.  Default to small_44k for 6 GB GPU
# headroom (RTX 3060). large_44k_v2 is recommended on 12 GB+.
DEFAULT_VARIANT = os.getenv("V2A_VARIANT", "small_44k")
DEFAULT_DURATION_SEC = float(os.getenv("V2A_DEFAULT_DURATION", "8.0"))
MAX_DURATION_SEC = float(os.getenv("V2A_MAX_DURATION", "30.0"))
DEFAULT_NUM_STEPS = int(os.getenv("V2A_NUM_STEPS", "25"))
DEFAULT_CFG_STRENGTH = float(os.getenv("V2A_CFG_STRENGTH", "4.5"))
IDLE_TIMEOUT_SEC = int(os.getenv("V2A_IDLE_TIMEOUT", "300"))
SECRET_TOKEN = os.getenv("WORKER_SECRET_TOKEN") or os.getenv("V2A_SECRET_TOKEN")

# â”€â”€ GPU placement (mirrors `sidecars/worker/server_cuda.py`) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
V2A_DEVICE_OVERRIDE: str = os.getenv("V2A_DEVICE", "").strip()
V2A_PREFER_LARGER_GPU: bool = os.getenv("V2A_PREFER_LARGER_GPU", "1").strip() in (
    "1", "true", "True",
)
V2A_FALLBACK_TO_CPU: bool = os.getenv("V2A_FALLBACK_TO_CPU", "0").strip() in (
    "1", "true", "True",
)

# Containment roots for user-supplied video paths and tempfile outputs.
_DEFAULT_RENDER_ROOT = os.path.expanduser("~/.openzigs/renders")
ALLOWED_VIDEO_ROOTS: tuple[Path, ...] = tuple(
    Path(p).resolve()
    for p in (
        os.getenv("V2A_VIDEO_ROOT", _DEFAULT_RENDER_ROOT),
        tempfile.gettempdir(),
    )
)
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_ALLOWED_CALLBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

# Lazy state â€” torch/mmaudio are heavy, only loaded when first needed.
torch = None
_pipeline = None  # tuple: (net, feature_utils, seq_cfg, dtype, device)
_pipeline_load_lock = threading.Lock()
_last_used_at: float = 0.0

# mmaudio import status. Recorded once at startup (in `_probe_mmaudio()`)
# so /health can surface the install-or-not state without re-importing.
_MMAUDIO_AVAILABLE: bool = False
_MMAUDIO_IMPORT_ERROR: Optional[str] = None

_selected_device: Optional[str] = None
_selected_device_reason: str = "unset"


def _reset_selected_device_for_tests() -> None:
    """Test-only helper to clear cached device selection between cases."""
    global _selected_device, _selected_device_reason
    _selected_device = None
    _selected_device_reason = "unset"


def _select_device() -> tuple[str, str]:
    """Pick the CUDA device this sidecar should run on.

    Resolution order (mirrors `sidecars/worker/server_cuda.py`):
      1. ``V2A_DEVICE`` env override â†’ returned verbatim, reason ``env-override``.
      2. No CUDA available â†’ :class:`RuntimeError` (no silent CPU fallback).
      3. Single GPU â†’ ``cuda:0`` with reason ``auto``.
      4. Multiple GPUs and ``V2A_PREFER_LARGER_GPU=1`` â†’ device with the most
         total VRAM, reason ``auto``.
      5. Multiple GPUs and ``V2A_PREFER_LARGER_GPU=0`` â†’ ``cuda:0``, reason
         ``auto``.
    """
    _ensure_torch()
    env_override = os.getenv("V2A_DEVICE", "").strip()
    if env_override:
        return env_override, "env-override"
    if torch is None or not torch.cuda.is_available():
        raise RuntimeError(
            "V2A sidecar requires CUDA. Set V2A_DEVICE=cuda:0 manually if "
            "running in a container with passthrough, or run on a CUDA-enabled "
            "host. CPU fallback is not supported because MMAudio inference is "
            "impractically slow without a GPU."
        )
    device_count = torch.cuda.device_count()
    if device_count <= 0:
        raise RuntimeError(
            "V2A sidecar requires CUDA. torch.cuda.device_count() returned 0."
        )
    prefer_larger = os.getenv("V2A_PREFER_LARGER_GPU", "1").strip() in (
        "1", "true", "True",
    )
    if device_count == 1 or not prefer_larger:
        return "cuda:0", "auto"
    best_idx = 0
    best_total = -1
    for i in range(device_count):
        try:
            _, total = torch.cuda.mem_get_info(i)
        except Exception as exc:
            logger.debug("[v2a] mem_get_info(%d) failed: %s", i, exc, exc_info=True)
            try:
                props = torch.cuda.get_device_properties(i)
                total = int(getattr(props, "total_memory", 0))
            except Exception as exc2:
                logger.debug(
                    "[v2a] get_device_properties(%d) failed: %s",
                    i, exc2, exc_info=True,
                )
                total = 0
        if total > best_total:
            best_total = total
            best_idx = i
    return f"cuda:{best_idx}", "auto"


def _get_selected_device() -> str:
    global _selected_device, _selected_device_reason
    if _selected_device is None:
        _selected_device, _selected_device_reason = _select_device()
        logger.info(
            "[v2a] Selected device %s (reason=%s)",
            _selected_device, _selected_device_reason,
        )
    return _selected_device


def _get_selected_device_reason() -> str:
    return _selected_device_reason


# Job results: in-memory ring buffer.
_MAX_RESULTS = 64
_results: dict[str, dict] = {}
_results_lock = threading.Lock()


# â”€â”€ Security â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    """Loopback-only callback validator (SSRF defence).

    Returns a URL string that is **reconstructed** from the validated
    components rather than the original tainted input, so CodeQL's
    py/full-ssrf flow analysis recognises the function as a sanitizer.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("URL scheme must be http or https")
    host = (parsed.hostname or "").strip("[]")
    if not host:
        raise ValueError("URL must have a hostname")
    if host not in _ALLOWED_CALLBACK_HOSTS:
        raise ValueError("Callback host not in allow-list")
    port = f":{parsed.port}" if parsed.port else ""
    path = parsed.path or "/"
    query = f"?{parsed.query}" if parsed.query else ""
    return f"{parsed.scheme}://{host}{port}{path}{query}"


def safe_video_path(p: str) -> str:
    """Validate that ``p`` resolves to an existing file under one of the
    allow-listed roots (CodeQL py/path-injection sanitizer using
    ``pathlib.Path.resolve()`` + ``relative_to()`` containment)."""
    candidate = pathlib.Path(p).resolve(strict=True)
    for root in ALLOWED_VIDEO_ROOTS:
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        if not candidate.is_file():
            raise ValueError("Video path is not a regular file")
        return str(candidate)
    raise ValueError("Video path is outside the allowed roots")


def safe_job_id(jid: str) -> str:
    if not _JOB_ID_RE.match(jid):
        raise ValueError("job_id must match ^[A-Za-z0-9_-]{1,128}$")
    return jid


# â”€â”€ Lazy torch + mmaudio loader â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _ensure_torch() -> None:
    global torch
    if torch is None:
        import torch as _torch
        torch = _torch
        if _torch.cuda.is_available():
            _torch.backends.cudnn.benchmark = True


def _probe_mmaudio() -> tuple[bool, Optional[str]]:
    """Try importing the upstream mmaudio package once at startup.

    We deliberately import only the names we'll actually call in the loader
    so a partial install (e.g. missing flash-attn dependency) reports
    accurately. The result is cached in ``_MMAUDIO_AVAILABLE`` /
    ``_MMAUDIO_IMPORT_ERROR`` so /health can surface it without paying
    the import cost on every request.
    """
    try:
        from mmaudio.eval_utils import (  # noqa: F401
            ModelConfig, all_model_cfg, generate, load_video,
        )
        from mmaudio.model.flow_matching import FlowMatching  # noqa: F401
        from mmaudio.model.networks import MMAudio, get_my_mmaudio  # noqa: F401
        from mmaudio.model.utils.features_utils import FeaturesUtils  # noqa: F401
        return True, None
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


def _load_pipeline() -> tuple[Any, Any, Any, Any, str]:
    """Load MMAudio on first use; cache for subsequent jobs.

    Raises :class:`RuntimeError` with an actionable message when:
      - the `mmaudio` package isn't importable (graceful degrade);
      - CUDA isn't available;
      - the upstream loader fails (model weights download error, etc.).

    The orchestrator translates RuntimeError â†’ audio_status=failed via the
    /generate handler below, so callers always see an explicit failure.
    """
    global _pipeline, _last_used_at
    if _pipeline is not None:
        _last_used_at = time.time()
        return _pipeline
    with _pipeline_load_lock:
        if _pipeline is not None:
            _last_used_at = time.time()
            return _pipeline
        if not _MMAUDIO_AVAILABLE:
            raise RuntimeError(
                "MMAudio is not installed. Install via: "
                "`pip install -r sidecars/v2a/requirements.txt` "
                "(this pulls `git+https://github.com/hkchengrex/MMAudio.git`). "
                f"Import error captured at startup: {_MMAUDIO_IMPORT_ERROR}"
            )
        _ensure_torch()
        from mmaudio.eval_utils import all_model_cfg
        from mmaudio.model.networks import get_my_mmaudio
        from mmaudio.model.utils.features_utils import FeaturesUtils

        if DEFAULT_VARIANT not in all_model_cfg:
            raise RuntimeError(
                f"Unknown V2A_VARIANT={DEFAULT_VARIANT!r}. "
                f"Valid values: {sorted(all_model_cfg.keys())}"
            )
        model_cfg = all_model_cfg[DEFAULT_VARIANT]
        device = _get_selected_device()
        dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
        logger.info(
            "[v2a] Loading mmaudio variant=%s on %s (dtype=%s). "
            "Weights will download to the mmaudio cache on first run.",
            DEFAULT_VARIANT, device, dtype,
        )
        try:
            model_cfg.download_if_needed()
            seq_cfg = model_cfg.seq_cfg
            net = get_my_mmaudio(model_cfg.model_name).to(device, dtype).eval()
            net.load_weights(
                torch.load(model_cfg.model_path, map_location=device, weights_only=True)
            )
            feature_utils = FeaturesUtils(
                tod_vae_ckpt=model_cfg.vae_path,
                synchformer_ckpt=model_cfg.synchformer_ckpt,
                enable_conditions=True,
                mode=model_cfg.mode,
                bigvgan_vocoder_ckpt=getattr(model_cfg, "bigvgan_16k_path", None),
                need_vae_encoder=False,
            ).to(device, dtype).eval()
        except Exception as exc:
            raise RuntimeError(
                f"Failed to load MMAudio variant '{DEFAULT_VARIANT}': {exc}. "
                "Verify your install: `pip install -r sidecars/v2a/requirements.txt` "
                "and ensure the host has internet access on first run for the ~600MB weight download."
            ) from exc
        _pipeline = (net, feature_utils, seq_cfg, dtype, device)
        _last_used_at = time.time()
        logger.info("[v2a] MMAudio pipeline ready (variant=%s)", DEFAULT_VARIANT)
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
        except Exception as exc:
            logger.debug("[v2a] torch.cuda.empty_cache() failed: %s", exc, exc_info=True)
        logger.info("[v2a] Pipeline unloaded; VRAM freed")


# â”€â”€ Idle-timeout watchdog â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async def _idle_unload_watchdog() -> None:
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


# â”€â”€ FastAPI App â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

from contextlib import asynccontextmanager


@asynccontextmanager
async def _lifespan(app: FastAPI):
    global _MMAUDIO_AVAILABLE, _MMAUDIO_IMPORT_ERROR
    _MMAUDIO_AVAILABLE, _MMAUDIO_IMPORT_ERROR = _probe_mmaudio()
    if _MMAUDIO_AVAILABLE:
        logger.info("[v2a] mmaudio import probe: OK")
    else:
        logger.warning(
            "[v2a] mmaudio import probe FAILED: %s. /generate will return 503 "
            "until you `pip install -r sidecars/v2a/requirements.txt`.",
            _MMAUDIO_IMPORT_ERROR,
        )
    task = asyncio.create_task(_idle_unload_watchdog())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            logger.debug("[v2a] watchdog cancelled during lifespan shutdown")


app = FastAPI(title="OpenZigs v2a Sidecar", version="2.0.0", lifespan=_lifespan)


class GenerateRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=128)
    video_path: Optional[str] = Field(default=None, max_length=4096)
    video_b64: Optional[str] = Field(default=None)
    duration_sec: float = Field(default=DEFAULT_DURATION_SEC, gt=0.0, le=MAX_DURATION_SEC)
    prompt: Optional[str] = Field(default=None, max_length=512)
    negative_prompt: Optional[str] = Field(default=None, max_length=512)
    seed: Optional[int] = None
    callback_url: Optional[str] = None
    num_steps: Optional[int] = Field(default=None, ge=1, le=100)
    cfg_strength: Optional[float] = Field(default=None, ge=0.0, le=20.0)


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


def _generate_audio_sync(
    request: GenerateRequest, in_video: str, out_audio: str,
) -> None:
    """Run the synchronous mmaudio inference. Called via asyncio.to_thread."""
    from mmaudio.eval_utils import generate as mmaudio_generate, load_video
    from mmaudio.model.flow_matching import FlowMatching

    net, feature_utils, seq_cfg, dtype, device = _load_pipeline()

    duration = float(request.duration_sec)
    num_steps = int(request.num_steps or DEFAULT_NUM_STEPS)
    cfg_strength = float(request.cfg_strength or DEFAULT_CFG_STRENGTH)

    rng = torch.Generator(device=device)
    if request.seed is not None:
        rng.manual_seed(int(request.seed))
    else:
        rng.manual_seed(int(time.time()) % (2**31))

    fm = FlowMatching(min_sigma=0, inference_mode="euler", num_steps=num_steps)

    # Adjust seq lengths to match the requested duration. The upstream
    # `seq_cfg` exposes a `duration` setter that recomputes latent / clip
    # / sync sequence lengths so the network can be `update_seq_lengths`'d
    # in a single call.
    seq_cfg.duration = duration

    video_info = load_video(Path(in_video), duration)
    clip_frames = video_info.clip_frames.unsqueeze(0)
    sync_frames = video_info.sync_frames.unsqueeze(0)

    # The user's video may be shorter than `duration` (e.g. 3.96s when 4.0s
    # was requested), in which case `load_video` returns fewer CLIP/sync
    # frames than `seq_cfg` expects, and the network's
    # `preprocess_conditions` assertion fires. Re-derive the network's
    # expected sequence lengths from the *actual* frame counts so they
    # always match. The latent length scales linearly with CLIP length.
    actual_clip_len = int(clip_frames.shape[1])
    actual_sync_len = int(sync_frames.shape[1])
    expected_clip_len = int(seq_cfg.clip_seq_len)
    if actual_clip_len != expected_clip_len:
        ratio = actual_clip_len / max(expected_clip_len, 1)
        actual_latent_len = max(1, int(round(int(seq_cfg.latent_seq_len) * ratio)))
        logger.info(
            "[v2a] Adjusting seq lengths to actual video frames: "
            "clip %d->%d, sync %d->%d, latent %d->%d",
            expected_clip_len, actual_clip_len,
            int(seq_cfg.sync_seq_len), actual_sync_len,
            int(seq_cfg.latent_seq_len), actual_latent_len,
        )
        net.update_seq_lengths(actual_latent_len, actual_clip_len, actual_sync_len)
    else:
        net.update_seq_lengths(
            seq_cfg.latent_seq_len, seq_cfg.clip_seq_len, seq_cfg.sync_seq_len,
        )

    prompt_text = request.prompt or ""
    negative_text = request.negative_prompt or ""

    with torch.inference_mode():
        audios = mmaudio_generate(
            clip_frames, sync_frames, [prompt_text],
            negative_text=[negative_text],
            feature_utils=feature_utils,
            net=net, fm=fm, rng=rng,
            cfg_strength=cfg_strength,
        )
    audio = audios.float().cpu()[0]
    sample_rate = int(getattr(seq_cfg, "sampling_rate", 16000))

    # Write 16-bit PCM WAV via torchaudio when available, else stdlib `wave`.
    try:
        import torchaudio  # type: ignore
        if audio.ndim == 1:
            audio = audio.unsqueeze(0)
        torchaudio.save(out_audio, audio, sample_rate=sample_rate)
    except Exception as exc:
        logger.debug("[v2a] torchaudio.save failed (%s); falling back to wave module", exc)
        _write_wav_stdlib(audio, out_audio, sample_rate=sample_rate)


async def _run_job(request: GenerateRequest) -> None:
    safe_jid = safe_job_id(request.job_id)
    out_audio = os.path.join(tempfile.gettempdir(), f"v2a_{safe_jid}.wav")
    in_video: Optional[str] = None
    try:
        in_video = _resolve_video_input(request)
        await asyncio.to_thread(_generate_audio_sync, request, in_video, out_audio)
        _store(safe_jid, {"status": "completed", "audio_path": out_audio})
        if request.callback_url:
            try:
                safe_url = validate_callback_url(request.callback_url)
                async with httpx.AsyncClient(timeout=30.0) as client:
                    await client.post(
                        safe_url,
                        json={
                            "job_id": safe_jid,
                            "status": "completed",
                            "audio_path": out_audio,
                        },
                    )
            except Exception as cb_exc:
                logger.warning(f"[v2a] callback failed: {cb_exc}")
    except Exception as exc:
        logger.exception(f"[v2a] job {safe_jid} failed")
        # Do not leak stack traces or internal details to external callers
        # (CodeQL py/stack-trace-exposure). Persist a generic message.
        _store(safe_jid, {"status": "failed", "error": "job failed; see worker logs"})
        if request.callback_url:
            try:
                safe_url = validate_callback_url(request.callback_url)
                async with httpx.AsyncClient(timeout=30.0) as client:
                    await client.post(
                        safe_url,
                        json={
                            "job_id": safe_jid,
                            "status": "failed",
                            "error": "job failed; see worker logs",
                        },
                    )
            except Exception as cb_exc:
                logger.warning("[v2a] failure callback failed: %s", cb_exc)
    finally:
        if in_video and request.video_b64:
            try:
                cleanup = os.path.realpath(in_video)
                if cleanup.startswith(os.path.realpath(tempfile.gettempdir()) + os.sep):
                    os.remove(cleanup)
            except OSError as exc:
                logger.debug("[v2a] temp input cleanup failed: %s", exc, exc_info=True)


def _write_wav_stdlib(arr, out_path: str, *, sample_rate: int) -> None:
    """Persist a 1-D float audio tensor / numpy array as 16-bit PCM WAV.

    Used as a fallback when torchaudio is missing. The mmaudio package
    pulls torchaudio in transitively, so this is rarely hit in practice.
    """
    import wave
    import struct
    if hasattr(arr, "cpu"):
        arr = arr.cpu().numpy()
    if hasattr(arr, "ndim") and arr.ndim > 1:
        arr = arr[0]
    samples = [max(-1.0, min(1.0, float(x))) for x in arr]
    with wave.open(out_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"".join(struct.pack("<h", int(s * 32767)) for s in samples))


# â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "sidecar": "v2a",
        "loaded": _pipeline is not None,
        "variant": DEFAULT_VARIANT,
        "mmaudio_available": _MMAUDIO_AVAILABLE,
        "mmaudio_import_error": _MMAUDIO_IMPORT_ERROR,
    }


@app.get("/gpu-info")
async def gpu_info():
    _ensure_torch()
    if torch is None or not torch.cuda.is_available():
        return {"cuda_available": False}
    try:
        device = _get_selected_device()
        try:
            device_index = int(device.split(":", 1)[1]) if ":" in device else 0
        except (ValueError, IndexError):
            device_index = 0
        free, total = torch.cuda.mem_get_info(device_index)
        return {
            "cuda_available": True,
            "device": device,
            "device_reason": _get_selected_device_reason(),
            "device_count": torch.cuda.device_count(),
            "total_gb": int(total / 1024**3),
            "free_gb": int(free / 1024**3),
            "loaded": _pipeline is not None,
            "mmaudio_available": _MMAUDIO_AVAILABLE,
        }
    except RuntimeError as exc:
        logger.warning("[v2a] gpu-info: device selection failed: %s", exc)
        return {"cuda_available": False, "error": str(exc)}
    except Exception as exc:
        logger.exception("[v2a] gpu-info query failed: %s", exc)
        return {"cuda_available": True, "error": "gpu_info_unavailable"}


@app.post("/unload", dependencies=[Depends(verify_token)])
async def unload():
    _unload_pipeline()
    return {"status": "unloaded"}


@app.post("/generate", status_code=202, dependencies=[Depends(verify_token)])
async def generate(request: GenerateRequest):
    """Accept a v2a job.

    Issue #939 gap D contract: when MMAudio cannot run for a structural
    reason (package not installed), reject *synchronously* with HTTP 503
    + a clear ``error`` body so the orchestrator can persist
    ``audio_status: "failed"`` immediately. Never accept-then-silently-fail.
    """
    if not _MMAUDIO_AVAILABLE:
        msg = (
            "MMAudio not installed in the v2a sidecar. "
            "Run: pip install -r sidecars/v2a/requirements.txt"
        )
        if _MMAUDIO_IMPORT_ERROR:
            msg += f" (import error: {_MMAUDIO_IMPORT_ERROR})"
        logger.warning("[v2a] /generate rejected: %s", msg)
        raise HTTPException(status_code=503, detail=msg)
    try:
        # Validate inputs synchronously so HTTP 400s come back to the
        # orchestrator BEFORE we accept the job.
        safe_job_id(request.job_id)
        if request.video_path:
            safe_video_path(request.video_path)
        elif not request.video_b64:
            raise HTTPException(
                status_code=400,
                detail="Either video_path or video_b64 is required",
            )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

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


# â”€â”€ Entrypoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="OpenZigs v2a (MMAudio) sidecar")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5012")))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    logger.info("[v2a] Starting uvicorn on %s:%d (mmaudio_available=%s)",
                args.host, args.port, _MMAUDIO_AVAILABLE)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
