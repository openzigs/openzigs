# OpenZigs 🧠⚡

> A secure, local, containerized AI agent platform using GitHub Copilot SDK + Model Context Protocol (MCP).

**"God Mode" AI agent that runs locally with human-in-the-loop safety controls.**

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Web UI (React/Next.js)                    │
│              Tool Toggles | Approval Queue | Logs             │
├──────────────────────────────────────────────────────────────┤
│                        OpenZigs Server                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │
│  │ Channel     │  │ Session     │  │ Tool Registry       │   │
│  │ Manager     │  │ Manager     │  │ (Risk Classification)│   │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘   │
│         │                │                     │              │
│         ▼                ▼                     ▼              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              GitHub Copilot SDK (CopilotClient)          │ │
│  │              Model: gpt-5 | Streaming | Tools            │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                  │
│                            ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    MCP Servers                           │ │
│  │  @filesystem  @brave-search  @fetch  @memory  @shell    │ │
│  └─────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│                   Docker Container (Isolated)                 │
├──────────────────────────────────────────────────────────────┤
│              Cloudflare Tunnel (Public URL)                  │
└──────────────────────────────────────────────────────────────┘
         ▲                    ▲                    ▲
         │                    │                    │
    Discord Bot          Telegram Bot          Slack App
```

## 🎯 Core Features

| Feature | Description |
|---------|-------------|
| **GitHub Copilot SDK** | Uses `@github/copilot-sdk` for reasoning with GPT-5 |
| **MCP Tools** | Standard Model Context Protocol servers for file, search, shell |
| **Human-in-the-Loop** | High-risk actions require explicit approval |
| **Tool Toggles** | Enable/disable tools via Web UI |
| **Multi-Channel** | Discord, Telegram, Slack, Web chat |
| **Containerized** | Runs in Docker for security isolation |
| **Cloudflare Tunnel** | External webhooks without port forwarding |

## 📋 Project Plan

### Epic 1: Core Agent Infrastructure ([#1](https://github.com/mgcronin/openzigs/issues/1))

| Issue | Title |
|-------|-------|
| [#2](https://github.com/mgcronin/openzigs/issues/2) | Initialize TypeScript project with strict mode and ESM |
| [#4](https://github.com/mgcronin/openzigs/issues/4) | Implement CopilotClient wrapper service |
| [#6](https://github.com/mgcronin/openzigs/issues/6) | Create MCP Server integration layer |
| [#3](https://github.com/mgcronin/openzigs/issues/3) | Build session management system |
| [#5](https://github.com/mgcronin/openzigs/issues/5) | Implement tool registry with risk classification |

### Epic 2: Security & Control UI ([#7](https://github.com/mgcronin/openzigs/issues/7))

| Issue | Title |
|-------|-------|
| [#8](https://github.com/mgcronin/openzigs/issues/8) | Create approval queue system (human-in-the-loop) |
| [#9](https://github.com/mgcronin/openzigs/issues/9) | Build Web UI with tool toggles and status |
| [#10](https://github.com/mgcronin/openzigs/issues/10) | Implement audit logging system |
| [#11](https://github.com/mgcronin/openzigs/issues/11) | Add authentication and authorization |

### Epic 3: Messaging Bridge ([#12](https://github.com/mgcronin/openzigs/issues/12))

| Issue | Title |
|-------|-------|
| [#13](https://github.com/mgcronin/openzigs/issues/13) | Create channel abstraction layer |
| [#14](https://github.com/mgcronin/openzigs/issues/14) | Implement Discord bot integration |
| [#15](https://github.com/mgcronin/openzigs/issues/15) | Implement Telegram bot integration |
| [#16](https://github.com/mgcronin/openzigs/issues/16) | Add message routing and context |

### Epic 4: Container & Tunnel Infrastructure ([#17](https://github.com/mgcronin/openzigs/issues/17))

| Issue | Title |
|-------|-------|
| [#18](https://github.com/mgcronin/openzigs/issues/18) | Create Docker container configuration |
| [#19](https://github.com/mgcronin/openzigs/issues/19) | Implement Cloudflare Tunnel integration |
| [#20](https://github.com/mgcronin/openzigs/issues/20) | Add docker-compose for orchestration |
| [#21](https://github.com/mgcronin/openzigs/issues/21) | Create install and setup scripts |

## 🔧 Tech Stack

- **Language**: TypeScript (strict mode, ESM)
- **Runtime**: Node.js 22+ in Docker
- **AI Backend**: GitHub Copilot SDK (individual auth via device flow)
- **Tools**: Model Context Protocol (MCP) servers
- **Web UI**: Next.js 14+ / React / Tailwind / shadcn/ui
- **Messaging**: grammY (Telegram) - primary channel
- **Tunnel**: Cloudflare Tunnel (cloudflared)
- **Testing**: Vitest

## 🛠️ MCP Tools Stack

| Tool | Package | Role | Risk |
|------|---------|------|------|
| **Filesystem** | `@modelcontextprotocol/server-filesystem` | Read/write code files | 🟢/🔴 |
| **Web Search** | `@modelcontextprotocol/server-brave-search` | Find docs & libraries | 🟢 |
| **Browser** | `mcp-server-chrome-devtools` | Read pages, debug localhost | 🟡 |
| **Shell** | Custom executor | Run terminal commands | 🔴 |

### ⚠️ Chrome DevTools Setup (Required)

Chrome must be launched with remote debugging enabled for the browser tool to work:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Windows
start chrome --remote-debugging-port=9222
```

Without this, the agent will get "Connection refused" when trying to browse.

## 🔐 Security Model

### Risk Classification

| Level | Description | Tools | Behavior |
|-------|-------------|-------|----------|
| 🟢 Low | Read-only, no side effects | web search, read file, memory | Auto-approve |
| 🟡 Medium | External network, rate limits | HTTP fetch, API calls | Log and execute |
| 🔴 High | Destructive, file writes, shell | write file, delete, shell | **Require approval** |

### Dual-Channel Approval

High-risk tool calls trigger approval requests to **both**:
- **Web UI**: Real-time notification with Approve/Reject buttons
- **Telegram**: InlineKeyboard in the originating chat

First response wins - the other channel is notified of the decision.

## 📁 Project Structure

```
openzigs/
├── src/
│   ├── agent/           # CopilotClient wrapper
│   ├── mcp/             # MCP server integration
│   ├── tools/           # Tool registry & classification
│   ├── security/        # Approval queue, auth
│   ├── channels/        # Discord, Telegram, Slack
│   ├── sessions/        # Session management
│   ├── config/          # Configuration
│   └── server/          # HTTP/WebSocket server
├── ui/                  # Next.js web UI
├── config/              # Configuration files
├── scripts/             # Install/setup scripts
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## 📖 Reference

This project architecture draws inspiration from [OpenClaw](https://github.com/openclaw/openclaw), re-architected to use:

- **GitHub Copilot SDK** (instead of direct browser automation)
- **Model Context Protocol** (instead of custom tool implementations)
- **Containerized deployment** (instead of native installation)

## 📜 License

MIT

---

**Status**: 🚧 In Development

See [Issues](https://github.com/mgcronin/openzigs/issues) for current progress.
