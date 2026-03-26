---
name: resolve-pr-comments
description: Fetch, triage, and fix unresolved PR review comments. Reads comment threads, validates each against code context and best practices, applies fixes, pushes, and resolves threads via GitHub API. Works as a sub-workflow of the Code Issue agent after a PR has been reviewed.
argument-hint: "[PR number] — e.g. 'resolve comments on PR #47'"
---

# Resolve PR Review Comments

## Purpose

This skill processes **unresolved review comments** on a pull request, fixes valid issues, pushes the fixes, and resolves the comment threads — all autonomously. It replaces the one-shot `review-pr-issues.prompt.md` with a durable, multi-phase workflow that integrates with the Code Issue agent's branching and testing conventions.

## When to Use

- A reviewer has left comments on your PR and you want to address them
- The user says "fix PR comments", "resolve review comments on PR #N", or "address feedback on #N"
- After getting a "changes requested" review on a pull request
- As a handoff step from the **Code Review** agent after it identifies issues

## Agent

Execute with the **Code Issue** agent (`code-issue.agent.md`). The agent has the required MCP tools:
- `github/*` — Read PR comments, reply to threads, push files
- `context7/*` — Look up library/API docs when evaluating a comment's validity
- `cve-search-mcp/*` — Verify security-related comments against CVE databases
- Built-in tools — `edit`, `execute`, `read`, `search`, `todo`

## Workflow Overview

```
┌─────────────────────────────────────────────────────┐
│  1. GATHER — Fetch PR, diff, and all review threads │
├─────────────────────────────────────────────────────┤
│  2. TRIAGE — Classify each comment                  │
│     • actionable → fix                              │
│     • clarification-needed → ask user               │
│     • already-resolved → skip                       │
│     • disagree → explain reasoning, ask user        │
├─────────────────────────────────────────────────────┤
│  3. CONTEXT — Load related issue/epic requirements  │
├─────────────────────────────────────────────────────┤
│  4. FIX — Apply changes, run tests, lint            │
├─────────────────────────────────────────────────────┤
│  5. COMMIT — Atomic commit referencing the PR       │
├─────────────────────────────────────────────────────┤
│  6. RESPOND — Reply to each thread with fix details │
├─────────────────────────────────────────────────────┤
│  7. REPORT — Summary to user                        │
└─────────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: Gather

1. **Fetch PR metadata** using `mcp_github_pull_request_read`:
   - PR title, body, branch, base branch, linked issues
   - Extract any `Closes #N` references to find the parent issue/epic
2. **Fetch all review comments** using `mcp_github_pull_request_read` (comments mode)
   - If MCP tool lacks thread-level data, fall back to terminal:
     ```bash
     gh api repos/{owner}/{repo}/pulls/{PR_NUMBER}/comments --paginate
     gh api repos/{owner}/{repo}/pulls/{PR_NUMBER}/reviews --paginate
     ```
3. **Fetch the diff** to understand the full change set:
   ```bash
   gh pr diff {PR_NUMBER}
   ```
4. **Read affected files** in the workspace for full context (not just the diff hunks)

### Step 2: Triage

For each unresolved comment thread, classify it:

| Category | Criteria | Action |
|----------|----------|--------|
| **actionable** | Clear code change requested, technically valid | Fix it |
| **clarification-needed** | Ambiguous or requires design decision from user | Ask user |
| **already-resolved** | Comment was on code that's since been updated | Reply noting resolution |
| **disagree** | Comment suggests a change that would introduce a bug or conflict with requirements | Explain reasoning, ask user to decide |
| **nit** | Style/cosmetic suggestion, valid but minor | Fix it (cheap to address) |
| **scanner-finding** | Comment from `github-advanced-security`, `dependabot`, `snyk`, or another security bot | Treat as actionable — scanner findings are authoritative |
| **copilot-review** | Comment from GitHub Copilot automated review (`copilot`, `github-copilot`, `copilot-pull-request-reviewer`) | Validate first — Copilot can produce false positives on complex code. If valid → fix. If false positive → reply explaining why. |

**Identifying comment authors:**

When fetching review comments, check the `author` field to categorize the source:

