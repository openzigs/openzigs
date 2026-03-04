"""
Music Studio Worker Sidecar — FastAPI
Issue #388: Orchestrates the 3-stage voice2voice pipeline:
  1. Stem separation (Demucs v4)      → extract_vocals.py
  2. Voice conversion (RVC v2)         → apply_rvc.py
  3. Final mixdown (pydub)             → mix_audio.py

HTTP API:
  POST /generate       — Submit a voice2voice job (returns 202)
  GET  /health         — Health check + busy status
  GET  /status/{job_id} — Poll job status and progress

Port: 5010 (default)
"""

import asyncio
import base64
import json
import logging
import os
import tempfile
import time
import traceback
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("music-studio-sidecar")

# ── Configuration ────────────────────────────────────────────

GALLERY_DIR = os.environ.get(
    "GALLERY_DIR",
    os.path.expanduser("~/.openzigs/gallery"),
)

RVC_MODELS_DIR = os.environ.get(
    "RVC_MODELS_DIR",
    os.path.expanduser("~/.openzigs/rvc-models"),
)

AUTH_TOKEN: Optional[str] = os.environ.get("MUSIC_STUDIO_AUTH_TOKEN")

DEVICE = os.environ.get("MUSIC_STUDIO_DEVICE", "cpu")

# ── State ────────────────────────────────────────────────────

app = FastAPI(title="Music Studio Sidecar", version="1.0.0")

worker_state = {
    "is_busy": False,
    "current_job_id": None,
    "loaded_model": None,
}

# Job progress tracking: job_id → { stage, progress, message, status, result }
job_progress: dict[str, dict] = {}
MAX_STORED_JOBS = 50


def cleanup_old_jobs():
    """Remove oldest finished jobs if we exceed the limit."""
    finished = [
        (jid, info) for jid, info in job_progress.items()
        if info.get("status") in ("complete", "failed")
    ]
    finished.sort(key=lambda x: x[1].get("completed_at", 0))
    while len(finished) > MAX_STORED_JOBS:
        oldest_id = finished.pop(0)[0]
        job_progress.pop(oldest_id, None)


# ── Request Models ───────────────────────────────────────────

class GenerateRequest(BaseModel):
    job_id: str
    source_asset_id: Optional[str] = None
    source_path: Optional[str] = None
    voice_model: str = "default"
    pitch_shift: int = 0
    index_rate: float = Field(default=0.75, ge=0.0, le=1.0)
    filter_radius: int = Field(default=3, ge=0, le=7)
    vocal_volume: float = Field(default=1.0, ge=0.0, le=5.0)
    instrumental_volume: float = Field(default=1.0, ge=0.0, le=5.0)
    output_format: str = "wav"
    callback_url: Optional[str] = None
    progress_url: Optional[str] = None


# ── Pipeline ─────────────────────────────────────────────────

