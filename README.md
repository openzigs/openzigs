# OpenZigs — Open-source AI Assistant & Automation Platform

[![Release](https://img.shields.io/github/v/release/openzigs/openzigs?include_prereleases&style=flat-square)](https://github.com/openzigs/openzigs/releases)
[![License](https://img.shields.io/github/license/openzigs/openzigs?style=flat-square)](LICENSE.md)
[![Build](https://img.shields.io/github/actions/workflow/status/openzigs/openzigs/desktop-release.yml?style=flat-square&label=desktop%20build)](https://github.com/openzigs/openzigs/actions/workflows/desktop-release.yml)

> **⚠️ ALPHA — This project is under active development. Expect breaking changes between releases.**

> An open-source AI automation platform built on GitHub Copilot SDK, combining chat, task automation, social media management, video production, voice synthesis, image generation, and human-in-the-loop safety controls.

OpenZigs gives you a "God Mode" AI assistant that can read files, search the web, browse pages, execute shell commands, generate media, post to social platforms, and autonomously chain sub-agents — but only with the controls you define. Every high-risk action requires explicit human approval.

---

## Download

| Platform | Download | Package Manager |
|----------|----------|-----------------|
| **Windows** | [Download .exe](https://github.com/openzigs/openzigs/releases/latest) | `scoop install openzigs` |
| **macOS (Apple Silicon)** | [Download .dmg (arm64)](https://github.com/openzigs/openzigs/releases/latest) | `brew install openzigs/tap/openzigs` |
| **macOS (Intel)** | [Download .dmg (x64)](https://github.com/openzigs/openzigs/releases/latest) | `brew install openzigs/tap/openzigs` |

See [**Installation Guide**](docs/INSTALL.md) for detailed instructions, system requirements, and troubleshooting.

---

## Platform Status

**ALPHA** — Core systems are functional and actively used in production by the maintainers, but APIs and configuration formats may change without notice between releases. Windows and macOS desktop apps are available. Linux is development-only (run from source).

---

## Quick Start (Development)

```bash
git clone --recurse-submodules https://github.com/openzigs/openzigs.git && cd openzigs
pnpm install
pnpm dev
```

> **Already cloned without `--recurse-submodules`?** Run `git submodule update --init` to fetch external MCP dependencies.

Open **http://localhost:3001** for the UI. The API server runs on **http://localhost:3000**. Run `pnpm setup` on first launch to authenticate with GitHub Copilot.

---

## What It Does

| Capability | Description |
|---|---|
| **AI Chat** | Streams responses from GitHub Copilot SDK models (`gpt-4.1`, `claude-sonnet-4`, `o4-mini`, etc.) with full tool use. |
| **Tool Use** | MCP-based tools for filesystem, web search, Chrome DevTools, shell, browser navigation, and more — all risk-classified. |
| **Safety** | High-risk actions pause until you approve via the approval queue. Interactive chat auto-approves low-risk tools. |
| **Task Engine** | SQLite-backed async task queue with DAG parent-child trees, multi-stage pipelines, parallel groups, and recursion depth limits. |
| **Multi-Channel** | Chat via Web UI, Telegram, or Discord. Message routing with access control and personality injection. |
| **Social Media** | Post, schedule, and manage content across Facebook, Instagram, LinkedIn, Reddit, TikTok, Twitter/X, and YouTube. |
| **Video Pipeline** | Blog-to-video production: script generation, thumbnail selection, Remotion rendering, asset download from Pexels/Pixabay. |
| **Voice & Audio** | TTS via Google Cloud and F5-TTS sidecar, GPT-SoVITS voice cloning, background music generation via music sidecar. |
| **Image Generation** | Stable Diffusion / FLUX via image-gen sidecar, with optional Mac Mini network node offloading. |
| **Music Studio** | AI music composition and generation via dedicated music-studio sidecar (local or networked). |
| **Knowledge Base** | Document ingestion, chunking, and semantic retrieval for RAG-style agent memory. |
| **Presenter Mode** | Cloudflare Tunnel-powered public room sharing with invite links. |
| **Sentinel** | Autonomous SRE monitor with cron-scheduled reviews, LLM prompt auditing, and daily digest alerts. |
| **Scheduler** | Cron-based job scheduling with SQLite persistence. |
| **Outbox** | Queued social post outbox with approval workflow. |
| **Containerized** | Docker Compose configuration for full stack or sidecar-only deployment with Cloudflare Tunnel ingress. |

---

## Documentation

| Document | Description |
|---|---|
| **[Installation](docs/INSTALL.md)** | Download links, system requirements, platform-specific setup instructions. |
| **[Architecture](docs/ARCHITECTURE.md)** | System design, component breakdown, security model, Mermaid diagrams. |
| **[User Guide](docs/USER_GUIDE.md)** | Configuration, connecting channels, tool management. |

---

## Tech Stack

- **Runtime:** Node.js 22+ / TypeScript (ESM only)
- **AI:** `@github/copilot-sdk` with streaming, tool calling, and model selection
- **UI:** Next.js 15 (App Router) + React 19 + Tailwind CSS + Radix UI + Socket.IO
- **Database:** SQLite via `better-sqlite3` (WAL mode) for tasks, scheduler, prompts, personality
- **Channels:** Web Chat (Socket.IO), Telegram (grammY), Discord (discord.js)
- **Social MCPs:** Facebook, Instagram, LinkedIn, Reddit, TikTok, Twitter/X, YouTube (git submodules in `external/`)
- **Sidecars:** Audio/TTS (`sidecars/audio`), Image Gen (`sidecars/image-gen`), Music (`sidecars/music`), Music Studio (`sidecars/music-studio`), Worker (`sidecars/worker`)
- **Infra:** Docker Compose, Cloudflare Tunnel
- **Testing:** Vitest (4,850+ unit tests), Playwright (E2E)
- **Package Manager:** pnpm (workspaces)

---

## UI Routes

| Route | Description |
|---|---|
| `/chat` | Main AI chat interface with real-time streaming |
| `/admin` | Tools, sessions, agents, personality, sentinel, model, and network node management |
| `/tasks` | Task engine viewer — DAG trees, pipeline stages, sub-task progress |
| `/scheduler` | Cron job manager |
| `/library` | Saved prompt library with template interpolation |
| `/workbench` | Multi-step prompt workbench |
| `/social` | Social media management dashboard |
| `/outbox` | Queued post outbox and approval workflow |
| `/director` | AI video director and production studio |
| `/gallery` | Generated media gallery |
| `/music-studio` | AI music studio interface |
| `/knowledge` | Knowledge base document management |
| `/skills` | Agent skill browser |
| `/characters` | AI character/persona management |
| `/presenter` | Public presenter mode with invite links |

---

## Project Status

### Implemented

- Core AI agent with Copilot SDK wrapper (streaming, model selection, device auth, API key mode)
- MCP tool registry with Zod schema validation, risk classification, and runtime toggles
- Three tool runtimes: built-in, Docker sidecars, and local MCP servers
- Human-in-the-loop approval queue (interactive chat auto-approves low-risk tools)
- SQLite-backed task engine with DAG parent-child trees, recursion depth limits, and multi-stage pipelines with parallel groups
- Session management with JSONL append-only history and sidecar metadata files
- Full Web Chat UI (Next.js 15 + React 19 + Tailwind + Radix UI) with Socket.IO streaming
- Admin panels: tools, sessions, agents, personality, sentinel, model selection, network nodes
- Telegram channel integration (grammY)
- Discord channel integration (discord.js)
- Message routing with access control, personality injection, and tool scoping
- Cloudflare Tunnel integration (quick and named tunnel modes) + Presenter public room sharing
- Auth middleware with role-based access control and API token support
- Audit logging with JSONL persistence, value redaction, and queryable API
- Sentinel autonomous SRE monitor with cron-scheduled task review, LLM prompt auditing, and daily digest alerts
- Recursive agent chaining (`spawn-agent`, `orchestrate-agents`)
- Saved prompt library with `{{variable}}` template interpolation, staged pipelines, and import/export
- Cron scheduler with SQLite persistence
- Social media MCPs: Facebook, Instagram, LinkedIn, Reddit, TikTok, Twitter/X, YouTube (git submodules)
- Social outbox with queued post approval workflow
- Blog-to-video pipeline: script generation, asset fetching (Pexels, Pixabay, Jamendo), thumbnail selection, Remotion rendering
- Voice Lab: Google Cloud TTS, F5-TTS sidecar, GPT-SoVITS voice cloning
- Image generation sidecar (Stable Diffusion / FLUX) with Mac Mini network node offloading
- Music generation sidecar and music studio UI
- Knowledge base: document ingestion, chunking, and semantic retrieval
- Character/persona system
- Vault for secret management
- Browser automation via Chrome DevTools Protocol
- Docker Compose for full-stack and sidecar-only deployment
- 4,850+ unit tests with Vitest; Playwright E2E test suite
- Comprehensive security hardening: SSRF guards, path traversal validation, input sanitization, scrypt for API key hashing

### Known Limitations (ALPHA)

- **macOS only** — only tested on macOS. Windows and Linux are untested and may not work.
- Webhook configs are in-memory and do not persist across server restarts.
- Video rendering (Remotion) requires additional setup — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Social MCPs depend on platform API access and token freshness; some require periodic re-auth.
- The `music` and `music-studio` sidecars require Python and specific model downloads to function.
- Image generation sidecar requires a capable GPU or a networked Mac Mini node; CPU fallback is slow.

---

### Git Submodules

All social media MCP servers live in `external/` as git submodules. After cloning, run:

```bash
git submodule update --init
```

---

## License

[FSL-1.1-MIT](LICENSE.md) — Functional Source License, Version 1.1, with MIT future license. See [LICENSE.md](LICENSE.md) for full terms.

Copyright 2026 Zylos Labs LLC.
