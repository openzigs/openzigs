# Research: In-Session Subagent Orchestration via Copilot SDK
**Date**: 2026-03-28
**Sources**: Local codebase, @github/copilot-sdk Context7 docs
**Used for**: Evaluating SDK-native subagent orchestration as alternative to TaskEngine fan-out

---

## Research Summary

### Sources Consulted
| Source | Type | Key Findings |
|--------|------|-------------|
| src/mcp/tools/orchestrate-agents.ts | Local | Fan-out pattern: submits 1–10 child tasks to TaskEngine, waits, optionally aggregates |
| src/tasks/task-worker.ts | Local | Each task → separate copilot.chat() session; already supports enableInSessionSubagents flag |
| src/routing/message-router.ts | Local | Interactive chat passes enableSubagents: true to every session |
| src/copilot/copilot-wrapper.ts | Local | buildSessionConfig merges customAgents, wires subagent lifecycle events |
| config/agents.json | Local | 11 agent archetypes defined with name/displayName/description/prompt/tools |
| src/copilot/subagent-event-relay.ts | Local | Socket.IO bridge for 5 subagent lifecycle events already wired |
| src/server.ts | Local | Agents merged (defaults + user overrides) → resolvedCustomAgents → CopilotWrapper + TaskWorker |
| docs/ARCHITECTURE.md | Local | Documents both modes, cost comparison (1 vs N+1 premium requests) |
| @github/copilot-sdk docs | Context7 | Full customAgents API, subagent delegation flow, infinite sessions |

### Current State

#### Already Implemented
1. **Interactive chat**: MessageRouter passes `enableSubagents: true` on every call
2. **Agent archetypes → SDK customAgents**: server.ts merges config/agents.json with user agents and passes to CopilotWrapperService
3. **TaskWorker subagent support**: Tasks with enableInSessionSubagents: true pass enableSubagents + customAgentsConfig to chat()
4. **Subagent event pipeline**: 5 SDK lifecycle events wired through EventEmitter → SubagentEventRelay → Socket.IO → SubagentLivePanel
5. **Session-level agent switching**: Admin API + MessageRouter.setSessionAgent()
6. **Pipeline stage toggle**: UI exposes enableInSessionSubagents checkbox per stage

#### Current Fan-Out (orchestrate-agents)
- Creates parent task + N child tasks in TaskEngine
- Each child → separate copilot.chat() session (separate API call)
- Polls via waitForTask(), optional aggregation call
- **Cost**: N+1 premium requests minimum

### SDK Native Subagent Capabilities

#### How It Works
1. Session created with `customAgents` array
2. Runtime analyzes prompt against agent name/description (intent matching)
3. If match found and `infer: true`, runtime auto-delegates
4. Sub-agent runs in isolated context (own prompt + restricted tools)
5. Lifecycle events streamed to parent session
6. Output integrated into parent response automatically
7. **Single premium request** for all subagent work

#### Context Management
- Infinite sessions with compaction (80%/95% thresholds) — already configured
- Subagent isolation: own context, output relayed as summary
- **Sequential only**: one agent per prompt turn, no parallel fan-out

### Feasibility Assessment

#### Pros
| Benefit | Detail |
|---------|--------|
| Cost reduction | 1 premium request vs N+1 |
| Lower latency | No task queue overhead, no polling |
| Shared context | Results integrate into conversation history |
| Simpler code path | No TaskEngine dependency for orchestration |
| Already wired | Event pipeline, UI, agent definitions all exist |

#### Cons
| Limitation | Detail |
|------------|--------|
| Sequential only | No parallel fan-out |
| No explicit orchestration | LLM decides delegation via intent matching |
| Context window pressure | All work shares one window |
| Less control | No per-agent model/timeout/auto-approve |
| Inference-dependent | May not pick the right agent |
| No aggregation step | No built-in combine-results mechanism |

### Required Changes
1. `orchestrationMode: "task" | "session"` toggle on orchestrate-agents tool
2. Session-mode handler: single prompt + enableSubagents + customAgents
3. Global config: `tasks.defaultOrchestrationMode`
4. Pipeline editor: expose orchestrationMode alongside enableInSessionSubagents
5. Set `infer: true` on orchestration-eligible agents (only 3/11 have it currently)
6. Hybrid: "task" for parallel, "session" for sequential chains

### Recommended Approach
Dual-mode toggle. Both modes serve different use cases:
- **"task"**: Parallel fan-out, per-agent models, timeouts, autonomous background
- **"session"**: Sequential delegation, cost-sensitive, interactive context continuity

### Open Questions
1. Can SDK handle multi-agent sequential chains in one sendAndWait?
2. Subagent delegation cap per session turn?
3. Full output vs summary relayed to parent?
4. Mid-session agent pre-selection changes without session destroy?

### Security Considerations
- Subagents share parent's permission handler
- Per-agent tool restrictions rely on SDK enforcement
- Auto-approve lists should NOT auto-propagate to subagents with different trust levels
