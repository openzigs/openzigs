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
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from functools import wraps
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("acestep-sidecar")

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


def generate_music(
    prompt: str,
    duration_seconds: int = 30,
    lyrics: Optional[str] = None,
    instrumental: bool = False,
    model: str = DEFAULT_MODEL,
    lm_model: str = DEFAULT_LM,
    seed: Optional[int] = None,
) -> tuple[bytes, str]:
    """
    Run ACE-Step CLI to generate music.

    Returns:
        Tuple of (audio_bytes, mime_type).
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = os.path.join(tmpdir, "output.wav")

        # Build the caption/prompt text
        caption = prompt
        if lyrics and not instrumental:
            caption = f"{prompt}\n\n[Lyrics]\n{lyrics}"

        cmd = [
            "uv", "run", "python", "-m", "acestep.cli",
            "generate",
            "--caption", caption,
            "--duration", str(min(duration_seconds, 300)),
            "--model", model,
            "--lm-model", lm_model,
            "--device", DEFAULT_DEVICE,
            "--backend", DEFAULT_BACKEND,
            "--output", output_path,
        ]

        if instrumental:
            cmd.append("--instrumental")

        if seed is not None:
            cmd.extend(["--seed", str(seed)])

        logger.info(
            f"Running ACE-Step: model={model}, duration={duration_seconds}s, "
            f"instrumental={instrumental}"
        )

        result = subprocess.run(
            cmd,
            cwd=ACESTEP_DIR,
            capture_output=True,
            text=True,
            timeout=600,  # 10 min max
        )

        if result.returncode != 0:
            logger.error(f"ACE-Step failed: {result.stderr}")
            raise RuntimeError(
                f"ACE-Step generation failed: {result.stderr[:500]}"
            )

        # Read the generated audio file
        if not os.path.exists(output_path):
            # Check if output went to a different path
            wav_files = list(Path(tmpdir).glob("*.wav"))
            if wav_files:
                output_path = str(wav_files[0])
            else:
                raise RuntimeError("No output audio file generated")

        with open(output_path, "rb") as f:
            audio_bytes = f.read()

        logger.info(
            f"Generated {len(audio_bytes)} bytes of audio"
        )

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
            parsed = urlparse(callback_url)
            if parsed.scheme not in ("http", "https"):
                logger.warning(
                    f"Invalid callback scheme: {parsed.scheme}"
                )
                return

            data = json.dumps(result).encode("utf-8")
            req = Request(
                callback_url,
                data=data,
                headers={"Content-Type": "application/json"},
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
            worker_state["loaded_model"] = None
            self._send_json(200, {
                "ok": True,
                "previous_model": worker_state["loaded_model"],
            })
        else:
            self._send_json(404, {"error": "Not found"})

    def _handle_generate_async(self):
        if worker_state["is_busy"]:
            self._send_json(503, {
                "error": "Worker busy",
                "current_job_id": worker_state["current_job_id"],
            })
            return

        body = self._read_body()
        prompt = body.get("prompt", "")
        if not prompt:
            self._send_json(400, {"error": "prompt is required"})
            return

        job_id = body.get("job_id", str(uuid.uuid4()))
        callback_url = body.get("callback_url")
        duration = min(int(body.get("duration_seconds", 30)), 300)
        lyrics = body.get("lyrics")
        instrumental = bool(body.get("instrumental", False))
        model = body.get("model", DEFAULT_MODEL)
        seed = body.get("seed")

        thread = threading.Thread(
            target=run_async_job,
            args=(
                job_id, prompt, callback_url, duration,
                lyrics, instrumental, model, seed,
            ),
            daemon=True,
        )
        thread.start()

        self._send_json(202, {
            "job_id": job_id,
            "status": "accepted",
            "estimated_seconds": max(duration * 1.5, 30),
        })

    def _handle_generate_sync(self):
        if worker_state["is_busy"]:
            self._send_json(503, {"error": "Worker busy"})
            return

        body = self._read_body()
        prompt = body.get("prompt", "")
        if not prompt:
            self._send_json(400, {"error": "prompt is required"})
            return

        worker_state["is_busy"] = True
        try:
            audio_bytes, mime_type = generate_music(
                prompt=prompt,
                duration_seconds=min(
                    int(body.get("duration_seconds", 30)), 300
                ),
                lyrics=body.get("lyrics"),
                instrumental=bool(body.get("instrumental", False)),
                model=body.get("model", DEFAULT_MODEL),
                seed=body.get("seed"),
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
