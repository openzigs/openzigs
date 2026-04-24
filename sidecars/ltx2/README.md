# LTX-2 Native Audio+Video Sidecar (port 5013)

Wraps Lightricks' native `ltx_pipelines.distilled` CLI to produce single-pass
MP4s with **natively muxed audio**. This is what the orchestrator's
`audio_mode: "native"` capability resolves to at runtime.

## Why this is a separate sidecar (and not embedded in the worker)

The LTX-2 stack ships only via the [Lightricks/LTX-2 monorepo](https://github.com/Lightricks/LTX-2)
(`ltx_core` + `ltx_pipelines`, **not** published to PyPI as `ltx2`). It must
be installed via [`uv`](https://docs.astral.sh/uv/) directly from the cloned
source tree — `pip install -r requirements.txt` won't work and is
intentionally **not** provided.

The diffusers `LTX2Pipeline` path advertised in `Lightricks/LTX-2`'s
`model_index.json` references `LTX2TextConnectors` / `LTX2Vocoder` symbols
that don't exist in any published package as of 2026-04. This sidecar
sidesteps all of that by calling the upstream CLI directly.

## Hardware requirements

| Profile           | VRAM (single GPU) | System RAM | Wall clock (25f @ 24fps) |
| ----------------- | ----------------- | ---------- | ------------------------ |
| `--offload cpu`   | ~6 GB             | ~31 GB     | ~35 s (RTX 3060 12 GB)   |
| `--offload disk`  | ~6 GB             | ~5 GB      | ~120 s (NVMe streaming)  |
| `--offload none`  | ~30 GB            | minimal    | ~10 s (RTX 5090 / A100)  |

**Upstream constraint** (`ltx_pipelines/utils/blocks.py:162`): `--quantization`
is mutually exclusive with `--offload {cpu,disk}`. Layer streaming requires
un-quantised BF16 weights.

`DistilledPipeline` does **not** shard across multiple GPUs. The sidecar
pins to `CUDA_VISIBLE_DEVICES=0` by default.

## Setup

```bash
bash sidecars/ltx2/setup.sh
```

This idempotent script:

1. Installs `uv` if missing (`~/.local/bin/uv`)
2. Clones `Lightricks/LTX-2` to `~/openzigs-sidecars/ltx2-src/`
3. Runs `uv sync --frozen` (creates `.venv` with PyTorch 2.9 / CUDA 12.8)
4. Downloads model artefacts (~53 GB total) to `~/openzigs-sidecars/ltx2-models/`:
   - `ltx2/ltx-2.3-22b-dev-fp8.safetensors` (29 GB)
   - `ltx2/ltx-2.3-spatial-upscaler-x2-1.1.safetensors` (~1 GB)
   - `gemma-3-12b/` (23 GB) — Gemma 3 text encoder; **requires HF login**
     and acceptance of the Gemma license (the distilled checkpoint is
     trained against Gemma 3 specifically — Gemma 4 is not a substitute)

The HuggingFace token is read from `.env` at the repo root (`HF_TOKEN=...`).

## API

| Method | Path                | Auth     | Description                                        |
| ------ | ------------------- | -------- | -------------------------------------------------- |
| GET    | `/health`           | —        | Service ready check + venv/model presence probe    |
| GET    | `/gpu-info`         | —        | `nvidia-smi` summary (sidecar's own venv stays light) |
| POST   | `/generate`         | bearer   | Accept job → 202 + `job_id`; runs in subprocess     |
| GET    | `/status/{job_id}`  | —        | Poll status; returns `{status, video_path, ...}`   |
| POST   | `/unload`           | bearer   | No-op (subprocess mode releases all RAM at exit)   |

## Generate request schema

```json
{
  "job_id": "ltx2-001",
  "prompt": "A cat purring softly on a wooden floor.",
  "seed": 42,
  "height": 512,
  "width": 512,
  "num_frames": 25,
  "frame_rate": 24,
  "offload_mode": "cpu",
  "callback_url": "http://localhost:3000/api/queue/complete"
}
```

`callback_url` is loopback-only (SSRF-hardened).

## Implementation choice — subprocess vs. in-process

Each `/generate` job invokes `python -m ltx_pipelines.distilled` as a
subprocess. Rationale documented in [server_cuda.py](server_cuda.py)'s
module docstring. TL;DR: per-job RAM reclamation is more important than
warm-cache speed on shared dev hardware, and the upstream Python API
moves faster than its CLI flags.

## Environment variables

| Variable                       | Default                                        | Purpose                                  |
| ------------------------------ | ---------------------------------------------- | ---------------------------------------- |
| `LTX2_SRC_ROOT`                | `~/openzigs-sidecars/ltx2-src`                 | Path to cloned monorepo                  |
| `LTX2_VENV_PYTHON`             | `$LTX2_SRC_ROOT/.venv/bin/python`              | Upstream venv interpreter                |
| `LTX2_MODELS_ROOT`             | `~/openzigs-sidecars/ltx2-models`              | Model download root                      |
| `LTX2_OUTPUT_ROOT`             | `$TMPDIR/ltx2-out`                             | Containment root for generated MP4s      |
| `LTX2_OFFLOAD_MODE`            | `cpu`                                          | `none` / `cpu` / `disk`                  |
| `LTX2_DEFAULT_FRAMES`          | `25`                                           | ~1 s @ 24 fps                            |
| `LTX2_MAX_FRAMES`              | `121`                                          | ~5 s @ 24 fps cap                        |
| `LTX2_MAX_DIM`                 | `1024`                                         | Per-axis resolution cap                  |
| `LTX2_GENERATION_TIMEOUT_SEC`  | `1800`                                         | Per-job wall clock cap                   |
| `WORKER_SECRET_TOKEN`          | (none → unauthenticated dev mode)              | Bearer token for `/generate` + `/unload` |

## Smoke test (bypass the HTTP layer)

```bash
bash scripts/ltx2_smoke.sh
ffprobe -v error -show_streams /tmp/ltx2-out/smoke.mp4
```

Expected output: 1 video stream (`h264`) + 1 audio stream (`aac`, 48 kHz).
