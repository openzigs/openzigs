import { test, expect, type Page } from "@playwright/test";
import {
  LocalLlmPanelPage,
  installLocalLlmMocks,
  stoppedStatus,
  healthyStatus,
  defaultRouter,
} from "./pages/local-llm-panel.page";
import {
  GpuDispatcherPanelPage,
  installGpuMocks,
  singleGpuProfile,
  dualGpuProfile,
} from "./pages/gpu-dispatcher-panel.page";
import {
  SetupWizardPage,
  installSetupMocks,
  macM4Max64Platform,
  linuxNvidia4090Platform,
} from "./pages/setup-wizard.page";

/**
 * E2E tests — Epic #1053 "Local LLM as Primary Provider with GitHub Copilot
 * CLI Offline Mode" (PR #1064, branch `feature/local-llm-primary-epic-1053`).
 *
 * These tests cover the user-visible UI surface added by the PR:
 *   - Sub-issue #1054 — `local-copilot` BYOK provider type (admin form save).
 *   - Sub-issue #1055 — Sentinel-driven health badge transitions.
 *   - Sub-issue #1057 — Admin Local LLM panel: provider, privacy, autodetect.
 *   - Sub-issue #1058 — Autodetect of Ollama / vLLM endpoints.
 *   - Sub-issue #1056 — GPU dispatcher mutual-exclusion + cancel.
 *   - Sub-issue #1059 — Admin GPU dispatcher card layout (single + dual).
 *   - Sub-issue #1061 — Smart router slider + toggle persistence.
 *   - Sub-issue #1062 — Apple-Silicon-aware MLX install instructions.
 *   - Sub-issue #1063 — Five-step offline setup wizard at `/setup/offline`.
 *
 * Acceptance-criteria → test mapping (see "Unmapped" section at the bottom
 * for criteria that ship without a UI surface in this PR):
 *
 * | Sub-issue / AC | Test name |
 * | --- | --- |
 * | #1057 AC1 (panel renders + health badge present)     | "renders the panel with a health badge that reflects the /status response" |
 * | #1058 AC1 (Test connection runs autodetect)          | "Test connection hydrates endpoint + model from the autodetect response" |
 * | #1054 AC1 (provider save persists)                   | "Save provider POSTs local-copilot and persists across reload" |
 * | #1057 AC3 (privacy global lockdown w/ confirm)       | "Global privacy lockdown asks for confirmation, POSTs, and reflects the new state" |
 * | #1057 AC4 (per-session privacy localStorage flag)    | "Per-session privacy toggle persists in localStorage across reloads" |
 * | #1061 AC1 (smart router threshold persists)          | "Smart router threshold can be lowered and persists across reload" |
 * | #1061 AC2 (smart router disable disables the slider) | "Disabling the smart router disables the threshold slider and persists" |
 * | #1059 AC1 (single-GPU layout)                        | "GPU dispatcher renders a single-card layout when only one GPU is reported" |
 * | #1056 AC1 + #1059 AC2 (dual-GPU mutex)               | "GPU dispatcher renders dual cards with a mutex-blocked indicator on the LLM lane" |
 * | #1056 AC3 (cancel a running job w/ confirm)          | "Cancel on a busy GPU asks for confirmation and POSTs the cancel endpoint" |
 * | #1059 AC3 (empty state when no dispatcher data)      | "GPU dispatcher renders an empty-state hint when the server omits the dispatcher block" |
 * | #1063 AC1 (wizard happy path detect→switch)          | "Setup wizard happy path: detect → recommend → install → test → switch" |
 * | #1063 AC2 (idempotent already-offline banner)        | "Setup wizard shows an 'already running offline' banner when provider is local-copilot" |
 * | #1062 AC1 (Mac MLX env var snippet)                  | "Setup wizard surfaces OLLAMA_USE_MLX=1 in the install commands on macOS arm64" |
 * | #1063 AC4 (Linux NVIDIA recommendation)              | "Setup wizard recommends gemma4:26b AWQ INT4 on Linux + NVIDIA" |
 *
 * Network is fully mocked via `page.route()` — no live local LLM endpoint,
 * no real GPUs, no platform autodetect required.
 */

// ── Local LLM admin panel (#1054 / #1055 / #1057 / #1058) ─────────────

