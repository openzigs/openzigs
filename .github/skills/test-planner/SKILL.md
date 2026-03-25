---
name: test-planner
description: "Analyzes requirements and codebase to create a prioritized test plan. Retrieves knowledge from the RAG knowledge base, maps testable requirements, identifies coverage gaps, and outputs a structured plan with test types and priorities."
argument-hint: "[app ID or requirements path] — provide an app ID or path to requirements to plan tests for"
---

# Test Planner

## Purpose

This skill drives the **Test Orchestrator** agent through the test planning phase. It analyzes ingested requirements, examines the application's codebase structure, and produces a prioritized test plan that maps every testable requirement to a recommended test type, priority level, and coverage gap analysis.

## When to Use

- After requirements documents have been ingested into the knowledge base (Phase 1 of Test Orchestrator)
- The user asks to "plan tests", "create a test strategy", or "identify what to test"
- Before generating acceptance criteria, to understand the testing scope
- When assessing coverage gaps between existing tests and requirements

## Agent

Execute with the **Test Orchestrator** agent (`test-orchestrator.agent.md`), which has access to Talos MCP tools, GitHub, and web search.

## Required MCP Tools

| Tool | Purpose |
|------|---------|
| `talos_get_traceability` | Retrieve the requirements traceability matrix and coverage report |
| `talos_list_criteria` | List existing acceptance criteria with filters |
| `talos_ingest_document` | Ingest additional requirements if gaps are found |
| `read_file` | Read application source code and existing tests |
| `mcp_github_get_file_contents` | Read files from GitHub when working with remote repos |

## Workflow

### Step 1: Read Application Configuration and Existing Tests

1. **Read project config** — Examine `package.json`, `playwright.config.ts`, `vitest.config.ts`, and `tsconfig.json` to understand:
   - Test framework setup (Playwright version, test directory, browser config)
   - Existing test scripts and coverage thresholds
   - Application structure (monorepo? separate UI/API?)

2. **Inventory existing tests** — Scan the test directories:
   ```
   tests/           → Playwright e2e tests
   src/**/*.test.ts → Unit/integration tests
   ```
   Record: file count, test count, which features are already covered.

3. **Read test configuration** — Check for:
   - Authentication setup (global setup files, storage state)
   - Test fixtures and helpers
   - Custom matchers or utilities

### Step 2: Retrieve Requirements from Knowledge Base

1. **Query the knowledge base** using hybrid search to retrieve all ingested requirement chunks:
   - Filter by `docType`: `requirement`, `user_story`, `prd`, `api_spec`
   - Group results by source document and functional area
   - Note chunk metadata: `tags`, `confidence`, `sourceVersion`

2. **Deduplicate and merge** — Requirements may span multiple documents. Consolidate overlapping requirements by functional area.

3. **Identify requirement types**:
   - **Functional requirements** (FR): user-facing behavior, workflows, business rules
   - **Non-functional requirements** (NFR): performance, accessibility, security, reliability
   - **Integration requirements** (IR): API contracts, third-party service interactions
   - **Data requirements** (DR): validation rules, data models, constraints

### Step 3: Analyze Code Structure via Discovery

1. **Map application architecture** — From the codebase, identify:
   - Routes and pages (Next.js `app/` directory structure)
   - API endpoints (`src/api/` handlers)
   - Shared components (`components/` directory)
   - State management patterns
   - Authentication and authorization flows

2. **Identify critical paths** — Trace the most important user journeys:
   - Login → Dashboard → Core action → Result
   - Data creation → Validation → Persistence → Retrieval
   - Error scenarios → Error handling → Recovery

3. **Map code to requirements** — For each requirement, identify which source files implement it. This creates the initial code-to-requirement mapping needed for traceability.

### Step 4: Identify Testable Requirements

Group requirements into testable categories:

#### By Functional Area
| Area | Requirements | Source Files | Existing Tests |
|------|-------------|--------------|----------------|
| Authentication | FR-001, FR-002 | `app/auth/`, `api/auth.ts` | `auth.spec.ts` |
| Dashboard | FR-010, FR-011 | `app/dashboard/` | — |
| ... | ... | ... | ... |

#### By Persona
| Persona | Requirements | Priority |
|---------|-------------|----------|
| Admin | FR-001, FR-020, NFR-003 | P0 |
| Standard User | FR-010, FR-011, FR-012 | P0 |
| Read-Only User | FR-030, FR-031 | P1 |
| Anonymous | FR-040 | P2 |

#### By NFR Category
| NFR Type | Requirements | Test Approach |
|----------|-------------|---------------|
| Performance | NFR-001 (page load < 3s) | Lighthouse audit, Playwright timing |
| Accessibility | NFR-002 (WCAG 2.1 AA) | axe-core integration, keyboard nav |
| Security | NFR-003 (auth required) | Role-based access tests |

### Step 5: Prioritize by Risk and Impact

Apply the following priority heuristics (highest priority first):

