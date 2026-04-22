# examples/multi-gpu

The reference vLLM TP=2 launcher and async client that previously lived
here have been promoted into the main tree as part of Epic #888:

| Old path | New canonical location |
| --- | --- |
| `examples/multi-gpu/vllm-dual-gpu.py` | [`sidecars/vllm/launch.py`](../../sidecars/vllm/launch.py) (host-Python launcher) and [`docker-compose.vllm.yml`](../../docker-compose.vllm.yml) (production) |
| `examples/multi-gpu/vllm-client.ts` | [`src/llm/vllm-client.ts`](../../src/llm/vllm-client.ts) — wired into the BYOK provider path with audit logging, single-flight, and backpressure |

See [`docs/MULTI_GPU.md`](../../docs/MULTI_GPU.md) for the dual-GPU
serving guide, hardware reality check, and the conflict policy enforced
by the GPU coordinator (`src/gpu/gpu-coordinator.ts`).
# Multi-GPU LLM Serving — vLLM Reference

Companion to `docs/MULTI_GPU.md`. This directory holds **reference**
implementations for serving large quantized LLMs across the two RTX 3060s
using vLLM. Not yet wired into the main app.

## Files

| File | Purpose |
| --- | --- |
| `vllm-dual-gpu.py` | Launches vLLM OpenAI-compatible server with TP=2 across GPUs 0+1 |
| `vllm-client.ts` | Async TS client with single-flight queue + backpressure |

## When to use

- ✅ Mixtral-8x7B-AWQ, Qwen2.5-32B-AWQ, Llama-3-70B-AWQ (tight)
- ❌ Llama-3.1-8B, Mistral-7B (fits on one card → use single GPU instead)
- ❌ Anything you need to run **simultaneously** with FLUX (vLLM TP=2
  takes both cards; FLUX needs at least one)

## Why this isn't auto-enabled

Serving is mutually exclusive with the existing diffusion sidecar topology.
You can run one of:

1. The current default — image-gen on GPU 0, video on GPU 1 (talking-head pipeline)
2. vLLM TP=2 across both cards (24 GB-class quantized LLM)

…but not both at once on this hardware.

## See also

- `docs/MULTI_GPU.md` — hardware reality, env overrides
- Epic #883 — multi-GPU awareness
- Issue #888 — integrating this reference into a `sidecars/vllm/` runtime
- Issue #886 — accelerate `device_map=balanced` for diffusion sidecars
