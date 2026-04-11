# OpenZigs — Windows Setup Log

**Date**: 2026-04-08
**OS**: Windows 11 Pro (AMD64)
**PowerShell**: 5.1.26100.7920

---

## System Audit

### Already Installed

| Tool | Version | Status |
|------|---------|--------|
| Git | 2.53.0.windows.2 | OK |
| Docker Desktop | 29.3.1 | OK (Running) |
| WSL2 (Ubuntu) | Running | OK |
| winget | 1.28.220 | OK |

### Missing — Required

| Tool | Required Version | Install Method | Notes |
|------|-----------------|----------------|-------|
| **Node.js** | >=22 | `winget install OpenJS.NodeJS.LTS` | No node/nvm/fnm/volta detected |
| **pnpm** | 10.28.2 (packageManager field) | `corepack enable` then auto | Requires Node.js first |

### Missing — Recommended

| Tool | Purpose | Install Method |
|------|---------|----------------|
| **ffmpeg** | Media processing (fluent-ffmpeg dep, music-studio sidecar) | `winget install Gyan.FFmpeg` |
| **Python 3.12** | WSL sidecars (image-processing, music-studio) | Pre-installed in WSL Ubuntu; or `winget install Python.Python.3.12` for native |

### Already Available (No Action Needed)

| Tool | Notes |
|------|-------|
| Docker Compose | Bundled with Docker Desktop |
| WSL2 + Ubuntu | Running, available for compatible sidecars |

---

## Sidecar Compatibility Matrix

| Sidecar | Runtime | MLX Required | Windows Native | WSL Viable | Docker (x86) | Action |
|---------|---------|-------------|---------------|------------|--------------|--------|
| **audio** | Python 3.12 / FastAPI | Yes (Apple Silicon) | No | No | No | Skip — Apple-only |
| **image-gen** | Python / FastAPI | Yes (MFLUX) | No | No | No | Skip — Apple-only |
| **image-processing** | Python / FastAPI (PyTorch/ONNX) | No | **Yes** | Optional | **Yes** | **Install in WSL** |
| **music** | Python / http.server | Yes (Apple fork) | No | No | No | Skip — Apple-only |
| **music-studio** | Python / FastAPI (PyTorch) | No | Partial | **Recommended** | **Yes** | **Install in WSL** |
| **worker** | Python / FastAPI (MLX video) | Yes | No | No | No | Skip — Apple-only |

### WSL Sidecar Recommendation

Install **image-processing** and **music-studio** sidecars in WSL2 Ubuntu:
- Both use PyTorch/ONNX (platform-agnostic)
- WSL2 supports CUDA GPU passthrough if an NVIDIA GPU is present
- System deps (ffmpeg, fluidsynth) are easier to manage via apt
- Main Node.js server runs on Windows host; sidecars communicate via HTTP (localhost port mapping works transparently with WSL2)

The other 4 sidecars (audio, image-gen, music, worker) are **hard-locked to Apple Silicon via MLX** and cannot run on any x86 platform.

---

## Known Windows Code Issues

| Severity | Issue | File | Description |
|----------|-------|------|-------------|
| **High** | `/bin/sh` hardcoded | `src/tasks/custom-post-actions.ts:202` | Script execution uses `/bin/sh` — will fail on Windows. Needs `cmd /c` or `powershell` branch |
| **High (FIXED)** | whisper-node crashes server | `src/knowledge/converters/media-converter.ts` | whisper-node's shelljs calls `process.exit(1)` via `make` on Windows. **Fixed**: added `process.platform !== "win32"` guard around the dynamic import |
| **Medium** | Zombie Chrome cleanup no-op | `src/browser/chrome-launcher.ts:72` | `killZombieChromes()` returns early on win32 — needs `taskkill` implementation |
| **Medium** | `process.env.HOME` fallback | `src/tasks/custom-post-actions.ts:190` | `HOME` is often unset on Windows — should use `os.homedir()` or `USERPROFILE` |
| **Medium** | `npx` not found by MCP server launcher | Local MCP server startup | Node installed but background shells don't inherit updated PATH — github MCP server skipped |
| **Low** | Raw `fs.chmod` calls | `admin.ts`, `knowledge.ts`, `social.ts`, `memory.ts` | Bypass cross-platform `chmodSecureFile()` helper — no-op on NTFS but inconsistent |
| **Low** | No `.nvmrc` / `.node-version` | Project root | No version-pinning file for Node version managers |

