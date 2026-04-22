"""Standalone launcher for the vLLM dual-GPU sidecar (TP=2).

Issue #916 (Epic #888). This script is the *non-Docker* fallback for
contributors who have a working host CUDA + vllm pip install and want to
iterate on launch flags without rebuilding a container.

The supported production path is `docker-compose -f docker-compose.vllm.yml
up -d`. This launcher exists so we can tweak `--max-model-len`,
`--gpu-memory-utilization`, and quantization mode quickly during a
benchmark sweep.

Promoted from `examples/multi-gpu/vllm-dual-gpu.py` to keep all sidecar
launchers under `sidecars/`.
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_MODEL = "Qwen/Qwen2.5-14B-Instruct-AWQ"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Launch vLLM TP=2 dual-GPU server")
    p.add_argument("--model", default=os.environ.get("VLLM_MODEL", DEFAULT_MODEL))
    p.add_argument(
        "--quantization",
        default=os.environ.get("VLLM_QUANTIZATION", "awq"),
        choices=["awq", "gptq", "fp16", "none"],
    )
    p.add_argument(
        "--tensor-parallel-size",
        type=int,
        default=int(os.environ.get("VLLM_TENSOR_PARALLEL_SIZE", "2")),
    )
    p.add_argument(
        "--gpu-memory-utilization",
        type=float,
        default=float(os.environ.get("VLLM_GPU_MEMORY_UTILIZATION", "0.85")),
    )
    p.add_argument(
        "--max-model-len",
        type=int,
        default=int(os.environ.get("VLLM_MAX_MODEL_LEN", "4096")),
    )
    p.add_argument("--host", default=os.environ.get("VLLM_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("VLLM_PORT", "8000")))
    p.add_argument(
        "--api-key-file",
        default=str(Path.home() / ".openzigs" / "vllm-api-key"),
        help="Path to a file containing the API key (mode 0600).",
    )
    return p.parse_args()


def load_api_key(path: str) -> str:
    api_key = os.environ.get("VLLM_API_KEY", "").strip()
    if api_key:
        return api_key
    p = Path(path)
    if not p.exists():
        sys.stderr.write(
            f"ERROR: VLLM_API_KEY not set and {p} does not exist.\n"
            "Run sidecars/vllm/install.sh first, or export VLLM_API_KEY.\n"
        )
        sys.exit(2)
    if p.stat().st_size == 0:
        sys.stderr.write(f"ERROR: API key file {p} is empty.\n")
        sys.exit(2)
    return p.read_text(encoding="utf-8").strip()


def main() -> int:
    args = parse_args()
    api_key = load_api_key(args.api_key_file)

    if shutil.which("vllm") is None:
        sys.stderr.write(
            "ERROR: 'vllm' CLI not found. Install with: pip install vllm==0.6.4\n"
        )
        return 1

    # Build the command WITHOUT the API key. The key is passed to the child
    # exclusively via the VLLM_API_KEY environment variable so it never
    # appears in argv (avoids leaking via /proc/<pid>/cmdline) and never
    # touches any logging path. vLLM's OpenAI server reads VLLM_API_KEY
    # natively when --api-key is not supplied.
    cmd = [
        "vllm",
        "serve",
        args.model,
        "--tensor-parallel-size",
        str(args.tensor_parallel_size),
        "--gpu-memory-utilization",
        str(args.gpu_memory_utilization),
        "--max-model-len",
        str(args.max_model_len),
        "--host",
        args.host,
        "--port",
        str(args.port),
    ]
    if args.quantization != "none":
        cmd.extend(["--quantization", args.quantization])

    # Safe to log: the api_key is not in cmd at all.
    print(
        f"Launching: {' '.join(shlex.quote(a) for a in cmd)} "
        "(VLLM_API_KEY=<redacted> in env)",
        flush=True,
    )

    child_env = os.environ.copy()
    child_env["VLLM_API_KEY"] = api_key
    # Drop the local reference; we want it readable only by the child process.
    del api_key
    return subprocess.call(cmd, env=child_env)


if __name__ == "__main__":
    sys.exit(main())