| Author Pattern | Category | Priority |
|----------------|----------|----------|
| `github-advanced-security` | Scanner (CodeQL/GHAS) | **Highest** — static analysis, authoritative |
| `dependabot` | Scanner (dependency) | **Highest** — known CVE alerts |
| `snyk`, `sonarcloud` | Scanner (third-party) | **High** — verify but treat seriously |
| `copilot`, `github-copilot`, `copilot-pull-request-reviewer` | Copilot automated review | **Medium** — validate each finding individually |
| Any other non-PR-author username | Human reviewer | **High** — understands business context |
| `codecov`, `coveralls` | Coverage bot | **Low** — informational only |

Scanner comments have a distinct format — they link to a code scanning alert page (e.g., `https://github.com/{owner}/{repo}/security/code-scanning/{N}`). These are **not opinion-based** — they are static analysis findings that should be treated with higher authority than typical reviewer comments.

**Triage rules for scanner findings:**
- `is_outdated: true` → Code changed after the finding. **Read the current code** to verify if the fix actually addressed the issue. If yes → `already-resolved`. If the vulnerability moved rather than being fixed → `actionable`.
- `is_outdated: false` → Code has NOT changed. Finding is **presumed still valid**. Classify as `actionable`.
- `is_resolved: true` → Explicitly resolved by a reviewer. Can be skipped.
- **Severity escalation**: CodeQL `High` and `Critical` findings must be prioritized above all human reviewer comments. Fix these first.

**Triage rules for Copilot review comments:**
- Copilot comments are suggestions, not authoritative findings. Each must be validated against the actual code context.
- If Copilot flags an unused import or dead code → likely valid, fix it.
- If Copilot suggests a refactor or design change → check if it aligns with project conventions and the linked issue requirements. If it conflicts, classify as `disagree`.
- If Copilot flags a security issue → cross-reference with your own analysis and any scanner findings. Copilot security suggestions overlap with but are less authoritative than CodeQL.

**Triage rules for human reviewer comments:**
- Human comments carry high trust — they understand the business context.
- Comments marked with 🔴, "CRITICAL", "BLOCKING", or "REQUEST_CHANGES" severity → treat as highest priority within human comments.
- Comments prefixed with `nit:` → classify as `nit`.
- Comments asking a question without requesting a change → classify as `clarification-needed`.

**Validation checks for each comment:**
- Does the suggested change align with the linked issue/epic requirements?
- Does the suggested change follow project conventions?
- Does `context7` docs confirm the reviewer's claim about API usage?
- Would the suggested change break existing tests?
- For scanner findings: Does the current code at the flagged line still exhibit the vulnerability?
- For Copilot comments: Is the suggestion actually correct for this code context?

### Step 3: Context Loading

Before applying fixes, ensure the broader picture is understood:

1. **Read the linked issue/epic** — check requirements, acceptance criteria, DoD
2. **Read docs/** — scan the `docs/` folder for relevant specs, architecture docs, or user guides
3. **Check test expectations** — run existing tests to establish a baseline

This prevents "fixing" a review comment in a way that violates the original requirements.

### Step 4: Fix

For each **actionable** and **nit** comment:

1. Read the file and locate the code referenced in the comment
2. Apply the fix — respect project conventions
3. If the fix is non-trivial, write or update a test to cover it
4. Run the full test suite: ensure no regressions
5. Run the linter: ensure no new warnings/errors

**Rules:**
- Fix exactly what was requested — do not refactor adjacent code
- If a fix conflicts with another comment, resolve the conflict and note it
- If a fix would break a test, investigate before changing the test

### Step 5: Commit

1. Stage all changes: `git add -A`
2. Commit with a clear message:
   ```
   fix: address review comments from PR #{PR_NUMBER}
   
   - [comment-id] Description of fix
   - [comment-id] Description of fix
   ```
3. Push to the PR branch: `git push`

### Step 6: Respond to Threads

For each resolved comment, reply with the fix details:

**Primary method** — GitHub MCP tools:
- Use `mcp_github_add_reply_to_pull_request_comment` to reply to the thread

**Fallback** — `gh` CLI:
```bash
# Reply to a specific comment
gh api POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/replies \
  -f body="Fixed in $(git rev-parse --short HEAD). [description of change]"
```

**Thread resolution** (if supported):
```bash
# Get the thread node ID, then resolve it
gh api graphql -f query='
  mutation {
    resolveReviewThread(input: {threadId: "THREAD_NODE_ID"}) {
      thread { isResolved }
    }
  }
'
```

**Fallback** — summary review comment:
```bash
gh pr review {PR_NUMBER} --comment \
  -b "Addressed all review comments in $(git rev-parse --short HEAD):
  - Fixed X in file.ts
  - Fixed Y in other.ts
  - Question about Z — see inline reply"
```

### Step 7: Report

Present a summary to the user:

```
## PR #{PR_NUMBER} — Review Comments Resolved

### Fixed (N comments)
| # | File | Comment | Fix |
|---|------|---------|-----|
| 1 | src/foo.ts:42 | "Use const instead of let" | Changed to const |

### Needs Clarification (N comments)
| # | File | Comment | Question |
|---|------|---------|----------|
| 1 | src/bar.ts:15 | "Should this validate input?" | The issue spec doesn't mention validation. Should I add it? |

### Already Resolved (N comments)
- Comment on line 20 of old diff — code was rewritten in previous commit

### Scanner Findings (N comments)
| # | Scanner | File | Finding | Severity | Fix |
|---|---------|------|---------|----------|-----|
| 1 | CodeQL | src/api/m365.ts:151 | Missing rate limiting | High | Added express-rate-limit middleware |
| 2 | CodeQL | src/m365/file-parser.ts:132 | Incomplete string escaping | Medium | Added backslash escaping |

### Copilot Review (N comments)
| # | File | Comment | Triage | Action |
|---|------|---------|--------|--------|
| 1 | ui/lib/api.ts:42 | Unused import | Valid | Removed import |
| 2 | src/utils.ts:18 | Suggest using optional chaining | False positive | Replied with explanation |

### Human Reviewer (N comments)
| # | Reviewer | File | Comment | Fix |
|---|----------|------|---------|-----|
| 1 | mgcronin | src/api/m365.ts:102 | Rate limit /cleanup | Added middleware |

**Commit:** `abc1234`
**Tests:** All passing (87% coverage)
**Lint:** Clean
```

## Error Recovery

| Scenario | Action |
|----------|--------|
| Cannot identify comment thread IDs | Use summary review comment as fallback |
| Fix breaks tests | Debug, adjust fix, re-run |
| Comment references deleted code | Mark as already-resolved, reply noting it |
| MCP GitHub tools fail | Fall back to `gh` CLI for all operations |
| Merge conflict on push | Rebase from base branch, re-apply, push |
| Reviewer comment is wrong | Explain reasoning in reply, flag for user |

## Example Invocations

```
@Code Issue resolve comments on PR #47
```

```
Fix the review feedback on PR #23 — the reviewer flagged some security issues
```

```
Address the changes requested in my latest PR
```

## Shell Execution Rules

**Critical — follow these to avoid orphaned terminal tabs in VS Code:**

1. **Batch commands** — chain multiple commands in a SINGLE `execute` call using `&&`. Never create a new shell invocation for each command.
   ```bash
   # CORRECT — one execute call
   pnpm lint && pnpm typecheck && pnpm test
   
   # WRONG — three separate execute calls
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

2. **No watch mode** — never run watch or interactive commands. Always enforce one-shot execution:
   - `pnpm test` → already configured as `vitest run` in this repo (exits cleanly)
   - `pnpm test:watch` → NEVER use this in agent workflows
   - `jest --watch` → use `jest --run` instead
   - `webpack --watch` → use `webpack --mode production` instead
   - `nodemon` → spawn via tsx/node directly instead

3. **No background processes** — never use `&`, `nohup`, or `disown` to background a process. Each command must run to completion before continuing.

4. **No interactive sessions** — never launch interactive REPLs (`node`, `python`, `psql`, `sqlite3` without `-c`). Use one-shot variants with command flags.

5. **Prefer `execution_subagent`** — when you need to run a command and see its output to make a decision, prefer using the `execution_subagent` tool over the `execute` tool where available. `execution_subagent` is non-interactive and always exits.

6. **CI quality gate** — always run the gate as ONE batched call:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test && cd ui && npx next build
   ```

## Prerequisites

- On the PR's feature branch (or able to check it out)
- Git configured with push access
- GitHub CLI (`gh`) installed as fallback
- Project test runner and linter configured
