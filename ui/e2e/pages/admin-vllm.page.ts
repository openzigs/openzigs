import type { Page, Locator, Route } from "@playwright/test";

/**
 * Page Object for the "Local vLLM (TP=2)" panel inside the Admin page.
 * Covers Issue #922 (Epic #888): admin UI for status / KV cache /
 * start+stop of the vLLM sidecar.
 *
 * Wraps:
 *   - SectionCard expand/collapse
 *   - Status fields (running/stopped/starting, model, KV cache bar)
 *   - Start flow (model selector + Start button)
 *   - Stop flow (Stop button + inline confirm dialog)
 *   - API mocking helpers for /api/admin/gpu/vllm/{status,start,stop}
 */

export type VllmAllowedModel = {
  id: string;
  label: string;
  approxWeightsGb: number;
  quantization: string;
  recommendedFor12GbDual: boolean;
  notes?: string;
};

export type VllmMetric = {
  name: string;
  value: number;
  labels: Record<string, string>;
};

export type VllmStatusBody = {
  claim: { workload: string; gpus: number[]; startedAt: number } | null;
  reachable: boolean;
  model: string | null;
  metrics: VllmMetric[];
  allowedModels: VllmAllowedModel[];
  defaultModel: string;
};

const DEFAULT_ALLOWED_MODELS: VllmAllowedModel[] = [
  {
    id: "Qwen/Qwen2.5-14B-Instruct-AWQ",
    label: "Qwen 2.5 14B Instruct (AWQ)",
    approxWeightsGb: 9,
    quantization: "awq",
    recommendedFor12GbDual: true,
  },
  {
    id: "casperhansen/mixtral-8x7b-instruct-v0.1-awq",
    label: "Mixtral 8x7B Instruct (AWQ)",
    approxWeightsGb: 24,
    quantization: "awq",
    recommendedFor12GbDual: false,
  },
];

export const stoppedStatus = (): VllmStatusBody => ({
  claim: null,
  reachable: false,
  model: null,
  metrics: [],
  allowedModels: DEFAULT_ALLOWED_MODELS,
  defaultModel: DEFAULT_ALLOWED_MODELS[0].id,
});

export const runningStatus = (
  overrides: Partial<VllmStatusBody> = {},
): VllmStatusBody => ({
  claim: { workload: "vllm", gpus: [0, 1], startedAt: Date.now() },
  reachable: true,
  model: DEFAULT_ALLOWED_MODELS[0].id,
  metrics: [
    {
      name: "vllm:gpu_cache_usage_perc",
      value: 0.42,
      labels: {},
    },
    { name: "vllm:num_requests_running", value: 2, labels: {} },
    { name: "vllm:num_requests_waiting", value: 0, labels: {} },
  ],
  allowedModels: DEFAULT_ALLOWED_MODELS,
  defaultModel: DEFAULT_ALLOWED_MODELS[0].id,
  ...overrides,
});

export class AdminVllmPage {
  readonly page: Page;
  readonly section: Locator;
  readonly expandToggle: Locator;
  readonly heading: Locator;
  readonly statusValue: Locator;
  readonly modelValue: Locator;
  readonly kvCacheLabel: Locator;
  readonly modelSelect: Locator;
  readonly startButton: Locator;
  readonly stopButton: Locator;
  readonly confirmStopButton: Locator;
  readonly cancelStopButton: Locator;
  readonly errorAlert: Locator;
  readonly stopConfirmDialog: Locator;

  constructor(page: Page) {
    this.page = page;

    // The vllm panel is rendered inside a SectionCard whose header is a
    // <button> labelled "Local vLLM (TP=2)". The panel itself is a <section>
    // with aria-labelledby="vllm-panel-heading".
    this.expandToggle = page.getByRole("button", {
      name: /Local vLLM \(TP=2\)/i,
    });
    this.section = page.locator('section[aria-labelledby="vllm-panel-heading"]');
    this.heading = page.getByRole("heading", { name: /Local vLLM \(TP=2\)/i });

    this.statusValue = this.section
      .locator("dt", { hasText: /^Status$/ })
      .locator("xpath=following-sibling::dd[1]");
    this.modelValue = this.section
      .locator("dt", { hasText: /^Model$/ })
      .locator("xpath=following-sibling::dd[1]");

    this.kvCacheLabel = this.section.getByText("KV cache", { exact: true });

    this.modelSelect = this.section.getByLabel("Model", { exact: true });
    this.startButton = this.section.getByRole("button", {
      name: /Start vLLM/i,
    });
    this.stopButton = this.section.getByRole("button", { name: /^Stop vLLM$/i });

    this.stopConfirmDialog = this.section.getByRole("alertdialog");
    this.confirmStopButton = this.stopConfirmDialog.getByRole("button", {
      name: /Confirm Stop/i,
    });
    this.cancelStopButton = this.stopConfirmDialog.getByRole("button", {
      name: /^Cancel$/i,
    });

    this.errorAlert = this.section.getByRole("alert");
  }

  async goto() {
    await this.page.goto("/admin");
    await this.page.waitForLoadState("domcontentloaded");
    await this.page
      .getByRole("heading", { name: "Administration" })
      .waitFor({ state: "visible", timeout: 15_000 });
  }

  /** Expand the SectionCard if it isn't already open. */
  async expand() {
    await this.expandToggle.scrollIntoViewIfNeeded();
    if (!(await this.heading.isVisible().catch(() => false))) {
      await this.expandToggle.click();
    }
    await this.heading.waitFor({ state: "visible", timeout: 10_000 });
  }

  // ── Mocking helpers ────────────────────────────────────────────────

  /** Mock GET /api/admin/gpu/vllm/status with a fixed body. */
  async mockStatus(body: VllmStatusBody) {
    await this.page.route("**/api/admin/gpu/vllm/status*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      }),
    );
  }

  /** Make GET /status return a 5xx so the panel renders its error state. */
  async mockStatusUnreachable() {
    await this.page.route("**/api/admin/gpu/vllm/status*", (route) =>
      route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "vLLM endpoint unreachable",
      }),
    );
  }

  /**
   * Mock POST /start. `onCall` receives the parsed body so tests can capture
   * the model name and / or return a custom status code.
   */
  async mockStart(opts: {
    onCall?: (body: { model?: string }) => void;
    status?: number;
    responseBody?: unknown;
  } = {}) {
    const { onCall, status = 200, responseBody } = opts;
    const fallback = { ok: true, model: "", message: "starting" };
    await this.page.route(
      "**/api/admin/gpu/vllm/start*",
      async (route: Route) => {
        const req = route.request();
        let parsed: { model?: string } = {};
        try {
          parsed = JSON.parse(req.postData() ?? "{}");
        } catch {
          /* ignore */
        }
        onCall?.(parsed);
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(responseBody ?? { ...fallback, model: parsed.model ?? "" }),
        });
      },
    );
  }

  /** Mock POST /stop. */
  async mockStop(opts: {
    onCall?: () => void;
    status?: number;
    responseBody?: unknown;
  } = {}) {
    const { onCall, status = 200, responseBody = { ok: true } } = opts;
    await this.page.route(
      "**/api/admin/gpu/vllm/stop*",
      async (route: Route) => {
        onCall?.();
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(responseBody),
        });
      },
    );
  }
}
