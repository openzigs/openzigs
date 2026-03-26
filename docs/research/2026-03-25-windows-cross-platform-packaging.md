# Research: Windows Compatibility & Cross-Platform Packaging for OpenZigs
**Date**: 2026-03-25
**Sources**: Local codebase, Node.js docs, Electron Builder docs, Ollama/Open WebUI repos, Tauri docs
**Used for**: Evaluating Windows compatibility gaps and distribution strategy options
---

## Research Summary

### Sources Consulted
| Source | Type | Key Findings |
|--------|------|-------------|
| `package.json` | Local | ESM TypeScript, Node >=22, pnpm 10.28, native deps (sharp, better-sqlite3, @napi-rs/canvas) |
| `install.sh` | Local | Bash-only, Homebrew-dependent, Apple Silicon sidecars, interactive sidecar menu |
| `install.ps1` | Local | PowerShell Windows installer exists, explicitly skips all AI sidecars, uses `$env:USERPROFILE\.openzigs` |
| `uninstall.sh` / `uninstall.ps1` | Local | Both exist — sh uses docker compose down, ps1 uses Get-NetTCPConnection for port cleanup |
| `src/config/index.ts` | Local | Uses `os.homedir()`, mode `0o600`/`0o700` perms, `path.join()` throughout |
| `src/server.ts` | Local | `import "dotenv/config"` at top, SIGINT/SIGTERM handlers, Chrome launcher with win32 paths |
| `src/project-root.ts` | Local | Uses `import.meta.url` + `path.resolve` — cross-platform safe |
| `src/mcp/docker-sidecar-manager.ts` | Local | Hardcoded Unix socket paths (`/var/run/docker.sock`, macOS Docker Desktop paths), no Windows named pipe |
| `src/mcp/local-mcp-server-manager.ts` | Local | Spawns `uvx`, `npx`, `jbang` — all cross-platform if installed |
| `src/browser/chrome-launcher.ts` | Local | Has `win32` Chrome paths, uses `os.platform()` — already cross-platform aware |
| `docker-compose.yml` | Local | Standard compose v3.9, audio-sidecar only active Docker service |
| `Dockerfile` | Local | Debian-based, `useradd`/`chown` (Linux-only), installs ffmpeg/imagemagick/ghostscript |
| `scripts/dev-clean.sh` / `dev-clean.ps1` | Local | Both exist — bash uses `lsof`, ps1 uses `Get-NetTCPConnection` |
| Node.js `os` module docs | Web | `os.homedir()` → `$USERPROFILE` on Windows, `os.tmpdir()` → `%TEMP%`, `os.platform()` → `"win32"` |
| Node.js SEA docs | Web | Single Executable Applications: `--build-sea`, supports Windows/macOS/Linux, needs bundled script |
| Electron Builder docs | Library | NSIS (default Windows target), MSI via WiX, DMG/ZIP for macOS, AppImage/deb/rpm for Linux |
| Ollama repo | Web | Go binary, uses `OllamaSetup.exe` (NSIS), `install.ps1`, distributed via brew/winget/pacman/nix |
| Open WebUI repo | Web | Docker-first (`pip install` fallback), no native installer — Docker Desktop is the Windows strategy |
| Tauri docs | Web | Rust+webview, <600KB apps, system webview (no bundled Chromium), supports all platforms |

---

### Requirements Extracted

#### Functional Requirements
1. **FR-001**: Core Node.js backend (text/tool agent) must run on Windows without AI sidecars *(Source: install.ps1 already declares this)*
2. **FR-002**: `~/.openzigs` data directory must resolve correctly on Windows via `os.homedir()` → `C:\Users\<user>\.openzigs` *(Source: config/index.ts)*
3. **FR-003**: File permission modes (`0o600`, `0o700`) must degrade gracefully on Windows (NTFS ignores POSIX modes) *(Source: config/index.ts, sentinel-state.ts, copilot-wrapper.ts, vault-service.ts)*
4. **FR-004**: Docker socket connection must support Windows named pipes (`//./pipe/docker_engine`) *(Source: docker-sidecar-manager.ts)*
5. **FR-005**: Process signal handling (SIGINT/SIGTERM) must work on Windows (Node.js emulates SIGINT on Ctrl+C; SIGTERM is not natively supported) *(Source: server.ts line 2806-2807)*
6. **FR-006**: Shell execution tools (`shell-execute`, custom post-actions) must use platform-appropriate shells *(Source: custom-post-actions.ts, shell.test.ts)*
7. **FR-007**: Chrome launcher already has win32 paths — no change needed *(Source: chrome-launcher.ts)*

