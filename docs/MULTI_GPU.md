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

## Optional: model parallelism (`device_map="balanced"`)

Setting `LTX_DEVICE_MAP=balanced` or `FLUX_DEVICE_MAP=balanced` switches the
relevant sidecar from `enable_model_cpu_offload()` to accelerate's
`device_map="balanced"`, sharding the model across all visible GPUs.

This unlocks `medium`+ models on hosts with 2× 12 GB cards, **but**:

- RTX 30/40-series consumer cards have **no NVLink**. Shard transfers happen
  over PCIe and benchmark at ~0.6–0.7× single-card throughput for 13B inference.
- On hosts with one big card (e.g. 24 GB), leave this OFF — single-card
  inference is faster.

The flag is ignored when fewer than 2 GPUs are visible after pinning.

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
```

Reports land in `~/.openzigs/stress-tests/<timestamp>-<scenario>.md` with
per-GPU peak VRAM and per-job wall times. PowerShell wrapper:
`pwsh ./scripts/gpu-stress-test.ps1 -Scenario smoke`.
