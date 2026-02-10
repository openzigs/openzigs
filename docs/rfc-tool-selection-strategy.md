# RFC: Tool Limits & Dynamic Selection Strategy

**Status**: Draft  
**Issue**: [#114](https://github.com/mgcronin/openzigs/issues/114)  
**Epic**: [#112 — Tool Context Optimization & Scoping](https://github.com/mgcronin/openzigs/issues/112)  
**Date**: 2026-02-10  

---

## 1. Provider Hard Limits

### Maximum Tool/Function Count by Model

| Provider / Model | Max Functions | Notes |
|---|---|---|
| **GPT-4.1** (default) | 128 | OpenAI function-calling limit; enforced server-side |
| **GPT-4.1-mini** | 128 | Same architecture limit as GPT-4.1 |
| **GPT-5-mini** | 128 | OpenAI's latest compact model, same limit |
| **Claude 3.5 Sonnet** | 200+ | Anthropic has no documented hard cap; tool schemas are inlined in the system prompt, so the limit is effectively context-window-bound |
| **Copilot SDK relay** | Model-dependent | The `@github/copilot-sdk` passes tool definitions through to the underlying model; no additional SDK-layer cap |

### Key Observations

- **OpenAI models are the binding constraint** at 128 tools. Our registry can hold 91+ tools today, so we're within limits — but expansion beyond ~120 unique tools would require scoping regardless.
- The Copilot SDK's `infinite_sessions` compaction feature **preserves tool schemas** across session windows. Tool definitions are re-sent on every request; they are not compacted.

---

## 2. Token Consumption Analysis

### Per-Tool Schema Cost

Each tool definition sent to the model consumes tokens for:
- Tool name and description (~20–60 tokens)
- JSON Schema for `inputSchema` (~30–150 tokens depending on complexity)
- Overhead framing (~10 tokens per tool for function-call protocol)

**Estimated token cost per tool**: ~60–220 tokens, median ~120 tokens.

### Current Impact

| Configuration | Tool Count | Est. Schema Tokens | % of 128k Context | % of 32k Context |
|---|---|---|---|---|
| `maxToolsPerRequest: 30` | 30 | ~3,600 | ~2.8% | ~11.3% |
| `maxToolsPerRequest: 91` (all) | 91 | ~10,920 | ~8.5% | ~34.1% |
| Always-on tools only | 7 | ~840 | ~0.7% | ~2.6% |
| Scoped (10–15 tools) | 12 | ~1,440 | ~1.1% | ~4.5% |

### Registered Tool Categories (Current)

| Category | Est. Tool Count | Examples |
|---|---|---|
| `filesystem` | 3 | read-file, list-directory, write-file |
| `search` | 1 | web-search |
| `browser` | 2 | browser-read, browser-navigate |
| `shell` | 1 | shell-execute |
| `productivity` | 8–12 | prompt-*, scheduler-*, personality-* |
| `social` | 20–30 | linkedin-*, twitter-*, facebook-*, pinterest-*, instagram-* |
| `documents` | 5–10 | pdf-*, word-*, markitdown-*, calendar-* |
| `personal` | 2–4 | gmail-* |
| `data` | 3–5 | database-* |
| `developer` | 5–8 | github-*, spawn-agent, orchestrate-agents |

**Total estimated**: 50–91 tools depending on which sidecars/servers are running.

---

## 3. Impact of Silent Tool Dropping

When `maxToolsPerRequest: 30` was in effect and 91 tools were registered, `CopilotWrapper.chat()` sent only the first 30 tools by registration order. This caused:

1. **`spawn-agent` and `orchestrate-agents`** (registered last, positions 87–91) were always dropped — the AI could never delegate work to background agents.
2. **Social media tools** (positions ~20–50) were partially cut — LinkedIn/Twitter might make the cut, but Facebook/Pinterest/Instagram were silently dropped.
3. **No error signal** — the model simply couldn't see tools it wasn't given, so it would attempt workarounds or refuse the request entirely.

### Mitigation Already Implemented

The `ALWAYS_ON_TOOLS` set (7 tools) guarantees that `read-file`, `list-directory`, `web-search`, `browser-navigate`, `shell-execute`, `spawn-agent`, and `orchestrate-agents` are never dropped, regardless of the `maxToolsPerRequest` value.

---

## 4. Dynamic Selection Strategy Evaluation

### Option A — Router LLM Call (Two-Pass)

**How it works:**
1. Before the main request, send a lightweight prompt to a fast model (GPT-5-mini or similar) with the **full tool catalog** — names + one-line descriptions only (~20 tokens per tool, ~1,800 tokens total).
2. Ask: *"Given this user message, which 10–15 tools are most relevant?"*
3. Send the actual request with only the selected tools + always-on tools.

**Pros:**
- Highly accurate tool selection — the model understands intent
- Minimal token waste on the main request
- Adapts to new tools automatically without code changes

**Cons:**
- Adds ~200–500ms latency per request (fast model round-trip)
- Additional API cost (~2,000 input tokens + ~100 output tokens per routing call)
- Complexity: error handling, fallback when router fails, testing the meta-prompt

### Option B — Category-Based Selection

**How it works:**
1. Tools are already tagged with categories (`filesystem`, `browser`, `social`, `database`, etc.)
2. Use keyword/intent matching (regex or simple NLP) on the user's message to select relevant categories
3. Include all tools from matched categories + always-on tools

**Pros:**
- Zero additional latency (pure string matching)
- Zero additional API cost
- Simple to implement and test
- Deterministic — same message always gets same tools

**Cons:**
- Less accurate — "search LinkedIn for posts about AI" might not trigger `social` category via naive matching
- Requires manual keyword lists per category
- New tools/categories need keyword updates
- Can over-include (entire category when only 1 tool is needed)

### Option C — Hybrid (Recommended)

**How it works:**
1. **Default path**: Use category-based selection for fast, zero-latency routing
2. **Fallback**: If no categories match (or the user explicitly requests "use all tools"), send all enabled tools up to `maxToolsPerRequest`
3. **Per-job/prompt scoping**: The explicit `allowedTools` / `preferredTools` fields (Issues #113, #115) bypass dynamic selection entirely — the user has already declared intent
4. **Future upgrade path**: Swap category matching for a router LLM call once latency budget allows

**Implementation plan:**
1. Add a `matchCategories(message: string): ToolCategory[]` function in `src/mcp/tool-selector.ts`
2. The function uses keyword maps: `{ social: ["linkedin", "twitter", "post", "tweet", ...], browser: ["navigate", "screenshot", "click", ...], ... }`
3. `MessageRouter` and `TaskWorker` call `matchCategories()` when no explicit `allowedTools` is provided
4. Always-on tools are included regardless of category match

---

## 5. Recommendations

### Default `maxToolsPerRequest`

**Recommended value: 64**

Rationale:
- Well within the 128-tool hard limit for OpenAI models
- At ~7,680 estimated schema tokens, consumes only ~6% of a 128k context window
- Provides headroom for tool expansion without silent dropping
- Combined with always-on tools and per-request scoping, most requests will use far fewer

### Implementation Priority

| Priority | Item | Effort |
|---|---|---|
| ✅ Done | Always-on tools (`ALWAYS_ON_TOOLS` set) | — |
| ✅ Done | Per-job tool scoping (`allowedTools` on scheduled jobs) | Issue #113 |
| ✅ Done | Per-prompt tool scoping (`preferredTools` on saved prompts) | Issue #115 |
| ✅ Done | Per-chat tool scoping (`tools` on web chat messages) | Issue #116 |
| Next | Category-based selector (`tool-selector.ts`) | ~2 hours |
| Future | Router LLM two-pass selection | ~4 hours |

### Configuration

```jsonc
// config/default.json
{
  "session": {
    "maxToolsPerRequest": 64, // Raise from 30 → 64
    "toolSelectionStrategy": "category" // "all" | "category" | "router-llm"
  }
}
```

---

## 6. Open Questions

1. **Should we expose `toolSelectionStrategy` in the admin UI?** — Probably yes, as a dropdown in the Session Config panel alongside `maxToolsPerRequest`.
2. **Should category-based selection log which categories were matched?** — Yes, at `debug` level for troubleshooting tool-selection misses.
3. **Should the router LLM option cache results per message pattern?** — Potentially, but cache invalidation when tools change makes this complex. Defer to future work.

---

## Appendix: Tool Registration Order (Current)

1. `read-file` (filesystem, low) — **always-on**
2. `list-directory` (filesystem, low) — **always-on**
3. `write-file` (filesystem, high)
4. `web-search` (search, low) — **always-on**
5. `browser-read` (browser, medium)
6. `browser-navigate` (browser, high) — **always-on**
7. `shell-execute` (shell, high) — **always-on**
8–19. Productivity tools (prompt-*, scheduler-*, personality-*)
20–49. Social media tools (linkedin-*, twitter-*, facebook-*, pinterest-*)
50–65. Document intelligence tools (pdf-*, word-*, markitdown-*, calendar-*)
66–75. Gmail tools
76–85. Database tools, GitHub tools
86–88. Instagram tools
89–90. `spawn-agent` — **always-on**
91. `orchestrate-agents` — **always-on**