test.describe("Epic #1053 — Local LLM admin panel", () => {
  // AC #1057.1 — panel renders + health badge reflects /status.
  test("renders the panel with a health badge that reflects the /status response", async ({
    page,
  }) => {
    await installLocalLlmMocks(page, {
      status: healthyStatus(),
    });
    const panel = new LocalLlmPanelPage(page);
    await panel.goto();

    await expect(panel.heading).toBeVisible();
    await expect(panel.healthBadge).toHaveText("Healthy");
    await expect(panel.endpointInput).toHaveValue("http://127.0.0.1:11434/v1");
    await expect(panel.modelInput).toHaveValue("gemma4:26b");
  });

  // AC #1058.1 — Test connection runs autodetect, hydrates the form.
  test("Test connection hydrates endpoint + model from the autodetect response", async ({
    page,
  }) => {
    const ctrl = await installLocalLlmMocks(page, {
      status: stoppedStatus(),
      autodetect: {
        ollama: {
          endpoint: "http://127.0.0.1:11434/v1",
          models: ["gemma4:26b"],
          recommendedModel: "gemma4:26b",
        },
        vllm: null,
      },
    });
    const panel = new LocalLlmPanelPage(page);
    await panel.goto();

    // Sanity: starts empty (no provider configured).
    await expect(panel.endpointInput).toHaveValue("");
    await expect(panel.modelInput).toHaveValue("");

    await panel.testConnectionButton.click();

    await expect(panel.endpointInput).toHaveValue("http://127.0.0.1:11434/v1");
    await expect(panel.modelInput).toHaveValue("gemma4:26b");
    expect(ctrl.autodetectCalls).toBe(1);
  });

  // AC #1054.1 — POST /provider on Save, persists across reload.
  test("Save provider POSTs local-copilot and persists across reload", async ({
    page,
  }) => {
    const ctrl = await installLocalLlmMocks(page, { status: stoppedStatus() });
    const panel = new LocalLlmPanelPage(page);
    await panel.goto();

    await panel.endpointInput.fill("http://127.0.0.1:11434/v1");
    await panel.modelInput.fill("gemma4:26b");
    await panel.saveButton.click();

    // The saveButton is disabled while pending; wait for the POST to settle.
    await expect.poll(() => ctrl.providerSaves.length).toBeGreaterThan(0);
    expect(ctrl.providerSaves[0]).toMatchObject({
      type: "local-copilot",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "gemma4:26b",
    });

    // Reload — the mock controller persists state, so the form should rehydrate.
    await page.reload();
    await panel.heading.waitFor({ state: "visible" });
    await expect(panel.endpointInput).toHaveValue("http://127.0.0.1:11434/v1");
    await expect(panel.modelInput).toHaveValue("gemma4:26b");
  });

  // AC #1057.3 — Global lockdown asks for confirmation, POSTs, reflects state.
  test("Global privacy lockdown asks for confirmation, POSTs, and reflects the new state", async ({
    page,
  }) => {
    const ctrl = await installLocalLlmMocks(page, { status: healthyStatus() });
    const panel = new LocalLlmPanelPage(page);
    await panel.goto();

    // Confirmed control flow: click → window.confirm → mutate → POST → status
    // refetch → re-render checked. We use `click()` (not `check()`) to avoid
    // Playwright's auto state-assertion racing the React Query roundtrip, then
    // wait for the POST to settle before asserting visual state.
    page.once("dialog", (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toMatch(/GLOBAL privacy lockdown/);
      void dialog.accept();
    });

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/admin/local-llm/privacy/global") &&
          r.request().method() === "POST",
      ),
      panel.globalLockdownCheckbox.click(),
    ]);

    expect(ctrl.privacySaves).toEqual([{ globalLockdown: true }]);
    await expect(panel.globalLockdownCheckbox).toBeChecked();
  });

  // AC #1057.4 — Per-session privacy persists in localStorage.
  test("Per-session privacy toggle persists in localStorage across reloads", async ({
    page,
  }) => {
    await installLocalLlmMocks(page, { status: healthyStatus() });
    const panel = new LocalLlmPanelPage(page);
    await panel.goto();

    await expect(panel.perSessionPrivacyCheckbox).not.toBeChecked();
    await panel.perSessionPrivacyCheckbox.check();

    await expect
      .poll(() =>
        page.evaluate(() => window.localStorage.getItem("openzigs:privacy-mode")),
      )
      .toBe("true");

    await page.reload();
    await panel.heading.waitFor({ state: "visible" });
    await expect(panel.perSessionPrivacyCheckbox).toBeChecked();
  });
});

