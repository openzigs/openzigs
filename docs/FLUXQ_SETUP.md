# Remote Image Generation — FluxQ Network Node Setup

This guide explains how to offload AI image generation from your primary OpenZigs
machine to a second Mac on the same local network. The remote machine runs a
headless Python sidecar (FluxQ) that serves Flux.1 or SDXL-Turbo diffusion
models on Apple Silicon MPS.

## Prerequisites

| Requirement | Details |
|-------------|---------|
| **Second Mac** | Apple Silicon (M1/M2/M3/M4) with ≥16 GB RAM |
| **macOS** | 13 Ventura or later |
| **Python** | 3.11 or 3.12 recommended (`python3 --version`). Python 3.13+ may require compiling packages from source; the setup script installs `cmake` and `pkg-config` automatically via Homebrew if needed. |
| **Network** | Both Macs on the same LAN/subnet |

## Quick Start

### 1. Run the setup script on the remote Mac

```bash
curl -fsSL https://raw.githubusercontent.com/mgcronin/openzigs/main/scripts/setup-fluxq-node.sh | bash
```

Or clone the repo and run locally:

```bash
git clone https://github.com/mgcronin/openzigs.git
cd openzigs
bash scripts/setup-fluxq-node.sh
```

The script:
- Creates `~/fluxq-node/` with a Python virtual environment.
- Installs PyTorch (MPS-enabled), diffusers, FastAPI, and dependencies.
- Downloads `server.py` from the repo.
- Generates a 64-character hex secret token (stored in `~/fluxq-node/.fluxq-token`).
- Creates a `.env` file and a `start.sh` convenience script.

### 2. Start the sidecar

```bash
cd ~/fluxq-node
./start.sh
```

The server binds to `0.0.0.0:5005` by default.

### 3. Note the IP address and token

The setup script prints the local IP at the end. You can re-check with:

```bash
ipconfig getifaddr en0   # Wi-Fi
ipconfig getifaddr en1   # Ethernet
```

The token is in `~/fluxq-node/.fluxq-token`.

### 4. Allow port 5005 through the macOS firewall

If the macOS firewall is enabled (System Settings → Network → Firewall):

- Go to **System Settings → Network → Firewall → Options**.
- Add Python (at `~/fluxq-node/.venv/bin/python3`) to the allowed list.
- Or temporarily disable the firewall for setup, then re-enable.

### 5. Configure OpenZigs to use the remote node

#### Option A: Admin UI

1. Open **Admin → Image Generation Node**.
2. Switch to **Network Node**.
3. Enter the **Node URL** (e.g. `http://192.168.1.50:5005`).
4. Paste the **Secret Token** from step 3.
5. Click **Test Connection** to verify.
6. Click **Save**.

#### Option B: Edit config directly

Edit `~/.openzigs/config.json`:

```json
{
  "imageGen": {
    "mode": "network",
    "networkNodeUrl": "http://192.168.1.50:5005",
    "networkNodeToken": "<paste-token-here>"
  }
}
```

#### Option C: Environment variables

```bash
export IMAGE_GEN_MODE=network
export IMAGE_GEN_NETWORK_URL=http://192.168.1.50:5005
export IMAGE_GEN_NETWORK_TOKEN=<paste-token-here>
```

## Auto-Start with launchd

To have FluxQ start automatically on boot:

```bash
cd ~/fluxq-node

# Edit the plist template (replace placeholders)
sed "s|__FLUXQ_DIR__|$HOME/fluxq-node|g; s|__USER__|$USER|g" \
  com.openzigs.fluxq.plist > ~/Library/LaunchAgents/com.openzigs.fluxq.plist

launchctl load ~/Library/LaunchAgents/com.openzigs.fluxq.plist
```

To stop/unload:

```bash
launchctl unload ~/Library/LaunchAgents/com.openzigs.fluxq.plist
```

Logs are written to `/tmp/fluxq-stdout.log` and `/tmp/fluxq-stderr.log`.

## Architecture

```
┌──────────────────────┐        HTTP + Bearer Token       ┌──────────────────────┐
│   Primary Mac        │ ──────────────────────────────── │   Remote Mac         │
│                      │   POST /generate                 │                      │
│   OpenZigs Server    │   GET  /health                   │   FluxQ Sidecar      │
│   (Express + UI)     │   POST /model                    │   (FastAPI + MPS)    │
│                      │                                  │                      │
│   ImageGenService    │◄─── JSON + PNG bytes ───────────│   Flux.1 / SDXL      │
│   mode: "network"    │                                  │   Apple Silicon GPU  │
└──────────────────────┘                                  └──────────────────────┘
```

- **All requests** to `/generate`, `/model`, and `/unload` require a
  `Authorization: Bearer <token>` header.
- **Health and model list** endpoints (`/health`, `/models`) are unauthenticated
  for easy discovery.
- The sidecar is stateless (no database). Model weights are downloaded on first
  use and cached in `~/.cache/huggingface/`.

## Switching Models

The default model is `sdxl-turbo` (fast, ~4s per image). To switch to Flux:

```bash
curl -X POST http://<remote-ip>:5005/model \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"model": "flux-schnell"}'
```

Available models: `flux-schnell`, `flux-dev`, `sdxl-turbo`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Connection refused` | Check the sidecar is running (`curl http://<ip>:5005/health`) and firewall allows port 5005. |
| `401 Unauthorized` | Token mismatch. Compare `~/fluxq-node/.fluxq-token` on the remote with the value in OpenZigs config. |
| `CUDA/MPS not available` | Ensure the remote Mac has Apple Silicon and macOS ≥13. Check `python3 -c "import torch; print(torch.backends.mps.is_available())"`. |
| `Failed building wheel for sentencepiece` (cmake not found) | The setup script now auto-installs `cmake` via Homebrew. If you see this, run `brew install cmake pkg-config` then re-run the script. Alternatively, use Python 3.12: `FLUXQ_PYTHON=python3.12 ./setup-fluxq-node.sh`. |
| Slow first generation | Normal. The model downloads weights from HuggingFace on first use (~2-5 GB). Subsequent runs use the cache. |
| Images look bad at 1920×1080 | Diffusion models produce best results at their native resolution (512×512 for SDXL-Turbo, 1024×1024 for Flux). The Director Mode compositor scales images to fill the frame. |

## Security Notes

- The Bearer token is a shared secret. **Do not expose port 5005 to the
  internet.** The sidecar is designed for trusted LAN use only.
- Token comparison uses `hmac.compare_digest` to prevent timing attacks.
- The token is stored with `0600` permissions in `~/.openzigs/config.json`.
