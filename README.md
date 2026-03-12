# OpenZigs — Open-source AI Assistant & Developer Tools

> An open-source AI coding assistant and secure local automation platform built on GitHub Copilot SDK, combining developer tools, task automation, and human-in-the-loop safety controls.

OpenZigs gives you a "God Mode" AI assistant that can read files, search the web, browse pages, and execute shell commands — but only when you say it should. Every high-risk action requires explicit human approval.

---

## Quick Start

```bash
git clone --recurse-submodules https://github.com/mgcronin/openzigs.git && cd openzigs
pnpm install
pnpm dev
```

> **Already cloned without `--recurse-submodules`?** Run `git submodule update --init` to fetch external dependencies.

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
| **[Architecture](docs/ARCHITECTURE.md)** | System design, component breakdown, security model, Mermaid diagrams. |
| **[User Guide](docs/USER_GUIDE.md)** | Installation, configuration, connecting channels, tool management. |

---

## Tech Stack

- **Runtime:** Node.js 22+ / TypeScript (ESM)
- **AI:** `@github/copilot-sdk` with streaming and tool calling
- **Tools:** Filesystem, Brave Search, Chrome DevTools, Shell, Instagram (all risk-classified)
- **Channels:** Web Chat (Socket.IO), Telegram (grammY), Discord (discord.js)
- **Infra:** Docker, Cloudflare Tunnel
- **External:** [ig-mcp](https://github.com/jlbadano/ig-mcp) (git submodule in `external/ig-mcp`)
- **Testing:** Vitest (370+ tests)

---

## Project Status

### Implemented

- Core agent with Copilot SDK wrapper (streaming, model selection, device auth)
- Tool registry with risk classification and runtime toggles
- Human-in-the-loop approval queue
- Session management (JSONL persistence)
- Web Chat UI with model selector and admin panels
- Telegram and Discord channel integrations
- Cloudflare Tunnel integration (quick and named modes)
- Auth middleware with role-based access control
- Audit logging with queryable API
- Recursive agent chaining (spawn-agent, orchestrate-agents)
- Instagram MCP tools via [ig-mcp](https://github.com/jlbadano/ig-mcp) submodule
- Configurable tool limit per request (1–128) with always-on tool guarantees

### Git Submodules

The Instagram MCP server lives in `external/ig-mcp` as a **git submodule** referencing [jlbadano/ig-mcp](https://github.com/jlbadano/ig-mcp). All other MCP sidecars use pre-built Docker images. After cloning, run:

```bash
git submodule update --init
```

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
