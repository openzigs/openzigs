# Multi-GPU Configuration

OpenZigs auto-detects NVIDIA GPUs at sidecar startup and pins each sidecar to a
device when more than one card is present. This document covers how the
detection works, how to override it, and what is/isn't possible on consumer
multi-GPU setups.

## Auto-detection

`sidecars/start-cuda-sidecars.sh` runs `nvidia-smi -L` at boot:

| GPUs detected | Default pinning |
| --- | --- |
| 1 (or 0) | All sidecars on GPU 0 |
| ≥ 2 | image-gen + audio + music → GPU 0; worker (video) + lipsync + sadtalker → GPU 1 |

The split is chosen so the **talking-head pipeline (TTS → video → lipsync)**
overlaps work across both cards.

## Per-sidecar overrides

Set any of the following before invoking `start-cuda-sidecars.sh` (e.g. via
`~/.openzigs/.env.cuda`):

```sh
IMAGE_GEN_GPU_INDEX=0
AUDIO_GPU_INDEX=0
WORKER_GPU_INDEX=1
LIPSYNC_GPU_INDEX=1
SADTALKER_GPU_INDEX=1
MUSIC_GPU_INDEX=0
```

Each value is fed to the sidecar's `CUDA_VISIBLE_DEVICES` env var, so PyTorch
sees exactly one device (`cuda:0` from the sidecar's perspective).

## Verifying

```sh
curl http://localhost:5005/gpu-info  # image-gen
curl http://localhost:5007/gpu-info  # video worker
curl http://localhost:5010/gpu-info  # lipsync
```

The backend exposes a consolidated view at `GET /api/system/gpu` (auth
required) returning the parsed `nvidia-smi` profile, total VRAM, the
recommended model tier, and the default pinning the orchestrator would use.

## Model tier reference

Model registry entries carry `tier` and `min_vram_gb` fields:

| Tier | Min VRAM (largest single GPU) | Example models |
| --- | --- | --- |
| `low` | 8 GB | LTX-Video 2B distilled, SDXL-base, Kokoro TTS |
| `medium` | 11–12 GB | LTX-Video 13B distilled, FLUX.1-schnell, LatentSync v1.5 |
| `high` | 16 GB | LTX-Video 13B dev, FLUX.1-dev, LatentSync v1.6 |
| `ultra` | 24 GB+ | Anything we ship; reserved for future larger models |

The recommended tier is bound by the **largest single GPU** in the host. Two
12 GB cards = `medium` tier — aggregating VRAM across cards requires model
parallelism, see below.

## Optional: VRAM pooling for FLUX (`IMAGE_GEN_POOLING_MODE=manual-flux`)

By default each sidecar runs on a single GPU and uses
`enable_model_cpu_offload()` to fit larger models in 12 GB. On hosts with
**≥ 2 same-architecture GPUs** you can opt the image-gen sidecar into
**manual-placement pooling** to keep the entire FLUX pipeline resident in
GPU VRAM and avoid the CPU↔GPU page-fault tax:

```sh
# in ~/.openzigs/.env.cuda
IMAGE_GEN_POOLING_MODE=manual-flux
```

When the flag is set:

- `start-cuda-sidecars.sh` exposes both GPUs to image-gen (`CUDA_VISIBLE_DEVICES=0,1`)
  instead of pinning to one card.
- `server_cuda.py` places `text_encoder` + `text_encoder_2` + `vae` on `cuda:0`
  and the FLUX `transformer` on `cuda:1`. CPU offload is **off** in this mode.
- `GET /api/system/gpu` reports `pooling_supported: true` and a higher
  `recommended_tier_pooled` value (advisory only — never auto-selected).
- `GET http://localhost:5005/gpu-info` reports `pooled_active: true` after the
  first FLUX load.

Trade-offs and known limitations:

- **Only FLUX is wired up.** SDXL stays single-GPU. Worker (LTX) and lipsync
  ignore the flag; their components do not split cleanly without re-engineering
  the pipeline.
- **Same-arch only.** Mixing a 3060 with a 4090 will load but inter-GPU
  collective ops can stall. The `same_arch: false` field on `/api/system/gpu`
  is your warning.
- **Per-card VRAM matters more than aggregate.** The FLUX-dev transformer is
  ~12 GB at FP16 — it must fit on a *single* card. Verified results:
  - **2× 12 GB (e.g., 2× RTX 3060):** pooled path executes, then **OOMs on
    transformer placement** (transformer ≈ card capacity, no room for CUDA
    context). Fall-back to cpu_offload kicks in automatically; net effect is
    a successful load via the slower offload path. Use the flag here only
    for SDXL or future models with smaller transformers.
  - **2× 16 GB (e.g., 2× RTX 4060 Ti 16 GB) or larger same-arch:** pooled
    path holds end-to-end and removes the CPU↔GPU page-fault tax on FLUX-dev.
- **Throughput is mostly about *fit*, not speed.** PCIe-only consumer cards
  (no NVLink) shuffle prompt embeddings between cards each step. Expect
  parity with single-card cpu_offload on FLUX-schnell and a meaningful win
  on FLUX-dev (which spills hard to system RAM under cpu_offload on 12 GB).
- **Multi-tenant safe.** Default mode is `off`. The pooled tier is advisory
  only — the orchestrator never picks `flux-dev` for a tenant whose host is
  not opted in. The OOM-then-fallback path means enabling the flag on
  undersized hardware is *safe* (loads succeed via cpu_offload) but provides
  no speed benefit — check `~/.openzigs/logs/image-gen-cuda.log` for
  "Pooled placement failed" warnings to confirm.

To revert, unset the env var (or set to `off`) and restart the sidecars.

## Hardware reality check

| You have | What's realistic |
| --- | --- |
| 1× 8 GB | Stick to `low` tier; expect occasional OOM on larger payloads |
| 1× 12 GB (RTX 3060) | `medium` tier with CPU offload; LTX-13B distilled is the sweet spot |
| 2× 12 GB | All sidecars in parallel; `medium` tier per card; opt into balanced sharding for `high` tier at the cost of speed |
| 1× 24 GB (RTX 4090, A6000) | `high` tier; FLUX-dev + LTX-13B-dev unloaded |
| > 24 GB | `ultra` tier; ship-it-all |

Models like HunyuanVideo, Wan2.1 14B, Mochi 1, and CogVideoX-5B require 16–40 GB
of *contiguous* VRAM and are **not viable** on 12 GB shards even with two cards.

## Stress testing

```sh
python scripts/gpu-stress-test.py --scenario smoke    # 2 image-gen + 1 TTS
python scripts/gpu-stress-test.py --scenario full     # 5 image-gen + 1 video + 1 TTS
python scripts/gpu-stress-test.py --scenario oom      # Same as full with oversized payloads
python scripts/gpu-stress-test.py --scenario ollama   # Ollama inference latency
```

Reports land in `~/.openzigs/stress-tests/<timestamp>-<scenario>.md` with
per-GPU peak VRAM and per-job wall times. PowerShell wrapper:
`pwsh ./scripts/gpu-stress-test.ps1 -Scenario smoke`.

## Ollama Dual-GPU: Running Gemma 4 26b

[Ollama](https://ollama.com/) is the simplest path to running large language
models across multiple GPUs. It automatically splits model layers across all
visible CUDA devices, so there is no manual tensor-parallel configuration.

### Prerequisites

1. **NVIDIA Container Toolkit** installed and configured for Docker:
   ```sh
   sudo apt-get install -y nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```
2. **Docker / Docker Desktop** with GPU support.
3. Two NVIDIA GPUs (e.g., 2× RTX 3060 12 GB).

### Quick start

```sh
# Start Ollama container with GPU access
docker compose -f docker-compose.ollama.yml up -d

# Pull the model (~18 GB download)
docker exec -it ollama ollama pull gemma4:26b

# Interactive test
docker exec -it ollama ollama run gemma4:26b "Hello, how are you?"

# Verify GPU layer split
docker exec -it ollama ollama ps
```

### Memory budget

| Component         | Size   | Notes                                 |
| ----------------- | ------ | ------------------------------------- |
| Gemma 4 26B weights | ~18 GB | Quantized Q4_0; FP16 is ~52 GB       |
| KV cache (2K ctx) | ~3 GB  | Shared across GPUs                    |
| CUDA overhead     | ~0.5 GB | Per GPU                               |
| **Total**         | ~21.5 GB | Fits across 2× 12 GB (~10.75 GB/card) |

With `OLLAMA_NUM_GPU=99`, Ollama assigns all layers to GPU. On 2× 12 GB cards
it splits layers roughly 50/50 across the two devices.

### Performance expectations

- **Throughput**: 1.0–1.3× single-card equivalent over PCIe 4.0 (no NVLink).
  Layer-split parallelism adds inter-GPU transfer overhead per token.
- **Latency**: First-token latency ~2–3 s; sustained generation ~8–15 tok/s
  depending on context length and quantization.
- **Context length**: 8K tokens is safe on 2× 12 GB; 32K requires ≥ 2× 24 GB.

### BYOK configuration

Point OpenZigs at local Ollama via the OpenAI-compatible API:

```json
{
  "copilot": {
    "provider": {
      "type": "openai",
      "baseUrl": "http://localhost:11434/v1"
    }
  }
}
```

Save to `~/.openzigs/config.json`, then restart the server. The model is
auto-detected from Ollama; no `model` field is required unless you want to
pin a specific model name.

### Ollama vs. vLLM comparison

| Feature               | Ollama                   | vLLM TP=2                    |
| --------------------- | ------------------------ | ---------------------------- |
| Setup complexity       | Simple (Docker, 1 cmd)   | Medium (Python env, config)  |
| Layer split strategy   | Auto (greedy by VRAM)    | Tensor Parallel (manual)     |
| Throughput (2× 12 GB)  | 8–15 tok/s               | 12–20 tok/s                  |
| GPU memory efficiency  | Good (Q4_0 default)      | Better (FP16 with PagedAttn) |
| Quantization options   | GGUF (Q4, Q5, Q8, FP16)  | FP16, AWQ, GPTQ              |
| Multi-model switching  | Native (`ollama run`)    | Requires restart              |
| API compatibility      | OpenAI `/v1` + native    | OpenAI `/v1`                  |
| Recommended for        | Quick eval, dev, BYOK    | Production, high throughput   |

For most OpenZigs users with consumer hardware (2× 12 GB), Ollama is the
recommended starting point due to simplicity and automatic layer splitting.