def report_progress(
    job_id: str,
    stage: str,
    progress: float,
    message: str,
    progress_url: Optional[str] = None,
):
    """Update local progress state and POST to the progress webhook."""
    job_progress[job_id] = {
        **job_progress.get(job_id, {}),
        "stage": stage,
        "progress": progress,
        "message": message,
        "status": "processing",
    }

    if progress_url:
        try:
            data = json.dumps({
                "job_id": job_id,
                "stage": stage,
                "progress": progress,
                "message": message,
            }).encode()
            req = Request(
                progress_url,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urlopen(req, timeout=5)
        except (URLError, OSError) as e:
            logger.debug(f"Progress webhook failed: {e}")


def resolve_source_path(source_asset_id: Optional[str], source_path: Optional[str]) -> str:
    """Resolve the source audio file path from asset ID or direct path."""
    if source_path:
        p = Path(source_path)
        if not p.exists():
            raise FileNotFoundError(f"Source file not found: {source_path}")
        return str(p)

    if source_asset_id:
        # Look for the asset in the gallery directory
        gallery = Path(GALLERY_DIR)
        # Asset files are named with their job_id
        for ext in [".wav", ".mp3", ".flac", ".m4a", ".ogg", ".mp4"]:
            candidate = gallery / f"{source_asset_id}{ext}"
            if candidate.exists():
                return str(candidate)
        # Also try matching files that contain the asset ID
        for f in gallery.iterdir():
            if source_asset_id in f.stem and f.suffix in (".wav", ".mp3", ".flac", ".m4a"):
                return str(f)
        raise FileNotFoundError(
            f"No audio file found for asset {source_asset_id} in {gallery}"
        )

    raise ValueError("Either source_asset_id or source_path is required")


def run_pipeline(req: GenerateRequest):
    """Execute the 3-stage voice2voice pipeline synchronously."""
    from extract_vocals import extract_vocals
    from apply_rvc import apply_rvc
    from mix_audio import mix_audio

    job_id = req.job_id
    progress_url = req.progress_url

    with tempfile.TemporaryDirectory(prefix=f"v2v-{job_id}-") as tmpdir:
        # ── Stage 1: Stem Separation ──
        report_progress(job_id, "stem_separation", 0, "Starting stem separation...", progress_url)

        source_path = resolve_source_path(req.source_asset_id, req.source_path)
        stems_dir = os.path.join(tmpdir, "stems")

        stems = extract_vocals(
            input_path=source_path,
            output_dir=stems_dir,
            device=DEVICE,
        )

        report_progress(job_id, "stem_separation", 100, "Stem separation complete", progress_url)

        # ── Stage 2: Voice Conversion ──
        report_progress(job_id, "voice_conversion", 0, "Starting voice conversion...", progress_url)

        converted_path = os.path.join(tmpdir, "converted_vocals.wav")
        apply_rvc(
            input_path=stems["vocals"],
            output_path=converted_path,
            voice_model=req.voice_model,
            pitch_shift=req.pitch_shift,
            index_rate=req.index_rate,
            filter_radius=req.filter_radius,
            device=DEVICE,
        )

        report_progress(job_id, "voice_conversion", 100, "Voice conversion complete", progress_url)

        # ── Stage 3: Final Mixdown ──
        report_progress(job_id, "mixdown", 0, "Starting mixdown...", progress_url)

        output_ext = "mp3" if req.output_format == "mp3" else "wav"
        output_path = os.path.join(tmpdir, f"final_mix.{output_ext}")

        mix_audio(
            vocals_path=converted_path,
            instrumental_path=stems["no_vocals"],
            output_path=output_path,
            vocal_volume=req.vocal_volume,
            instrumental_volume=req.instrumental_volume,
            output_format=req.output_format,
        )

        report_progress(job_id, "mixdown", 100, "Mixdown complete", progress_url)

        # Read the final output for callback
        with open(output_path, "rb") as f:
            media_bytes = f.read()

        media_base64 = base64.b64encode(media_bytes).decode("ascii")
        media_type = "audio/mpeg" if output_ext == "mp3" else "audio/wav"

        return {
            "media_base64": media_base64,
            "media_type": media_type,
            "metadata": {
                "voice_model": req.voice_model,
                "pitch_shift": req.pitch_shift,
                "output_format": req.output_format,
                "duration": len(media_bytes),
            },
        }


async def process_job(req: GenerateRequest):
    """Run the pipeline in a background thread and POST results via callback."""
    job_id = req.job_id

    try:
        worker_state["is_busy"] = True
        worker_state["current_job_id"] = job_id
        worker_state["loaded_model"] = req.voice_model

        job_progress[job_id] = {
            "stage": "queued",
            "progress": 0,
            "message": "Job accepted",
            "status": "processing",
            "started_at": time.time(),
        }

        # Run pipeline in thread pool to avoid blocking the event loop
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, run_pipeline, req)

        job_progress[job_id] = {
            **job_progress[job_id],
            "stage": "complete",
            "progress": 100,
            "message": "Pipeline complete",
            "status": "complete",
            "completed_at": time.time(),
        }

        # POST result to callback
        if req.callback_url:
            try:
                data = json.dumps({
                    "job_id": job_id,
                    "status": "complete",
                    "media_base64": result["media_base64"],
                    "media_type": result["media_type"],
                    "metadata": result["metadata"],
                }).encode()
                cb_req = Request(
                    req.callback_url,
                    data=data,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                urlopen(cb_req, timeout=30)
                logger.info(f"Callback sent for job {job_id}")
            except (URLError, OSError) as e:
                logger.error(f"Callback failed for job {job_id}: {e}")

    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        logger.error(f"Pipeline failed for job {job_id}: {error_msg}")
        logger.error(traceback.format_exc())

        job_progress[job_id] = {
            **job_progress.get(job_id, {}),
            "stage": "failed",
            "progress": 0,
            "message": error_msg,
            "status": "failed",
            "completed_at": time.time(),
        }

        # POST failure to callback
        if req.callback_url:
            try:
                data = json.dumps({
                    "job_id": job_id,
                    "status": "failed",
                    "error": error_msg,
                }).encode()
                cb_req = Request(
                    req.callback_url,
                    data=data,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                urlopen(cb_req, timeout=10)
            except (URLError, OSError):
                pass

    finally:
        worker_state["is_busy"] = False
        worker_state["current_job_id"] = None
        cleanup_old_jobs()


# ── Endpoints ────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Health check — also returns busy status for queue master polling."""
    return {
        "status": "ok",
        "is_busy": worker_state["is_busy"],
        "loaded_model": worker_state["loaded_model"],
        "current_job_id": worker_state["current_job_id"],
        "device": DEVICE,
    }


@app.post("/generate", status_code=202)
async def generate(req: GenerateRequest):
    """
    Submit a voice2voice pipeline job.
    Returns 202 immediately; results are POSTed to callback_url.
    """
    if worker_state["is_busy"]:
        raise HTTPException(
            status_code=409,
            detail=f"Worker busy with job {worker_state['current_job_id']}",
        )

    # Validate source exists before accepting
    try:
        resolve_source_path(req.source_asset_id, req.source_path)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Fire and forget — job runs in background
    asyncio.create_task(process_job(req))

    return {
        "job_id": req.job_id,
        "status": "accepted",
        "message": "Voice2voice pipeline started",
    }


@app.get("/status/{job_id}")
async def job_status(job_id: str):
    """Get the current progress of a job."""
    if job_id not in job_progress:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    return {
        "job_id": job_id,
        **job_progress[job_id],
    }


@app.get("/models")
async def list_models():
    """List available RVC voice models."""
    models_dir = Path(RVC_MODELS_DIR)
    if not models_dir.exists():
        return {"models": []}

    models = []
    for d in models_dir.iterdir():
        if d.is_dir():
            pth_files = list(d.glob("*.pth"))
            if pth_files:
                models.append({
                    "name": d.name,
                    "path": str(d),
                    "has_index": any(d.glob("*.index")),
                })

    return {"models": models}


# ── Main ─────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Music Studio Sidecar")
    parser.add_argument("--port", type=int, default=5010, help="Port (default: 5010)")
    parser.add_argument("--host", default="0.0.0.0", help="Host (default: 0.0.0.0)")
    args = parser.parse_args()

    logger.info(f"Starting Music Studio sidecar on {args.host}:{args.port}")
    logger.info(f"Gallery dir: {GALLERY_DIR}")
    logger.info(f"RVC models dir: {RVC_MODELS_DIR}")
    logger.info(f"Device: {DEVICE}")

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