#### Non-Functional Requirements
1. **NFR-001**: Installation must be achievable by non-programmers on Windows (one-click or near-one-click) *(Source: research goal)*
2. **NFR-002**: App size should be reasonable (<500MB excluding optional AI models) *(Source: comparison with Ollama ~100MB, Open WebUI Docker ~2GB)*
3. **NFR-003**: Auto-update mechanism for Windows distribution *(Source: electron-builder supports this natively)*

#### Business Rules
1. **BR-001**: AI sidecars (image-gen, audio, music, music-studio, video) are Apple Silicon (MLX) only — must be clearly communicated as unavailable on Windows *(Source: install.ps1 already states this)*
2. **BR-002**: The `.env` file with secrets should never be committed to git *(Source: already in .gitignore)*

---

### Windows Compatibility Audit

#### Already Cross-Platform (Good)
| Component | Evidence |
|-----------|----------|
| `project-root.ts` | Uses `import.meta.url` + `path.resolve()` — fully cross-platform |
| Config loading (`config/index.ts`) | Uses `path.join()`, `os.homedir()`, no hardcoded separators |
| Chrome launcher | Has explicit `win32` binary paths at `chrome-launcher.ts:39-42` |
| PowerShell installer | Full `install.ps1` with prerequisite checks, `winget` support |
| PowerShell dev-clean | `scripts/dev-clean.ps1` mirrors `dev-clean.sh` functionality |
| PowerShell uninstaller | `uninstall.ps1` with process cleanup via `Get-NetTCPConnection` |
| Shell test | `shell.test.ts:7-8` has `process.platform === "win32"` check |
| Local MCP servers | Uses `StdioClientTransport` (stdin/stdout) — cross-platform |
| `.env` loading | `dotenv/config` at `server.ts:1` — reads `.env` from `process.cwd()`, works on all platforms |
| Session/SQLite storage | `better-sqlite3` works on Windows, data at `os.homedir()/.openzigs/` |

#### Issues Requiring Fixes (Moderate Priority)
| Issue | Location | Severity | Fix |
|-------|----------|----------|-----|
| **Docker socket paths** — only Unix sockets, no Windows named pipe | `docker-sidecar-manager.ts:13-26` | Medium | Add `//./pipe/docker_engine` to candidates when `process.platform === "win32"` |
| **File permission modes** — `0o600`/`0o700` are no-ops on Windows NTFS | 20+ locations across codebase | Low | These are silently ignored on Windows — functionally harmless but misleading. Consider wrapping in a helper that skips `chmod` on win32. |
| **SIGTERM handling** — Windows doesn't have native SIGTERM | `server.ts:2807` | Low | Node.js on Windows emits SIGINT for Ctrl+C. SIGTERM only works via `process.kill()`. The graceful shutdown will still work for normal scenarios. |
| **Hard link in Remotion** — `fs.linkSync()` | `remotion/media-resolver.ts:86` | Low | Hard links work on NTFS but may fail without admin privileges. Consider `fs.copyFileSync()` fallback. |
| **launchd plist files** — macOS-only process management | `sidecars/*.plist` | N/A | macOS-only; Windows would need Windows Service or Task Scheduler equivalent. Only relevant for sidecars which are already Apple Silicon-only. |
| **macOS TTS** — `process.platform !== "darwin"` guard | `video/producer/macos-tts.ts:23` | N/A | Already guarded — returns false on non-darwin. No fix needed. |
| **lsof usage** in dev-clean.sh | `scripts/dev-clean.sh` | N/A | Already has PS1 equivalent |

