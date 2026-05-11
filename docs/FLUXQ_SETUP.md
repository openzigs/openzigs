# Remote Image Generation — FluxQ Network Node Setup

This guide explains how to offload AI image generation from your primary OpenZigs
machine to a second Mac on the same local network. The remote machine runs a
headless Python sidecar (FluxQ) that serves FLUX.1 models via [MFLUX](https://github.com/filipstrand/mflux)
(native MLX) on Apple Silicon.

## Prerequisites

| Requirement | Details |
|-------------|---------|
| **Second Mac** | Apple Silicon (M1/M2/M3/M4) with ≥16 GB RAM |
| **macOS** | 13 Ventura or later |
| **Python** | 3.10–3.13 (`python3 --version`). All versions supported (MFLUX has no ceiling). |
| **Network** | Both Macs on the same LAN/subnet |
| **HuggingFace account** | Required to download FLUX.1 models (gated). Create a free account at https://huggingface.co, accept the [FLUX.1-schnell license](https://huggingface.co/black-forest-labs/FLUX.1-schnell), then generate a read token at https://huggingface.co/settings/tokens. Add `HF_TOKEN=hf_…` to `~/fluxq-node/.env` before generating images. |

## Quick Start

### 1. Run the setup script on the remote Mac

```bash
curl -fsSL https://raw.githubusercontent.com/openzigs/openzigs/main/scripts/setup-fluxq-node.sh | bash
```

Or clone the repo and run locally:

```bash
git clone https://github.com/openzigs/openzigs.git
cd openzigs
bash scripts/setup-fluxq-node.sh
```

The script:
- Creates `~/fluxq-node/` with a Python virtual environment.
- Installs MFLUX (native MLX for Apple Silicon), FastAPI, and Python dependencies.
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

> **Tip:** you can automatically register the launchd service by setting
> `FLUXQ_INSTALL_SERVICE=1` before running the setup script.  The script will
> copy the plist into `~/Library/LaunchAgents` and `launchctl load` it for
> you.  Use `launchctl unload …` later to stop it.


The setup script prints the local IP at the end. You can re‑check with one of the
following; the correct interface name depends on your hardware and whether you
are on Wi‑Fi or wired Ethernet.

```bash
# common names; try each until you see an address
ipconfig getifaddr en0   # usually Wi‑Fi
ipconfig getifaddr en1   # often Ethernet
ipconfig getifaddr en2   # fallback on some machines
```

If none of the above produce output, run `ifconfig` and look for the `inet`
address under the active adapter, or use:

```bash
ifconfig | awk '/inet /{print $2}' | grep -v '^127\.'
```

(macOS sometimes uses `bridge0`, `p2p0`, etc. depending on configuration.)

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

# Edit the plist template (replace placeholders) and copy it to your
# LaunchAgents directory. Run these as two separate commands (or join with
# `&&`); do **not** try to paste them on one line or you'll get a “Not a
# directory” error as in the example above.

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
│                      │   POST /generate-async (→ 202)   │                      │
│   OpenZigs Server    │   POST /img2img-async  (→ 202)   │   FluxQ Sidecar      │
│   (Express + Next)   │   POST /kontext-async  (→ 202)   │   (FastAPI + MPS)    │
│                      │   GET  /health                   │                      │
│   QueueMaster        │   POST /model                    │   FLUX.1 (MFLUX/MLX) │
│   MediaQueue         │   GET  /job-result/{id} ◄──────  │   Apple Silicon GPU  │
│   (SQLite)           │                                  │                      │
│                      │◄── POST /api/queue/complete ─────│   Result store       │
│   Gallery            │       (callback on completion)   │   (in-memory, ≤100)  │
│   ~/.openzigs/gallery│                                  │                      │
└──────────────────────┘                                  └──────────────────────┘
```

**Job flow (happy path):**
1. `QueueMaster` dispatches a job via `POST /generate-async` (or `/img2img-async`, `/kontext-async`). FluxQ responds **202 Accepted** immediately.
2. FluxQ generates the image in the background and POSTs the result (including base64 image bytes) back to the primary Mac's `QUEUE_CALLBACK_URL` (`/api/queue/complete`).
3. The webhook handler saves the image to `~/.openzigs/gallery/` and creates a gallery asset record in SQLite.

**Polling fallback (for asymmetric networks):**
If the callback POST fails (e.g., router AP/client isolation where the worker cannot reach the primary Mac), `QueueMaster` automatically polls `GET /job-result/{job_id}` on the worker for any job dispatched more than 3 minutes ago. FluxQ stores results in memory (up to 100 jobs); results are acknowledged and deleted after the primary Mac fetches them.

- **All requests** to `/generate-async`, `/img2img-async`, `/kontext-async`, `/model`, and `/unload` require an `Authorization: Bearer <token>` header.
- **Health, model list, and job polling** endpoints (`/health`, `/models`, `/job-result/{id}`) are unauthenticated for easy discovery and fallback polling.
- The sidecar is stateless (no database). The in-memory result store is only for polling fallback. Model weights are downloaded on first use and cached in `~/.cache/huggingface/`.

## Switching Models

The default model is `flux-schnell` (fast, 4 inference steps, ~25–36s per image on M2 Pro 32 GB).
To switch to `flux-dev` (25 steps, higher quality, ~3–4× slower):

```bash
curl -X POST http://<remote-ip>:5005/model \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"model": "flux-dev"}'
```

Available models: `flux-schnell` (4-step, fast) and `flux-dev` (25-step, higher quality).

### Resolution Performance (M2 Pro 32 GB, flux-schnell, 4 steps, int4)

| Resolution | Time | Notes |
|---|---|---|
| 512×512 | ~95s\* | First run per shape (MLX JIT recompile) |
| 768×432 | ~36s | 16:9 video — recommended for Director Mode |
| 1024×576 | ~35s | 16:9 HD |
| 1024×1024 | ~25s | Fastest; FLUX native square resolution |

\* The first generation at each unique resolution shape triggers an MLX JIT compilation (~60–90s overhead). Subsequent generations at the same shape are fast.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Connection refused` | Check the sidecar is running (`curl http://<ip>:5005/health`) and firewall allows port 5005. |
| `401 Unauthorized` | Token mismatch. Compare `~/fluxq-node/.fluxq-token` on the remote with the value in OpenZigs config. |
| Jobs stuck in `dispatched` after 3+ minutes | The callback POST from FluxQ → primary Mac is failing (check for `[Errno 65] No route to host` in FluxQ logs). The polling fallback should recover the result automatically after ~3 min. If it doesn't, verify `QUEUE_CALLBACK_URL` is a reachable LAN IP, not `localhost`. |
| `MLX not available` | Ensure the remote Mac has Apple Silicon (M1–M4) and macOS ≥13. Check `python3 -c "import mlx.core as mx; print(mx.default_device())"`. |
| `GatedRepoError: 401 Client Error` / `Cannot access gated repo` | FLUX.1 models are gated on HuggingFace. Perform all of the following:
<br>• accept the license at https://huggingface.co/black-forest-labs/FLUX.1-schnell (must be done per account even if you use the same token elsewhere)
<br>• create a read token at https://huggingface.co/settings/tokens or reuse an existing one
<br>• run `grep HF_TOKEN ~/.env` to make sure it’s set correctly (no stray quotes/newlines)
<br>• verify the token can access the repo: `curl -H "Authorization: Bearer $HF_TOKEN" https://huggingface.co/api/models/black-forest-labs/FLUX.1-schnell` (should return JSON, not 401)
<br>• restart the sidecar (`launchctl unload ... && launchctl load ...`) so the token is read from `.env` or `~/.cache/huggingface/token` (the setup script now copies it there automatically). |
| `Failed building wheel for mflux` | Ensure Python 3.10–3.13 is installed. Run `pip install --upgrade pip` then retry. |
| `ipconfig getifaddr en0` prints nothing | The interface name may not be `en0` on your machine. Try `en1` or `en2`, or run `ifconfig` to discover the active adapter's `inet` address. |
| `cp … Not a directory` when installing plist | You accidentally combined the copy and launchctl commands on one line. Run the `cp`/`sed` step and `launchctl load` as separate commands (or join with `&&`). |
| Slow first generation | Normal. The model downloads weights from HuggingFace on first use (~2-5 GB). Subsequent runs use the cache. |
| Images look bad at 1920×1080 | FLUX.1 produces best results at native resolution. Recommended: 1024×1024 (~25s), 1024×576 16:9 HD (~35s), or 768×432 video 16:9 (~36s) on M2 Pro 32 GB. The Director compositor upscales to fill the frame. |

## Security Notes

- The Bearer token is a shared secret. **Do not expose port 5005 to the
  internet.** The sidecar is designed for trusted LAN use only.
- Token comparison uses `hmac.compare_digest` to prevent timing attacks.
- The token is stored with `0600` permissions in `~/.openzigs/config.json`.

## See also

- [REMOTE_OLLAMA_SETUP.md](REMOTE_OLLAMA_SETUP.md) — the same "second-Mac on the LAN" pattern for local-LLM inference (Ollama / Gemma 4).
