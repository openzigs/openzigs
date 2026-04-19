#!/usr/bin/env python3
"""
Dual-GPU vLLM launcher for openzigs (Epic #883 follow-up).

Boots a vLLM OpenAI-compatible server using tensor-parallel-size=2 to shard
ONE large quantized LLM across the two RTX 3060s.

WHY THIS EXISTS
---------------
Single-card serving is faster for any model that fits on one GPU. This script
is ONLY for models in the ~16–22 GB INT4-quantized range that don't fit on
one 12 GB card. Recommended models:

    - mistralai/Mixtral-8x7B-Instruct-v0.1 + AWQ (~24 GB sharded)
    - Qwen/Qwen2.5-32B-Instruct-AWQ        (~20 GB sharded)
    - meta-llama/Meta-Llama-3-70B-Instruct-AWQ  (tight, 4096 ctx max)

For Llama-3.1-8B / Mistral-7B / smaller — DO NOT use this. Run two single-card
data-parallel instances instead (one per GPU) — you'll get 2× throughput
because you skip the all-reduce.

PCIe 4.0 x16 between the cards = ~32 GB/s real-world. NVLink would be ~900
GB/s. Expect TP=2 throughput ≈ 1.0–1.3× single-card, not 2×.

FLUX coexistence
----------------
This launcher pins vLLM to GPUs 0+1 and exposes port 8000. To run FLUX (which
also wants GPU 0 in our default pinning) at the same time, either:

  (a) Re-pin FLUX to CPU offload only (slow), or
  (b) Don't run vLLM TP=2 + FLUX simultaneously — pick one large workload.

The TS layer (see src/llm/vllm-client.ts) tracks "vllm.busy" and gates FLUX
submissions when vLLM is loaded.

Usage
-----
    # First time setup (one-off):
    python -m venv ~/openzigs-sidecars/vllm/venv
    source ~/openzigs-sidecars/vllm/venv/bin/activate
    pip install vllm==0.7.3

    # Launch:
    python examples/multi-gpu/vllm-dual-gpu.py \\
        --model casperhansen/mixtral-8x7b-instruct-v0.1-awq \\
        --port 8000

Environment overrides:
    VLLM_GPUS              comma-separated CUDA indices (default "0,1")
    VLLM_MAX_MODEL_LEN     int   (default 4096; KV cache scales with this)
    VLLM_GPU_MEM_UTIL      float (default 0.85; LOWER if FLUX is also on GPU 0)
    VLLM_QUANT             awq | gptq | None (default awq)
    VLLM_DISABLE_LOG_STATS truthy to silence per-step stats
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys


def _gpu_count(visible: str) -> int:
    return len([s for s in visible.split(",") if s.strip()])


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model", required=True, help="HF repo id, e.g. casperhansen/mixtral-8x7b-instruct-v0.1-awq")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--api-key", default=os.environ.get("VLLM_API_KEY"))
    p.add_argument("--dtype", default="auto", choices=["auto", "float16", "bfloat16"])
    args = p.parse_args(argv)

    visible = os.environ.get("VLLM_GPUS", "0,1")
    tp = _gpu_count(visible)
    if tp < 1:
        print("VLLM_GPUS must list at least one GPU index", file=sys.stderr)
        return 2

    max_len = int(os.environ.get("VLLM_MAX_MODEL_LEN", "4096"))
    mem_util = float(os.environ.get("VLLM_GPU_MEM_UTIL", "0.85"))
    quant = os.environ.get("VLLM_QUANT", "awq")
    disable_stats = bool(os.environ.get("VLLM_DISABLE_LOG_STATS"))

    env = {
        **os.environ,
        # Pin physical GPUs. Inside vLLM these become cuda:0, cuda:1.
        "CUDA_VISIBLE_DEVICES": visible,
        # Hard-disable the Windows shared-memory spillover. Linux/WSL ignores
        # this anyway, but it documents intent. PYTORCH_CUDA_ALLOC_CONF caps
        # fragmentation: with TP=2, allocator pressure is the #1 cause of
        # silent slowdowns.
        "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True,max_split_size_mb:512",
        # NCCL is what does the all-reduce. Force P2P off if it's flaky on
        # consumer cards (it sometimes is on RTX 30xx without NVLink). Set
        # NCCL_P2P_DISABLE=1 if you see hangs at startup.
        "NCCL_DEBUG": os.environ.get("NCCL_DEBUG", "WARN"),
    }

    cmd = [
        sys.executable, "-m", "vllm.entrypoints.openai.api_server",
        "--model", args.model,
        "--host", args.host,
        "--port", str(args.port),
        "--tensor-parallel-size", str(tp),
        "--gpu-memory-utilization", f"{mem_util:.3f}",
        "--max-model-len", str(max_len),
        "--dtype", args.dtype,
        # Trust quantization auto-detect; only pass --quantization when the
        # repo doesn't carry a quant_config.json.
        # "--quantization", quant,
        # The single biggest TP-over-PCIe win: enable chunked prefill so the
        # prefill phase doesn't monopolise PCIe and starve decode.
        "--enable-chunked-prefill",
        # Cap concurrent sequences. With 2× 12 GB and a 24 GB sharded model,
        # KV cache headroom is small. Tune up only after measuring.
        "--max-num-seqs", "16",
    ]
    if quant and quant.lower() != "none":
        cmd.extend(["--quantization", quant.lower()])
    if disable_stats:
        cmd.append("--disable-log-stats")
    if args.api_key:
        cmd.extend(["--api-key", args.api_key])

    print(f"[vllm] launching: tp={tp} gpus={visible} model={args.model}", flush=True)
    print(f"[vllm] cmd: {' '.join(cmd)}", flush=True)
    return subprocess.call(cmd, env=env)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
