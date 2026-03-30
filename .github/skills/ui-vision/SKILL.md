---
name: ui-vision
description: Interactive browser walkthrough skill. Launches Chrome, walks through a web app step-by-step, validates UI behavior visually, collects bugs with screenshots and console logs, and hands off to Code Issue for batch fixes.
argument-hint: "Describe the walkthrough scenario — e.g. 'test the admin page forms' or 'walk through setup wizard at localhost:3000'"
---

# UI Vision — Interactive Browser Walkthrough

## Purpose

This skill drives the **UI Vision** agent through a structured walkthrough of a web application in a real Chrome browser. It navigates pages, interacts with elements, takes screenshots at every step, validates expected behavior, and documents bugs with full evidence. After completing the walkthrough, it hands off any discovered bugs to the **Code Issue** agent for batch fixing, then re-tests to verify the fixes.

## When to Use

- The user asks to "walk through" or "test" a page, feature, or workflow in the browser
- The Orchestrator calls UI Vision as an optional phase after implementation (user must explicitly request it)
- The user wants to visually verify that a deployed feature works as expected
- The user says "check the UI", "look at the admin page", "test the setup wizard", or similar

## Agent

Execute with the **UI Vision** agent (`ui-vision.agent.md`), which has Playwright MCP (real headed Chrome), and GitHub MCP tools enabled.

## Prerequisites

Before starting, the agent must confirm it has:

| Requirement | Default | How to get it |
|-------------|---------|---------------|
| Target URL | `http://localhost:3000` | User provides, or use default |
| Scenario description | *(none)* | User must describe what to walk through |
| Credentials / test data | *(none)* | Ask the user if the scenario requires login or specific data |
| App running | *(assumed)* | Check with a quick fetch or `read_page` — if the app is down, tell the user |

**If any required input is missing, pause and ask the user. Do not proceed with assumptions.**

## Workflow Overview

```
┌─────────────────────────────────────────────────────────────┐
│  1. PREPARE — Confirm URL, scenario, prerequisites          │
├─────────────────────────────────────────────────────────────┤
│  2. LAUNCH — Open browser, screenshot initial state          │
├─────────────────────────────────────────────────────────────┤
│  3. WALK — Step-by-step execution:                           │
│     For each step in the scenario:                           │
│       a. Describe the action about to be taken               │
│       b. Execute the action (click, type, navigate)          │
│       c. Wait for page to settle (auto-wait + network idle)  │
│       d. Screenshot the result                               │
│       e. Read page content to validate expected state         │
│       f. Check DevTools console for JS errors                │
│       g. If behavior is wrong → log bug with evidence        │
│       h. Continue to next step                               │
├─────────────────────────────────────────────────────────────┤
│  4. REPORT — Summarize walkthrough results                   │
├─────────────────────────────────────────────────────────────┤
│  5. HANDOFF — Create issues, call Code Issue for fixes       │
├─────────────────────────────────────────────────────────────┤
│  6. RE-TEST — Re-run failing steps after fixes are pushed    │
└─────────────────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: PREPARE

1. Parse the user's request to extract:
   - **Target URL** — Use the URL they provide, or default to `http://localhost:3000`
   - **Scenario** — What pages/features/flows to walk through
   - **Parameters** — Any test data, credentials, or configuration values the user supplied
2. If the scenario requires information the user didn't provide (e.g., login credentials for a protected page, specific test data to enter in forms), **stop and ask**. Present your questions clearly:
   ```
   Before I start the walkthrough, I need a few things:
   1. What credentials should I use to log in?
   2. Should I use any specific test data for the form fields?
   ```
3. Verify the target app is reachable:
   - Use `browser_navigate` to check connectivity
   - If the app is down, report it to the user and stop

### Step 2: LAUNCH

1. Navigate to the target URL using `browser_navigate`
2. Take an initial screenshot with `browser_take_screenshot`
3. Get an accessibility snapshot with `browser_snapshot` to establish element refs and baseline state
4. Check the browser console via `browser_console_messages` for any pre-existing errors
5. Note the initial state in your walkthrough log:
   ```
   ## Walkthrough: {scenario description}
   - **URL**: {target URL}
   - **Started**: {timestamp}
   - **Initial state**: {brief description of what the page shows}
   ```

### Step 3: WALK

For each step in the scenario, follow this cycle:

#### 3a. Describe
Before executing, state what you're about to do:
> "Step 3: Clicking the 'Save Settings' button to submit the form"

#### 3b. Snapshot
**Always call `browser_snapshot` first** to get the current accessibility tree with `ref` attributes. Use these refs to target elements for interaction. Never guess element selectors or refs from previous snapshots — the page state may have changed.

#### 3c. Execute
Use the appropriate Playwright MCP tool with the `ref` from the snapshot:
- `browser_click` — for buttons, links, tabs, checkboxes, radio buttons (pass `ref`)
- `browser_type` — for text fields, search boxes, text areas (pass `ref` and text)
- `browser_navigate` — for URL navigation
- `browser_hover` — for hover-triggered menus, tooltips (pass `ref`)
- `browser_select_option` — for dropdown selections (pass `ref` and value)
- `browser_press_key` — for keyboard input (Enter, Tab, Escape)
- `browser_handle_dialog` — for browser dialogs (alert, confirm, prompt)

#### 3d. Wait
Allow the page to settle after the action. Playwright auto-waits for most interactions, but for API-triggered updates:
- Call `browser_snapshot` again to check if content has updated
- Use `browser_network_requests` to verify API calls completed

#### 3e. Screenshot
**Always** take a screenshot with `browser_take_screenshot` after each significant action:
- Page navigation
- Form submission
- Modal/dialog open or close
- Tab or section switch
- Error state appearance
- Success confirmation

