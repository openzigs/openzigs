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
curl http://localhost:5012/gpu-info  # sadtalker (Issue #919)
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
| 2× 12 GB | All sidecars in parallel; `medium` tier per card; opt into balanced sharding for `high` tier at the cost of speed; **vLLM TP=2** can replace FLUX on these cards (one-or-the-other, never both — see [Conflict policy](#conflict-policy-vllm-vs-flux)) |
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
python scripts/gpu-stress-test.py --scenario vllm     # 8 concurrent vLLM completions (TPS ≥ 8 SLO)
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

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Base URL the GPU panel and admin API use to reach Ollama (e.g. for listing models and running-model status). Change this if Ollama is on a different host or port. |
| `OLLAMA_NUM_GPU` | (Ollama default) | Number of GPU layers to offload. Set to `99` to place all layers on GPU. |

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

## vLLM Dual-GPU (TP=2)

For users who want production-grade LLM throughput on 2x 12 GB consumer cards, the optional vLLM sidecar serves an OpenAI-compatible chat-completions endpoint at `127.0.0.1:8000/v1` with tensor-parallel inference across both GPUs.

**Default model:** `Qwen/Qwen2.5-14B-Instruct-AWQ` (~9 GB weights, AWQ 4-bit). Other allow-listed models (Gemma 2 9B AWQ, Mistral Nemo 12B AWQ, Qwen 32B AWQ, Mixtral 8x7B AWQ) are selectable from the admin UI.

### Setup

```sh
# 1. One-time install (pulls vllm/vllm-openai:v0.6.4, generates API key in ~/.openzigs/vllm-api-key, mode 0600)
bash sidecars/vllm/install.sh

# 2. Opt in (cannot run alongside FLUX image-gen)
echo 'OPENZIGS_ENABLE_VLLM=1' >> ~/.openzigs/.env.cuda

# 3. Start via admin UI (Admin -> Local vLLM (TP=2) -> Start) OR directly:
VLLM_API_KEY=$(cat ~/.openzigs/vllm-api-key) docker compose -f docker-compose.vllm.yml up -d
```

### Auto-detection

On server boot, if `llm.localVllm.enabled = true` and `llm.localVllm.autoRegister != false` in `~/.openzigs/config.json`, the server will probe `http://127.0.0.1:8000/v1/models` and (if reachable and not already configured) write a `copilot.provider` block pointing at the local vLLM with the generated key. The key is **never logged** and is read from `~/.openzigs/vllm-api-key` (mode 0600).

### Conflict policy: vLLM vs FLUX

vLLM TP=2 claims **both GPUs** (indices 0 and 1). FLUX image-gen \u2014 whether single-GPU or pooled (`IMAGE_GEN_POOLING_MODE=manual-flux`) \u2014 also wants those GPUs. **They cannot coexist.** The `GpuCoordinator` enforces this two ways:

1. **Boot guard:** `sidecars/start-cuda-sidecars.sh` checks `OPENZIGS_ENABLE_VLLM`. When set it skips `image-gen`, `lipsync`, and `sadtalker` sidecars, and forces `IMAGE_GEN_POOLING_MODE=off`.
2. **Runtime guard:** `POST /api/admin/gpu/vllm/start` calls `coordinator.register('vllm', [0, 1])` and returns `409 Conflict` if FLUX has an active claim. The response body lists `conflictWith` and the GPU indices \u2014 no host paths or PIDs \u2014 so the operator can stop the conflicting workload first.

To switch from FLUX -> vLLM: stop the existing image-gen container, set `OPENZIGS_ENABLE_VLLM=1`, then start vLLM. To switch back: stop vLLM via the admin panel, unset the env, restart sidecars.

### Backpressure

The `VllmClient` (`src/llm/vllm-client.ts`) enforces a per-process queue cap (`llm.localVllm.maxQueueDepth`, default 8). Beyond that, calls fail synchronously with code `VLLM_BACKPRESSURE` so the orchestrator can shed load instead of letting requests pile up in the OS socket buffer.

### Observability

- **Admin UI:** Admin -> Local vLLM (TP=2) shows reachability, current model, KV-cache utilisation (green <70%, amber 70-90%, red >90%), running and queued request counts. Polls every 5 seconds.
- **Prometheus metrics:** `curl http://127.0.0.1:8000/metrics` (key series: `vllm:gpu_cache_usage_perc`, `vllm:num_requests_running`, `vllm:num_requests_waiting`).
- **Audit log:** every completion / stream / error is appended to `~/.openzigs/logs/` under category `tool`, subcategory `llm.vllm.*`. The API key is auto-redacted by `AuditLogger`.



---

## LTX-Video VRAM pooling (WS2-A #927)

Drop a second NVIDIA card in and the LTX-Video worker will automatically pool
VRAM, shard the transformer onto `cuda:1`, and unlock longer clips, higher
resolutions, and the LTX-2 22B synchronized-audio model.

### What "pooling" means

The LTX-Video pipeline (`LTXConditionPipeline` / `LTXPipeline` in
[diffusers](https://github.com/huggingface/diffusers)) decomposes into three
heavy modules: a T5-XXL **text encoder** (~9 GB FP16), a **DiT transformer**
(13B for distilled, 22B for LTX-2), and a **VAE** decoder. On a single 12 GB
card the worker has historically used `enable_model_cpu_offload()` to swap
modules to host RAM between forward passes � correct, but slow. With two
visible CUDA devices the worker can **shard** the modules across them in a
single resident set:

| Component         | Default device | Why                                                |
| ----------------- | -------------- | -------------------------------------------------- |
| `transformer`     | `cuda:1`       | Largest; gets the secondary card to itself         |
| `text_encoder`    | `cuda:0`       | Co-located with VAE; only runs once per generation |
| `vae`             | `cuda:0`       | Tiled decode keeps peak low                        |

### Topology matrix

| Topology       | `device_count` | per-card VRAM | Pooling | Pooled VRAM tier | LTX-13B max frames | LTX-2 22B max frames | Native sync audio |
| -------------- | -------------- | ------------- | ------- | ---------------- | ------------------ | -------------------- | ----------------- |
| 1 x 12 GB      | 1              | 12 GB         | off     | 10 GB            | 57                 | n/a                  | no                |
| 1 x 24 GB      | 1              | 24 GB         | off     | 22 GB            | 161                | 121                  | yes (LTX-2)       |
| **2 x 12 GB**  | 2              | 12 GB         | **on**  | 24 GB            | **161**            | **161**              | **yes**           |
| 2 x 16 GB      | 2              | 16 GB         | on      | 32 GB            | 201                | 201                  | yes               |
| 2 x 24 GB      | 2              | 24 GB         | on      | 48 GB            | 257                | 257                  | yes               |
| Mixed 12+24    | 2              | 12+24 GB      | on      | 32+ GB           | 201                | 201                  | yes               |

Pooled tiers are only enabled when total VRAM >= `LTX_POOLING_MIN_VRAM_GB`
(default 18 GB). Below that, the worker falls back silently to single-GPU
mode regardless of how many cards are present.

### LTX env variables

| Variable                     | Default     | Purpose                                                                                   |
| ---------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `LTX_POOLING_MODE`           | `auto`      | `off` / `manual` / `auto`. `manual` skips VRAM gating; `off` disables sharding entirely.  |
| `LTX_TRANSFORMER_DEVICE`     | `cuda:1`    | Where the DiT lives                                                                       |
| `LTX_ENCODER_DEVICE`         | `cuda:0`    | Where the T5-XXL text encoder lives                                                       |
| `LTX_VAE_DEVICE`             | `cuda:0`    | Where the VAE lives                                                                       |
| `LTX_POOLING_MIN_VRAM_GB`    | `18`        | `auto` only enables sharding when summed VRAM >= this                                     |
| `LTX_MAX_FRAMES_OVERRIDE`    | `0` (off)   | Hard cap on per-clip frames; useful for OOM debugging                                     |
| `LTX_ALLOW_AUDIO`            | `0`         | Set to `1` to allow the LTX-2 22B model's native synchronized audio path                  |

Audio gating logic (`POST /generate` with `audio: true`):

```
audio: true requires
   model.synchronized_audio == true   (currently only ltxv-2-22b-distilled)
   AND LTX_ALLOW_AUDIO == 1
   AND pooled_vram_gb >= 24
otherwise the request is rejected with HTTP 400 and a precise error message.
```

For everything else, request `audio_mode: "auto"` on the queue payload and
the orchestrator dispatches a follow-up job to the v2a (MMAudio) sidecar
after the silent video completes.

### Verifying pooling

```bash
curl -s http://localhost:5007/capabilities | jq
```

```jsonc
{
  "cuda_available": true,
  "device_count": 2,
  "pooled_vram_gb": 24,
  "pooling": {
    "mode": "auto",
    "active": true,
    "transformer_device": "cuda:1",
    "encoder_device": "cuda:0",
    "vae_device": "cuda:0",
    "min_vram_gb": 18
  },
  "max_frames": { "ltxv-13b-097-distilled": 161, "ltxv-2-22b-distilled": 161 },
  "audio_modes": ["off", "auto", "native"]
}
```

When sharding activates the worker logs:

```
[ws2a] Dual-GPU sharding active: transformer=cuda:1 encoder=cuda:0 vae=cuda:0 pooled_vram=24GB
```

### Troubleshooting

**"Sharding placement failed (...); falling back to model_cpu_offload."**
Common cause: the secondary card already has a process holding most of its
VRAM (browser GPU acceleration, gnome-shell, etc.). Free it, then `POST
/unload` and the next job re-loads with sharding.

**"LTX-2 synchronized audio is disabled. Set LTX_ALLOW_AUDIO=1 to enable."**
Self-explanatory. Make sure pooled VRAM >= 24 GB or the request will still
be rejected with the VRAM error variant.

**`device_map="auto"` doesn't work on LTX.**
Correct - diffusers' Accelerate-backed `device_map` integration is documented
as experimental and is incompatible with `.to()` / `enable_model_cpu_offload`
without an explicit `reset_device_map()`. Manual per-component placement
(what this code does) is the supported path on LTX 0.9.x through current
main.

### Sources

Tavily research **2026-04-22**:

- HuggingFace diffusers - *Working with big models*
  <https://huggingface.co/docs/diffusers/main/tutorials/inference_with_big_models>
- HuggingFace forums - *Using second GPU?*
  <https://discuss.huggingface.co/t/using-second-gpu/23453>

## LoRA training across two GPUs (WS3-E #934, optional)

When `LORA_MULTI_GPU=1` is set and the host has two CUDA devices, the
`image-gen` sidecar's `_bg_train` will launch DreamBooth via `accelerate
launch --multi_gpu --num_processes=N` instead of plain `python`. This
typically halves wall time for SDXL/FLUX runs at the cost of doubled VRAM
draw - safe on 2x16 GB or higher, marginal on 2x12 GB.

When the env var is unset (default) or only one CUDA device is visible, the
trainer runs single-GPU exactly as before.


---

## LTX-Video VRAM pooling (WS2-A #927)

Drop a second NVIDIA card in and the LTX-Video worker will automatically pool
VRAM, shard the transformer onto `cuda:1`, and unlock longer clips, higher
resolutions, and the LTX-2 22B synchronized-audio model.

### What "pooling" means

The LTX-Video pipeline (`LTXConditionPipeline` / `LTXPipeline` in
[diffusers](https://github.com/huggingface/diffusers)) decomposes into three
heavy modules: a T5-XXL **text encoder** (~9 GB FP16), a **DiT transformer**
(13B for distilled, 22B for LTX-2), and a **VAE** decoder. On a single 12 GB
card the worker has historically used `enable_model_cpu_offload()` to swap
modules to host RAM between forward passes � correct, but slow. With two
visible CUDA devices the worker can **shard** the modules across them in a
single resident set:

| Component         | Default device | Why                                                |
| ----------------- | -------------- | -------------------------------------------------- |
| `transformer`     | `cuda:1`       | Largest; gets the secondary card to itself         |
| `text_encoder`    | `cuda:0`       | Co-located with VAE; only runs once per generation |
| `vae`             | `cuda:0`       | Tiled decode keeps peak low                        |

### Topology matrix

| Topology       | `device_count` | per-card VRAM | Pooling | Pooled VRAM tier | LTX-13B max frames | LTX-2 22B max frames | Native sync audio |
| -------------- | -------------- | ------------- | ------- | ---------------- | ------------------ | -------------------- | ----------------- |
| 1 x 12 GB      | 1              | 12 GB         | off     | 10 GB            | 57                 | n/a                  | no                |
| 1 x 24 GB      | 1              | 24 GB         | off     | 22 GB            | 161                | 121                  | yes (LTX-2)       |
| **2 x 12 GB**  | 2              | 12 GB         | **on**  | 24 GB            | **161**            | **161**              | **yes**           |
| 2 x 16 GB      | 2              | 16 GB         | on      | 32 GB            | 201                | 201                  | yes               |
| 2 x 24 GB      | 2              | 24 GB         | on      | 48 GB            | 257                | 257                  | yes               |
| Mixed 12+24    | 2              | 12+24 GB      | on      | 32+ GB           | 201                | 201                  | yes               |

Pooled tiers are only enabled when total VRAM >= `LTX_POOLING_MIN_VRAM_GB`
(default 18 GB). Below that, the worker falls back silently to single-GPU
mode regardless of how many cards are present.

### LTX env variables

| Variable                     | Default     | Purpose                                                                                   |
| ---------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `LTX_POOLING_MODE`           | `auto`      | `off` / `manual` / `auto`. `manual` skips VRAM gating; `off` disables sharding entirely.  |
| `LTX_TRANSFORMER_DEVICE`     | `cuda:1`    | Where the DiT lives                                                                       |
| `LTX_ENCODER_DEVICE`         | `cuda:0`    | Where the T5-XXL text encoder lives                                                       |
| `LTX_VAE_DEVICE`             | `cuda:0`    | Where the VAE lives                                                                       |
| `LTX_POOLING_MIN_VRAM_GB`    | `18`        | `auto` only enables sharding when summed VRAM >= this                                     |
| `LTX_MAX_FRAMES_OVERRIDE`    | `0` (off)   | Hard cap on per-clip frames; useful for OOM debugging                                     |
| `LTX_ALLOW_AUDIO`            | `0`         | Set to `1` to allow the LTX-2 22B model's native synchronized audio path                  |

Audio gating logic (`POST /generate` with `audio: true`):

```
audio: true requires
   model.synchronized_audio == true   (currently only ltxv-2-22b-distilled)
   AND LTX_ALLOW_AUDIO == 1
   AND pooled_vram_gb >= 24
otherwise the request is rejected with HTTP 400 and a precise error message.
```

For everything else, request `audio_mode: "auto"` on the queue payload and
the orchestrator dispatches a follow-up job to the v2a (MMAudio) sidecar
after the silent video completes.

### Verifying pooling

```bash
curl -s http://localhost:5007/capabilities | jq
```

```jsonc
{
  "cuda_available": true,
  "device_count": 2,
  "pooled_vram_gb": 24,
  "pooling": {
    "mode": "auto",
    "active": true,
    "transformer_device": "cuda:1",
    "encoder_device": "cuda:0",
    "vae_device": "cuda:0",
    "min_vram_gb": 18
  },
  "max_frames": { "ltxv-13b-097-distilled": 161, "ltxv-2-22b-distilled": 161 },
  "audio_modes": ["off", "auto", "native"]
}
```

When sharding activates the worker logs:

```
[ws2a] Dual-GPU sharding active: transformer=cuda:1 encoder=cuda:0 vae=cuda:0 pooled_vram=24GB
```

### Troubleshooting

**"Sharding placement failed (...); falling back to model_cpu_offload."**
Common cause: the secondary card already has a process holding most of its
VRAM (browser GPU acceleration, gnome-shell, etc.). Free it, then `POST
/unload` and the next job re-loads with sharding.

**"LTX-2 synchronized audio is disabled. Set LTX_ALLOW_AUDIO=1 to enable."**
Self-explanatory. Make sure pooled VRAM >= 24 GB or the request will still
be rejected with the VRAM error variant.

**`device_map="auto"` doesn't work on LTX.**
Correct - diffusers' Accelerate-backed `device_map` integration is documented
as experimental and is incompatible with `.to()` / `enable_model_cpu_offload`
without an explicit `reset_device_map()`. Manual per-component placement
(what this code does) is the supported path on LTX 0.9.x through current
main.

### Sources

Tavily research **2026-04-22**:

- HuggingFace diffusers - *Working with big models*
  <https://huggingface.co/docs/diffusers/main/tutorials/inference_with_big_models>
- HuggingFace forums - *Using second GPU?*
  <https://discuss.huggingface.co/t/using-second-gpu/23453>

## LoRA training across two GPUs (WS3-E #934, optional)

When `LORA_MULTI_GPU=1` is set and the host has two CUDA devices, the
`image-gen` sidecar's `_bg_train` will launch DreamBooth via `accelerate
launch --multi_gpu --num_processes=N` instead of plain `python`. This
typically halves wall time for SDXL/FLUX runs at the cost of doubled VRAM
draw - safe on 2x16 GB or higher, marginal on 2x12 GB.

When the env var is unset (default) or only one CUDA device is visible, the
trainer runs single-GPU exactly as before.
