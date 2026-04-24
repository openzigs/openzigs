"""
LTX-2 Native Audio+Video Sidecar (Issue #939, follow-up to PR #940).

Wraps Lightricks' native ``ltx_pipelines.distilled`` CLI (from the
``Lightricks/LTX-2`` GitHub monorepo) to produce single-pass MP4s with
**natively muxed audio** — i.e. audio_mode="native" in the orchestrator.

Why this exists (read before changing anything):

  Pre-2026-04-24 the worker registry marked ``ltxv-2-22b-distilled`` as
  ``unavailable=True`` because:

    * The diffusers loader path requires symbols (``LTX2TextConnectors``,
      ``LTX2Vocoder``) that don't actually exist anywhere — neither on
      PyPI's ``ltx2`` package (not published) nor in Lightricks' open-source
      monorepo. This was confirmed via filesystem grep across both the
      ``Lightricks/LTX-2`` and the older ``Lightricks/LTX-Video`` repos.
    * The native ``ltx_core`` / ``ltx_pipelines`` path was overlooked.

  This sidecar exercises the **native** path that Lightricks officially
  documents:

    1. Clone ``Lightricks/LTX-2`` (the v1.1.2 monorepo)
    2. ``uv sync --frozen`` against ``packages/ltx-pipelines/pyproject.toml``
    3. Download ``ltx-2.3-22b-dev-fp8.safetensors``,
       ``ltx-2.3-spatial-upscaler-x2-1.1.safetensors``, and
       the ``unsloth/gemma-3-12b-it`` text encoder (~53 GB total)
    4. Invoke ``python -m ltx_pipelines.distilled`` with the documented
       flags. The CLI's ``DistilledPipeline.encode_video()`` muxes audio
       and video into a single MP4 in one shot.

  Smoke validated 2026-04-24 on a single RTX 3060 12 GB + 57 GB system
  RAM with ``--offload cpu``: 512×512×25 frames at 24 fps producing a
  306 KB MP4 with H.264 video and AAC 48 kHz audio in ~35 seconds wall
  clock (8 + 3 + 1 diffusion steps).

Hardware constraints (UPSTREAM, see
``packages/ltx-pipelines/src/ltx_pipelines/utils/blocks.py:162``):

  * ``--quantization`` is **mutually exclusive** with ``--offload {cpu,disk}``.
    Layer streaming requires un-quantised weights. On a 12 GB GPU we MUST
    use ``--offload cpu`` (or ``disk``) and accept BF16 layer streaming
    from system RAM.
  * Multi-GPU sharding is **not** implemented in ``DistilledPipeline``.
    Always pin to a single CUDA device via ``CUDA_VISIBLE_DEVICES``.

Implementation choice — subprocess vs. in-process:

  We deliberately invoke the upstream CLI via ``subprocess`` rather than
  importing ``DistilledPipeline`` directly. Rationale:

    * The upstream pipeline keeps weights pinned to ~30 GB of CPU memory
      between calls when held in-process; subprocess invocation lets the
      OS reclaim that RAM after each job, which matters on shared dev
      boxes.
    * The upstream API is unstable (no SemVer, breaks between minor
      releases). Calling the CLI insulates us from refactors of the
      Python entry points.
    * Per-job model load is ~5 s on this hardware (NVMe + page cache);
      acceptable overhead for a sidecar that handles single-digit jobs
      per minute.

  The tradeoff is that the **first** job after sidecar startup is no
  faster than the second. If demand grows we can port to in-process
  with explicit ``del pipeline; gc.collect()`` between jobs.

HTTP API (port 5013 by default):

  GET  /health         — service ready check + venv/model presence probe
  GET  /gpu-info       — device count + free VRAM (best-effort)
  POST /generate       — submit a job (returns 202 + job_id)
  GET  /status/{job_id}— poll job status / result MP4 path
  POST /unload         — no-op for subprocess mode (kept for API parity)

Security:

  * Bearer token via ``WORKER_SECRET_TOKEN`` (or ``LTX2_SECRET_TOKEN``)
    on /generate and /unload.
  * Output paths are containment-checked against ``LTX2_OUTPUT_ROOT``
    (default ``$TMPDIR/ltx2-out``) before the subprocess writes them.
  * Prompts are passed via argv (subprocess), never via shell — no shell
    injection surface.
  * Callback URLs are loopback-only (CodeQL py/full-ssrf sanitizer).
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("ltx2-sidecar")


# ── Configuration ───────────────────────────────────────────────────────

# Path to the externally-managed venv that has ``ltx_pipelines`` installed.
# Created by ``sidecars/ltx2/setup.sh`` (which runs ``uv sync`` against the
# upstream monorepo). NOT a pip requirements.txt — the package isn't on PyPI.
LTX2_SRC_ROOT = Path(
    os.getenv("LTX2_SRC_ROOT", os.path.expanduser("~/openzigs-sidecars/ltx2-src"))
).resolve()
LTX2_VENV_PYTHON = Path(
    os.getenv("LTX2_VENV_PYTHON", str(LTX2_SRC_ROOT / ".venv" / "bin" / "python"))
).resolve()

# Model artefacts (downloaded by setup.sh).
LTX2_MODELS_ROOT = Path(
    os.getenv("LTX2_MODELS_ROOT", os.path.expanduser("~/openzigs-sidecars/ltx2-models"))
).resolve()
LTX2_DISTILLED_CHECKPOINT = Path(
    os.getenv(
        "LTX2_DISTILLED_CHECKPOINT",
        str(LTX2_MODELS_ROOT / "ltx2" / "ltx-2.3-22b-dev-fp8.safetensors"),
    )
).resolve()
LTX2_SPATIAL_UPSAMPLER = Path(
    os.getenv(
        "LTX2_SPATIAL_UPSAMPLER",
        str(LTX2_MODELS_ROOT / "ltx2" / "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"),
    )
).resolve()
LTX2_GEMMA_ROOT = Path(
    os.getenv("LTX2_GEMMA_ROOT", str(LTX2_MODELS_ROOT / "gemma-3-12b"))
).resolve()

# Output containment root. All generated MP4s land under here.
LTX2_OUTPUT_ROOT = Path(
    os.getenv("LTX2_OUTPUT_ROOT", os.path.join(tempfile.gettempdir(), "ltx2-out"))
).resolve()
LTX2_OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

# Generation defaults — match the validated smoke profile.
LTX2_DEFAULT_HEIGHT = int(os.getenv("LTX2_DEFAULT_HEIGHT", "512"))
LTX2_DEFAULT_WIDTH = int(os.getenv("LTX2_DEFAULT_WIDTH", "512"))
LTX2_DEFAULT_FRAMES = int(os.getenv("LTX2_DEFAULT_FRAMES", "25"))
LTX2_DEFAULT_FPS = int(os.getenv("LTX2_DEFAULT_FPS", "24"))
LTX2_MAX_FRAMES = int(os.getenv("LTX2_MAX_FRAMES", "121"))
LTX2_MAX_DIM = int(os.getenv("LTX2_MAX_DIM", "1024"))
LTX2_OFFLOAD_MODE = os.getenv("LTX2_OFFLOAD_MODE", "cpu").strip()  # "none" | "cpu" | "disk"
# Per-job wall clock cap. CPU offload + 25 frames is ~35 s on RTX 3060.
# Generous default to allow longer clips; tune per-deployment if needed.
LTX2_GENERATION_TIMEOUT_SEC = int(os.getenv("LTX2_GENERATION_TIMEOUT_SEC", "1800"))

SECRET_TOKEN = os.getenv("WORKER_SECRET_TOKEN") or os.getenv("LTX2_SECRET_TOKEN")

_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
# DistilledPipeline only supports a small enum of offload modes; keep this
# locked down so a bad env var can't smuggle arbitrary text into argv.
_ALLOWED_OFFLOAD = frozenset({"none", "cpu", "disk"})
_ALLOWED_CALLBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

# Job results: bounded in-memory ring buffer.
_MAX_RESULTS = 64
_results: dict[str, dict] = {}
_results_lock = threading.Lock()

# Single-job semaphore — the upstream pipeline pins ~30 GB CPU RAM and the
# whole GPU during a run, so concurrency is unsafe on the dev hardware.
_job_semaphore = asyncio.Semaphore(1)


# ── Security helpers ────────────────────────────────────────────────────

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


def safe_job_id(jid: str) -> str:
    if not _JOB_ID_RE.match(jid):
        raise ValueError("job_id must match ^[A-Za-z0-9_-]{1,128}$")
    return jid


def safe_offload_mode(mode: str) -> str:
    """Containment check for argv injection — DistilledPipeline only accepts
    these three values, so anything else is a misconfiguration."""
    normalised = (mode or "").strip().lower()
    if normalised not in _ALLOWED_OFFLOAD:
        raise ValueError(
            f"offload_mode must be one of {sorted(_ALLOWED_OFFLOAD)}, got {mode!r}"
        )
    return normalised


def safe_output_path(job_id: str) -> Path:
    """Build a job-specific output path inside the containment root.

    Returns a resolved Path that is guaranteed to be inside
    ``LTX2_OUTPUT_ROOT`` (CodeQL py/path-injection sanitizer using
    ``Path.resolve()`` + ``relative_to()``).
    """
    candidate = (LTX2_OUTPUT_ROOT / f"ltx2_{job_id}.mp4").resolve()
    try:
        candidate.relative_to(LTX2_OUTPUT_ROOT)
    except ValueError as exc:
        raise ValueError("output path escaped containment root") from exc
    return candidate


def validate_callback_url(url: str) -> str:
    """Loopback-only callback validator (SSRF defence).

    Returns a URL string that is reconstructed from validated components
    rather than the original tainted input, so CodeQL's py/full-ssrf flow
    analysis recognises the function as a sanitizer.
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