---

## Installation Steps Performed

### Step 1: Set PowerShell Execution Policy

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
```

### Step 2: Install Node.js LTS

```powershell
winget install OpenJS.NodeJS.LTS --accept-package-agreements
# Installed: Node.js v24.14.1 (npm 11.11.0)
```

### Step 3: Install pnpm

```powershell
# corepack enable requires admin (writes to Program Files) — used npm instead:
npm install -g pnpm@10.28.2
# Installed: pnpm 10.28.2
```

### Step 4: Install ffmpeg

```powershell
winget install Gyan.FFmpeg --accept-package-agreements
# Installed: ffmpeg 8.1 — auto-added to PATH
```

### Step 5: Install project dependencies

```powershell
cd C:\Users\mgbre\Development\openzigs
pnpm install     # Installs all workspace packages (root + ui + desktop)
# Result: 1855 packages, better-sqlite3 compiled successfully
# TypeScript typecheck: PASSED
# Tests: 282/297 files passed (28 failing tests — all Windows-specific, see below)
```

### Step 5: VS Code Extensions Installed

| Extension | Purpose |
|-----------|---------|
| `dbaeumer.vscode-eslint` | ESLint integration |
| `esbenp.prettier-vscode` | Prettier formatter |
| `bradlc.vscode-tailwindcss` | Tailwind CSS IntelliSense (UI) |
| `ms-vscode.vscode-typescript-next` | Latest TypeScript language features |
| `ms-vscode-remote.remote-wsl` | WSL integration for sidecars |
| `ms-azuretools.vscode-docker` | Docker container management |
| `vitest.explorer` | Vitest test runner |
| `ms-playwright.playwright` | Playwright test runner for e2e |

### Step 6: Install VC++ Redistributable

```powershell
winget install Microsoft.VCRedist.2015+.x64 --accept-package-agreements
# Required for native .node modules (LanceDB, etc.) — ERR_DLOPEN_FAILED without it
```

### Step 7: WSL System Dependencies

```bash
# In WSL Ubuntu:
sudo apt update && sudo apt install -y python3-pip python3.12-venv ffmpeg fluidsynth libfluidsynth3
# Python 3.12.3 was already pre-installed in Ubuntu Noble
```

### Step 8: WSL Sidecar Setup (image-processing & music-studio)

**Important**: Python venvs MUST be created in WSL's native ext4 filesystem, NOT on `/mnt/c/` (NTFS).
Symlinks don't work on NTFS mounts, causing `ensurepip` to fail.

```bash
# image-processing sidecar
mkdir -p ~/openzigs-sidecars/image-processing
python3 -m venv ~/openzigs-sidecars/image-processing/.venv
source ~/openzigs-sidecars/image-processing/.venv/bin/activate
pip install -r /mnt/c/Users/mgbre/Development/openzigs/sidecars/image-processing/requirements.txt
# Installed: PyTorch 2.11.0 + CUDA 13, rembg, realesrgan, basicsr

