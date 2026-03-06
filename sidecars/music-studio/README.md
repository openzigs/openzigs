# Music Studio Sidecar

Voice2Voice pipeline and Smart Remix Lab sidecar for the OpenZigs media queue system.

## Architecture

3-stage pipeline running on Apple Silicon (CPU or MPS):

1. **Stem Separation** (Demucs v4) — Separates vocals from instrumentals
2. **Voice Conversion** (Seed-VC) — Zero-shot vocal timbre conversion using a reference audio clip
3. **Final Mixdown** (pydub) — Recombines converted vocals with the instrumental

> **Note:** The legacy `apply_rvc.py` and `rvc_infer.py` files contain placeholder stubs and are not used by the production pipeline. The active implementation uses `apply_seedvc.py` (Seed-VC zero-shot conversion).

## Setup

```bash
cd sidecars/music-studio
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### System Dependencies

```bash
brew install ffmpeg       # Required by pydub for audio format conversion
brew install fluidsynth   # Required for MIDI/soundfont support
```

### Voice Reference Files

Place short reference audio clips (3–10 seconds) in `~/.openzigs/voice-references/`:

```
~/.openzigs/voice-references/
  artist_name.wav       # 3-10s reference clip for Seed-VC zero-shot conversion
```

## Running

```bash
# Activate venv
source .venv/bin/activate

# Start the sidecar (default port 5010)
python server.py

# With custom port
python server.py --port 5010

# With MPS acceleration (Apple Silicon)
MUSIC_STUDIO_DEVICE=mps python server.py
```

## API

### POST /generate

Submit a voice2voice job. Returns 202 immediately.

```json
{
  "job_id": "uuid",
  "source_asset_id": "gallery-asset-id",
  "voice_model": "artist_name",
  "pitch_shift": 0,
  "index_rate": 0.75,
  "filter_radius": 3,
  "vocal_volume": 1.0,
  "instrumental_volume": 1.0,
  "output_format": "wav",
  "callback_url": "http://localhost:3000/api/queue/complete",
  "progress_url": "http://localhost:3000/api/queue/progress"
}

### GET /health

Health check + worker busy status.

### GET /status/{job_id}

Get current pipeline stage and progress for a job.

### GET /models

List available RVC voice models.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GALLERY_DIR` | `~/.openzigs/gallery` | Path to media asset files |
| `RVC_MODELS_DIR` | `~/.openzigs/rvc-models` | Path to RVC model directories |
| `MUSIC_STUDIO_AUTH_TOKEN` | _(none)_ | Bearer token for auth |
| `MUSIC_STUDIO_DEVICE` | `cpu` | Compute device (`cpu` or `mps`) |

## Standalone Script Usage

Each pipeline stage can be run independently:

```bash
# 1. Extract vocals
python extract_vocals.py input.wav --output-dir ./stems

# 2. Apply voice conversion
python apply_rvc.py stems/vocals.wav --voice-model artist_name --output converted.wav

# 3. Mix final output
python mix_audio.py converted.wav stems/no_vocals.wav --output final_mix.wav
```
