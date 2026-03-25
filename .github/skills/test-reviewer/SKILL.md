---
name: test-reviewer
description: "Reviews generated tests against acceptance criteria for scenario coverage, assertion completeness, precondition setup, POM compliance, and accessible locator usage. Outputs a structured review with per-criterion pass/fail and overall coverage score."
argument-hint: "[test file or app ID] — review generated tests against their linked acceptance criteria"
---

# Test Reviewer

## Purpose

This skill drives a structured review of generated Playwright tests against their linked acceptance criteria. It verifies that every criterion is covered, assertions are complete, preconditions are properly set up, and tests follow Playwright best practices. The output is a scored review with actionable feedback.

## When to Use

- After tests have been generated from acceptance criteria (Phase 3 of Test Orchestrator)
- The user asks to "review tests", "check test coverage against criteria", or "audit test quality"
- Before executing tests, to catch structural issues early
- After self-healing, to verify that healed tests still meet criteria

## Agent

Execute with the **Test Orchestrator** agent (`test-orchestrator.agent.md`), which has access to Talos MCP tools, file reading, and code analysis.

## Required MCP Tools

| Tool | Purpose |
|------|---------|
| `talos_list_criteria` | Load acceptance criteria linked to the tests under review |
| `talos_get_traceability` | Get the requirements → criteria → tests mapping |
| `read_file` | Read test source code and page objects |

## Workflow

### Step 1: Load Test Code and Linked Acceptance Criteria

1. **Identify test files** — Determine which test files to review:
   - If the user specifies files, use those
   - Otherwise, scan `tests/**/*.spec.ts` and `ui/tests/**/*.spec.ts` for all test files

2. **Read test source code** — For each test file, extract:
   - `test.describe()` blocks and their titles
   - Individual `test()` cases with titles
   - `test.step()` steps within each test
   - Assertions (`expect()` calls) and what they verify
   - Page Object imports and usage
   - Locator strategies used (identify `getByRole`, `getByLabel`, CSS selectors, etc.)

3. **Load linked criteria** — Call `talos_list_criteria` to get all criteria for the app under test. Build a mapping:
   ```
   Criterion ID → { title, given, when, then, priority, testType, tags }
   ```

4. **Build the mapping** — Call `talos_get_traceability` to get the criteria → test links. For each criterion, identify which test(s) are supposed to cover it.

### Step 2: Verify Scenario Coverage

For each acceptance criterion, check whether the linked test(s) cover all aspects of the scenario:

#### Given (Precondition) Check
- Does the test set up the exact precondition described in the `given` clause?
- Is the setup done in `beforeEach`, a fixture, or the test body?
- Are all data requirements from the criterion satisfied?

**Pass criteria**: Test establishes the described initial state before the action.

