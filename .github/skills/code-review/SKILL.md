---
name: code-review
description: Comprehensive code review workflow for pull requests. Validates against requirements (epic/issue), checks code quality, security (OWASP Top 10), performance, test coverage, and documentation. Leaves structured GitHub review with inline comments. Optionally hands off to Code Issue agent for fixes.
argument-hint: "[PR number] — e.g. 'review PR #47' or 'review PR #47 against epic #12'"
---

# Code Review

## Purpose

This skill drives the **Code Review** agent through a structured, multi-dimensional review of a pull request. It goes beyond surface-level linting — it validates the PR against the original requirements, checks for OWASP security issues, evaluates performance characteristics, verifies test quality, and assesses code design. The review is published as a formal GitHub PR review with inline comments.

Inspired by [Google's Engineering Practices](https://google.github.io/eng-practices/review/reviewer/looking-for.html) and the [OWASP Code Review Guide](https://owasp.org/www-project-code-review-guide/).

## When to Use

- A PR is ready for review and the user asks "review PR #N"
- The user wants a pre-merge quality gate before approving
- After the Code Issue agent creates a PR and before the user merges
- The user asks to "check if PR #N meets the requirements for issue #M"
- As a handoff target from the Code Issue agent's delivery step

## Agent

Execute with the **Code Review** agent (`code-review.agent.md`), which has the same tool access as Code Issue but operates with a reviewer mindset — read-heavy, comment-focused, doesn't modify code unless asked.

## Workflow Overview

```
┌───────────────────────────────────────────────────────┐
│  1. ORIENT — Read PR, linked issues, and docs/        │
├───────────────────────────────────────────────────────┤
│  1b. SCANNER — Fetch CodeQL / GHAS bot comments       │
├───────────────────────────────────────────────────────┤
│  1c. PRIOR REVIEWS — Analyze human & Copilot comments │
├───────────────────────────────────────────────────────┤
│  2. REQUIREMENTS — Validate completeness against spec │
├───────────────────────────────────────────────────────┤
│  3. DESIGN — Evaluate architecture and design choices │
├───────────────────────────────────────────────────────┤
│  4. SECURITY — OWASP Top 10 + CVE scan + scanner xref │
├───────────────────────────────────────────────────────┤
│  5. QUALITY — Code quality, complexity, naming, style │
├───────────────────────────────────────────────────────┤
│  6. PERFORMANCE — Identify bottlenecks and anti-pats  │
├───────────────────────────────────────────────────────┤
│  7. TESTS — Coverage, quality, edge cases             │
├───────────────────────────────────────────────────────┤
│  8. DOCUMENTATION — Inline docs, README, changelogs   │
├───────────────────────────────────────────────────────┤
│  9. PUBLISH — Submit GitHub review with verdict       │
├───────────────────────────────────────────────────────┤
│  10. HANDOFF — Offer to fix issues via Code Issue     │
└───────────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: Orient

**Goal:** Build a complete mental model before reviewing any code.

1. **Read the PR** using `mcp_github_pull_request_read`:
   - Title, description, branch, base branch
   - Extract `Closes #N` / `Fixes #N` references
   - Note the author and any previous reviews
2. **Read the linked issue(s)/epic** using `mcp_github_issue_read`:
   - Acceptance criteria and definition of done
   - Sub-issue scope and boundaries
   - Labels (bug, feature, security, etc.)
3. **Scan docs/ folder** — read any relevant specs, architecture docs, or user guides in the `docs/` directory
4. **Fetch the diff**:
   ```bash
   gh pr diff {PR_NUMBER}
   ```
5. **List changed files** to understand the scope:
   ```bash
   gh pr view {PR_NUMBER} --json files --jq '.files[].path'
   ```
6. **Read each changed file in full** — not just the diff hunks. Context matters.

### Step 1b: Security Scanner Comments (CodeQL / GHAS)

**Goal:** Collect all findings from automated security scanners so they can be cross-referenced during the security review and tracked in the final verdict.

GitHub Advanced Security (GHAS) runs CodeQL analysis on PRs and posts review comments from the `github-advanced-security` bot. These comments identify real vulnerabilities (injection, path traversal, missing rate limiting, XSS, etc.) that the human/agent reviewer must acknowledge.

**Procedure:**

1. **Fetch all review comments** on the PR:
   ```
   mcp_github_pull_request_read  method=get_review_comments  perPage=100
   ```

2. **Filter for scanner bot comments** — identify comments where `author` is `github-advanced-security` (CodeQL), `dependabot`, `snyk`, or any other known security bot. These are distinct from human reviewer comments.

3. **Classify each scanner finding:**

   | Status | Meaning |
   |--------|---------|
   | `is_outdated: true` | The code was changed after the comment — finding MAY be resolved. **Read the current file at the flagged location to verify.** |
   | `is_outdated: false` | The code has NOT changed since the comment — finding is **likely still present**. |
   | `is_resolved: true` | Explicitly resolved by a reviewer — can be skipped. |

4. **Build a scanner findings table** for use in Step 4 and Step 9:

   ```markdown
   | # | Bot | File:Line | Finding | Severity | Outdated? | Verified? |
   |---|-----|-----------|---------|----------|-----------|----------|
   | 1 | CodeQL | src/api/m365.ts:151 | Missing rate limiting | High | No | Pending |
   | 2 | CodeQL | src/m365/file-parser.ts:132 | Incomplete string escaping | Medium | No | Pending |
   ```

5. **For each non-outdated, non-resolved finding**, read the current file at the flagged line to understand the context. These are your **pre-seeded security findings** for Step 4.

6. **For each outdated finding**, still verify by reading the current code — "outdated" means the diff changed, NOT that the issue was fixed. A refactor might move the vulnerability rather than fix it.

**Important:** Scanner findings are authoritative signals. A CodeQL High/Critical that remains unaddressed after your review is a **blocking** issue that must appear in your verdict, even if your own manual analysis didn't independently flag it.

### Step 1c: Existing Reviewer Comments (Human & Copilot)

**Goal:** Identify and analyze all prior review comments from human reviewers, GitHub Copilot, or any other non-scanner reviewer so their feedback is incorporated into the review verdict.

Other people or automated reviewers (e.g., GitHub Copilot code review) may have already left comments on the PR. These comments represent prior review work that should not be ignored or duplicated.

**Procedure:**

1. **From the same review comments fetched in Step 1b**, filter for all comments where `author` is NOT a known scanner bot (`github-advanced-security`, `dependabot`, `snyk`, `sonarcloud`) and is NOT the PR author themselves.

2. **Identify the reviewer type** for each comment:

   | Author Pattern | Type | Trust Level |
   |----------------|------|-------------|
   | `copilot` / `github-copilot` / `copilot-pull-request-reviewer` | GitHub Copilot automated review | Medium — good at patterns, may miss context |
   | Any human username | Human reviewer | High — understands business context |
   | Other bots (e.g., `codecov`, `sonarcloud`) | Quality/coverage bots | Medium — data-driven, verify claims |

3. **Classify each existing comment:**

   | Status | Meaning |
   |--------|---------|
   | `is_outdated: true` + code changed | May be resolved — **verify by reading current code** |
   | `is_outdated: false` | Comment likely still applies |
   | `is_resolved: true` | Explicitly resolved — note but don't re-open unless the fix is wrong |
   | Thread has replies | Read the full thread to understand the discussion before judging |

4. **Build an existing comments table** for tracking:

   ```markdown
   | # | Reviewer | Type | File:Line | Comment Summary | Outdated? | Status |
   |---|----------|------|-----------|-----------------|-----------|--------|
   | 1 | mgcronin | Human | src/api/m365.ts:102 | Missing rate limiting on /cleanup | No | Unresolved |
   | 2 | copilot | Copilot | ui/lib/api.ts:42 | Unused import | Yes | Verify |
   ```

5. **For each unresolved, non-outdated comment:**
   - Read the current code at the flagged location
   - Determine if the comment is valid, already addressed, or a false concern
   - If valid and unaddressed: include it in your review findings (do NOT duplicate it as a new inline comment — reference the existing thread instead)
   - If addressed by subsequent commits: note it as resolved in your review summary

6. **For outdated comments with replies:**
   - Read the full thread to understand the discussion
   - Check if the code change that made it "outdated" actually addressed the concern
   - If the concern persists despite the code change, flag it as still-open

7. **Cross-reference with your own findings:**
   - If a prior reviewer already flagged something you also found, reference their comment rather than duplicating
   - If a prior reviewer flagged something you disagree with, explain your reasoning
   - If a prior reviewer's comment was addressed but introduced a new issue, flag the regression

**Priority of existing comments:**
- 🔴 **Blocking comments** from humans (marked with "CRITICAL", "BLOCKING", or severity indicators) → must be addressed before APPROVE
- 🟡 **Copilot suggestions** → validate each one; Copilot can produce false positives on complex code
- 🟢 **Nit / style comments** → nice to fix but not blocking
- **Resolved threads** → verify the fix is correct, then skip

**Include in Step 9 (Publish) review body:**
```markdown
### Prior Review Comments: {N total, M unresolved}
| Reviewer | Unresolved | Addressed | Disagreed |
|----------|------------|-----------|-----------|
| mgcronin | 2 | 3 | 0 |
| copilot | 0 | 1 | 1 (false positive) |
```

### Step 2: Requirements Validation

**Goal:** Ensure the PR delivers what was asked for — no more, no less.

Check each item against the linked issue/epic:

| Check | Question |
|-------|----------|
| **Completeness** | Does the PR address ALL acceptance criteria from the issue? |
| **Scope creep** | Does the PR include changes NOT described in the issue? |
| **Sub-issues** | If this is part of an epic, are all assigned sub-issues covered? |
| **Edge cases** | Did the issue mention edge cases? Are they handled? |
| **Backwards compat** | Does this change break any existing APIs or behavior? |

**Output:** List of requirements with pass/fail status. Flag any gaps.

### Step 3: Design Review

**Goal:** Evaluate high-level architecture and design decisions.

Based on [Google's design review criteria](https://google.github.io/eng-practices/review/reviewer/looking-for.html#design):

- **Does this change belong here?** Or should it be in a library, a different module, or a configuration?
- **Integration:** Does it integrate well with the existing codebase architecture?
- **Abstractions:** Are the right abstractions used? Too many layers? Too few?
- **Coupling:** Does this change introduce tight coupling between modules?
- **Single Responsibility:** Does each new class/function/module do one thing?
- **Over-engineering:** Is there unnecessary generalization or premature abstraction?
- **Patterns:** Does it follow existing patterns in the codebase, or introduce new ones without justification?

Use `context7` to verify any library APIs are used correctly.

### Step 4: Security Review (OWASP Focus)

**Goal:** Identify security vulnerabilities before they reach production.

Scan all changed files for these OWASP Top 10 categories:

| OWASP Category | What to Look For |
|----------------|------------------|
| **A01: Broken Access Control** | Missing auth checks, IDOR, privilege escalation, CORS misconfig |
| **A02: Cryptographic Failures** | Hardcoded secrets, weak algorithms (MD5, SHA1), missing TLS, plaintext storage |
| **A03: Injection** | SQL injection, NoSQL injection, OS command injection, LDAP injection, XSS |
| **A04: Insecure Design** | Missing rate limiting, no input validation at trust boundaries, business logic flaws |
| **A05: Security Misconfiguration** | Debug mode enabled, default credentials, unnecessary features exposed, verbose errors |
| **A06: Vulnerable Components** | Known CVE in dependencies — use `cve-search-mcp` tools to verify |
| **A07: Auth Failures** | Weak passwords allowed, missing MFA, session fixation, token leakage in logs/URLs |
| **A08: Data Integrity Failures** | Insecure deserialization, unsigned updates, CI/CD pipeline manipulation |
| **A09: Logging Failures** | Missing audit logs for sensitive ops, PII in logs, no alerting |
| **A10: SSRF** | Unvalidated URLs from user input used in server-side requests |

**Additional checks:**
- No `eval()`, `innerHTML` with untrusted data, or `dangerouslySetInnerHTML` without sanitization
- External links use `rel="noopener noreferrer"` with `target="_blank"`
- API keys / secrets not committed (check `.env` patterns, config files)
- Path traversal protection on file operations
- CSRF tokens present on state-changing requests

**Cross-reference with scanner findings (Step 1b):**

For each finding in the scanner table built during Step 1b:

1. **Read the current code** at the flagged file and line.
2. **Verify** whether the finding is still valid, a false positive, or already fixed.
3. **Update the Verified column**: `Still present`, `Fixed`, or `False positive (reason)`.
4. **For findings still present**: Add them to your review as inline comments with the scanner's severity. Prefix with the scanner name for traceability:
   ```
   🔒 **CodeQL: Missing rate limiting (High)** — This route handler performs file system access without rate limiting.
   Recommend: Add express-rate-limit middleware to this route group.
   ```
5. **For false positives**: Optionally add a comment explaining why the finding doesn't apply, so the scanner comment can be resolved.
6. **Any CodeQL High or Critical finding that is `Still present` is automatically a blocking issue** — it must contribute to a `REQUEST_CHANGES` verdict regardless of other review dimensions.

**Scanner-specific patterns to check:**

| Scanner Finding | What to Verify |
|-----------------|----------------|
| Missing rate limiting | Is the route behind auth middleware? Does it do I/O? Add `express-rate-limit` if exposed. |
| Incomplete string escaping | Is the output used in HTML/SQL context? Check if backslash, quote, and angle bracket escaping are all handled. |
| Incomplete multi-character sanitization | Does the sanitizer handle nested/reconstructed tags? Test with `<scr<script>ipt>` input mentally. |
| Double escaping/unescaping | Trace the data flow: does an entity decode (`&amp;` → `&`) feed into another decode or an HTML context? |
| Uncontrolled data in path expression | Is `path.resolve()` + `startsWith(allowedDir)` used? Check for symlink bypasses. |
| Polynomial ReDoS | Is the regex applied to user input? Check for nested quantifiers. |

**Severity ratings:** Critical / High / Medium / Low / Informational

### Step 5: Code Quality

**Goal:** Ensure the code is readable, maintainable, and follows conventions.

Based on [Google's code review checklist](https://google.github.io/eng-practices/review/reviewer/looking-for.html):

| Dimension | What to Check |
|-----------|---------------|
| **Complexity** | Can each function/method be understood quickly? Is anything over-engineered? |
| **Naming** | Are variables, functions, classes named clearly and consistently? |
| **Comments** | Do comments explain *why*, not *what*? Are there stale comments? |
| **Style** | Does the code follow the project's lint config and style conventions? |
| **Consistency** | Does new code match existing patterns? |
| **DRY** | Is there duplicated logic that should be extracted? |
| **Error handling** | Are errors caught at system boundaries? Are error messages helpful? |
| **Dead code** | Are there unused variables, imports, or unreachable branches? |
| **Magic values** | Are there hardcoded numbers/strings that should be constants? |

### Step 6: Performance Review

**Goal:** Catch performance problems before they manifest in production.

| Pattern | What to Look For |
|---------|------------------|
| **N+1 queries** | Database calls inside loops |
| **Unbounded queries** | `SELECT *` without LIMIT, missing pagination |
| **Memory leaks** | Event listeners not cleaned up, unclosed resources, growing caches |
| **Bundle size** | Large dependencies imported for small features (`moment` vs `dayjs`) |
| **Unnecessary re-renders** | React components missing `useMemo`/`useCallback` where appropriate |
| **Blocking operations** | Synchronous I/O on the main thread, long-running computations without workers |
| **Missing caching** | Repeated expensive computations without memoization |
| **Regex catastrophic backtracking** | Complex regex patterns that could cause ReDoS |

### Step 7: Test Review

**Goal:** Verify tests are correct, meaningful, and sufficient.

| Check | Question |
|-------|----------|
| **Coverage** | Are new code paths covered? Target ≥80% |
| **Happy path** | Do tests verify the primary use case? |
| **Edge cases** | Empty inputs, nulls, boundary values, large datasets? |
| **Error cases** | Do tests verify error handling and failure modes? |
| **Test quality** | Are assertions specific? Do tests have clear names? |
| **False positives** | Would these tests still pass if the implementation were wrong? |
| **Isolation** | Are unit tests properly isolated from external dependencies? |
| **Missing tests** | Are there code changes without corresponding test changes? |

### Step 8: Documentation Review

| Check | Question |
|-------|----------|
| **Inline docs** | Are public APIs documented? Are complex algorithms explained? |
| **README** | If behavior changed, is the README updated? |
| **CHANGELOG.md** | If the PR has any user-facing changes and `CHANGELOG.md` exists, is `## [Unreleased]` updated with entries under `### Added`, `### Changed`, `### Fixed`, `### Removed`, or `### Security`? A missing changelog entry with user-facing changes is a **blocking** issue. |
| **Architecture docs** | If new modules, services, API endpoints, or data models were introduced: is `docs/ARCHITECTURE.md` updated? Specifically check for new Mermaid diagram nodes, updated project structure, new endpoint contracts, and updated tech stack table. Flag as blocking if architectural changes lack documentation. |
| **User Guide** | If user-facing features, config options, or CLI commands changed: is `docs/USER_GUIDE.md` updated? |
| **Migration** | If there are schema/API changes, is there a migration guide? |
| **Removed code** | If features were removed, is the documentation also removed? |

### Step 9: Publish Review

Create a formal GitHub PR review using the MCP tools:

**Method — Structured Review via MCP:**
1. Create a pending review: `mcp_github_pull_request_review_write` with method `create`
2. Add inline comments: `mcp_github_add_comment_to_pending_review` for each finding
3. Submit the review: `mcp_github_pull_request_review_write` with method `submit_pending`

**Fallback — `gh` CLI:**
```bash
gh pr review {PR_NUMBER} --request-changes --body "$(cat review-body.md)"
```

**Review verdict logic:**
- **APPROVE** — No critical/high issues, minor nits only
- **COMMENT** — Informational findings, suggestions, no blockers
- **REQUEST_CHANGES** — Any critical, high, or medium security issue; missing requirements; broken tests

**Review body structure:**
```markdown
## Code Review Summary — PR #{PR_NUMBER}

### Requirements: {PASS|PARTIAL|FAIL}
- [x] Acceptance criteria 1
- [ ] Missing: acceptance criteria 2

### Security: {CLEAN|FINDINGS}
| Severity | Count | Details |
|----------|-------|---------|
| Critical | 0 | — |
| High | 1 | XSS in UserInput.tsx:42 |

### Code Quality: {GOOD|NEEDS WORK}
- Naming: Good
- Complexity: 2 functions flagged
- Style: Consistent

### Performance: {CLEAN|FINDINGS}
- No issues found

### Tests: {SUFFICIENT|GAPS}
- Coverage: 85% (+3%)
- Missing: edge case for empty input

### Documentation: {UP TO DATE|NEEDS UPDATE}
- CHANGELOG.md: ✅ Updated under `### Added`
- docs/ARCHITECTURE.md: ⚠️ New `/api/widgets` endpoint not documented
- README: No changes needed

### Security Scanners: {CLEAN|FINDINGS}
| Scanner | Finding | File | Severity | Status |
|---------|---------|------|----------|--------|
| CodeQL | Missing rate limiting | src/api/m365.ts:151 | High | Still present |
| CodeQL | Path traversal | src/api/m365.ts:122 | Critical | Fixed |

### Prior Review Comments: {N total, M unresolved}
| Reviewer | Type | Unresolved | Addressed | Disagreed |
|----------|------|------------|-----------|-----------|
| mgcronin | Human | 2 | 3 | 0 |
| copilot | Copilot | 0 | 1 | 1 (false positive) |

### Verdict: REQUEST_CHANGES
```

**Verdict escalation rules:**
- Any `Still present` CodeQL **Critical** or **High** → `REQUEST_CHANGES` (blocking)
- Any `Still present` CodeQL **Medium** → `COMMENT` (non-blocking, but noted)
- All scanner findings `Fixed` or `False positive` → no impact on verdict
- Any **unresolved blocking comment from a human reviewer** → `REQUEST_CHANGES`
- Any unresolved Copilot suggestion → does NOT block on its own (validate first, may be false positive)
- If the only issues are resolved scanner findings and addressed reviewer comments → eligible for `APPROVE`

### Step 10: Handoff (Optional)

After publishing the review, offer the user:

> **Review published. Would you like me to switch to the Code Issue agent to fix the flagged issues?**

If yes, invoke the `resolve-pr-comments` skill with the same PR number to address the review comments just created.

## Review Comment Style Guide

Follow [Google's guidance on review comments](https://google.github.io/eng-practices/review/reviewer/comments.html):

- **Be kind.** Critique the code, not the person.
- **Explain why.** Don't just say "this is wrong" — explain what's better and why.
- **Prefix nits.** Use `nit:` for stylistic suggestions that aren't blockers.
- **Give credit.** If something is done well, say so. Good practices deserve recognition.
- **Be specific.** Reference the exact line and suggest a concrete alternative.
- **Prioritize.** Security > correctness > performance > style.

## Error Recovery

| Scenario | Action |
|----------|--------|
| Cannot read PR diff | Fall back to `gh pr diff` via terminal |
| No linked issue found | Review without requirements validation, note the gap |
| MCP review tools fail | Fall back to `gh pr review` CLI |
| Too many files to review | Focus on non-generated, non-config files first |
| Cannot determine test coverage | Run tests locally, parse output |
| Docs folder empty | Skip documentation cross-reference, note in review |

## Example Invocations

```
@Code Review review PR #47
```

```
Review PR #23 against the requirements in epic #12
```

```
Do a security-focused review of PR #55
```

```
Check if PR #31 is ready to merge
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

- GitHub access (read PRs, create reviews)
- GitHub CLI (`gh`) installed as fallback
- Project test runner configured (to verify coverage claims)
- MCP servers: GitHub, Context7, CVE Search