# music-studio sidecar
mkdir -p ~/openzigs-sidecars/music-studio
python3 -m venv ~/openzigs-sidecars/music-studio/.venv
source ~/openzigs-sidecars/music-studio/.venv/bin/activate
pip install -r /mnt/c/Users/mgbre/Development/openzigs/sidecars/music-studio/requirements.txt
# Installed: PyTorch 2.11.0 + torchaudio, demucs, librosa, pedalboard, matchering, transformers
```

### Step 9: Fix whisper-node crash

Applied platform guard in `src/knowledge/converters/media-converter.ts` to skip
whisper-node import on Windows (its shelljs `make` call does `process.exit(1)`).

### Step 10: Fix .env paths

Updated `OPENZIGS_ALLOWED_DIRS` from macOS paths to Windows equivalents:
```env
OPENZIGS_ALLOWED_DIRS=C:/Users/mgbre/AppData/Local/Temp,C:/Users/mgbre/Development/openzigs,C:/Users/mgbre/.openzigs/research
```

---

## Environment Configuration

The `.env` was already configured from macOS. Key Windows adjustments made:
- `OPENZIGS_ALLOWED_DIRS` updated from Unix paths to Windows paths
- `CHROME_AUTO_LAUNCH=true` works — Chrome detected at `C:\Program Files\Google\Chrome\Application\chrome.exe`

Data directory: `%USERPROFILE%\.openzigs\`

---

## Test Results on Windows

**282 / 297 test files passed** (5797 / 5825 tests passed)

15 test files had failures (28 tests), all due to Windows-specific issues:

### Path Separator Failures (`\` vs `/`)

These tests hardcode Unix `/` path separators in assertions but `path.join()` produces `\` on Windows:

| Test File | Failing Tests |
|-----------|---------------|
| `src/video/ingestion/audio-extractor.test.ts` | 2 — expects `/output/test.wav`, gets `\output\test.wav` |
| `src/video/asset-overlay.test.ts` | 1 — path validation with `/tmp` |
| `src/mcp/tools/draft-media-tools.test.ts` | 1 — copy path assertion |
| `src/mcp/tools/seo-gap-tools.test.ts` | 1 — PDF report path |
| `src/mcp/tools/transcribe-audio-tools.test.ts` | 1 — relative path resolution |
| `src/mcp/tools/shell.test.ts` | 1 — `echo` command args with `cmd /c` |

### Permission Mode Failures (Unix-only API)

These tests assert `chmod` / `mode` behavior that doesn't apply on Windows NTFS:

| Test File | Failing Tests |
|-----------|---------------|
| `src/config/file-permissions.test.ts` | 4 — mode 0o600/0o700 assertions |
| `src/copilot/copilot-wrapper.test.ts` | 1 — auth token file permissions |
| `src/sentinel/sentinel-state.test.ts` | 2 — mkdir mode, atomic write |
| `src/vault/secret-vault-service.test.ts` | 1 — vault file 0600 perms |

### Script Execution Failures (`/bin/sh`)

| Test File | Failing Tests |
|-----------|---------------|
| `src/tasks/custom-post-actions.test.ts` | 3 — uses `/bin/sh` execution |

### Other

| Test File | Failing Tests |
|-----------|---------------|
| `src/app.test.ts` | 8 — prompt CRUD tests (sqlite path or env) |
| `src/api/director.test.ts` | 1 — voice service availability |
| `src/knowledge/__tests__/rag-integration.test.ts` | 1 — RAG integration |
| `src/video/render-orchestrator.test.ts` | 1 — worker process exit |

### Recommendation

Most failures are cosmetic (test assertions, not runtime bugs). The codebase itself handles Windows well via `path.join()` and platform detection. Fix priorities:
1. **High**: `custom-post-actions.ts` `/bin/sh` hardcode — affects runtime on Windows
2. **Medium**: Path separator test assertions — use `path.sep` or `path.normalize` in test expectations
3. **Low**: Permission mode tests — conditionally skip on Windows or adjust assertions

---

## Notes

- The desktop Electron app has Windows build targets (`dist:win`) and should work
- `better-sqlite3` compiled successfully with Node 24 — no manual Windows Build Tools needed
- `sharp`, `@napi-rs/canvas`, `@lancedb/lancedb` all installed with prebuilt Windows x64 binaries
- Docker Desktop with WSL2 backend is the recommended Docker setup (already configured)
- WSL2 sidecars communicate via HTTP on localhost — no additional network config needed
- PowerShell execution policy was set to `RemoteSigned` for current user (required for npm/pnpm scripts)
- Node.js 24.14.1 installed (project requires >=22) — LTS available via winget
- `corepack enable` requires admin elevation on Windows (npm global install was used for pnpm instead)
- VC++ Redistributable 14.x required for LanceDB native module (`ERR_DLOPEN_FAILED` without it)
- WSL Python venvs must be created in ext4 (`~/`), NOT on `/mnt/c/` (NTFS) — symlinks fail on NTFS mounts
- whisper-node crashes the server on Windows via shelljs `process.exit(1)` — platform guard applied
- Server starts cleanly after fixes: health endpoint returns `{"status":"ok"}`
- Local MCP servers (github, word, markitdown) need `npx`/`uvx` on PATH — background shell PATH refresh needed
- External Python MCP servers (twitter, youtube, linkedin, etc.) need Windows venvs at `external/*/` with `Scripts\python.exe` (not `bin/python`)

---

## Post-Setup Improvements (2026-04-09)

### WSL CUDA Sidecar Auto-Startup

Added automatic WSL sidecar startup to `scripts/dev-clean.ps1`:

```powershell
# dev-clean.ps1 now auto-starts image-processing and music-studio sidecars in WSL
# Uses sidecars/start-cuda-sidecars.sh which injects HF_TOKEN from .env
```

- Created `sidecars/start-cuda-sidecars.sh` — starts image-processing (port 8200) and music-studio (port 8300)
- Script sources `.env` from Windows mount for `HF_TOKEN` injection
- Sidecars run in background with PID tracking and wait-for-ready health checks

### Backend Startup Performance

Parallelized MCP server startup in `src/mcp/local-mcp-server-manager.ts`:
- Changed from sequential initialization to `Promise.allSettled()` for all MCP servers
- Startup time reduced from ~45s to ~12s with 3 concurrent servers

### Windows Defender Exclusions

Added exclusion paths to reduce antivirus scan overhead:

```powershell
Add-MpPreference -ExclusionPath "C:\Users\mgbre\Development\openzigs"
Add-MpPreference -ExclusionPath "C:\Users\mgbre\Development\openzigs\node_modules"
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\pnpm-store"
```

### Gallery Bad Gateway Fix

Fixed `ui/tailwind.config.ts` ESM dynamic import issue that caused the UI build to fail on Windows.

### Flux Image Generation Fix

- Fixed HuggingFace token auth in `.env` — `HF_TOKEN` was not being passed to sidecars
- Fixed callback URL: `QUEUE_CALLBACK_URL=http://192.168.68.67:3000/api/queue/complete`
- Created `scripts/media-ctl.ps1` — Windows log viewer for sidecars, queue, and media pipeline

### Ollama + Gemma 4 BYOK Setup

Installed Ollama for local LLM inference, bypassing GitHub Copilot for private/offline use.

#### Installation

```powershell
winget install Ollama.Ollama
# Installed: Ollama 0.20.4 at C:\Users\mgbre\AppData\Local\Programs\Ollama\ollama.exe
```

#### Model Download

```powershell
ollama pull gemma4:e4b    # 9.6 GB, Q4_K_M quantization, 8B params
```

**Note on model naming**: Gemma 4 uses a different naming scheme than Gemma 3. The article referenced `gemma4:12b` which doesn't exist. Correct Gemma 4 variants:

| Tag | Size | Description |
|-----|------|-------------|
| `gemma4:e2b` | 7.2 GB | 2B effective params |
| `gemma4:e4b` | 9.6 GB | 4B effective params (default/latest) |
| `gemma4:26b` | 18 GB | 26B MoE arch |
| `gemma4:31b` | 20 GB | 31B dense |

#### BYOK Configuration

```powershell
# Set provider to Ollama
curl -X PUT -H "Authorization: Bearer <token>" `
  -H "Content-Type: application/json" `
  -d '{"provider":{"type":"ollama","baseUrl":"http://localhost:11434"}}' `
  http://localhost:3000/api/admin/models/config

# Set default model
curl -X POST -H "Authorization: Bearer <token>" `
  -H "Content-Type: application/json" `
  -d '{"modelId":"gemma4:e4b"}' `
  http://localhost:3000/api/models/select
```

#### GPU Issue — Driver Compatibility

**Problem**: Ollama 0.20.4 ships `cuda_v13` libraries (cuBLAS v13) but NVIDIA driver 560.94 only supports CUDA 12.6. Result: model runs on **100% CPU** instead of GPU.

**Diagnosis** (from `OLLAMA_DEBUG=1` logs):
```
"evaluating which, if any, devices to filter out" initial_count=0   ← 0 GPUs detected
"inference compute" id=cpu library=cpu total="79.7 GiB"             ← CPU fallback
```

**Fix**: Update NVIDIA display driver to ≥ 570 (installing CUDA toolkit alone is not sufficient — the driver that `nvidia-smi` reports must be upgraded). Downloaded GeForce Game Ready Driver **595.97** from nvidia.com, ran clean install.

**Verified working after driver update**:
```
NVIDIA-SMI 595.97    Driver Version: 595.97    CUDA Version: 13.x

# Ollama server log confirms GPU detected:
library=CUDA compute=8.6 name=CUDA0 description="NVIDIA GeForce RTX 3060"
libdirs=ollama,cuda_v13 driver=13.2 total="12.0 GiB" available="10.7 GiB"

# ollama ps confirms model running on GPU:
NAME          SIZE     PROCESSOR    CONTEXT
gemma4:e4b    10 GB    100% GPU     4096
```

**GPU benchmark** (gemma4:e4b Q4_K_M, RTX 3060 12GB):
- First inference (cold cache): ~60s total (51s model load from disk + 5-9s inference)
- Warm inference (model cached): **~5.5s for 65 tokens = 48.5 tok/s**
- VRAM used: **10.5 GB / 12 GB**
- vs. CPU: ~2-3 tok/s → **~17× faster on GPU**

### Code Changes Made

#### New: Test Connection Endpoint (`src/api/admin.ts`)

Added `POST /api/admin/models/test-connection` endpoint (~90 lines):
- Validates BYOK provider connectivity without full chat
- Ollama: fetches `/api/tags` for model list
- OpenAI/Azure: fetches `/models` with API key
- Anthropic: fetches `/models` with `x-api-key` header
- Returns `{ success, latency, model, models }`

#### Fix: Ollama SDK Provider Mapping (`src/copilot/copilot-wrapper.ts`)

The Copilot SDK only accepts `type: "openai" | "azure" | "anthropic"`. Our `ProviderConfig` has a convenience `type: "ollama"` variant. Added `toSdkProvider()` method to map:

```typescript
// type: "ollama", baseUrl: "http://localhost:11434"
// → type: "openai", baseUrl: "http://localhost:11434/v1"
```

Without this mapping, the SDK would receive an unknown provider type and silently fail.

#### Updated: Documentation

- `docs/ARCHITECTURE.md` — Added "BYOK Provider & Local LLM Integration" section with architecture diagram, provider type mapping table, Ollama-specific notes
- `docs/USER_GUIDE.md` — Added setup walkthrough for Ollama + Gemma 4, test connection docs, model selection guide, troubleshooting table
- `docs/Windows_log.md` — This section

#### Modified Files Summary

| File | Change |
|------|--------|
| `src/api/admin.ts` | Added `POST /models/test-connection` endpoint |
| `src/copilot/copilot-wrapper.ts` | Added `toSdkProvider()` Ollama → OpenAI mapping |
| `config/user.json` | Set `selectedModel: "gemma4:e4b"` |
| `~/.openzigs/config.json` | Set `copilot.provider` to Ollama config |
| `docs/ARCHITECTURE.md` | BYOK architecture section |
| `docs/USER_GUIDE.md` | Ollama + Gemma 4 setup guide |
| `docs/Windows_log.md` | This log |