#### Non-Issues (Already Handled)
- `os.homedir()` resolves to `C:\Users\<username>` on Windows (confirmed by Node.js docs)
- `path.join()` used consistently (handles `\` vs `/` transparently)
- `os.tmpdir()` resolves to `%TEMP%` on Windows
- `os.devNull` is `\\.\nul` on Windows (Node.js handles this)
- `dotenv` reads `.env` from CWD — works identically on Windows

---

### Sidecar Analysis

| Sidecar | Directory | Runtime | Platform | Docker? | Windows Compatible? |
|---------|-----------|---------|----------|---------|-------------------|
| **Audio (STT + TTS)** | `sidecars/audio/` | Python (MLX, Kokoro, Whisper) | Apple Silicon | Has Dockerfile | **No** — requires MLX (Apple Metal) |
| **Image Generation** | `sidecars/image-gen/` | Python (MFLUX/Flux.1) | Apple Silicon | No Dockerfile in dir | **No** — requires MLX |
| **Music Generation** | `sidecars/music/` | Python (ACE-Step 1.5) | Apple Silicon (Python 3.11) | No | **No** — requires specific Python + Metal |
| **Music Studio** | `sidecars/music-studio/` | Python (Demucs, Seed-VC) | Apple Silicon | No | **Partially** — Demucs works on CPU; Seed-VC may need GPU |
| **Video (LTX)** | `sidecars/worker/` | Python (LTX-Video) | Apple Silicon (M2 Pro+) | No | **No** — requires MLX |
| **GPT-SoVITS** | External install | Python | Mixed | No | **Partially** — has Windows support upstream |

**Conclusion**: All sidecars are Apple Silicon (MLX/Metal) optimized. The core text/tool agent works without them. Windows users get full text agent + web search + browser + shell + task management + all MCP tools except media generation.

---

### .env File Analysis

#### Current Setup
- **Location**: Project root (`/Users/matthewcronin/Development/openzigs/.env`)
- **Loading**: `import "dotenv/config"` at `server.ts:1` — reads from `process.cwd()`
- **Security**: Listed in `.gitignore` (assumed), file permissions `0o600` when written by admin routes
- **Admin writes**: `src/api/admin.ts:832` writes `.env` with `mode: 0o600`

#### Config Layering (from `config/index.ts:662-678`)
1. `config/default.json` (project defaults)
2. `~/.openzigs/config.json` (user overrides, created with `0o600` perms)
3. Environment variables (via `${ENV_VAR}` interpolation in JSON values)
4. `.env` file (loaded by `dotenv` before config loading)

#### Security Considerations
- `.env` in project root is standard for development
- For production/installed mode, secrets should be in `~/.openzigs/config.json` (already supported) or native credential stores
- On Windows, `0o600` is a no-op — file is readable by any user on the system. For sensitive data, consider Windows DPAPI or Credential Manager integration in a future release.

#### Best Practice Recommendation
- Keep `.env` in project root for development (current pattern is fine)
- For installed apps (`install.ps1` clones to `~/.openzigs`), `.env` lives inside `~/.openzigs/.env` — this is the user's private directory
- No change needed for current architecture

---

### `~/.openzigs` on Windows

#### How `os.homedir()` Works on Windows
- Returns `$USERPROFILE` environment variable (e.g., `C:\Users\matthewcronin`)
- Falls back to reading the user's profile directory from the OS
- **Result**: `~/.openzigs` → `C:\Users\<user>\.openzigs`

#### Windows App Data Conventions
| Location | Env Var | Usage |
|----------|---------|-------|
| `%LOCALAPPDATA%` (`C:\Users\X\AppData\Local`) | `LOCALAPPDATA` | Machine-specific data, caches, large files |
| `%APPDATA%` (`C:\Users\X\AppData\Roaming`) | `APPDATA` | Roaming user data (syncs across domain machines) |
| `%USERPROFILE%` (`C:\Users\X`) | `USERPROFILE` | User home directory |

#### Assessment
- Using `~/.openzigs` (i.e., `C:\Users\X\.openzigs`) is **acceptable** and follows the pattern used by:
  - Ollama (`%USERPROFILE%\.ollama`)
  - Docker (`%USERPROFILE%\.docker`)
  - npm (`%USERPROFILE%\.npm`)
  - SSH (`%USERPROFILE%\.ssh`)
- The "proper" Windows convention would be `%LOCALAPPDATA%\OpenZigs`, but the dotfile convention is widely used by developer tools
- **Recommendation**: Keep `~/.openzigs` for now. It's consistent across platforms, already works via `os.homedir()`, and matches developer expectations. Consider adding an `OPENZIGS_DATA_DIR` env var override (already supported in docker-compose.yml — extend to native mode).

---

### Windows Installer / Packaging Options

#### Option 1: PowerShell Script (Current Approach)
- **Pros**: Already exists (`install.ps1`), zero dependencies, clones git repo + runs `pnpm install`
- **Cons**: Requires Git, Node.js, pnpm pre-installed; not discoverable; no Start Menu integration; no auto-update
- **Target audience**: Developers who are comfortable with terminal

#### Option 2: Node.js Single Executable Application (SEA)
- **How**: `node --build-sea` bundles a single JS file into a standalone executable
- **Pros**: No Node.js install required, single `.exe` file
- **Cons**: Only bundles one script — can't include `node_modules` with native addons (sharp, better-sqlite3, @napi-rs/canvas); would need all deps bundled via Webpack/esbuild; native modules are a dealbreaker
- **Verdict**: **Not viable** for OpenZigs due to native dependencies (sharp, better-sqlite3, canvas)

#### Option 3: Electron Wrapper
- **How**: Wrap the existing Next.js UI in Electron, bundle the Express backend as a child process
- **Pros**: Full desktop experience, system tray, NSIS installer, auto-update via `electron-updater`, Start Menu entry
- **Cons**: +100MB overhead (Chromium), complex build pipeline, two separate processes to manage
- **electron-builder NSIS config**: `"win": { "target": "nsis" }`, supports x64/ia32/arm64
- **Verdict**: **Best option for non-programmer distribution** if you want a polished desktop app

#### Option 4: Tauri Wrapper
- **How**: Rust-based, uses system WebView2 (pre-installed on Windows 10+)
- **Pros**: ~600KB base size (vs 100MB Electron), native performance, system webview
- **Cons**: Backend must be Rust or spawned as a sidecar process; WebView2 on Windows can have version issues; less mature plugin ecosystem
- **Verdict**: **Viable but higher complexity** — would need to spawn the Node.js backend as a child process

#### Option 5: Docker Desktop (Container Distribution)
- **How**: `docker compose up` — already works
- **Pros**: Zero platform-specific code, consistent environment, already configured
- **Cons**: Docker Desktop is 2GB+ install, requires WSL2 on Windows, overhead for casual users
- **This is how Open WebUI distributes** — works well for technical users
- **Verdict**: **Good for technical users**, not for general audience

#### Option 6: Package Manager Distribution
| Manager | Coverage | Effort |
|---------|----------|--------|
| **winget** | Pre-installed on Windows 11, available on 10 | Submit manifest to `winget-pkgs` repo; needs MSI or MSIX |
| **Chocolatey** | Popular with developers | `choco push` with `.nupkg`; moderate effort |
| **Scoop** | JSON manifest, very simple | Submit bucket; easy for portable apps |
| **Homebrew** | macOS/Linux | Already possible; `brew tap openzigs/tap` |

**Recommendation**: Start with **Scoop** (easiest, developer-friendly) then **winget** for broader reach.

#### Option 7: npx Distribution
- **How**: `npx openzigs` or `pnpm dlx openzigs`
- **Pros**: Zero install beyond Node.js, familiar to JS developers
- **Cons**: Requires Node.js 22+, native module compilation at install time (sharp, better-sqlite3), slow first run
- **Verdict**: **Good for developers**, not for general users

---

### How Similar Projects Distribute

| Project | Strategy | Windows | Notes |
|---------|----------|---------|-------|
| **Ollama** | Go binary + NSIS installer | `OllamaSetup.exe` via GitHub Releases | Also `winget`, `choco`, `scoop` |
| **LM Studio** | Electron app | `.exe` installer | Full desktop app with model management |
| **Jan.ai** | Electron app | `.exe` installer | Open source, uses electron-builder |
| **Open WebUI** | Docker + pip | Docker Desktop | No native Windows installer |
| **AnythingLLM** | Electron app | `.exe` installer | Similar to OpenZigs (Node.js + AI tools) |
| **Msty** | Electron app | `.exe` installer | Multi-model desktop client |
| **LocalAI** | Go binary + Docker | Docker compose | Similar to Ollama approach |

**Pattern**: Most successful local AI tools use either **Go/Rust native binary** (Ollama) or **Electron** (LM Studio, Jan, AnythingLLM) for Windows distribution.

---

### Technology Recommendations

#### Recommended Distribution Strategy (Tiered)

**Tier 1 — Immediate (Developer audience)**
1. Keep and improve `install.ps1` — already works
2. Publish to **Scoop** bucket for `scoop install openzigs`
3. Docker Compose remains the "runs anywhere" fallback

**Tier 2 — Medium term (Broader audience)**
1. **Electron wrapper** using `electron-builder` with NSIS target
   - Bundle Express backend + Next.js build as child process
   - System tray icon for start/stop
   - Auto-update via GitHub Releases
2. Publish to **winget** and **Chocolatey**

**Tier 3 — Long term (Non-programmer audience)**
1. Consider **Tauri** for a lightweight alternative if Electron size is a concern
2. Native platform notifications and OS integration

#### Minimum Code Changes for Windows Compatibility

1. **Docker socket** — Add Windows named pipe path:
   ```typescript
   if (process.platform === "win32") {
     return "//./pipe/docker_engine";
   }
   ```
2. **File permissions** — Create a helper:
   ```typescript
   export const safeWriteFile = async (path, data, opts) => {
     const mode = process.platform === "win32" ? undefined : opts?.mode;
     await fs.writeFile(path, data, { ...opts, mode });
   };
   ```
3. **Hard link fallback** — In `media-resolver.ts`:
   ```typescript
   try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
   ```

---

### Open Questions
1. What is the primary target audience for Windows? Developers (terminal-comfortable) or general users (one-click install)?
2. Should the Electron wrapper include the UI only, or also embed the Node.js backend?
3. Is there interest in a cloud-hosted version (SaaS) that would avoid local installation entirely?
4. Should Windows users get access to remote sidecar connections (e.g., connect to a macOS Mini running sidecars over LAN)?
5. What priority is auto-update for Windows installations?

### Constraints & Assumptions
- All AI sidecars (audio, image-gen, music, music-studio, video) are Apple Silicon only and will NOT work on Windows natively
- Node.js 22+ is required — this is available on Windows via official installer, `nvm-windows`, or `winget`
- `pnpm` is required — installable via `npm install -g pnpm` or `corepack enable`
- `better-sqlite3` and `sharp` have pre-built Windows binaries (no C++ compiler needed at install time)
- The core text/tool agent with all MCP tools (web search, browser, shell, files, documents) works on Windows

### Security Considerations
- **NTFS permissions**: `0o600` mode is meaningless on Windows — sensitive files like `auth.json` and `vault.enc` are readable by any user on the machine. Consider Windows DPAPI or Credential Manager for future hardening.
- **Docker socket access**: On Windows, Docker Desktop manages access — named pipe access is controlled by group membership.
- **`.env` file**: No special protection on Windows beyond NTFS ACLs. For production deployments, recommend using the config.json approach (in user home) over `.env` in project root.
- **NSIS installer signing**: Windows SmartScreen will warn on unsigned executables — consider code signing certificate for distribution.
