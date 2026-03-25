---
name: code-issue
description: Autonomous senior developer workflow for resolving GitHub epics and sub-issues. Uses TDD, security scanning, branch/PR automation, CI validation, and self-review. Continues through all sub-issues until the epic is complete. Ensures 80% unit test coverage and optionally creates Playwright e2e tests for UI work.
argument-hint: "[epic or issue number] — GitHub issue number to resolve"
---

# Code Issue Resolver

## Purpose

This skill drives the **Code Issue** agent through a complete development workflow to resolve GitHub epics and their sub-issues. It orchestrates branching, test-driven development, security scanning, CI validation, and pull request creation — all autonomously with self-review checkpoints.

## When to Use

- The user asks to "work on issue #N" or "resolve epic #N"
- The user wants to implement a feature or fix described in a GitHub issue
- The user says "start coding", "pick up the next issue", or "implement this"
- There is an epic with multiple sub-issues to complete in sequence

## Agent

This skill should be executed by the **Code Issue** agent (`code-issue.agent.md`), which has the following MCP tool groups enabled:
- `mcp_github_*` — GitHub operations (issues, PRs, branches, code push, reviews)
- `mcp_context7_*` — Library and API documentation lookups
- `mcp_chrome-devtoo_*` — Browser automation for UI testing/verification
- `fetch_webpage` — Reference documentation and live site inspection

## Workflow Overview