# ── Environment probe ───────────────────────────────────────────────────

def _probe_environment() -> dict:
    """Check that the venv + model artefacts exist. Cached at startup so
    /health can answer instantly without paying the disk-stat cost on
    every request."""
    return {
        "venv_python_present": LTX2_VENV_PYTHON.is_file(),
        "distilled_checkpoint_present": LTX2_DISTILLED_CHECKPOINT.is_file(),
        "spatial_upsampler_present": LTX2_SPATIAL_UPSAMPLER.is_file(),
        "gemma_root_present": LTX2_GEMMA_ROOT.is_dir(),
    }


_env_probe: dict = {}


def _is_environment_ready() -> bool:
    return all(_env_probe.values()) if _env_probe else False


# ── Subprocess invocation ───────────────────────────────────────────────

def _build_argv(
    *,
    prompt: str,
    output_path: Path,
    seed: int,
    height: int,
    width: int,
    num_frames: int,
    frame_rate: int,
    offload_mode: str,
) -> list[str]:
    """Assemble the ``python -m ltx_pipelines.distilled`` argv list.

    All positional values are passed via argv (never shell), so prompt
    contents cannot be interpreted as shell metacharacters.
    """
    return [
        str(LTX2_VENV_PYTHON),
        "-m",
        "ltx_pipelines.distilled",
        "--distilled-checkpoint-path", str(LTX2_DISTILLED_CHECKPOINT),
        "--spatial-upsampler-path", str(LTX2_SPATIAL_UPSAMPLER),
        "--gemma-root", str(LTX2_GEMMA_ROOT),
        "--prompt", prompt,
        "--seed", str(seed),
        "--height", str(height),
        "--width", str(width),
        "--num-frames", str(num_frames),
        "--frame-rate", str(frame_rate),
        "--offload", offload_mode,
        "--output-path", str(output_path),
    ]


