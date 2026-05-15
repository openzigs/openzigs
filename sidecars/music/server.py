"""
ACE-Step 1.5 Music Generation Sidecar
Issue #337: Local AI music generation via ACE-Step Apple Silicon fork.

HTTP API compatible with the OpenZigs queue system.
Endpoints:
  POST /generate   — Submit a music generation job (returns 202)
  POST /generate-sync — Synchronous generation (returns audio)
  GET  /health     — Health check
  GET  /status     — Worker status
  GET  /job-result/<job_id> — Poll for completed job result
"""

import argparse
import base64
import gc
import json
import logging
import os
import sys
import tempfile
import threading
import time
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Optional
from urllib.request import Request, urlopen
from urllib.error import URLError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("acestep-sidecar")


# ── Security Utilities ───────────────────────────────────────

_SHARED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared")
if _SHARED_DIR not in sys.path:
    sys.path.insert(0, _SHARED_DIR)
from callback_validator import (  # type: ignore[import-not-found]  # noqa: E402
    is_safe_callback_url as _is_safe_callback_url,
)

# ── State ────────────────────────────────────────────────────

worker_state = {
    "is_busy": False,
    "loaded_model": None,
    "current_job_id": None,
}

# Store completed results for polling (job_id → result dict)
completed_results: dict = {}
MAX_STORED_RESULTS = 50


def cleanup_old_results():
    """Remove oldest results if we exceed the limit."""
    while len(completed_results) > MAX_STORED_RESULTS:
        oldest = next(iter(completed_results))
        del completed_results[oldest]


# ── Auth ─────────────────────────────────────────────────────

AUTH_TOKEN: Optional[str] = os.environ.get("MUSIC_GEN_AUTH_TOKEN")


def check_auth(headers: dict) -> bool:
    """Validate Bearer token if AUTH_TOKEN is configured."""
    if not AUTH_TOKEN:
        return True
    auth = headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False
    return auth[7:] == AUTH_TOKEN


# ── ACE-Step Generation ─────────────────────────────────────

ACESTEP_DIR = os.environ.get(
    "ACESTEP_DIR",
    os.path.expanduser("~/ace-step-apple-silicon"),
)

DEFAULT_MODEL = os.environ.get("ACESTEP_MODEL", "acestep-v15-turbo")
DEFAULT_LM = os.environ.get("ACESTEP_LM", "acestep-5Hz-lm-0.6B")
DEFAULT_BACKEND = os.environ.get("ACESTEP_BACKEND", "pt")
DEFAULT_DEVICE = os.environ.get("ACESTEP_DEVICE", "auto")

# Enable cuDNN autotuner for faster convolutions on CUDA
try:
    import torch as _torch_init
    if _torch_init.cuda.is_available():
        _torch_init.backends.cudnn.benchmark = True
except ImportError:
    pass

# Ensure the cloned ACE-Step repo is first on sys.path so that imports of
# `acestep` use the source files where _get_project_root() resolves
# correctly to ACESTEP_DIR (and finds checkpoints/ there).
if os.path.isdir(ACESTEP_DIR) and ACESTEP_DIR not in sys.path:
    sys.path.insert(0, ACESTEP_DIR)

# ── Lazy Model Init ──────────────────────────────────────────

_dit_handler = None
_llm_handler = None
_model_init_error: Optional[str] = None
_model_init_lock = threading.Lock()


def _ensure_model_loaded() -> None:
    """Initialize ACE-Step DiT model on first generation request."""
    global _dit_handler, _llm_handler, _model_init_error

    if _dit_handler is not None:
        return

    with _model_init_lock:
        if _dit_handler is not None:
            return
        if _model_init_error:
            raise RuntimeError(
                f"ACE-Step model init failed previously: {_model_init_error}"
            )

        try:
            from acestep.handler import AceStepHandler  # noqa: PLC0415
            from acestep.llm_inference import LLMHandler  # noqa: PLC0415

            handler = AceStepHandler()
            llm = LLMHandler()

            logger.info(
                f"Initializing ACE-Step model '{DEFAULT_MODEL}' on '{DEFAULT_DEVICE}'..."
                " (first request — may take a while to download weights)"
            )
            status_msg, ok = handler.initialize_service(
                project_root=ACESTEP_DIR,
                config_path=DEFAULT_MODEL,
                device=DEFAULT_DEVICE,
                use_flash_attention=True,
                compile_model=True,
                offload_to_cpu=False,
            )
            if not ok:
                raise RuntimeError(f"initialize_service failed: {status_msg}")

            _dit_handler = handler
            # LLMHandler is intentionally left un-initialized to skip LLM
            # chain-of-thought overhead. generate_music() guards on
            # llm_handler.llm_initialized, so no LLM calls will be made.
            _llm_handler = llm
            worker_state["loaded_model"] = DEFAULT_MODEL
            logger.info("ACE-Step model ready")

        except Exception as exc:
            _model_init_error = str(exc)
            logger.error(f"ACE-Step model init error: {exc}")
            raise


