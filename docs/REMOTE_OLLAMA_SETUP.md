# Remote Ollama Node — Run Ollama on a Second Mac on Your LAN

This guide explains how to offload local-LLM inference from your primary
OpenZigs Mac to a second Mac on the same network. The remote machine runs the
upstream [Ollama](https://ollama.com/) daemon (already HTTP on port `11434`),
so there's no custom sidecar — OpenZigs just routes its existing Ollama client
through a configurable base URL.

This is the recommended setup when your primary Mac has < 36 GB unified memory
but you want to run the larger Gemma 4 31B (INT4) model on a beefier peer
(M3/M4 Max / Ultra with 36 GB+).

## Prerequisites

| Requirement      | Details                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| **Second Mac**   | Apple Silicon (M1 / M2 / M3 / M4). 36 GB+ unified memory recommended for `gemma4:31b`.   |
| **macOS**        | 13 Ventura or later.                                                                     |
| **Network**      | Both Macs on the same LAN / subnet (RFC1918 private range — `10.x`, `192.168.x`, `172.16–31.x`). |
| **Homebrew**     | Installed (`brew --version`).                                                            |

## Quick Start

### 1. Install Ollama on the remote Mac

```bash
brew install ollama
```

### 2. Bind to all interfaces and start the server

By default Ollama listens only on loopback (`127.0.0.1`). Override
`OLLAMA_HOST` so the peer Mac can reach it:

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

### 3. Pull the recommended model

In a second terminal on the remote Mac:

```bash
ollama pull gemma4:31b
# or any model your peer can host:
ollama pull qwen2.5:14b
ollama pull llama3.1:8b
```

### 4. Find the remote Mac's LAN IP

```bash
ipconfig getifaddr en0   # Wi-Fi
ipconfig getifaddr en1   # wired Ethernet (varies by hardware)
```

Note the IP (e.g. `192.168.1.50`).

### 5. Firewall

macOS Application Firewall may prompt to allow incoming connections the first
time a client hits the socket — accept it. If you have a stricter firewall in
front of the Mac, allow inbound TCP `11434` from the LAN range only.

### 6. Configure OpenZigs to use the remote node

Three equivalent ways. Pick one.

#### Admin UI (recommended)

1. Open **Admin → Ollama Node**.
2. Toggle **Network Node**.
3. Enter the **Network Node URL**: `http://192.168.1.50:11434`.
4. (Optional) Enter a **Bearer Token** if the peer is behind a reverse proxy
   that enforces `Authorization: Bearer …`.
5. Click **Test Connection** — you should see `✅ Ollama 0.x.y · N models`.
6. Click **Save**.

#### `~/.openzigs/config.json`

```jsonc
{
  "localLlm": {
    "ollama": {
      "mode": "network",
      "localUrl": "http://127.0.0.1:11434",
      "networkNodeUrl": "http://192.168.1.50:11434",
      "networkNodeToken": "" // optional
    }
  }
}
```

The file is written with `0o600` permissions.

#### Environment variables

Env vars take precedence over `config.json`:

```bash
export OLLAMA_MODE=network
export OLLAMA_NETWORK_URL=http://192.168.1.50:11434
export OLLAMA_NETWORK_TOKEN=""   # optional
```

### 7. Auto-start the remote Ollama with launchd (optional)

On the remote Mac, create `~/Library/LaunchAgents/com.ollama.serve.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.ollama.serve</string>
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/ollama</string>
      <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>OLLAMA_HOST</key><string>0.0.0.0:11434</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/tmp/ollama.out.log</string>
    <key>StandardErrorPath</key><string>/tmp/ollama.err.log</string>
  </dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.ollama.serve.plist
```

## Architecture

```
┌───────────────────────────┐     LAN (RFC1918)     ┌────────────────────────────┐
│   Primary Mac             │                       │   Peer Mac (36 GB+)        │
│                           │                       │                            │
│  OpenZigs server          │   GET /api/tags       │   ollama serve             │
│  ├─ LocalCopilotClient ───┼──────────────────────►│   ├─ gemma4:31b (INT4)     │
│  │   (Ollama HTTP)        │                       │   ├─ qwen2.5:14b           │
│  ├─ resolveOllamaTarget() │   POST /api/generate  │   └─ llama3.1:8b           │
│  │   → baseUrl + Bearer   │◄──────────────────────┤                            │
│  └─ Admin → Ollama Node   │                       │                            │
└───────────────────────────┘                       └────────────────────────────┘
```

The primary Mac never spawns an inference process. All token generation runs on
the peer's Metal/MLX path; OpenZigs just streams the response back to the user.

## Security Notes

- **LAN-only.** The SSRF guard (`isAllowedNetworkNodeUrl`) refuses loopback,
  `0.0.0.0`, cloud metadata endpoints (`169.254.169.254`,
  `metadata.google.internal`), and IPv6 link-local. RFC1918 private ranges
  (`10.x`, `192.168.x`, `172.16–31.x`) are allowed because they are the
  legitimate worker-node range. **Do not expose Ollama on a public IP.**
- **Optional Bearer token.** Ollama itself ships without auth. If you put it
  behind a reverse proxy (Caddy, Nginx, Cloudflare Tunnel) that requires
  `Authorization: Bearer …`, paste the token into the **Bearer Token** field
  — it's persisted to `~/.openzigs/config.json` with `0o600` and attached
  automatically to every outbound request.
- **No PII leaves your LAN.** Network-mode requests target only the URL you
  configured; OpenZigs does not phone home.

## Troubleshooting

| Symptom                                  | Likely cause                                                         | Fix                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| ❌ "URL points to a blocked internal/loopback host" | You entered `127.0.0.1` / `localhost` in network mode.            | Use the peer's LAN IP. For same-machine, switch the radio back to **Local**.   |
| ❌ Test Connection times out (5 s)        | `OLLAMA_HOST=0.0.0.0:11434` was not set; daemon is bound to loopback. | Restart `ollama serve` with the env var.                                       |
| ❌ `HTTP 401` from `/api/version`         | Reverse proxy in front of the peer rejected the request.             | Fill in the **Bearer Token** field with the proxy's expected token.            |
| Models list is empty                     | Daemon is reachable but no models pulled.                            | Run `ollama pull gemma4:31b` (or another model) on the peer.                   |

## See also

- [FLUXQ_SETUP.md](FLUXQ_SETUP.md) — same pattern for remote image generation.
- [USER_GUIDE.md](USER_GUIDE.md) — local-LLM provider basics.
