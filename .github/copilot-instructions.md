# Copilot Instructions (openzigs)

## Big Picture
- Core runtime is a small Express server in [src/server.ts](src/server.ts) with health endpoint only today.
- AI integration lives in [src/copilot/copilot-wrapper.ts](src/copilot/copilot-wrapper.ts): wraps `@github/copilot-sdk`, device auth, streaming chat, and tool-call hooks.
- MCP tool wiring is centralized in [src/mcp/server.ts](src/mcp/server.ts) and [src/mcp/tool-registry.ts](src/mcp/tool-registry.ts) (risk levels, enable/disable, tool list).
- Session persistence is JSON + JSONL in [src/sessions/session-manager.ts](src/sessions/session-manager.ts) using `~/.openzigs/sessions/*`.

## Code Organization & Patterns
- ESM TypeScript only (package `type: module`), prefer explicit `.js` extensions in imports (see [src/index.ts](src/index.ts)).
- Tools follow a pattern: Zod schema + `ToolDefinition` + handler returning `{ text, isError? }` (see [src/mcp/server.ts](src/mcp/server.ts)).
- Session history is JSONL append-only; metadata is in a sidecar JSON file (same base name).

## Developer Workflows
- Dev server: `pnpm dev` (tsx watch, see package.json).
- Build: `pnpm build` (tsc).
- Tests: `pnpm test` (Vitest, includes `src/**/*.test.ts`).
- Lint/format: `pnpm lint`, `pnpm format`.
- **Quality Gate**: Before running `git commit` or creating a Pull Request, you **MUST** run `pnpm lint`, `pnpm typecheck`, and `pnpm build` (if touching UI) to ensure no regressions. Code quality is paramount; do not rely on CI to catch basic errors.

## Config & Integration Points
- Default config is JSON in [config/default.json](config/default.json); env vars are interpolated in config values.
- Copilot device auth writes token state to `~/.openzigs/auth.json` (see [src/copilot/copilot-wrapper.ts](src/copilot/copilot-wrapper.ts)).
- MCP tools include filesystem, brave search, chrome devtools, shell; risk levels gate enable/disable in [src/mcp/tool-registry.ts](src/mcp/tool-registry.ts).

## Testing Conventions
- Vitest tests live next to code under `src/**` (example: [src/health.test.ts](src/health.test.ts)).
- Use deterministic clocks when time-sensitive logic is tested (see [src/sessions/session-manager.test.ts](src/sessions/session-manager.test.ts)).
