---
name: e2e-test
description: Creates Playwright end-to-end tests for UI work. Maps acceptance criteria from linked GitHub issues to concrete test cases, follows Page Object Model, uses accessible locators, and validates against real browser behavior.
argument-hint: "[PR or issue number] — e.g. 'write e2e tests for PR #47' or 'e2e tests for issue #12'"
---

# E2E Test Writer

## Purpose

This skill drives the **E2E Test** agent through a structured workflow to create Playwright end-to-end tests for UI work delivered in a pull request. Every test traces back to acceptance criteria in the linked GitHub issue or epic, ensuring that user-facing behavior is verified in a real browser.

## When to Use

- After a PR with UI changes has been implemented (typically called by the Orchestrator after the Code Issue phase)
- The user asks to "write e2e tests for PR #N" or "add Playwright tests for issue #N"
- The Code Review agent flags missing e2e coverage for UI work

## Agent

Execute with the **E2E Test** agent (`e2e-test.agent.md`), which has Playwright, browser dev-tools, and GitHub MCP tool access.

## Playwright Best Practices (from playwright.dev)

These rules are non-negotiable. Every test must follow them:

### Locators
- **Use user-facing locators only** — `getByRole()`, `getByLabel()`, `getByText()`, `getByPlaceholder()`, `getByTestId()`
- **Never use CSS selectors or XPath** for element identification. DOM structure changes break tests.
- **Chain and filter** to narrow scope: `page.getByRole('listitem').filter({ hasText: 'Product 2' })`

### Assertions
- **Use web-first assertions** that auto-retry: `await expect(locator).toBeVisible()`
- **Never use manual assertions**: `expect(await locator.isVisible()).toBe(true)` is wrong
- **Prefer specific assertions**: `toHaveText()`, `toHaveURL()`, `toHaveCount()`, `toContainText()`
- **Use `toMatchAriaSnapshot()`** for complex component structure verification

### Test Isolation
- **Each test must be independent** — no shared state between tests
- **Use `beforeEach`** for common setup (navigation, auth), not `beforeAll`
- **Use test fixtures** for dependency injection (page, context, browser)
- **Clean up after tests** — no leftover state in databases or UI

### Auto-waiting
- **Rely on Playwright's built-in auto-waiting** — never use `page.waitForTimeout()`
- **Use `expect().toBeVisible()` or `expect().toHaveText()`** instead of sleep-based waits
- Playwright auto-waits for elements to be actionable before interacting

### Page Object Model
- **Every UI page/section gets a Page Object class** in `tests/pages/`
- Page Objects encapsulate selectors and common interactions
- Tests read like user stories, not DOM manipulation scripts
- Page Object methods return `this` or another Page Object for chaining

### Test Organization
- **File naming**: `<feature-or-page>.spec.ts` in the `tests/` directory
- **Group with `test.describe()`** — one describe block per feature
- **Use `test.step()`** for multi-step interactions within a test
- **Descriptive titles**: `test('should display error when submitting empty form')`

## Workflow Overview

```
┌─────────────────────────────────────────────────────────┐
│  1. ORIENT — Read PR, linked issues, acceptance criteria│
├─────────────────────────────────────────────────────────┤
│  2. MAP — Map acceptance criteria → test cases          │
├─────────────────────────────────────────────────────────┤
│  3. SCAFFOLD — Create page objects and test structure   │
├─────────────────────────────────────────────────────────┤
│  4. IMPLEMENT — Write tests for each acceptance criterion│
├─────────────────────────────────────────────────────────┤
│  5. VALIDATE — Run tests, fix failures, verify coverage │
├─────────────────────────────────────────────────────────┤
│  6. DELIVER — Commit, push, report results              │
└─────────────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: Orient

1. **Read the PR** using `mcp_github_pull_request_read`
   - List all changed files, identify UI-related changes
   - Read the PR description for context
2. **Read linked issues** using `mcp_github_issue_read`
   - Extract every acceptance criterion from the issue body
   - Note any edge cases or error scenarios mentioned
3. **Read the UI code** — understand the component tree, routes, and interactions
4. **Check for existing tests** in `tests/` directory
5. **Read `playwright.config.ts`** if it exists, or plan to create one

### Step 2: Map Acceptance Criteria to Test Cases

Create an explicit mapping table. Every acceptance criterion must have at least one test:

| # | Acceptance Criterion (from issue) | Test Case | Priority |
|---|-----------------------------------|-----------|----------|
| 1 | User can log in with valid creds  | `auth.spec.ts: should log in successfully` | P0 |
| 2 | Error shown for invalid password  | `auth.spec.ts: should show error for wrong password` | P0 |
| 3 | Session persists on refresh       | `auth.spec.ts: should maintain session after reload` | P1 |

Rules:
- **Every P0 criterion gets a test** — no exceptions
- **Happy path + error path** for each user flow
- **Visual state changes** (loading, empty, error states) get dedicated tests
- **Flag unmapped criteria** — report any acceptance criteria that cannot be tested via e2e

### Step 3: Scaffold

#### Playwright Config (if missing)

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
```