```
┌─────────────────────────────────────────────────┐
│  1. PLAN — Read issue, analyze codebase, plan   │
├─────────────────────────────────────────────────┤
│  2. BRANCH — Create feature branch from main    │
├─────────────────────────────────────────────────┤
│  3. IMPLEMENT — For each sub-issue:             │
│     a. Write tests (TDD)                        │
│     b. Implement code                           │
│     c. Run tests (≥80% coverage)                │
│     d. Lint and fix                             │
│     e. Self-review checklist                    │
│     f. Ask about e2e tests (if UI)              │
├─────────────────────────────────────────────────┤
│  4. SECURITY — Scan for CVEs, OWASP, vulns      │
├─────────────────────────────────────────────────┤
│  5. CI — Run CI tasks, ensure lint + tests pass │
├─────────────────────────────────────────────────┤
│  6. DELIVER — Commit, push, create PR           │
│     • Include "Closes #N" for all issues        │
│     • Add inline review comments                │
├─────────────────────────────────────────────────┤
│  7. HANDOFF — Present results, wait for review  │
└─────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: Planning

1. Read the epic/issue using `mcp_github_issue_read`
2. If it has sub-issues, read each one to understand full scope
3. Use `mcp_context7_resolve-library-id` + `mcp_context7_query-docs` for any library questions
4. Use `fetch_webpage` to pull reference documentation or examples
5. Analyze the codebase — identify affected files, patterns, and conventions
6. Create a task tracking list with all issues to resolve

### Step 2: Branch Setup

1. Ensure working directory is clean: `git status`
2. Switch to `main` and pull latest: `git checkout main && git pull --ff-only origin main`
3. Create feature branch: `feature/issue-{number}-{short-description}`
4. Push the branch to establish remote tracking: `git push -u origin {branch-name}`

#### Resuming an Existing Branch (Merge Conflict Handling)

If the feature branch already exists (resuming interrupted work) and has fallen behind `main`:

```bash
git checkout feature/{branch-name} && git fetch origin && git merge origin/main
```

- **Clean merge** → continue
- **Conflicts detected** → resolve systematically:
  1. List conflicted files: `git diff --name-only --diff-filter=U`
  2. Read each conflict — understand both the incoming (`main`) and current (feature) change before resolving
  3. Resolution strategy:
     - Foundation/infrastructure changes from `main` → prefer `main`
     - New feature code → preserve feature branch intent
     - Logic conflicts (both sides modified the same function) → merge the intent of both, ask the user if behaviorally ambiguous
  4. Stage resolved files and complete: `git add {files} && git merge --continue`
  5. Run the full test suite to verify: `pnpm test`
  6. If tests fail after merge, fix the regressions before proceeding

### Step 3: Implementation Loop

**For each sub-issue** (or the main issue if there are no sub-issues):

#### 3a. Test-Driven Development
- Write failing unit tests that verify the expected behavior
- Implement the minimum code to make tests pass
- Run the full test suite with coverage: `pnpm test:coverage`
- **Verify ≥80% coverage** across statements, branches, functions, and lines
- If any metric is below 80%, write additional tests until the gate passes
- This is a **hard gate** — do not proceed to delivery with coverage below 80%
- Use `mcp_context7_query-docs` when unsure about API usage

#### 3b. Lint & Format
- Run the project's linter (`eslint`, `checkstyle`, etc.)
- Fix all errors and warnings — do not suppress them
- Run the formatter if configured

#### 3c. Self-Review Checklist
Before proceeding, verify:
- [ ] No unused variables or imports
- [ ] No hardcoded secrets, credentials, or API keys
- [ ] Code follows existing project conventions
- [ ] Error handling at system boundaries
- [ ] Tests cover happy path, edge cases, and error cases
- [ ] No TODO/FIXME comments left unresolved
- [ ] `docs/ARCHITECTURE.md` updated (if architectural changes made)
- [ ] `docs/USER_GUIDE.md` updated (if user-facing changes made)

#### 3d. UI Consideration
If the issue involves UI changes:
- Ask the user: *"This issue includes UI changes. Would you like me to create Playwright e2e tests?"*
- If yes, create e2e tests using `mcp_chrome-devtoo_*` tools or Playwright test files
- Verify visual correctness using browser dev tools if applicable

### Step 4: Security Scan

Before creating the PR, perform a comprehensive security review:

1. **Dependency audit**:
   - Run the package manager audit: `npm audit --audit-level=moderate` (Node.js), `gradle dependencies` (Gradle), or `mvn dependency:check` (Maven)
   - **CVE lookup for direct dependencies** — for the top direct dependencies (from `package.json` `dependencies`/`devDependencies`, `pom.xml`, or `build.gradle`), use the cve-search tools:
     ```
     mcp_cve-search-mc_vul_vendor_product_cve with vendor "{vendor}" product "{package-name}"
     ```
   - For any CVE IDs returned by `npm audit`, look up the full record:
     ```
     mcp_cve-search-mc_vul_cve_search with cve_id "CVE-XXXX-XXXXX"
     ```
   - **Severity gate**: Flag any finding with CVSS ≥ 7.0 as High/Critical — these **block the PR**. CVSS 4.0–6.9 (Medium) are noted but do not block unless exploitable in context.
   - Check `mcp_cve-search-mc_vul_last_cves` to see if any recently published CVEs match the project's technology stack
2. **Static code analysis** — Review all changed files for:
   - SQL injection, XSS, CSRF
   - Insecure deserialization
   - Path traversal
   - Hardcoded credentials
   - Insecure crypto
   - OWASP Top 10 issues
3. **Report to user** — Present findings with severity and suggested fixes
4. **Apply fixes** — Fix all identified vulnerabilities and re-run tests

### Step 5: CI Validation

1. Check for CI configuration (`.github/workflows/`, `Jenkinsfile`, etc.)
2. Run CI tasks locally where possible
2. Verify: all tests pass, linter clean, **coverage ≥80% (run `pnpm test:coverage` and check the summary table)**

### Step 5.5: Update Living Documents

After implementation and before creating the PR, update the project's living documents if they exist:

#### `docs/ARCHITECTURE.md`
Update if this issue introduced:
- New modules, services, or components
- New API endpoints or data models
- Changes to the system architecture or data flow
- New dependencies or integrations
- Infrastructure or deployment changes

**What to update**:
- Add new components to the architecture diagram (Mermaid)
- Update the project structure section
- Document new API endpoints with request/response contracts
- Update the data model section if schema changed
- Add entries to the technology stack table if new deps added

#### `docs/USER_GUIDE.md`
Update if this issue introduced:
- New user-facing features or pages
- Changes to existing user workflows
- New configuration options
- New CLI commands or scripts

**What to update**:
- Add new feature documentation with screenshots/examples
- Update getting started instructions if onboarding changed
- Document new configuration options with defaults
- Update the FAQ if common questions are anticipated

#### `.github/copilot-instructions.md`
Update only when changes affect how a future agent would navigate or build this repo. Trigger conditions:

| Change Type | Example | Update? |
|---|---|---|
| New top-level module or service | Added `src/payments/` | ✅ Update Project Layout + Architecture |
| New build/test/run command | Added `npm run migrate` | ✅ Update Build & Run Commands |
| New coding convention established | Adopted Zod validation everywhere | ✅ Update Coding Conventions |
| New major dependency with unusual setup | Added Playwright, Redis | ✅ Update Known Gotchas |
| New CI check or lint rule | Added type-check step to CI | ✅ Update CI / Validation Pipeline |
| Routine bug fix or small feature | Fixed a null check | ❌ Skip — no structural change |
| Test added for existing logic | Added unit test | ❌ Skip |

**What to update** (surgical edits only — keep file under ~150 lines):
- Update the relevant section(s) in place
- Do **not** rewrite the entire file
- Add gotchas only if you hit non-obvious issues during the implementation
- End with: `<!-- Last updated: {date} by Code Issue agent resolving #{issue-number} -->`