// ── Smart router (#1061) ──────────────────────────────────────────────

test.describe("Epic #1053 — Smart router", () => {
  // AC #1061.1 — slide threshold from 4096 → 1024, POST fires, persists.
  test("Smart router threshold can be lowered and persists across reload", async ({
    page,
  }) => {
    const ctrl = await installLocalLlmMocks(page, {
      status: healthyStatus(),
      router: defaultRouter({ enabled: true, cloudThresholdTokens: 4096 }),
    });
    const panel = new LocalLlmPanelPage(page);
    await panel.goto();

    await expect(panel.smartRouterThresholdValue).toHaveText("4096");
    await expect(panel.smartRouterThreshold).toBeEnabled();

    // The slider is a `<input type="range">` whose value is the index into
    // ROUTER_THRESHOLD_STOPS = [256, 1024, 4096, 8192]; index 1 = 1024.
    // `fill` on a range only sets value without firing an input/change event
    // reliably across browsers — we set value + dispatch the events explicitly
    // so React's onChange handler runs and triggers the mutation.
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/admin/local-llm/router") &&
          r.request().method() === "POST",
      ),
      panel.smartRouterThreshold.evaluate((el) => {
        const input = el as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, "1");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }),
    ]);

    expect(ctrl.routerSaves.at(-1)).toMatchObject({
      enabled: true,
      cloudThresholdTokens: 1024,
    });
    await expect(panel.smartRouterThresholdValue).toHaveText("1024");

    await page.reload();
    await panel.heading.waitFor({ state: "visible" });
    await expect(panel.smartRouterThresholdValue).toHaveText("1024");
  });

  // AC #1061.2 — Disabling the router disables the slider, persists.
  test("Disabling the smart router disables the threshold slider and persists", async ({
    page,
  }) => {
    const ctrl = await installLocalLlmMocks(page, {
      status: healthyStatus(),
      router: defaultRouter({ enabled: true, cloudThresholdTokens: 4096 }),
    });
    const panel = new LocalLlmPanelPage(page);
    await panel.goto();

    await expect(panel.smartRouterToggle).toBeChecked();
    await expect(panel.smartRouterToggle).toBeEnabled();
    await expect(panel.smartRouterThreshold).toBeEnabled();

    // Use `click()` + `waitForResponse` instead of `uncheck()` so that
    // Playwright's actionability check does not race the React Query refetch
    // that flips `routerEnabled` back into the panel.
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/admin/local-llm/router") &&
          r.request().method() === "POST",
      ),
      panel.smartRouterToggle.click(),
    ]);

    expect(ctrl.routerSaves.at(-1)).toMatchObject({ enabled: false });
    await expect(panel.smartRouterToggle).not.toBeChecked();
    await expect(panel.smartRouterThreshold).toBeDisabled();

    await page.reload();
    await panel.heading.waitFor({ state: "visible" });
    await expect(panel.smartRouterToggle).not.toBeChecked();
    await expect(panel.smartRouterThreshold).toBeDisabled();
  });
});

// ── GPU dispatcher (#1056 / #1059) ────────────────────────────────────