**Common failures**:
- Test skips precondition setup (assumes state from previous test)
- Setup is incomplete (e.g., criterion says "user is logged in as admin" but test logs in as standard user)
- Data seeding missing (e.g., criterion says "5 items exist" but test doesn't create them)

#### When (Action) Check
- Does the test perform the exact action described in the `when` clause?
- Is it a single, atomic user interaction?
- Does it use the correct UI interaction method (click, fill, select)?

**Pass criteria**: Test performs the described action via user-facing interaction.

**Common failures**:
- Test calls an API directly instead of using the UI (unless `testType` is `api`)
- Multiple actions conflated into one step without `test.step()` separation
- Wrong interaction target (clicks a different button than the one described)

#### Then (Assertion) Check
- Does the test assert the exact expected outcome from the `then` clause?
- Are web-first assertions used (`expect(locator).toBeVisible()`, not `expect(await locator.isVisible()).toBe(true)`)?
- Are all observable outcomes checked, not just one?

**Pass criteria**: Every outcome described in `then` has a corresponding `expect()` assertion.

**Common failures**:
- Missing assertions (criterion says "error message displayed AND user stays on page" but test only checks error message)
- Wrong assertion type (checking text content when criterion describes visibility)
- Manual assertions instead of web-first (`expect(await ...)` pattern)

### Step 3: Quality Checks

Run these checks across all test files:

#### 3a. Missing Scenario Coverage

| Check | How to Verify |
|-------|--------------|
| Every criterion has ≥1 test | Cross-reference criteria list with test-to-criterion mapping |
| Negative scenarios exist | For each happy-path criterion, check if an error-path test exists |
| Edge cases covered | Look for boundary values, empty states, max-length inputs |

Flag any criterion with zero linked tests as **UNCOVERED**.

#### 3b. Assertion Completeness

For each test, score assertion coverage:

```
assertion_score = assertions_matching_then_clauses / total_then_clause_outcomes
```

| Score | Rating |
|-------|--------|
| 1.0 | Complete — all outcomes asserted |
| 0.7–0.99 | Partial — most outcomes checked but some missing |
| < 0.7 | Incomplete — significant assertion gaps |

#### 3c. Precondition Setup

Verify that every `given` clause has matching setup:

- **Authentication**: `given` mentions a user role → test must authenticate as that role
- **Data state**: `given` mentions data exists → test must seed or verify that data
- **Navigation**: `given` mentions a specific page → test must navigate there
- **Feature flags**: `given` mentions a feature state → test must configure it

#### 3d. Data Coverage

Check that test data matches the criterion's data requirements:

- Concrete values used (not generic "test" or "data")
- Edge cases represented (empty strings, special characters, max lengths)
- Multiple data variants if the criterion implies variability

#### 3e. Page Object Model Compliance

| Check | Pass | Fail |
|-------|------|------|
| Locators defined in Page Objects | Selectors in `tests/pages/*.ts` | Raw selectors in `.spec.ts` files |
| Interactions wrapped in PO methods | `loginPage.login(user, pass)` | `page.fill('#email', user)` in test |
| Page Objects return `this` or another PO | Method chains possible | Void methods without return |
| No business logic in Page Objects | POs only encapsulate UI interactions | POs contain assertions or conditionals |

#### 3f. Accessible Locator Usage

Audit every locator in test files and page objects:

| Locator Strategy | Status |
|-----------------|--------|
| `getByRole()` | Preferred |
| `getByLabel()` | Preferred |
| `getByText()` | Acceptable |
| `getByPlaceholder()` | Acceptable |
| `getByTestId()` | Acceptable (last resort) |
| `locator('.css-class')` | **VIOLATION** — flag and suggest accessible alternative |
| `locator('#id')` | **VIOLATION** — flag and suggest accessible alternative |
| `locator('xpath=...')` | **VIOLATION** — flag and suggest accessible alternative |
| `page.$()` / `page.$$()` | **VIOLATION** — not Playwright-idiomatic |

### Step 4: Flag Gaps and Suggest Improvements

For each issue found, produce a structured finding:

```markdown
#### Finding: {short title}
- **Criterion**: {criterion ID and title}
- **Test**: {test file}:{test name}
- **Severity**: Critical | Major | Minor | Info
- **Category**: Coverage | Assertion | Precondition | Data | POM | Locator
- **Description**: {what's wrong}
- **Suggestion**: {how to fix it}
```

**Severity guidelines**:
- **Critical**: Criterion has zero test coverage, or test has zero assertions
- **Major**: Missing assertions for key `then` outcomes, CSS/XPath locators, missing precondition setup
- **Minor**: Missing edge-case scenarios, incomplete data coverage, POM method naming
- **Info**: Style suggestions, optional improvements

### Step 5: Calculate Coverage Score

Compute the overall coverage score:

```
coverage_score = covered_scenarios / total_scenarios × 100
```

Where:
- **total_scenarios** = sum of all scenarios across all criteria
- **covered_scenarios** = scenarios with at least one linked test that passes the Given/When/Then check (Step 2)

Additionally, compute sub-scores:

| Metric | Formula |
|--------|---------|
| Criterion coverage | criteria_with_tests / total_criteria |
| Scenario coverage | scenarios_with_tests / total_scenarios |
| Assertion completeness | avg(assertion_score) across all tests |
| POM compliance | tests_using_POM / total_tests |
| Locator compliance | accessible_locators / total_locators |

### Step 6: Output Review Summary

Produce the structured review:

```markdown
## Test Review Summary

### Overall Score: {score}% ({rating})

| Rating | Score Range |
|--------|------------ |
| Excellent | 90–100% |
| Good | 75–89% |
| Needs Work | 50–74% |
| Poor | <50% |

### Coverage Breakdown
| Metric | Score | Status |
|--------|-------|--------|
| Criterion coverage | {X}% | {✓/✗} |
| Scenario coverage | {X}% | {✓/✗} |
| Assertion completeness | {X}% | {✓/✗} |
| POM compliance | {X}% | {✓/✗} |
| Locator compliance | {X}% | {✓/✗} |

### Per-Criterion Results
| # | Criterion | Scenarios | Covered | Score | Status |
|---|-----------|-----------|---------|-------|--------|
| 1 | {title} | 3 | 3 | 100% | ✓ Pass |
| 2 | {title} | 4 | 2 | 50% | ✗ Fail |
| ... | ... | ... | ... | ... | ... |

### Findings ({total}: {critical} critical, {major} major, {minor} minor)

{List all findings from Step 4, ordered by severity}

### Action Items
- [ ] **Critical**: {action item}
- [ ] **Major**: {action item}
- [ ] **Minor**: {action item}

### Recommendations
{High-level suggestions for improving test quality}
```

## Notes

- This skill **reviews** tests — it does not write or fix them. Fixes are handled by the Code Issue agent via the Test Orchestrator's heal phase.
- Run this skill after every test generation pass and after every self-healing pass.
- The coverage score is based on acceptance criteria mapping, not code coverage. A test with 100% line coverage can still score 0% here if it doesn't map to any criterion.
- When locator violations are found, always suggest the accessible alternative (e.g., "Replace `locator('.submit-btn')` with `getByRole('button', { name: 'Submit' })`").