> **Rule**: If `.github/copilot-instructions.md` does not exist, skip this step — it is created by the Code Planner agent during project setup. Do not create it here.

> **Why this matters**: `copilot-instructions.md` is automatically injected into every Copilot Chat request, Copilot code review, and Copilot coding agent session for this repo. Keeping it accurate means future agents (and humans) don't need to re-explore the codebase from scratch.

> **Rule**: If `docs/ARCHITECTURE.md` or `docs/USER_GUIDE.md` do not exist, skip those sections. These documents are created by the Code Planner agent during project setup.

### Step 6: Delivery

1. Stage all changes: `git add -A`
2. Commit with conventional message: `feat: [Issue #N] description` or `fix: [Issue #N] description`
3. Push branch to origin
4. Create PR using `mcp_github_create_pull_request`:
   - Title: `feat: Resolve #{epic-number} — {description}`
   - Body includes:
     - Summary of all changes
     - `Closes #N` for every resolved issue
     - Test coverage summary
     - Security scan results
5. Add inline review comments using `mcp_github_add_comment_to_pending_review`
   - If MCP tool fails, fall back to: `gh pr create` via terminal

### Step 7: Handoff

Present to the user:
- **PR link**
- **Issues to close** — numbered list
- **Coverage** — statement/branch/function/line percentages (all must be ≥80%)
- **Security** — clean scan or findings with status

Then state:
> **PR created and self-reviewed. All issues listed for closure. Please review. Type 'Next' when ready for the next epic.**

## Example Invocation

```
@Code Issue resolve epic #42
```

```
Work on issue #15 — it has 4 sub-issues
```

```
Pick up where we left off on epic #42, starting from sub-issue #45
```

## Error Recovery

| Scenario | Action |
|----------|--------|
| GitHub push fails | Fall back to `git push` via terminal |
| MCP review tool fails | Fall back to `gh pr create` CLI |
| Tests fail after implementation | Debug, fix, and re-run |
| Security scan finds CVEs | Present to user, suggest fixes, apply |
| CI task fails | Read logs, fix issues, re-run |
| Issue is unclear or blocked | Ask user for clarification |

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

- Git configured with push access to the repository
- GitHub CLI (`gh`) installed as fallback
- Project test runner configured (Vitest, Jest, JUnit, etc.)
- Project linter configured (ESLint, Checkstyle, etc.)
- MCP servers running: GitHub, Context7, Chrome DevTools (for UI work)