#### Page Object Template

```typescript
// tests/pages/<page-name>.page.ts
import type { Page, Locator } from '@playwright/test';

export class ExamplePage {
  readonly page: Page;
  readonly heading: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'Example' });
    this.submitButton = page.getByRole('button', { name: 'Submit' });
  }

  async goto() {
    await this.page.goto('/example');
  }

  async submit() {
    await this.submitButton.click();
  }
}
```

#### Directory Structure

```
tests/
├── pages/           # Page Object Models
│   ├── admin.page.ts
│   ├── chat.page.ts
│   └── ...
├── admin.spec.ts    # Test specs — one per feature/page
├── chat.spec.ts
└── ...
playwright.config.ts
```

### Step 4: Implement Tests

For each test case from the mapping table:

1. **Create or update the Page Object** for the relevant page
2. **Write the test** using the POM, following all best practices above
3. **Include `test.step()`** for complex multi-step flows
4. **Add the acceptance criterion reference** as a comment:

```typescript
test.describe('Admin Environment Panel', () => {
  test.beforeEach(async ({ page }) => {
    const adminPage = new AdminPage(page);
    await adminPage.goto();
  });

  // AC: "All .env.example parameters are visible in the admin panel"
  test('should display all known environment variables', async ({ page }) => {
    await test.step('Navigate to env section', async () => {
      await page.getByRole('link', { name: 'Environment' }).click();
    });

    await test.step('Verify known variables are listed', async () => {
      await expect(page.getByText('GITHUB_CLIENT_ID')).toBeVisible();
      await expect(page.getByText('OPENAI_API_KEY')).toBeVisible();
      await expect(page.getByText('TALOS_ADMIN_TOKEN')).toBeVisible();
    });
  });
});
```

### Step 5: Validate

1. **Run tests** — `npx playwright test --project=chromium`
   - If the app needs to be running, start it first (or document the requirement)
2. **Fix failures** — debug using traces: `npx playwright test --trace on`
3. **Verify mapping coverage** — ensure every P0 acceptance criterion has a passing test
4. **Run in CI mode** — `CI=true npx playwright test` to simulate pipeline behavior

### Step 6: Deliver

1. **Commit** with conventional message: `test(e2e): add Playwright tests for #{issue-number}`
2. **Push** to the existing feature branch
3. **Report results** to the orchestrator/user:

```
## E2E Test Results

### Acceptance Criteria Coverage
| # | Criterion | Test | Status |
|---|-----------|------|--------|
| 1 | ... | `admin.spec.ts:L12` | ✅ Pass |
| 2 | ... | `admin.spec.ts:L28` | ✅ Pass |

### Test Summary
- Total: {N} tests
- Passed: {N}
- Failed: {N}
- Skipped: {N}

### Unmapped Criteria
{List any acceptance criteria that could not be covered by e2e tests, with explanation}
```

## Anti-Patterns to Avoid

| Anti-Pattern | Why It's Bad | Do This Instead |
|-------------|-------------|-----------------|
| `page.waitForTimeout(1000)` | Flaky, slow | Use web-first assertions |
| `page.locator('.btn-primary')` | Breaks on CSS changes | `page.getByRole('button', {name: '...'})` |
| `expect(await el.isVisible()).toBe(true)` | No auto-retry | `await expect(el).toBeVisible()` |
| Tests sharing state via `beforeAll` | Non-isolated, flaky | `beforeEach` with clean setup |
| Testing implementation details | Brittle | Test user-visible behavior |
| Huge monolithic test files | Hard to maintain | One file per feature/page |
| Skipping error/edge-case paths | False confidence | Test unhappy paths too |
| No Page Objects | Duplicated selectors | Always use POM pattern |

## Shell Execution Rules

**Follow the same shell hygiene rules as the Code Issue skill:**

1. Batch commands with `&&`
2. No watch mode — use `npx playwright test` (exits cleanly)
3. No background processes
4. No interactive sessions

## Prerequisites

- `@playwright/test` installed in the project
- Playwright browsers installed: `npx playwright install chromium`
- Application must be running (or use `webServer` config in `playwright.config.ts`)
- GitHub CLI (`gh`) available as fallback for MCP tool failures
