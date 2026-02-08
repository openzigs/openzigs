# OpenZigs

> A secure, local AI agent platform built on GitHub Copilot SDK with human-in-the-loop safety controls.

OpenZigs gives you a "God Mode" AI assistant that can read files, search the web, browse pages, and execute shell commands — but only when you say it should. Every high-risk action requires explicit human approval.

---

## Quick Start

```bash
git clone https://github.com/mgcronin/openzigs.git && cd openzigs
pnpm install
pnpm dev
```

Open **http://localhost:3000** to start chatting. Run `pnpm setup` on first launch to authenticate with GitHub Copilot.

---

## What It Does

| Capability | How |
|---|---|
| **AI Chat** | Streams responses from GitHub Copilot SDK models (`gpt-4.1`, `claude-sonnet-4`, etc.). |
| **Tool Use** | MCP-based tools for filesystem, web search, Chrome DevTools, and shell access. |
| **Safety** | Risk-classified tools. High-risk actions pause until you approve. |
| **Multi-Channel** | Chat via the local Web UI, Telegram, or Discord. |
| **Containerized** | Runs in Docker with Cloudflare Tunnel for webhook ingress. |

---

## Documentation

| Document | Description |
|---|---|
| **[Architecture](docs/ARCHITECTURE.md)** | System design, component breakdown, security model, Mermaid diagrams. Future Personal Assistant architecture. |
| **[User Guide](docs/USER_GUIDE.md)** | Installation, configuration, connecting channels, tool management. Preview of upcoming features. |
| **[Roadmap](docs/ROADMAP.md)** | Product vision, quarterly roadmap, planned features for Personal Assistant evolution. |

---

## Tech Stack

- **Runtime:** Node.js 22+ / TypeScript (ESM)
- **AI:** `@github/copilot-sdk` with streaming and tool calling
- **Tools:** Filesystem, Brave Search, Chrome DevTools, Shell (all risk-classified)
- **Channels:** Web Chat (Socket.IO), Telegram (grammY), Discord (discord.js)
- **Infra:** Docker, Cloudflare Tunnel
- **Testing:** Vitest (79 tests)

---

## Project Status

### Implemented

- Core agent with Copilot SDK wrapper (streaming, model selection, device auth)
- Tool registry with risk classification and runtime toggles
- Human-in-the-loop approval queue
- Session management (JSONL persistence)
- Web Chat UI with model selector
- Telegram and Discord channel integrations
- Cloudflare Tunnel integration (quick and named modes)
- Auth middleware with role-based access control
- Audit logging with queryable API

### Open Epics

| Epic | Description | Status |
|---|---|---|
| [#21 — Container & Tunnel Infra](https://github.com/mgcronin/openzigs/issues/21) | Docker orchestration, install scripts | In Progress |
| [#11 — Security & Control UI](https://github.com/mgcronin/openzigs/issues/11) | Full Web UI for tool toggles, approval viewer, audit logs | In Progress |
| [#15 — Messaging Bridge](https://github.com/mgcronin/openzigs/issues/15) | Channel abstraction, routing, Slack support | In Progress |

See [Issues](https://github.com/mgcronin/openzigs/issues) for detailed progress.

---

## License

MIT