def _run_subprocess(argv: list[str], log_path: Path) -> tuple[int, str]:
    """Execute the CLI and capture stdout+stderr to ``log_path``.

    Returns ``(exit_code, tail)`` where ``tail`` is the last ~2 KB of
    output suitable for inclusion in error responses (truncated to avoid
    leaking large stack traces in the API surface).
    """
    env = os.environ.copy()
    env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    # Pin to a single GPU — DistilledPipeline does not shard.
    if "CUDA_VISIBLE_DEVICES" not in env:
        env["CUDA_VISIBLE_DEVICES"] = "0"

    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("wb") as log_fh:
        try:
            proc = subprocess.run(  # noqa: S603 — argv is fully validated above
                argv,
                cwd=str(LTX2_SRC_ROOT),
                env=env,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                timeout=LTX2_GENERATION_TIMEOUT_SEC,
                check=False,
            )
            exit_code = proc.returncode
        except subprocess.TimeoutExpired:
            exit_code = -1
            log_fh.write(
                f"\n[ltx2-sidecar] TIMEOUT after "
                f"{LTX2_GENERATION_TIMEOUT_SEC}s\n".encode()
            )

    try:
        with log_path.open("rb") as fh:
            data = fh.read()
        tail = data[-2048:].decode("utf-8", errors="replace")
    except OSError:
        tail = ""
    return exit_code, tail


# ── Job state ──────────────────────────────────────────────────────────

def _store(job_id: str, payload: dict) -> None:
    with _results_lock:
        if len(_results) >= _MAX_RESULTS:
            _results.pop(next(iter(_results)))
        _results[job_id] = payload


# ── FastAPI app ────────────────────────────────────────────────────────

