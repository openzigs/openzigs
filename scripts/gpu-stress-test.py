#!/usr/bin/env python3
"""
GPU stress-test harness for OpenZigs CUDA sidecars.
Issue #887 (Epic #883 — Multi-GPU Awareness).

Spawns concurrent jobs across image-gen, video, audio, and lipsync sidecars
while polling nvidia-smi for per-GPU utilisation. Emits a markdown report
under ~/.openzigs/stress-tests/ containing per-sidecar wall times, peak VRAM
per GPU, OOM count, and a throughput vs. serial-baseline comparison.

Scenarios:
  smoke   – 2 image-gens + 1 TTS (fast sanity check, no video)
  full    – 5 image-gens + 1 video gen + 1 TTS + 1 lipsync
  oom     – Same as full but with oversized payloads to force OOM probing

Usage:
    python scripts/gpu-stress-test.py --scenario smoke
    python scripts/gpu-stress-test.py --scenario full --base-url http://localhost:3000
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request


# ── Sidecar endpoints ─────────────────────────────────────────
SIDECARS = {
    "image-gen": ("http://localhost:5005", "/health"),
    "audio": ("http://localhost:5006", "/health"),
    "worker": ("http://localhost:5007", "/health"),
    "lipsync": ("http://localhost:5010", "/health"),
}


@dataclass
class JobResult:
    sidecar: str
    job_id: str
    started_at: float
    finished_at: float = 0.0
    success: bool = False
    error: str = ""
    http_status: int = 0

    @property
    def duration_sec(self) -> float:
        return max(0.0, self.finished_at - self.started_at)


@dataclass
class GpuSample:
    timestamp: float
    gpu_index: int
    memory_used_mb: int
    utilization_pct: int


@dataclass
class StressReport:
    scenario: str
    started_at: str
    finished_at: str = ""
    wall_time_sec: float = 0.0
    jobs: list[JobResult] = field(default_factory=list)
    gpu_samples: list[GpuSample] = field(default_factory=list)
    oom_count: int = 0
    sidecar_health: dict[str, dict] = field(default_factory=dict)

    def peak_per_gpu(self) -> dict[int, dict[str, int]]:
        out: dict[int, dict[str, int]] = {}
        for s in self.gpu_samples:
            cur = out.setdefault(s.gpu_index, {"peak_mb": 0, "peak_util": 0})
            cur["peak_mb"] = max(cur["peak_mb"], s.memory_used_mb)
            cur["peak_util"] = max(cur["peak_util"], s.utilization_pct)
        return out


# ── nvidia-smi polling ────────────────────────────────────────


def poll_nvidia_smi(stop_event: threading.Event, samples: list[GpuSample], interval: float = 2.0) -> None:
    """Poll `nvidia-smi --query-gpu=...` every `interval` seconds until stop_event is set."""
    if not shutil.which("nvidia-smi"):
        print("[poll] nvidia-smi not found — skipping GPU sampling", file=sys.stderr)
        return
    while not stop_event.is_set():
        try:
            out = subprocess.check_output(
                [
                    "nvidia-smi",
                    "--query-gpu=index,memory.used,utilization.gpu",
                    "--format=csv,noheader,nounits",
                ],
                text=True,
                timeout=5,
            )
            ts = time.time()
            for line in out.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 3:
                    try:
                        samples.append(
                            GpuSample(
                                timestamp=ts,
                                gpu_index=int(parts[0]),
                                memory_used_mb=int(parts[1]),
                                utilization_pct=int(parts[2]),
                            )
                        )
                    except ValueError:
                        continue
        except (subprocess.SubprocessError, FileNotFoundError) as exc:
            print(f"[poll] nvidia-smi error: {exc}", file=sys.stderr)
        stop_event.wait(interval)


# ── Sidecar request helpers ───────────────────────────────────


def _http_post(url: str, body: dict, *, token: Optional[str], timeout: int = 600) -> tuple[int, str]:
    data = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib_request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib_request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib_error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else str(e)
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def _http_get(url: str, *, token: Optional[str] = None, timeout: int = 30) -> tuple[int, str]:
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib_request.Request(url, headers=headers, method="GET")
    try:
        with urllib_request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib_error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else str(e)
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def collect_sidecar_health(token: Optional[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for name, (base, health_path) in SIDECARS.items():
        status, body = _http_get(f"{base}{health_path}", token=token, timeout=5)
        gpu_status, gpu_body = _http_get(f"{base}/gpu-info", token=token, timeout=5)
        info: dict[str, Any] = {"http_status": status}
        try:
            info["health"] = json.loads(body)
        except json.JSONDecodeError:
            info["health_raw"] = body[:200]
        if gpu_status == 200:
            try:
                info["gpu"] = json.loads(gpu_body)
            except json.JSONDecodeError:
                info["gpu_raw"] = gpu_body[:200]
        out[name] = info
    return out


# ── Job submitters ────────────────────────────────────────────


def submit_image_gen(
    token: Optional[str],
    oversized: bool = False,
    model: str = "flux-schnell",
    steps: int = 4,
) -> JobResult:
    job_id = uuid.uuid4().hex[:12]
    started = time.time()
    body = {
        "prompt": "a photorealistic blue parrot perched on a wooden branch, studio lighting",
        "width": 1280 if oversized else 1024,
        "height": 1280 if oversized else 576,
        "num_inference_steps": steps,
        "model": model,
    }
    status, response = _http_post(
        "http://localhost:5005/generate",
        body,
        token=token,
        timeout=900,
    )
    return JobResult(
        sidecar=f"image-gen[{model}]",
        job_id=job_id,
        started_at=started,
        finished_at=time.time(),
        success=200 <= status < 300,
        http_status=status,
        error="" if 200 <= status < 300 else response[:200],
    )


def submit_audio(token: Optional[str]) -> JobResult:
    job_id = uuid.uuid4().hex[:12]
    started = time.time()
    body = {
        "text": "Stress test in progress. The quick brown fox jumps over the lazy dog.",
        "voice": "af_bella",
        "format": "wav",
    }
    status, response = _http_post(
        "http://localhost:5006/tts",
        body,
        token=token,
        timeout=120,
    )
    return JobResult(
        sidecar="audio",
        job_id=job_id,
        started_at=started,
        finished_at=time.time(),
        success=200 <= status < 300,
        http_status=status,
        error="" if 200 <= status < 300 else response[:200],
    )


def submit_video(token: Optional[str], oversized: bool = False) -> JobResult:
    job_id = uuid.uuid4().hex[:12]
    started = time.time()
    body = {
        "job_id": job_id,
        "type": "txt2video",
        "prompt": "a calm beach at sunset, gentle waves, cinematic",
        "width": 1024 if oversized else 768,
        "height": 576 if oversized else 512,
        "num_frames": 121 if oversized else 49,
        "fps": 24,
        "model": "ltx-2",
        "num_inference_steps": 7,
        "callback_url": "http://localhost:3000/api/queue/complete",
    }
    status, response = _http_post(
        "http://localhost:5007/generate",
        body,
        token=token,
        timeout=900,
    )
    return JobResult(
        sidecar="worker",
        job_id=job_id,
        started_at=started,
        finished_at=time.time(),
        # 202 Accepted is success for the async worker
        success=200 <= status < 300,
        http_status=status,
        error="" if 200 <= status < 300 else response[:200],
    )


# ── Scenarios ─────────────────────────────────────────────────


def scenario_smoke(token: Optional[str]) -> list[concurrent.futures.Future]:
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
    return [
        pool.submit(submit_image_gen, token),
        pool.submit(submit_image_gen, token),
        pool.submit(submit_audio, token),
    ]


def scenario_full(token: Optional[str]) -> list[concurrent.futures.Future]:
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=8)
    futures: list[concurrent.futures.Future] = []
    for _ in range(5):
        futures.append(pool.submit(submit_image_gen, token))
    futures.append(pool.submit(submit_video, token))
    futures.append(pool.submit(submit_audio, token))
    return futures


def scenario_oom(token: Optional[str]) -> list[concurrent.futures.Future]:
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=8)
    futures: list[concurrent.futures.Future] = []
    for _ in range(5):
        futures.append(pool.submit(submit_image_gen, token, True))
    futures.append(pool.submit(submit_video, token, True))
    return futures


def scenario_pooled(token: Optional[str]) -> list[concurrent.futures.Future]:
    """Exercises IMAGE_GEN_POOLING_MODE=manual-flux.

    Submits one FLUX-schnell baseline (small, fast) + one FLUX-dev request
    (large, the actual pooling target). Run this AFTER setting the env var
    in ~/.openzigs/.env.cuda and restarting sidecars; then check
    GET http://localhost:5005/gpu-info for pooled_active=true.
    """
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
    futures: list[concurrent.futures.Future] = []
    futures.append(pool.submit(submit_image_gen, token, False, "flux-schnell", 4))
    futures.append(pool.submit(submit_image_gen, token, False, "flux-dev", 25))
    return futures


SCENARIO_RUNNERS = {
    "smoke": scenario_smoke,
    "full": scenario_full,
    "oom": scenario_oom,
    "pooled": scenario_pooled,
}


# ── Reporter ──────────────────────────────────────────────────


def render_markdown(report: StressReport) -> str:
    peaks = report.peak_per_gpu()
    lines: list[str] = []
    lines.append(f"# GPU Stress Test — {report.scenario}")
    lines.append("")
    lines.append(f"- **Started:** {report.started_at}")
    lines.append(f"- **Finished:** {report.finished_at}")
    lines.append(f"- **Wall time:** {report.wall_time_sec:.2f} s")
    lines.append(f"- **OOM count:** {report.oom_count}")
    lines.append(f"- **Total jobs:** {len(report.jobs)} ({sum(1 for j in report.jobs if j.success)} ok)")
    lines.append("")
    lines.append("## Per-GPU peak utilisation")
    lines.append("")
    lines.append("| GPU | Peak VRAM (MB) | Peak util (%) |")
    lines.append("| --- | --- | --- |")
    for gpu_idx in sorted(peaks):
        p = peaks[gpu_idx]
        lines.append(f"| {gpu_idx} | {p['peak_mb']} | {p['peak_util']} |")
    lines.append("")
    lines.append("## Sidecar health (post-test)")
    lines.append("")
    for name, info in report.sidecar_health.items():
        gpu = info.get("gpu", {})
        lines.append(
            f"- **{name}** (HTTP {info.get('http_status')}): "
            f"device_index={gpu.get('device_index', 'n/a')}, "
            f"name={gpu.get('device_name', 'n/a')}, "
            f"free_mb={gpu.get('free_mb', 'n/a')}, "
            f"cuda_visible={gpu.get('cuda_visible', '')!r}"
        )
    lines.append("")
    lines.append("## Job results")
    lines.append("")
    lines.append("| Sidecar | Job | HTTP | Duration (s) | OK | Error |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for j in report.jobs:
        lines.append(
            f"| {j.sidecar} | {j.job_id} | {j.http_status} | "
            f"{j.duration_sec:.2f} | {'yes' if j.success else 'no'} | "
            f"{(j.error[:80] + '...') if len(j.error) > 80 else j.error} |"
        )
    return "\n".join(lines) + "\n"


def write_report(report: StressReport) -> Path:
    out_dir = Path(os.path.expanduser("~/.openzigs/stress-tests"))
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d-%H%M%S")
    out_path = out_dir / f"{stamp}-{report.scenario}.md"
    out_path.write_text(render_markdown(report), encoding="utf-8")
    return out_path


# ── Main ──────────────────────────────────────────────────────


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=sorted(SCENARIO_RUNNERS), default="smoke")
    parser.add_argument(
        "--token",
        default=os.environ.get("OPENZIGS_API_TOKEN") or os.environ.get("WORKER_SECRET"),
        help="Bearer token for sidecar auth (defaults to OPENZIGS_API_TOKEN env).",
    )
    parser.add_argument("--poll-interval", type=float, default=2.0)
    args = parser.parse_args(argv)

    runner = SCENARIO_RUNNERS[args.scenario]
    report = StressReport(scenario=args.scenario, started_at=datetime.now(tz=timezone.utc).isoformat())

    print(f"[stress] starting scenario '{args.scenario}'")
    stop_event = threading.Event()
    samples: list[GpuSample] = []
    poll_thread = threading.Thread(
        target=poll_nvidia_smi,
        args=(stop_event, samples, args.poll_interval),
        daemon=True,
    )
    poll_thread.start()

    t0 = time.time()
    futures = runner(args.token)
    for fut in concurrent.futures.as_completed(futures):
        result = fut.result()
        report.jobs.append(result)
        if not result.success and ("oom" in result.error.lower() or "out of memory" in result.error.lower()):
            report.oom_count += 1
        print(
            f"[stress] {result.sidecar} job {result.job_id} -> "
            f"http={result.http_status} ok={result.success} dur={result.duration_sec:.2f}s"
        )

    report.wall_time_sec = time.time() - t0
    stop_event.set()
    poll_thread.join(timeout=5)
    report.gpu_samples = samples
    report.finished_at = datetime.now(tz=timezone.utc).isoformat()
    report.sidecar_health = collect_sidecar_health(args.token)

    out_path = write_report(report)
    print(f"\n[stress] report written to {out_path}")
    print(f"[stress] wall time: {report.wall_time_sec:.2f}s, OOM count: {report.oom_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