def generate_music(
    prompt: str,
    duration_seconds: int = 30,
    lyrics: Optional[str] = None,
    instrumental: bool = False,
    model: str = DEFAULT_MODEL,
    lm_model: str = DEFAULT_LM,
    seed: Optional[int] = None,
    steps: int = 20,
) -> tuple[bytes, str]:
    """
    Generate music using the ACE-Step Python API.

    Returns:
        Tuple of (audio_bytes, mime_type).
    """
    _ensure_model_loaded()

    from acestep.inference import (  # noqa: PLC0415
        GenerationParams,
        GenerationConfig,
        generate_music as _acegen,
    )

    # Build the lyrics field for the params
    if instrumental:
        lyrics_field = "[Instrumental]"
    elif lyrics:
        lyrics_field = lyrics
    else:
        lyrics_field = ""

    params = GenerationParams(
        caption=prompt,
        lyrics=lyrics_field,
        instrumental=instrumental,
        duration=float(min(duration_seconds, 300)),
        inference_steps=steps,
        seed=seed if seed is not None else -1,
        task_type="text2music",
        # Disable LLM chain-of-thought — llm_handler is not initialized,
        # so these flags are effectively no-ops, but setting them to False
        # is explicit about our intent.
        thinking=False,
        use_cot_metas=False,
        use_cot_caption=False,
    )

    config = GenerationConfig(
        batch_size=1,
        use_random_seed=(seed is None),
        audio_format="wav",
    )

    logger.info(
        f"Generating: model={DEFAULT_MODEL}, duration={duration_seconds}s, "
        f"instrumental={instrumental}, steps={steps}"
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        result = _acegen(
            dit_handler=_dit_handler,
            llm_handler=_llm_handler,
            params=params,
            config=config,
            save_dir=tmpdir,
        )

        if not result.success:
            raise RuntimeError(
                f"ACE-Step generation failed: {result.error or result.status_message}"
            )

        audio_paths = [a["path"] for a in result.audios if a.get("path")]
        if not audio_paths:
            raise RuntimeError("No audio generated — result.audios was empty")

        with open(audio_paths[0], "rb") as fh:
            audio_bytes = fh.read()

    logger.info(f"Generated {len(audio_bytes)} bytes of audio")
    return audio_bytes, "audio/wav"


def run_async_job(
    job_id: str,
    prompt: str,
    callback_url: Optional[str],
    duration_seconds: int = 30,
    lyrics: Optional[str] = None,
    instrumental: bool = False,
    model: str = DEFAULT_MODEL,
    seed: Optional[int] = None,
    steps: int = 20,
):
    """Run generation in a background thread and POST result to callback."""
    worker_state["is_busy"] = True
    worker_state["current_job_id"] = job_id
    worker_state["loaded_model"] = model

    try:
        audio_bytes, mime_type = generate_music(
            prompt=prompt,
            duration_seconds=duration_seconds,
            lyrics=lyrics,
            instrumental=instrumental,
            model=model,
            seed=seed,
            steps=steps,
        )

        audio_b64 = base64.b64encode(audio_bytes).decode("ascii")

        result = {
            "job_id": job_id,
            "status": "complete",
            "media_base64": audio_b64,
            "media_type": mime_type,
            "metadata": {
                "model": model,
                "duration_seconds": duration_seconds,
                "instrumental": instrumental,
                "steps": steps,
            },
        }

    except Exception as exc:
        logger.exception(f"Job {job_id} failed")
        result = {
            "job_id": job_id,
            "status": "failed",
            "error": str(exc),
        }

    finally:
        worker_state["is_busy"] = False
        worker_state["current_job_id"] = None

        # Clean up GPU memory
        try:
            import torch
            if hasattr(torch, "mps") and torch.backends.mps.is_available():
                torch.mps.empty_cache()
                torch.mps.synchronize()
        except ImportError:
            pass
        gc.collect()

    # Store result for polling
    completed_results[job_id] = result
    cleanup_old_results()

    # POST callback if URL provided
    if callback_url:
        try:
            if not _is_safe_callback_url(callback_url):
                logger.warning(
                    f"Refusing callback for job {job_id} — host not on SSRF "
                    f"allowlist (local/LAN or trusted callback host only): {callback_url}"
                )
                return

            data = json.dumps(result).encode("utf-8")
            # Issue #1089 — sign callback with HMAC + timestamp.
            from signed_callback import signed_headers as _sh  # type: ignore[import-not-found]
            _cb_secret = os.getenv("CALLBACK_SECRET") or None
            headers = _sh(_cb_secret, data, "music-gen", legacy_bearer=True)
            req = Request(
                callback_url,
                data=data,
                headers=headers,
                method="POST",
            )
            with urlopen(req, timeout=10) as resp:
                logger.info(
                    f"Callback POST {callback_url} → {resp.status}"
                )
        except (URLError, OSError) as exc:
            logger.warning(
                f"Callback failed for job {job_id}: {exc}"
            )


# ── HTTP Handler ─────────────────────────────────────────────

class MusicGenHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the ACE-Step sidecar."""

    def log_message(self, fmt, *args):
        """Route access logs through our logger."""
        logger.info(fmt % args)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw)

    def _send_json(self, status: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not check_auth(dict(self.headers)):
            self._send_json(401, {"error": "Unauthorized"})
            return

        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "model": worker_state["loaded_model"] or DEFAULT_MODEL,
                "device": DEFAULT_DEVICE,
                "backend": DEFAULT_BACKEND,
            })

        elif self.path == "/status":
            self._send_json(200, {
                "is_busy": worker_state["is_busy"],
                "loaded_model": worker_state["loaded_model"],
                "current_job_id": worker_state["current_job_id"],
            })

        elif self.path.startswith("/job-result/"):
            job_id = self.path.split("/job-result/", 1)[1]
            if job_id in completed_results:
                result = completed_results.pop(job_id)
                self._send_json(200, result)
            else:
                self._send_json(404, {"error": "Not found"})

        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if not check_auth(dict(self.headers)):
            self._send_json(401, {"error": "Unauthorized"})
            return

        if self.path == "/generate":
            self._handle_generate_async()
        elif self.path == "/generate-sync":
            self._handle_generate_sync()
        elif self.path == "/unload":
            # Free GPU memory
            try:
                import torch
                if hasattr(torch, "mps") and torch.backends.mps.is_available():
                    torch.mps.empty_cache()
                    torch.mps.synchronize()
            except ImportError:
                pass
            gc.collect()
            previous_model = worker_state["loaded_model"]
            worker_state["loaded_model"] = None
            self._send_json(200, {
                "ok": True,
                "previous_model": previous_model,
            })
        else:
            self._send_json(404, {"error": "Not found"})

    def _parse_generation_params(self, body: dict) -> dict:
        """Extract and validate generation parameters from a request body."""
        return {
            "prompt": body.get("prompt", ""),
            "duration_seconds": min(int(body.get("duration_seconds", 30)), 300),
            "lyrics": body.get("lyrics"),
            "instrumental": bool(body.get("instrumental", False)),
            "model": body.get("model", DEFAULT_MODEL),
            "seed": body.get("seed"),
            "steps": min(max(int(body.get("steps", 20)), 8), 27),
        }

    def _handle_generate_async(self):
        if worker_state["is_busy"]:
            self._send_json(503, {
                "error": "Worker busy",
                "current_job_id": worker_state["current_job_id"],
            })
            return

        body = self._read_body()
        params = self._parse_generation_params(body)
        if not params["prompt"]:
            self._send_json(400, {"error": "prompt is required"})
            return

        job_id = body.get("job_id", str(uuid.uuid4()))
        callback_url = body.get("callback_url")

        thread = threading.Thread(
            target=run_async_job,
            args=(
                job_id, params["prompt"], callback_url,
                params["duration_seconds"], params["lyrics"],
                params["instrumental"], params["model"],
                params["seed"], params["steps"],
            ),
            daemon=True,
        )
        thread.start()

        self._send_json(202, {
            "job_id": job_id,
            "status": "accepted",
            "estimated_seconds": max(params["duration_seconds"] * 1.5, 30),
        })

    def _handle_generate_sync(self):
        if worker_state["is_busy"]:
            self._send_json(503, {"error": "Worker busy"})
            return

        body = self._read_body()
        params = self._parse_generation_params(body)
        if not params["prompt"]:
            self._send_json(400, {"error": "prompt is required"})
            return

        worker_state["is_busy"] = True
        try:
            audio_bytes, mime_type = generate_music(
                prompt=params["prompt"],
                duration_seconds=params["duration_seconds"],
                lyrics=params["lyrics"],
                instrumental=params["instrumental"],
                model=params["model"],
                seed=params["seed"],
                steps=params["steps"],
            )

            audio_b64 = base64.b64encode(audio_bytes).decode("ascii")
            self._send_json(200, {
                "status": "complete",
                "media_base64": audio_b64,
                "media_type": mime_type,
            })
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})
        finally:
            worker_state["is_busy"] = False


# ── Main ─────────────────────────────────────────────────────

def main():
    """Start the ACE-Step music generation sidecar."""
    parser = argparse.ArgumentParser(
        description="ACE-Step 1.5 Music Generation Sidecar"
    )
    parser.add_argument(
        "--port", type=int, default=5009,
        help="Port to listen on (default: 5009)",
    )
    parser.add_argument(
        "--host", type=str, default="0.0.0.0",
        help="Host to bind to (default: 0.0.0.0)",
    )
    args = parser.parse_args()

    # Validate ACE-Step installation
    if not os.path.isdir(ACESTEP_DIR):
        logger.warning(
            f"ACE-Step directory not found: {ACESTEP_DIR}. "
            "Set ACESTEP_DIR env var to the correct path."
        )

    server = HTTPServer((args.host, args.port), MusicGenHandler)
    logger.info(
        f"ACE-Step sidecar listening on {args.host}:{args.port}"
    )
    logger.info(f"  ACESTEP_DIR={ACESTEP_DIR}")
    logger.info(f"  Model={DEFAULT_MODEL}, Backend={DEFAULT_BACKEND}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
