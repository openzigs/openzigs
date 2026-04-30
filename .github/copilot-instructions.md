# Copilot Instructions (openzigs)

## Codebase navigation hint (graphify)

If [graphify-out/GRAPH_REPORT.md](graphify-out/GRAPH_REPORT.md) exists at the repo root, **read it before any wide grep or file_search sweep** — it is a precomputed knowledge graph of the codebase and dramatically reduces tokens for "where is X defined / used" questions. For deeper queries, run `graphify query "<terms>" graphify-out/graph.json` (token-bounded subgraph) or `graphify path <fileA> <fileB>` (dependency reach). The graph is opt-in dev tooling — if `graphify-out/` is missing, fall through to normal search. Install/build instructions: see [CONTRIBUTING.md](../CONTRIBUTING.md#optional-graphify-knowledge-graph).

## Architecture Overview
- **Express server** ([src/server.ts](src/server.ts)) bootstraps all subsystems: config, tools, sessions, tasks, scheduler, personality, Sentinel, channels, Socket.IO wiring.
- **AI wrapper** ([src/copilot/copilot-wrapper.ts](src/copilot/copilot-wrapper.ts)): wraps `@github/copilot-sdk` for device auth, streaming chat, tool-call hooks, and session-level token tracking.
- **MCP tools** ([src/mcp/server.ts](src/mcp/server.ts), [src/mcp/tool-registry.ts](src/mcp/tool-registry.ts)): Zod schema + `ToolDefinition` + handler returning `{ text, isError? }`. Three runtimes: built-in, Docker sidecars ([docker-sidecar-manager.ts](src/mcp/docker-sidecar-manager.ts)), local servers ([local-mcp-server-manager.ts](src/mcp/local-mcp-server-manager.ts)).
- **Task engine** ([src/tasks/](src/tasks/)): SQLite-backed (`better-sqlite3`) task queue with `TaskEngine` (coordinator) → `TaskRepository` (persistence) → `TaskWorker` (background consumer). Supports DAG parent-child trees, recursion depth limits (5), and multi-stage pipelines with parallel groups.
- **Channel system** ([src/channels/types.ts](src/channels/types.ts)): `MessageChannel` interface implemented by Web (Socket.IO), Telegram (grammY), Discord (discord.js). Routing via [message-router.ts](src/routing/message-router.ts) with access control, personality injection, and tool scoping.
- **Approval queue** ([src/approvals/approval-queue.ts](src/approvals/approval-queue.ts)): EventEmitter-based, returns Promise that blocks until human decision or timeout. Interactive chat auto-approves certain tools (`INTERACTIVE_CHAT_AUTO_APPROVE_TOOLS` in [constants.ts](src/mcp/constants.ts)); background tasks respect the queue.
- **Sentinel** ([src/sentinel/](src/sentinel/)): Autonomous SRE monitor with cron-scheduled task review, LLM prompt auditing, daily digest generation, and cooldown-gated alerting via Socket.IO + channel broadcast.
- **Frontend** ([ui/](ui/)): Next.js 14 (App Router) + Tailwind + Radix UI + React Query. Socket.IO for real-time streaming. Routes: `/chat`, `/admin` (tools/sessions/agents/personality/sentinel/model panels), `/library`, `/scheduler`, `/tasks`, `/workbench`.

## Code Organization & Patterns
- ESM TypeScript only (package `type: module`); use explicit `.js` extensions in imports.
- Session history is JSONL append-only; metadata is in a sidecar JSON file (same base name) under `~/.openzigs/sessions/`.
- SQLite via `better-sqlite3` with WAL mode at `~/.openzigs/openzigs.db`. Schema evolution via runtime `ALTER TABLE` migrations. Tables: `personality`, `saved_prompts`, `scheduled_jobs`, `agent_tasks`.
- Config layering: `config/default.json` → `~/.openzigs/config.json` (user overrides, `0o600` perms) → env vars. Merged with Zod validation in [src/config/index.ts](src/config/index.ts).
- Agent archetypes in [config/agents.json](config/agents.json) (researcher, coder, writer, etc.); user agents override by name.
- Admin API is a single large Router in [src/api/admin.ts](src/api/admin.ts) (~1800 lines) mounted at `/api/admin`. Separate routers exist for tasks/models/files; future work should continue splitting admin domains into dedicated routers instead of expanding this file.
- Pipeline post-actions are deterministic code, not LLM calls — see [src/tasks/post-actions.ts](src/tasks/post-actions.ts) and [post-action-registry.ts](src/tasks/post-action-registry.ts).
- `spawn-agent`/`orchestrate-agents` tools get chat context via module-level `setActiveChatContext()` setters (workaround for SDK process boundary losing `AsyncLocalStorage`).
- `orchestrate-agents` supports two modes: `task` (fan-out via TaskEngine, ~N+1 API calls) and `session` (SDK subagent delegation via `enableSubagents`, ~2 API calls). Mode is per-invocation or defaulted via `tasks.defaultOrchestrationMode`.

## Prompt & Template System
- Saved prompts are SQLite-backed in [src/productivity/prompt-manager.ts](src/productivity/prompt-manager.ts) with optional staged pipelines (`stages`) and preferred tool scoping (`preferredTools`).
- Prompt templates use `{{variable}}` interpolation; extraction/resolution happens in `extractVariables()` and `interpolateTemplate()` in the prompt manager.
- Import/export format is `.openzigs-template.json` via [src/productivity/template-service.ts](src/productivity/template-service.ts) and admin routes in [src/api/admin.ts](src/api/admin.ts) (`/templates/analyze`, `/templates/import`).

## Developer Workflows
- Dev server: `pnpm dev` (tsx watch). UI dev: `cd ui && pnpm dev` (Next.js on port 3001).
- Build: `pnpm build` (tsc). UI build: `cd ui && npx next build`.
- Tests: `pnpm test` (Vitest, `src/**/*.test.ts`). UI tests: `cd ui && pnpm test` (React Testing Library + jsdom).
- Lint/format: `pnpm lint`, `pnpm format`. UI lint: `cd ui && npx next lint`.
- **Quality Gate**: Before `git commit` or creating a PR, you **MUST** run `pnpm lint`, `pnpm typecheck`, and `cd ui && npx next build` (if touching UI files) to ensure no regressions.

## Testing Conventions
- Tests live next to source code (`task-engine.test.ts` beside `task-engine.ts`).
- Time-dependent components accept `clock?: () => Date` for deterministic testing. Freeze time in tests: `const now = new Date("2026-02-09T12:00:00Z")`.
- SQLite tests use in-memory databases: `new Database(":memory:")` with WAL + foreign keys.
- Event lifecycle assertions use `vi.fn()` handlers on EventEmitter events.
- UI tests use `@testing-library/react` with jsdom environment.

## Key Integration Points
- Copilot device auth writes token state to `~/.openzigs/auth.json`.
- Socket.IO uses `clientId` query param for session restoration across page navigations. Client ID persisted in `localStorage` under `openzigs:client-id`.
- UI fetches from `NEXT_PUBLIC_OPENZIGS_API_BASE` with `NEXT_PUBLIC_OPENZIGS_TOKEN` auth.
- Always-on tools (`read-file`, `list-directory`, `web-search`, `browser-navigate`, `shell-execute`, `spawn-agent`, `orchestrate-agents`) are always included regardless of tool limit filtering.
- Logging: Winston logger + `AuditLogger` with JSONL persistence at `~/.openzigs/logs/`, value redaction, categories: `session`, `message`, `tool`, `security`, `system`.
- Sentinel state persists to `~/.openzigs/sentinel/`; uses atomic write-to-temp-then-rename for state files.
- Webhook configs are persisted to SQLite via [src/webhooks/webhook-repository.ts](src/webhooks/webhook-repository.ts) (WAL mode). Rate-limit state is intentionally in-memory (resets on restart).
