# ACE-Step 1.5 Music Generation Sidecar

HTTP API server for local AI music generation using ACE-Step 1.5 on Apple Silicon.

## Prerequisites

1. Clone the ACE-Step Apple Silicon fork:
   ```bash
   git clone https://github.com/clockworksquirrel/ace-step-apple-silicon.git ~/ace-step-apple-silicon
   cd ~/ace-step-apple-silicon
   uv sync
   ```

2. Python 3.11.x and PyTorch 2.4+ (for MPS bfloat16 support)

## Running

```bash
cd sidecars/music
python server.py --port 5009
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ACESTEP_DIR` | `~/ace-step-apple-silicon` | Path to ACE-Step installation |
| `ACESTEP_MODEL` | `acestep-v15-turbo` | DiT model (`acestep-v15-turbo` or `acestep-v15-sft`) |
| `ACESTEP_LM` | `acestep-5Hz-lm-0.6B` | Language model (`0.6B`, `1.7B`, or `4B`) |
| `ACESTEP_BACKEND` | `pt` | Backend (`pt` for PyTorch MPS or `mlx`) |
| `ACESTEP_DEVICE` | `auto` | Device (`auto`, `mps`, `cpu`) |
| `MUSIC_GEN_AUTH_TOKEN` | *(none)* | Optional Bearer token for authentication |

## API Endpoints

### POST /generate (async)
Submit a music generation job. Returns 202 immediately, POSTs result to `callback_url`.

```json
{
  "job_id": "uuid",
  "prompt": "upbeat electronic dance track, 128 BPM, energetic synths",
  "duration_seconds": 30,
  "lyrics": "optional lyrics text",
  "instrumental": false,
  "model": "acestep-v15-turbo",
  "seed": 42,
  "callback_url": "http://host:3000/api/queue/complete"
}
```

### POST /generate-sync
Synchronous generation. Blocks until audio is ready.

### GET /health
Returns `{ status, model, device, backend }`.

### GET /status
Returns `{ is_busy, loaded_model, current_job_id }`.

### GET /job-result/{job_id}
Poll for a completed job result (deletes after retrieval).

### POST /unload
Free GPU memory and unload the current model.

## Models

| Model | Steps | Quality | Speed (30s, M2 Pro) |
|-------|-------|---------|---------------------|
| `acestep-v15-turbo` | 8 | Good | ~45s |
| `acestep-v15-sft` | 32 | Best | ~3min |

## Memory Requirements

| RAM | Max Duration | Recommended Model |
|-----|-------------|-------------------|
| 8GB | 60s | turbo + 0.6B LM |
| 16GB | 120s | turbo + 0.6B LM |
| 24GB | 300s | turbo + 1.7B LM |
| 48GB+ | 600s | sft + 4B LM |