test.describe("Epic #1053 — GPU dispatcher panel", () => {
  // Local LLM panel mocks are needed because /admin renders both panels;
  // without them the panel page can spin on /status and emit unrelated noise.
  test.beforeEach(async ({ page }) => {
    await installLocalLlmMocks(page, { status: healthyStatus() });
  });

  // AC #1059.1 — single-GPU layout.
  test("GPU dispatcher renders a single-card layout when only one GPU is reported", async ({
    page,
  }) => {
    await installGpuMocks(page, { profile: singleGpuProfile() });
    const panel = new GpuDispatcherPanelPage(page);
    await panel.goto();

    await expect(panel.heading).toBeVisible();
    await expect(panel.card(0)).toBeVisible();
    await expect(panel.card(1)).toHaveCount(0);
    await expect(panel.state(0)).toHaveText("idle");
  });

  // AC #1056.1 + #1059.2 — dual GPU layout with mutex-blocked LLM lane.
  test("GPU dispatcher renders dual cards with a mutex-blocked indicator on the LLM lane", async ({
    page,
  }) => {
    await installGpuMocks(page, { profile: dualGpuProfile() });
    const panel = new GpuDispatcherPanelPage(page);
    await panel.goto();

    await expect(panel.card(0)).toBeVisible();
    await expect(panel.card(1)).toBeVisible();

    // GPU 0 is mutex-blocked by the video render on GPU 1.
    const mutex = panel.mutexLabel(0);
    await expect(mutex).toBeVisible();
    await expect(mutex).toContainText("Video render running on another GPU");
    // Tooltip provides the same explanation via the title attribute.
    await expect(mutex).toHaveAttribute(
      "title",
      /Video render running on another GPU/,
    );

    // GPU 1 is busy.
    await expect(panel.state(1)).toHaveText(/busy/);
  });

  // AC #1056.3 — Cancel asks for confirmation and POSTs.
  test("Cancel on a busy GPU asks for confirmation and POSTs the cancel endpoint", async ({
    page,
  }) => {
    const ctrl = await installGpuMocks(page, {
      profile: dualGpuProfile(),
    });
    const panel = new GpuDispatcherPanelPage(page);
    await panel.goto();

    page.once("dialog", (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toMatch(/Cancel the running video.*GPU 1/);
      void dialog.accept();
    });

    await panel.cancelButton(1).click();

    await expect.poll(() => ctrl.cancelCalls.length).toBe(1);
    expect(ctrl.cancelCalls[0]).toEqual({ index: 1 });
  });

  // AC #1059.3 — empty-state hint when dispatcher block is omitted.
  test("GPU dispatcher renders an empty-state hint when the server omits the dispatcher block", async ({
    page,
  }) => {
    const profile = singleGpuProfile();
    delete profile.dispatcher;
    await installGpuMocks(page, { profile });
    const panel = new GpuDispatcherPanelPage(page);
    await panel.goto();

    await expect(panel.emptyState).toBeVisible();
    await expect(panel.emptyState).toContainText(
      "GPU dispatcher is not active on this host",
    );
  });
});

// ── Setup wizard (#1062 / #1063) ──────────────────────────────────────

test.describe("Epic #1053 — Offline setup wizard", () => {
  // AC #1063.1 — happy path: detect → recommend → install → test → switch.
  test("Setup wizard happy path: detect → recommend → install → test → switch", async ({
    page,
  }) => {
    const ctrl = await installSetupMocks(page, {
      platform: linuxNvidia4090Platform(),
      provider: null,
    });
    const wizard = new SetupWizardPage(page);
    await wizard.goto();

    // Step 1 — Detect.
    await expect(wizard.stepDetectHeading).toBeVisible();
    await expect(page.getByText(/OS:\s*linux/)).toBeVisible();
    await expect(page.getByText(/Memory:\s*64\s*GB/)).toBeVisible();

    // Step 2 — Recommend.
    await wizard.clickNext();
    await expect(wizard.stepRecommendHeading).toBeVisible();
    await expect(page.getByText("gemma4:26b").first()).toBeVisible();
    await expect(page.getByText(/Quantisation:\s*AWQ INT4/)).toBeVisible();

    // Step 3 — Install (Linux).
    await wizard.clickNext();
    await expect(wizard.stepInstallHeading).toBeVisible();
    await expect(
      page.getByText("curl -fsSL https://ollama.com/install.sh | sh"),
    ).toBeVisible();

    // Step 4 — Test connection.
    await wizard.clickNext();
    await expect(wizard.stepTestHeading).toBeVisible();
    await wizard.probeButton.click();
    await expect(page.getByText(/Ollama:.*reachable/)).toBeVisible();
    expect(ctrl.autodetectCalls).toBe(1);

    // Step 5 — Switch.
    await wizard.clickNext();
    await expect(wizard.stepSwitchHeading).toBeVisible();
    await wizard.switchButton.click();
    await expect(page.getByText("Switched to local provider")).toBeVisible();

    expect(ctrl.switchCalls).toHaveLength(1);
    expect(ctrl.switchCalls[0]).toMatchObject({
      type: "local-copilot",
      modelId: "gemma4:26b",
    });
  });

  // AC #1063.2 — already-offline idempotency banner.
  test("Setup wizard shows an 'already running offline' banner when provider is local-copilot", async ({
    page,
  }) => {
    await installSetupMocks(page, {
      platform: linuxNvidia4090Platform(),
      provider: {
        type: "local-copilot",
        baseUrl: "http://127.0.0.1:11434",
        modelId: "gemma4:26b",
      },
    });
    const wizard = new SetupWizardPage(page);
    await wizard.goto();

    await expect(wizard.alreadyOfflineBanner).toBeVisible();
    await expect(wizard.rerunButton).toBeVisible();
    await expect(page.getByText("gemma4:26b").first()).toBeVisible();
  });

  // AC #1062.1 — macOS arm64 install instructions include OLLAMA_USE_MLX=1.
  test("Setup wizard surfaces OLLAMA_USE_MLX=1 in the install commands on macOS arm64", async ({
    page,
  }) => {
    await installSetupMocks(page, {
      platform: macM4Max64Platform(),
      provider: null,
    });
    const wizard = new SetupWizardPage(page);
    await wizard.goto();

    // Step 1 → 2 → 3 (install).
    await expect(wizard.stepDetectHeading).toBeVisible();
    await expect(page.getByText(/OS:\s*macos/)).toBeVisible();
    await wizard.clickNext();
    await wizard.clickNext();

    await expect(wizard.stepInstallHeading).toBeVisible();
    await expect(page.getByText("brew install ollama")).toBeVisible();
    // The MLX env-var snippet — the criterion-of-record for #1062.
    await expect(page.getByText("OLLAMA_USE_MLX=1 ollama serve")).toBeVisible();
  });

  // AC #1063.4 — Linux NVIDIA recommendation does not leak Mac-specific copy.
  test("Setup wizard recommends gemma4:26b AWQ INT4 on Linux + NVIDIA", async ({
    page,
  }) => {
    await installSetupMocks(page, {
      platform: linuxNvidia4090Platform(),
      provider: null,
    });
    const wizard = new SetupWizardPage(page);
    await wizard.goto();

    await wizard.clickNext(); // → recommend

    await expect(wizard.stepRecommendHeading).toBeVisible();
    await expect(page.getByText("gemma4:26b").first()).toBeVisible();
    await expect(page.getByText(/Quantisation:\s*AWQ INT4/)).toBeVisible();
    // Must NOT recommend MLX on Linux.
    await expect(page.getByText("OLLAMA_USE_MLX=1")).toHaveCount(0);
  });
});

