# End-to-End Testing

E2E tests use [Playwright](https://playwright.dev/) and live in `ui/e2e/`. They are **not run in CI** — they require both the backend and UI dev servers to be running locally, and they test against real openzigs state (auth token, saved prompts, scheduled jobs, skills, etc.).

## Prerequisites

1. **Backend running** on `http://localhost:3000`
2. **UI dev server running** on `http://localhost:3101`
3. **Playwright + Chromium installed** (one-time setup)

## Setup

Install the Playwright browser binary if you haven't already:

```bash
cd ui
npx playwright install chromium
```

## Running the Tests

### Quick start (automated)

`scripts/run-e2e.sh` starts the backend and UI dev server for you (if they aren't already running), installs the Playwright browser if needed, then hands off to `playwright test`. Any extra arguments are forwarded directly.

```bash
# Run all tests
./scripts/run-e2e.sh

# Run in headed mode
./scripts/run-e2e.sh --headed

# Run a single spec
./scripts/run-e2e.sh e2e/dashboard.spec.ts

# Open the interactive Playwright UI
./scripts/run-e2e.sh --ui
```

If both servers are already up the script skips starting them and goes straight to the test run.

### Manual (servers already running)

Start both servers (in separate terminals or via your usual dev workflow):

```bash
# Terminal 1 — backend
pnpm dev

# Terminal 2 — UI
cd ui && pnpm dev
```

Then run the E2E suite:

```bash
cd ui

# Run all tests (headless)
pnpm test:e2e

# Run with the Playwright UI (interactive, great for debugging)
pnpm test:e2e:ui

# Run a single spec file
npx playwright test e2e/dashboard.spec.ts

# Run in headed mode (watch the browser)
npx playwright test --headed

# Show the HTML report from the last run
npx playwright show-report
```

## Test Files

| File | Coverage | Tests |
|---|---|---|
| `e2e/navigation.spec.ts` | Nav bar, dropdown menus, logo, theme toggle | 6 |
| `e2e/dashboard.spec.ts` | Control Panel page, agent status, audit log, snapshot, automations widget | 8 |
| `e2e/library.spec.ts` | Prompt Library, search, prompt cards, action buttons, Ask AI panel | 9 |
| `e2e/scheduler.spec.ts` | Scheduler page, cron display, job controls, history, Ask AI panel | 11 |
| `e2e/skills.spec.ts` | Skills Editor at `/admin/skills`, built-in skill cards, View modal | 11 |
| `e2e/outbox.spec.ts` | Outbox page, stats, queue, modal, multi-platform selector, AI generate | 22 |

## Shared Helpers

`ui/e2e/helpers.ts` exports:

- `waitForHydration(page)` — waits for `domcontentloaded` + `<main>` visibility. Uses `domcontentloaded` (not `networkidle`) because Socket.IO keeps persistent WebSocket connections open, which prevents `networkidle` from ever resolving.
- `navigateTo(page, path)` — goto with hydration wait
- `expectNavBar(page)` — asserts the nav bar is present with core links

## Configuration

`ui/playwright.config.ts`:

- **baseURL**: `http://localhost:3101` (override with `E2E_BASE_URL` env var)
- **Browser**: Desktop Chrome (Chromium)
- **Timeout**: 30s per test
- **Reporter**: HTML (opens at `ui/playwright-report/`)
- **Screenshots**: on failure only
- **Traces**: on first retry

The config does not start servers automatically — you must have them running before executing tests.

## Why E2E Tests Are Not in CI

The E2E suite requires:

1. A **live openzigs backend** with auth token, SQLite database, and all subsystems initialized
2. The **Next.js dev server** which compiles on first request (slow cold-start)
3. **Saved data** in the database (prompt cards, scheduled jobs, skills) that tests assert against

Our CI runner is self-hosted `macOS ARM64` and could in principle run these, but the coupling to live runtime state makes E2E jobs fragile — test failures would reflect data drift or infra issues rather than regressions. The unit test suite (219 files, 4276+ tests) provides regression coverage; E2E is meant as a spot-check of the running app.

To add E2E to CI in the future, the main requirements would be:
- A seeded database with known fixture data
- A way to inject `NEXT_PUBLIC_OPENZIGS_TOKEN` from `/var/openzigs/config.json` (or a dedicated CI config)
- Port conflict handling between concurrent runs
