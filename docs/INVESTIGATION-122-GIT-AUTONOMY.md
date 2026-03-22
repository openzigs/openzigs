# Investigation #122: Git & Dependabot Autonomous Workflow

> **Status:** Complete — implements the investigation requirements for [Issue #122](https://github.com/openzigs/openzigs/issues/122).
>
> **Dependency:** #121 (Per-Run Approval Overrides) — now implemented on branch `feature/issue-118-advanced-orchestration`.

## Executive Summary

OpenZigs can orchestrate an autonomous Dependabot-like workflow today using `orchestrate-agents` with per-agent model overrides (#120) and per-run approval overrides (#121). The main gap is **credential forwarding** — the shell-execute tool inherits `process.env` but does not explicitly inject `GITHUB_PERSONAL_ACCESS_TOKEN` into git commands. For HTTPS-based git operations, a system-level git credential helper must be pre-configured.

## Investigation Answers

### 1. Are current shell tools sufficient?

**Partially.** The `shell-execute` tool supports:

| Argument | Type | Notes |
|----------|------|-------|
| `command` | `string` | Must be in the configured allowlist |
| `args` | `string[]` | Optional argument list |
| `cwd` | `string` | Must be within `allowedDirs` |
| `timeout` | `number` | Default 30,000ms |

**Gaps:**
- `git` must be added to the shell allowlist in `config/tools.json`
- The handler calls `execFile()` with no custom `env` — it inherits `process.env`. Git authentication over HTTPS requires either a pre-configured credential helper (e.g., `git config --global credential.helper store`) or SSH.
- The 30s default timeout may be insufficient for `git clone` on large repos. Agent prompts should specify `timeout: 120000` in tool args.

**Recommendation:** For production, add an optional `env` parameter to `shell-execute` so agents can inject `GH_TOKEN` or `GIT_ASKPASS`. For the prototype, SSH agent forwarding or a global credential store works.

### 2. GitHub MCP server coverage

**Excellent.** 35 tools registered, including all operations needed for this workflow:

| Operation | Tool Name | Risk Level |
|-----------|-----------|------------|
| Create branch | `github-create-branch` | medium |
| Push files | `github-push-files` | **high** |
| Create/update file | `github-create-or-update-file` | **high** |
| Create PR | `github-create-pr` | **high** |
| Add PR comment | `github-add-issue-comment` | medium |
| List PRs | `github-list-prs` | low |

The `github-push-files` tool implements the full Git Data API (blob → tree → commit → ref update) in a single operation, which is preferable to `git push` via shell for the PR creation workflow.

**For the Dependabot pattern:** The fixer agent can use `github-push-files` instead of `shell-execute git push`, avoiding the credential forwarding gap entirely.

### 3. Working directory isolation

**Not isolated today.** All parallel tasks share the same process and filesystem namespace. `shell-execute` uses `allowedDirs` for sandboxing but has no per-task directory concept.

**Impact:** Two fixer agents working on different branches simultaneously could conflict if they share a working directory. The `cwd` argument to `shell-execute` mitigates this — agents can be instructed to use separate subdirectories.

**Recommended approach for parallel branch work:**
```
/tmp/openzigs-workspaces/
  ├── dep-update-react/     ← Agent 1 cwd
  ├── dep-update-express/   ← Agent 2 cwd
  └── dep-update-zod/       ← Agent 3 cwd
```

Each agent's context should include:
```
Work in /tmp/openzigs-workspaces/{package-name}/. Clone once, then operate within that directory.
```

### 4. Credential forwarding

**Current state:** Shell commands inherit `process.env`. If `GITHUB_PERSONAL_ACCESS_TOKEN` is set in the server's environment, git can use it via:
```bash
git -c credential.helper='!f() { echo "password=$GITHUB_PERSONAL_ACCESS_TOKEN"; }; f' push
```

But this is fragile. Better options:
1. **Use GitHub MCP tools instead of shell git** — `github-push-files`, `github-create-branch` bypass credential issues entirely.
2. **SSH agent** — if the server process has access to `SSH_AUTH_SOCK`, `git push` via SSH works transparently.
3. **Git credential store** — pre-configure `~/.git-credentials` with a PAT on the host.

## Scheduled Job Configuration

### Option A: Single Orchestrated Job (Recommended)

Uses `orchestrate-agents` to fan-out the three phases with per-agent models:

```json
{
  "name": "weekly-dependency-update",
  "cronExpression": "0 9 * * 1",
  "timezone": "America/New_York",
  "actionType": "prompt",
  "actionPayload": {
    "promptName": "dependabot-orchestrator"
  },
  "model": "gpt-4.1",
  "allowedTools": [
    "orchestrate-agents",
    "shell-execute",
    "web-search",
    "read-file",
    "write-file",
    "github-list-prs",
    "github-create-branch",
    "github-push-files",
    "github-create-pr",
    "github-add-issue-comment"
  ],
  "autoApproveTools": [
    "orchestrate-agents",
    "shell-execute",
    "read-file",
    "web-search"
  ],
  "enabled": true
}
```

The orchestrator prompt would dispatch three agents via `orchestrate-agents`:

```json
{
  "agents": [
    {
      "goal": "Audit npm dependencies in /tmp/openzigs-ws/repo — run npm outdated, identify security advisories",
      "context": "Clone https://github.com/openzigs/openzigs to /tmp/openzigs-ws/repo if not present. Report outdated packages as JSON.",
      "model": "gpt-4o-mini",
      "auto_approve_tools": ["shell-execute", "web-search"]
    },
    {
      "goal": "Update each outdated package, run tests, commit changes on separate branches",
      "context": "Work in /tmp/openzigs-ws/repo. Create branch dep/update-{pkg} for each. Revert if tests fail.",
      "model": "gpt-4.1",
      "auto_approve_tools": ["shell-execute", "write-file", "read-file"]
    },
    {
      "goal": "Create pull requests for each successful update branch",
      "context": "Use github-create-pr for each dep/update-* branch. Include changelog summary in PR body.",
      "model": "gpt-4o-mini",
      "auto_approve_tools": ["github-create-pr", "github-add-issue-comment", "github-list-prs"]
    }
  ],
  "aggregation_prompt": "Summarize the dependency update results: which packages were updated, which PRs were created, and any failures.",
  "timeout_seconds": 600
}
```

### Option B: Sequential Scheduled Jobs

Three separate jobs triggered at staggered intervals:

| Job | Cron | Model | Auto-Approve |
|-----|------|-------|-------------|
| `dep-audit` | `0 9 * * 1` | `gpt-4o-mini` | `shell-execute` |
| `dep-fix` | `30 9 * * 1` | `gpt-4.1` | `shell-execute, write-file` |
| `dep-pr` | `0 10 * * 1` | `gpt-4o-mini` | `github-create-pr` |

This is simpler but lacks coordination between phases.

## Tool Gaps Identified

| Gap | Severity | Workaround |
|-----|----------|-----------|
| No `env` parameter on `shell-execute` | Medium | Use GitHub MCP tools for writes; SSH for reads |
| No per-task working directory | Low | Use `cwd` argument on `shell-execute` with isolated paths |
| 30s default shell timeout | Low | Agent specifies `timeout: 120000` in tool args |
| `git` not in default allowlist | Config | Add to `config/tools.json` `shellAllowlist` |

## Recommended Next Steps

1. **Add `git` to shell allowlist** in default config
2. **Create the `dependabot-orchestrator` saved prompt** with the workflow instructions
3. **Test on a fork** — create a test repo with intentionally outdated deps
4. **Consider `env` parameter** — PR to add optional env injection to shell-execute (low priority if GitHub MCP tools handle all writes)

## Proof of Concept Results

> **Note:** A live proof-of-concept requires a running OpenZigs instance with a valid GitHub PAT. The configuration above has been validated structurally against the current codebase. The approval override mechanism (#121) has been verified in unit tests — auto-approved tools bypass the approval queue and log an audit entry.

The workflow is architecturally sound. The `orchestrate-agents` tool with per-agent `auto_approve_tools` and `model` overrides provides exactly the primitives needed. The primary risk is credential forwarding for shell-based git operations, which is cleanly avoided by preferring GitHub MCP API tools for all write operations.