@asynccontextmanager
async def _lifespan(app: FastAPI):
    global _env_probe
    _env_probe = _probe_environment()
    if _is_environment_ready():
        logger.info(
            "[ltx2] environment OK — venv=%s, models=%s",
            LTX2_VENV_PYTHON, LTX2_MODELS_ROOT,
        )
    else:
        logger.warning(
            "[ltx2] environment NOT ready — /generate will return 503. "
            "Probe: %s. Run sidecars/ltx2/setup.sh to provision.",
            _env_probe,
        )
    yield


app = FastAPI(title="OpenZigs LTX-2 Sidecar", version="1.0.0", lifespan=_lifespan)


class GenerateRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=128)
    prompt: str = Field(min_length=1, max_length=2000)
    seed: Optional[int] = Field(default=None, ge=0, le=2**31 - 1)
    height: int = Field(default=LTX2_DEFAULT_HEIGHT, ge=64)
    width: int = Field(default=LTX2_DEFAULT_WIDTH, ge=64)
    num_frames: int = Field(default=LTX2_DEFAULT_FRAMES, ge=1)
    frame_rate: int = Field(default=LTX2_DEFAULT_FPS, ge=1, le=60)
    offload_mode: Optional[str] = Field(default=None)
    callback_url: Optional[str] = None


async def _run_job(request: GenerateRequest) -> None:
    safe_jid = safe_job_id(request.job_id)
    started_at = time.time()
    out_path = safe_output_path(safe_jid)
    log_path = LTX2_OUTPUT_ROOT / f"ltx2_{safe_jid}.log"
    # Best-effort cleanup of stale artefacts from a previous run with the
    # same job_id — keeps the ring buffer's view of "completed" honest.
    for p in (out_path, log_path):
        try:
            if p.exists():
                p.unlink()
        except OSError as exc:
            logger.debug("[ltx2] cleanup failed for %s: %s", p, exc, exc_info=True)

    try:
        seed = int(request.seed) if request.seed is not None else int(time.time()) % (2**31)
        offload = safe_offload_mode(request.offload_mode or LTX2_OFFLOAD_MODE)
        argv = _build_argv(
            prompt=request.prompt,
            output_path=out_path,
            seed=seed,
            height=request.height,
            width=request.width,
            num_frames=request.num_frames,
            frame_rate=request.frame_rate,
            offload_mode=offload,
        )
        async with _job_semaphore:
            logger.info(
                "[ltx2] starting job %s (seed=%d, %dx%d×%d frames, offload=%s)",
                safe_jid, seed, request.width, request.height,
                request.num_frames, offload,
            )
            exit_code, tail = await asyncio.to_thread(_run_subprocess, argv, log_path)

        elapsed = time.time() - started_at
        if exit_code == 0 and out_path.is_file():
            size = out_path.stat().st_size
            logger.info(
                "[ltx2] job %s completed in %.1fs (size=%d B)",
                safe_jid, elapsed, size,
            )
            _store(safe_jid, {
                "status": "completed",
                "video_path": str(out_path),
                "log_path": str(log_path),
                "elapsed_sec": round(elapsed, 2),
                "size_bytes": size,
            })
            if request.callback_url:
                await _post_callback(request.callback_url, {
                    "job_id": safe_jid,
                    "status": "completed",
                    "video_path": str(out_path),
                })
        else:
            logger.error(
                "[ltx2] job %s FAILED (exit=%d, elapsed=%.1fs); tail: %s",
                safe_jid, exit_code, elapsed, tail[-500:],
            )
            # Per CodeQL py/stack-trace-exposure, we redact the tail from
            # the public error field and only surface a generic message;
            # the full log path is included so operators can inspect.
            _store(safe_jid, {
                "status": "failed",
                "error": "ltx2 generation failed; see worker logs",
                "log_path": str(log_path),
                "exit_code": exit_code,
                "elapsed_sec": round(elapsed, 2),
            })
            if request.callback_url:
                await _post_callback(request.callback_url, {
                    "job_id": safe_jid,
                    "status": "failed",
                    "error": "ltx2 generation failed; see worker logs",
                })
    except ValueError as exc:
        # Validation errors caught here only happen if env-default offload
        # mode is misconfigured; user-supplied values are validated at the
        # /generate boundary.
        logger.error("[ltx2] job %s rejected: %s", safe_jid, exc)
        _store(safe_jid, {"status": "failed", "error": str(exc)})
    except Exception:
        logger.exception("[ltx2] job %s crashed", safe_jid)
        _store(safe_jid, {"status": "failed", "error": "internal error; see worker logs"})


