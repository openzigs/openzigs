import { test, expect } from "./helpers";
import {
  AdminVllmPage,
  runningStatus,
  stoppedStatus,
} from "./pages/admin-vllm.page";

/**
 * E2E tests for the Local vLLM (TP=2) admin panel — Issue #922 (Epic #888).
 *
 * Acceptance criteria mapping (from #922):
 *
 *   AC-UI-1  "UI card renders status, model, KV cache progress bar, queue
 *            depth, start/stop buttons"          → covered by tests below
 *   AC-UI-2  "Stop button shows confirmation dialog before firing"
 *                                                → covered: shows confirm + fires on Confirm
 *
 * Backend ACs (status shape, allowlist enforcement, 401 auth, SIGTERM) are
 * covered by `src/api/admin/vllm.test.ts` and not e2e-testable without a
 * real vLLM container; surfaced server errors are exercised via mocked 4xx.
 *
 * Unmapped (planner spec aspirational, not present in shipped UI):
 *   - Mutual-exclusion warning when image-gen sidecar conflicts (#917).
 *     The shipped panel relies on backend 409 conflictWith and surfaces it
 *     as a generic toast; no dedicated banner element exists.
 */

test.describe("Admin · Local vLLM (TP=2) panel", () => {
  let vllm: AdminVllmPage;

  test.beforeEach(async ({ page }) => {
    vllm = new AdminVllmPage(page);
  });

  // AC-UI-1: stopped state — Status="Stopped", Start button enabled.
  test("renders stopped state with model selector and Start button", async () => {
    await vllm.mockStatus(stoppedStatus());
    await vllm.goto();
    await vllm.expand();

    await expect(vllm.statusValue).toHaveText(/Stopped/i);
    await expect(vllm.modelSelect).toBeVisible();
    await expect(vllm.modelSelect).toBeEnabled();
    await expect(vllm.startButton).toBeVisible();
    await expect(vllm.startButton).toBeEnabled();
    await expect(vllm.stopButton).toHaveCount(0);
  });

  // AC-UI-1: running state — model name, KV cache bar, Stop button.
  test("renders running state with model name, KV cache bar, and Stop button", async () => {
    await vllm.mockStatus(runningStatus());
    await vllm.goto();
    await vllm.expand();

    await expect(vllm.statusValue).toHaveText(/Running/i);
    await expect(vllm.modelValue).toContainText("Qwen/Qwen2.5-14B-Instruct-AWQ");

    // KV cache bar: label + computed percentage (0.42 → 42.0%).
    await expect(vllm.kvCacheLabel).toBeVisible();
    await expect(vllm.section.getByText("42.0%", { exact: true })).toBeVisible();

    // Queue depth (Running / Queued requests) come from metrics.
    await expect(
      vllm.section.locator("dt", { hasText: /Running requests/i }),
    ).toBeVisible();
    await expect(
      vllm.section.locator("dt", { hasText: /Queued requests/i }),
    ).toBeVisible();

    await expect(vllm.stopButton).toBeVisible();
    await expect(vllm.stopButton).toBeEnabled();
    await expect(vllm.startButton).toHaveCount(0);
  });

  // Edge: status endpoint unreachable — clean error, no JS crash, no Start/Stop.
  test("renders a clean error state when the status endpoint is unreachable", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    await vllm.mockStatusUnreachable();
    await vllm.goto();
    await vllm.expand();

    await expect(vllm.errorAlert).toBeVisible();
    await expect(vllm.errorAlert).toContainText(/Failed to fetch vLLM status/i);

    // No Start/Stop controls render when status data is absent.
    await expect(vllm.startButton).toHaveCount(0);
    await expect(vllm.stopButton).toHaveCount(0);

    // The page itself must still be alive (no uncaught exception).
    expect(consoleErrors).toEqual([]);
    await expect(
      page.getByRole("heading", { name: "Administration" }),
    ).toBeVisible();
  });

  // AC-UI-1: clicking Start fires POST /start with the selected model id.
  test("clicking Start posts the selected model id to /api/admin/gpu/vllm/start", async () => {
    let captured: { model?: string } | null = null;
    await vllm.mockStatus(stoppedStatus());
    await vllm.mockStart({
      onCall: (body) => {
        captured = body;
      },
    });

    await vllm.goto();
    await vllm.expand();

    // Switch to the second allowed model so we prove the user's choice
    // (not the default) reaches the server.
    await vllm.modelSelect.selectOption(
      "casperhansen/mixtral-8x7b-instruct-v0.1-awq",
    );
    await vllm.startButton.click();

    await expect
      .poll(() => captured?.model)
      .toBe("casperhansen/mixtral-8x7b-instruct-v0.1-awq");
  });

  // AC-UI-2: Stop shows confirm dialog, then Confirm fires POST /stop.
  test("Stop button shows a confirm dialog and only fires /stop on confirmation", async () => {
    let stopCalls = 0;
    await vllm.mockStatus(runningStatus());
    await vllm.mockStop({ onCall: () => (stopCalls += 1) });

    await vllm.goto();
    await vllm.expand();

    await vllm.stopButton.click();
    await expect(vllm.stopConfirmDialog).toBeVisible();
    await expect(vllm.stopConfirmDialog).toContainText(/Stop vLLM\?/i);

    // Cancelling must NOT call /stop.
    await vllm.cancelStopButton.click();
    await expect(vllm.stopConfirmDialog).toHaveCount(0);
    expect(stopCalls).toBe(0);

    // Now actually confirm.
    await vllm.stopButton.click();
    await expect(vllm.stopConfirmDialog).toBeVisible();
    await vllm.confirmStopButton.click();
    await expect.poll(() => stopCalls).toBe(1);
  });

  // Security AC: server-side rejection of an invalid / non-allowlisted model
  // surfaces a clean error message (toast). The shipped UI uses a dropdown
  // sourced from the server allowlist, so the client cannot send an invalid
  // model on its own — we simulate the backend's 400 path.
  test("surfaces a clean error when the server rejects the model", async () => {
    await vllm.mockStatus(stoppedStatus());
    await vllm.mockStart({
      status: 400,
      responseBody: "Model not in allowlist",
    });

    await vllm.goto();
    await vllm.expand();

    await vllm.startButton.click();

    await expect(
      vllm.page.getByText(/vLLM start failed: Model not in allowlist/i),
    ).toBeVisible();
  });

  // Mutual-exclusion / GPU conflict (#917): server returns 409; UI must
  // surface the conflict cleanly without crashing. (No dedicated banner
  // exists in v1 — see "Unmapped" note at top of file.)
  test("surfaces a 409 GPU conflict from the server as an error toast", async ({
    page,
  }) => {
    await vllm.mockStatus(stoppedStatus());
    await vllm.mockStart({
      status: 409,
      responseBody: JSON.stringify({
        code: "GPU_CONFLICT",
        conflictWith: "flux",
        conflictGpus: [0, 1],
      }),
    });
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await vllm.goto();
    await vllm.expand();
    await vllm.startButton.click();

    await expect(
      vllm.page.getByText(/vLLM start failed/i),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
});