#### 3f. Validate
Check that the result matches expectations:
- Use `browser_snapshot` to extract the accessibility tree and text content
- Compare against expected behavior from the scenario
- Check for:
  - Correct page title / heading
  - Expected content visible
  - Form values persisted
  - Success/error messages displayed
  - Navigation to correct URL
  - No layout breakage

#### 3g. Console Check
After each significant action, check `browser_console_messages` for:
- JavaScript errors (`Error`, `TypeError`, `ReferenceError`)
- Unhandled promise rejections
- Failed network requests (use `browser_network_requests` for 4xx, 5xx)
- Deprecation warnings (note but don't flag as bugs)

#### 3g. Bug Logging
If any validation fails or unexpected behavior occurs, log a bug:

```
### Bug #{n}: {short descriptive title}
- **URL**: {current page URL}
- **Step**: {the action that triggered or revealed the bug}
- **Expected**: {what should have happened}
- **Actual**: {what actually happened}
- **Screenshot**: {reference to the screenshot taken}
- **Console errors**: {any JS errors captured, or "None"}
- **Network errors**: {any failed API calls, or "None"}
- **Severity**: Critical | High | Medium | Low
  - Critical: app crash, data loss, security issue
  - High: feature broken, blocking workflow
  - Medium: wrong behavior but workaround exists
  - Low: cosmetic issue, minor UX problem
```

**Do not stop the walkthrough when a bug is found.** Document it and continue to the next step.

#### 3h. Continue
Move to the next step in the scenario. If a bug blocks further progress on the current path (e.g., a button doesn't work), note it and try an alternative path if possible, or skip ahead.

### Step 4: REPORT

After completing all steps (or exhausting the scenario), present a structured report:

```
## Walkthrough Report

### Summary
- **URL**: {target URL}
- **Scenario**: {what was tested}
- **Steps completed**: {N}/{total}
- **Bugs found**: {count by severity}
- **Overall status**: PASS | FAIL | PARTIAL

### Steps Executed
| # | Action | Result | Bug? |
|---|--------|--------|------|
| 1 | Navigated to /admin | Page loaded correctly | No |
| 2 | Clicked "Settings" tab | Tab switched, form displayed | No |
| 3 | Submitted form with empty fields | No validation error shown | Bug #1 |
| ... | ... | ... | ... |

### Bugs Found
{Include full bug documentation from Step 3g for each bug}

### Console Health
- JS errors observed: {count}
- Failed network requests: {count}
- Details: {list if any}
```

### Step 5: HANDOFF (conditional — only if bugs were found)

If bugs were found during the walkthrough:

1. **Create GitHub issues** for the bugs:
   - One issue per bug (or group related bugs into a single issue)
   - Include the bug documentation, reproduction steps, and severity
   - Label with `bug` and the appropriate severity label
   - Reference the walkthrough context and screenshots

2. **Call the Code Issue agent** to fix the bugs:
   - Pass all bug issues as a batch
   - Include reproduction steps and expected behavior
   - The Code Issue agent will:
     - Create a feature branch
     - Fix the bugs (TDD)
     - Run tests and lint
     - Open a PR
   - Wait for the Code Issue agent to report back with the PR number

3. **If called from the Orchestrator**, report the bug issues and PR number back. The Orchestrator will route through its normal Review → Fix → Re-Review cycle before calling back for re-testing.

### Step 6: RE-TEST (conditional — only after fixes are pushed)

After Code Issue has fixed the bugs and pushed:

1. Navigate back to the target URL using `browser_navigate`
2. Re-execute **only the steps that had bugs** (not the entire walkthrough)
3. For each previously-failing step:
   - Call `browser_snapshot` to get fresh element refs
   - Execute the same action using Playwright MCP tools
   - `browser_take_screenshot` the result
   - Validate the fix resolves the reported issue
4. Report re-test results:
   ```
   ### Re-Test Results
   | Bug # | Title | Fixed? | Notes |
   |-------|-------|--------|-------|
   | 1 | Form validation missing | Yes | Error messages now display |
   | 2 | Save button unresponsive | No | Still fails on double-click |
   ```
5. If any bugs persist, report back to the caller for further action (another fix cycle or manual intervention)

## Standalone vs Orchestrator Mode

### Standalone Mode
When the user calls UI Vision directly:
- Run the full workflow (Prepare → Launch → Walk → Report → Handoff → Re-Test)
- The agent manages the entire lifecycle including Code Issue handoff
- Report directly to the user at each stage

### Orchestrator Mode
When called by the Orchestrator as an optional phase:
- The Orchestrator provides: PR number, branch name, target URL, and scenario
- Run Prepare → Launch → Walk → Report
- If bugs are found, report them back to the Orchestrator with issue numbers
- The Orchestrator will route through Code Issue → Review → Re-Review, then call UI Vision again for Re-Test
- On re-test, only verify the previously-failing steps

## Tips for Effective Walkthroughs

- **Be methodical** — Go through forms field by field, not all at once
- **Test edge cases** — Empty submissions, very long input, special characters
- **Check responsive behavior** — If relevant, note if layout breaks at different viewport sizes
- **Verify persistence** — After saving data, navigate away and come back to confirm it persists
- **Test error states** — Deliberately trigger errors (bad input, network issues) to verify error handling
- **Check accessibility** — Note if interactive elements lack labels or focus indicators (flag as Low severity)
- **Snapshot before every interaction** — Always call `browser_snapshot` to get fresh `ref` attributes. Stale refs from previous snapshots will fail.
- **Console after every API call** — Use `browser_console_messages` and `browser_network_requests` after form submissions to catch silent failures