1. **P0 — Critical Path**: Authentication, authorization, core business workflows. If these fail, the application is unusable.
2. **P1 — Auth & Data Mutation**: Login/logout flows, data creation/update/delete, payment processing. Failures cause data loss or security exposure.
3. **P2 — Data Mutation Secondary**: Non-critical creates/updates, settings changes, preference updates. Failures are annoying but recoverable.
4. **P3 — Read-Only**: Dashboard views, listing pages, search results, reports. Failures degrade experience but don't corrupt data.
5. **P4 — Edge Cases**: Rare user flows, uncommon browser configurations, cosmetic issues.

For each requirement, assign a priority level based on:
- **Blast radius**: How many users are affected if this fails?
- **Data risk**: Can this failure cause data loss or corruption?
- **Security impact**: Does failure expose a vulnerability?
- **Business criticality**: Is this a revenue-generating or compliance-critical flow?

### Step 6: Suggest Test Types per Requirement

For each testable requirement, recommend one or more test types:

| Test Type | When to Use | Tool |
|-----------|------------|------|
| **E2E (Playwright)** | User-facing workflows, multi-step interactions, cross-page flows | `npx playwright test` |
| **Smoke** | Critical path verification after deployments, basic health checks | Playwright with `--grep @smoke` tag |
| **Regression** | Previously-broken functionality, bug fix verification | Playwright with `--grep @regression` tag |
| **Accessibility** | WCAG compliance, screen reader compatibility, keyboard navigation | `@axe-core/playwright` integration |
| **API Integration** | REST endpoint contracts, response schemas, error codes | Playwright `request` context or `supertest` |
| **Visual Regression** | UI consistency, layout stability, theme compliance | Playwright screenshot comparison |
| **Performance** | Page load times, LCP/CLS/FID thresholds | Lighthouse CI, Playwright timing APIs |

**Decision matrix**:
- FR with UI interaction → E2E + Smoke (if P0)
- FR with API-only behavior → API Integration
- NFR-accessibility → Accessibility
- NFR-performance → Performance
- Any P0 requirement → also add Smoke tag
- Any previously-failed requirement → also add Regression tag

### Step 7: Estimate Coverage Gaps

1. **Compare existing tests against requirements**:
   ```
   Total testable requirements: {N}
   Requirements with existing tests: {M}
   Coverage: {M/N * 100}%
   ```

2. **Identify gaps by category**:
   - **Untested functional areas**: Requirements with no linked test at all
   - **Partially tested areas**: Requirements with some but not all scenarios covered
   - **Missing NFR tests**: Non-functional requirements without dedicated tests
   - **Missing negative tests**: Happy paths tested but error scenarios skipped
   - **Missing persona tests**: Tests only run as one role, not all required roles

3. **Quantify the gap**:
   - Tests needed to reach 100% requirement coverage: {count}
   - Tests needed to reach 80% requirement coverage: {count}
   - Estimated effort: {small/medium/large} based on test complexity

### Step 8: Output Structured Test Plan

Produce the final test plan in the following format:

```markdown
## Test Plan: {Application Name}

### Summary
- Total testable requirements: {N}
- Existing test coverage: {percentage}%
- Tests to write: {count}
- Estimated priority distribution: {P0: X, P1: Y, P2: Z, P3: W}

### Priority P0 — Critical Path (must test first)
| # | Requirement | Test Type | Test File | Personas | Status |
|---|-------------|-----------|-----------|----------|--------|
| 1 | FR-001: User login | E2E, Smoke | auth.spec.ts | Admin, User | Existing |
| 2 | FR-002: Session persistence | E2E | auth.spec.ts | User | Gap |
| ... | ... | ... | ... | ... | ... |

### Priority P1 — Auth & Data Mutation
| # | Requirement | Test Type | Test File | Personas | Status |
|---|-------------|-----------|-----------|----------|--------|
| ... | ... | ... | ... | ... | ... |

### Priority P2 — Secondary Data Mutation
| # | Requirement | Test Type | Test File | Personas | Status |
|---|-------------|-----------|-----------|----------|--------|
| ... | ... | ... | ... | ... | ... |

### Priority P3 — Read-Only Views
| # | Requirement | Test Type | Test File | Personas | Status |
|---|-------------|-----------|-----------|----------|--------|
| ... | ... | ... | ... | ... | ... |

### NFR Test Plan
| # | NFR | Test Type | Tool | Threshold | Status |
|---|-----|-----------|------|-----------|--------|
| 1 | Page load < 3s | Performance | Lighthouse | LCP < 3000ms | Gap |
| 2 | WCAG 2.1 AA | Accessibility | axe-core | 0 violations | Gap |
| ... | ... | ... | ... | ... | ... |

### Coverage Gap Summary
- Untested functional areas: {list}
- Missing negative test scenarios: {list}
- Missing persona coverage: {list}
- Missing NFR tests: {list}

### Recommended Execution Order
1. P0 smoke tests (critical path verification)
2. P0 full e2e tests (complete critical path coverage)
3. P1 auth and data mutation tests
4. Accessibility audit (all pages)
5. P2-P3 remaining tests
6. Performance benchmarks
```

## Notes

- This skill outputs a **plan**, not tests. Test generation happens in the next phase via the Test Orchestrator.
- The plan should be specific enough that a developer or AI agent can implement every test without ambiguity.
- Re-run this skill whenever new requirements are ingested to update the plan.