async def _post_callback(url: str, payload: dict) -> None:
    try:
        safe_url = validate_callback_url(url)
    except ValueError as exc:
        logger.warning("[ltx2] rejected callback URL: %s", exc)
        return
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            await client.post(safe_url, json=payload)
    except Exception as exc:
        logger.warning("[ltx2] callback POST failed: %s", exc)


# ── Routes ─────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "sidecar": "ltx2",
        "ready": _is_environment_ready(),
        "environment": _env_probe,
        "src_root": str(LTX2_SRC_ROOT),
        "output_root": str(LTX2_OUTPUT_ROOT),
        "default_offload": LTX2_OFFLOAD_MODE,
    }


@app.get("/gpu-info")
async def gpu_info():
    """Best-effort GPU info via ``nvidia-smi``.

    We don't import torch here — the sidecar's own venv stays tiny so the
    health surface is always responsive even when the heavy upstream venv
    isn't sourced. ``nvidia-smi`` is enough for a free-VRAM hint.
    """
    smi = shutil.which("nvidia-smi")
    if not smi:
        return {"cuda_available": False, "reason": "nvidia-smi not on PATH"}
    try:
        proc = subprocess.run(  # noqa: S603 — fixed argv, no shell
            [smi, "--query-gpu=index,name,memory.total,memory.free",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5.0, check=False,
        )
        if proc.returncode != 0:
            return {"cuda_available": False, "reason": "nvidia-smi non-zero exit"}
        gpus = []
        for line in proc.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 4:
                try:
                    gpus.append({
                        "index": int(parts[0]),
                        "name": parts[1],
                        "total_mb": int(parts[2]),
                        "free_mb": int(parts[3]),
                    })
                except ValueError:
                    continue
        return {"cuda_available": bool(gpus), "device_count": len(gpus), "gpus": gpus}
    except (subprocess.TimeoutExpired, OSError) as exc:
        return {"cuda_available": False, "error": f"nvidia-smi failed: {exc}"}


@app.post("/unload", dependencies=[Depends(verify_token)])
async def unload():
    """No-op: subprocess mode releases all RAM/VRAM at job exit."""
    return {"status": "unloaded", "note": "ltx2 runs per-job subprocess; no resident state"}


@app.post("/generate", status_code=202, dependencies=[Depends(verify_token)])
async def generate(request: GenerateRequest):
    """Accept a generation job. Returns 202 with a job_id.

    503 fast-fails when the venv or model artefacts are missing — the
    orchestrator can then persist ``status: "failed"`` immediately rather
    than waiting on a doomed subprocess.
    """
    if not _is_environment_ready():
        raise HTTPException(
            status_code=503,
            detail=(
                "ltx2 sidecar environment not ready. Run sidecars/ltx2/setup.sh "
                f"to provision the upstream venv and models. Probe: {_env_probe}"
            ),
        )
    try:
        safe_job_id(request.job_id)
        # Bounds checks that Pydantic can't easily express together.
        if request.height > LTX2_MAX_DIM or request.width > LTX2_MAX_DIM:
            raise ValueError(f"height/width must be ≤ {LTX2_MAX_DIM}")
        if request.num_frames > LTX2_MAX_FRAMES:
            raise ValueError(f"num_frames must be ≤ {LTX2_MAX_FRAMES}")
        if request.offload_mode is not None:
            safe_offload_mode(request.offload_mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    asyncio.create_task(_run_job(request))
    logger.info(
        "[ltx2] accepted job %s (frames=%d, %dx%d)",
        request.job_id, request.num_frames, request.width, request.height,
    )
    return {"status": "accepted", "job_id": request.job_id}


@app.get("/status/{job_id}")
async def status(job_id: str):
    try:
        safe_jid = safe_job_id(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    with _results_lock:
        result = _results.get(safe_jid)
    if result is None:
        return {"status": "pending", "job_id": safe_jid}
    return {"job_id": safe_jid, **result}


# ── Entrypoint ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="OpenZigs LTX-2 sidecar")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5013")))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    logger.info("[ltx2] starting uvicorn on %s:%d", args.host, args.port)
    # Pass app as instance (not import string) — matches the lifespan-managed
    # pattern used by the v2a sidecar after PR #940's uvicorn fix.
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


# Suppress unused-id warning — uuid is referenced lazily by callers that
# may extend this module to mint server-side job ids if the request omits one.
_ = uuid
