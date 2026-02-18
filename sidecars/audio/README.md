# Audio Sidecar — Local STT & TTS Server

FastAPI-based sidecar providing speech-to-text and text-to-speech inference on Apple Silicon using MLX-optimized models. Mirrors the architecture of the `image-gen` sidecar with lazy loading, idle auto-unload, and MPS acceleration.

## Models

| Capability | Model                            | Size   | Memory | Latency  |
| ---------- | -------------------------------- | ------ | ------ | -------- |
| **TTS**    | `mlx-community/Kokoro-82M-bf16` | ~330MB | ~400MB | ~0.3s/s  |
| **STT**    | `distil-large-v3` (Whisper)      | ~1.5GB | ~1.8GB | ~0.1s/s  |

## Quick Start

```bash
cd sidecars/audio

# Create virtual environment
python -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start server (lazy mode — no models loaded until first request)
python server.py
```

The server starts on `http://127.0.0.1:5006` by default.

## Endpoints

### `GET /health`

Readiness probe with model load status.

```bash
curl http://localhost:5006/health
```

```json
{
  "status": "ok",
  "ready": true,
  "tts_loaded": false,
  "stt_loaded": false,
  "tts_model": "mlx-community/Kokoro-82M-bf16",
  "stt_model": "distil-large-v3",
  "voice_count": 19
}
```

### `GET /voices`

List available TTS voice presets with language, gender, and style metadata.

```bash
curl http://localhost:5006/voices
```

### `POST /tts`

Synthesize text to speech. Returns a 24kHz WAV audio file.

```bash
curl -X POST http://localhost:5006/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, world!", "voice": "af_heart", "speed": 1.0}' \
  --output speech.wav
```

**Request body:**

| Field   | Type   | Default     | Description                    |
| ------- | ------ | ----------- | ------------------------------ |
| `text`  | string | _(required)_ | Text to synthesize (1–10,000 chars) |
| `voice` | string | `af_heart`  | Voice preset ID                |
| `speed` | float  | `1.0`       | Speed multiplier (0.5–2.0)     |

### `POST /transcribe`

Transcribe an audio file to text with segment-level timestamps.

```bash
curl -X POST http://localhost:5006/transcribe \
  -F "audio=@recording.wav" | jq
```

**Accepted formats:** wav, mp3, webm, m4a, ogg, flac

**Response:**

```json
{
  "text": "Hello, how are you?",
  "language": "en",
  "segments": [
    { "start": 0.0, "end": 1.5, "text": "Hello, how are you?" }
  ],
  "duration_seconds": 1.5
}
```

### `POST /unload`

Unload models to free RAM.

```bash
# Unload all models
curl -X POST "http://localhost:5006/unload?model=all"

# Unload TTS only
curl -X POST "http://localhost:5006/unload?model=tts"

# Unload STT only
curl -X POST "http://localhost:5006/unload?model=stt"
```

## Configuration

### CLI Arguments

```
--port            Port (default: 5006)
--host            Host (default: 127.0.0.1)
--tts-model       TTS model ID (default: mlx-community/Kokoro-82M-bf16)
--stt-model       STT model ID (default: distil-large-v3)
--idle-timeout    Auto-unload after N seconds idle (default: 0 = disabled)
```

### Environment Variables

| Variable             | Default                          | Description          |
| -------------------- | -------------------------------- | -------------------- |
| `AUDIO_PORT`         | `5006`                           | Server port          |
| `AUDIO_HOST`         | `127.0.0.1`                      | Bind address         |
| `AUDIO_TTS_MODEL`    | `mlx-community/Kokoro-82M-bf16`  | TTS model name       |
| `AUDIO_STT_MODEL`    | `distil-large-v3`                | STT Whisper model    |
| `AUDIO_IDLE_TIMEOUT` | `0`                              | Idle timeout (sec)   |

## Voice Presets

19 voices across 4 languages:

- **American English** — `af_heart`, `af_bella`, `af_nova`, `af_sarah`, `af_sky`, `am_adam`, `am_echo`, `am_liam`, `am_michael`
- **British English** — `bf_alice`, `bf_emma`, `bf_lily`, `bm_daniel`, `bm_george`, `bm_lewis`
- **Japanese** — `jf_alpha`, `jm_kumo`
- **Chinese** — `zf_xiaobei`, `zm_yunxi`

Voice ID format: `{language}{gender}_{name}` where language prefix is `a` (American), `b` (British), `j` (Japanese), `z` (Chinese) and gender is `f` (female) or `m` (male).

## Testing

```bash
pip install pytest httpx
pytest test_pipeline.py -v
```

## Engine B: GPT-SoVITS (Voice Cloning)

Engine B replaces Kokoro with [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — a high-fidelity voice cloning model that can mimic a speaker from a short reference audio clip.

### Requirements

- Python 3.9–3.11
- ~4 GB free disk space (pretrained models)
- ~8 GB RAM at inference time
- Apple Silicon (MPS) or CUDA GPU recommended; CPU-only works but is slow

### Quick Install

From the **repository root**, run the one-shot installer:

```bash
bash scripts/setup-gptsovits.sh
```

This will:
1. Clone [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) into `~/.openzigs/sidecars/gptsovits/`
2. Create a Python virtual environment and install all dependencies
3. Download the required pretrained models from Hugging Face (~2 GB)
4. Write a `start.sh` convenience launcher

### Starting the Server

```bash
~/.openzigs/sidecars/gptsovits/start.sh
```

Keep this terminal open. The server binds to `http://127.0.0.1:9880` by default.

To use a different port, pass `SOVITS_PORT=xxxx bash scripts/setup-gptsovits.sh` and update the audio sidecar's `--sovits-url` flag to match.

### Switching Engines

Once GPT-SoVITS is running:

1. Open **Admin → Voice Lab**
2. Click **Refresh** (↺ icon) — the "GPT-SoVITS" card should show green
3. Click **GPT-SoVITS (Engine B)** to activate

All subsequent `/tts` requests are proxied to GPT-SoVITS until you switch back to Engine A (Kokoro).

### Using Voice Cloning

GPT-SoVITS performs voice cloning by passing a `reference_audio` path and `prompt_text` in the `/tts` request body. Upload a reference audio file via **Voice Lab → Voice Profiles**, then select a profile in the Director wizard or via the API.

### Manual Start (without the installer)

```bash
cd ~/.openzigs/sidecars/gptsovits
source .venv/bin/activate
python api_v2.py --host 127.0.0.1 --port 9880
```

Or pass a custom URL when starting the audio sidecar:

```bash
python sidecars/audio/server.py --sovits-url http://127.0.0.1:9880
```

## Docker Support

The audio sidecar can run via Docker Compose (requires Apple Silicon host for MPS):

```yaml
# In docker-compose.yml
audio-sidecar:
  build: ./sidecars/audio
  ports:
    - "5006:5006"
  environment:
    - AUDIO_IDLE_TIMEOUT=300
```

## Memory Usage

| State               | RAM Usage  |
| ------------------- | ---------- |
| Server idle (no models) | ~50MB  |
| TTS only loaded     | ~450MB     |
| STT only loaded     | ~1.9GB     |
| Both models loaded  | ~2.3GB     |

Models auto-unload after the configured idle timeout to reclaim memory.