// ── Unmapped acceptance criteria ──────────────────────────────────────
//
// These criteria from epic #1053 were intentionally NOT covered by this
// e2e suite, with explanation:
//
//   - #1059 "Cost meter session widget" (test #10 in the brief): the
//     `<CostWidget />` component is implemented + unit-tested
//     ([ui/components/chat/cost-widget.test.tsx](../components/chat/cost-widget.test.tsx))
//     but is NOT mounted into any user-facing route in this PR. The
//     [/api/admin/sessions/:id/cost](../../src/api/session-costs.ts) endpoint
//     is exhaustively covered by [src/api/session-costs.test.ts](../../src/api/session-costs.test.ts).
//     E2E coverage will land when the widget is wired into the chat layout
//     in a follow-up PR.
//
//   - #1063 "System Requirements card" (test #11 in the brief): the
//     `<SystemRequirementsCard />` component is implemented + unit-tested
//     ([ui/components/admin/system-requirements-card.test.tsx](../components/admin/system-requirements-card.test.tsx))
//     but is NOT mounted into the admin page in this PR. The recommendation
//     logic itself (Apple M4 Max → gemma4:31b INT4, Linux NVIDIA → gemma4:26b
//     AWQ INT4) is exercised end-to-end via the setup wizard, which consumes
//     the same `/api/system/platform` response. E2E coverage of the standalone
//     card will land when it is mounted into the admin grid.
//
//   - #1055 "Sentinel local-endpoint health auto-failover": the failover
//     itself is server-side and exhaustively covered by
//     [src/sentinel/local-endpoint-health.test.ts](../../src/sentinel/local-endpoint-health.test.ts).
//     The user-facing surface (the health badge in the Local LLM panel) IS
//     covered by the "renders the panel with a health badge that reflects
//     the /status response" test above.
//
//   - Server-side AC for #1054, #1056, #1058, #1060, #1061, #1062 (provider
//     persistence in `~/.openzigs/config.json`, dispatcher state machine,
//     autodetect probe sequencing, smart-router token estimation,
//     Apple-Silicon detection heuristics) ship purely as backend code and
//     are covered by the matching `*.test.ts` suites in `src/`. They have
//     no UI affordance to test e2e.
