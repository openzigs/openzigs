import type { Page, Locator, Route } from "@playwright/test";

/**
 * Page Object for the "Local LLM Provider" admin panel
 * (epic #1053, sub-issues #1054 / #1057 / #1058 / #1060 / #1061).
 *
 * Wraps:
 *   - GET  /api/admin/local-llm/status        (health, provider, privacy)
 *   - GET  /api/admin/local-llm/router        (smart router state)
 *   - POST /api/admin/local-llm/autodetect    (test connection)
 *   - POST /api/admin/local-llm/provider      (save)
 *   - POST /api/admin/local-llm/privacy/global (lockdown)
 *   - POST /api/admin/local-llm/router        (router update)
 */

export type ProviderType = "local-copilot";

export interface StatusBody {
  provider: {
    type: ProviderType;
    endpoint: string;
    model: string;
    timeoutMs?: number;
    hasApiKey: boolean;
  } | null;
  privacyMode: { globalLockdown: boolean };
  health: {
    status: "healthy" | "degraded" | "failed-over" | "disabled";
    lastProbeAt: string | null;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    failoverActive: boolean;
  };
  vllmKey: { masked: string | null; present: boolean };
}

export interface RouterBody {
  enabled: boolean;
  cloudThresholdTokens: number;
  thresholdStops: number[];
}

export const stoppedStatus = (): StatusBody => ({
  provider: null,
  privacyMode: { globalLockdown: false },
  health: {
    status: "disabled",
    lastProbeAt: null,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    failoverActive: false,
  },
  vllmKey: { masked: null, present: false },
});

export const healthyStatus = (overrides: Partial<StatusBody> = {}): StatusBody => ({
  provider: {
    type: "local-copilot",
    endpoint: "http://127.0.0.1:11434/v1",
    model: "gemma4:26b",
    hasApiKey: false,
  },
  privacyMode: { globalLockdown: false },
  health: {
    status: "healthy",
    lastProbeAt: new Date().toISOString(),
    consecutiveFailures: 0,
    consecutiveSuccesses: 5,
    failoverActive: false,
  },
  vllmKey: { masked: null, present: false },
  ...overrides,
});

export const defaultRouter = (overrides: Partial<RouterBody> = {}): RouterBody => ({
  enabled: true,
  cloudThresholdTokens: 4096,
  thresholdStops: [256, 1024, 4096, 8192],
  ...overrides,
});

export class LocalLlmPanelPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly healthBadge: Locator;
  readonly endpointInput: Locator;
  readonly modelInput: Locator;
  readonly testConnectionButton: Locator;
  readonly saveButton: Locator;
  readonly perSessionPrivacyCheckbox: Locator;
  readonly globalLockdownCheckbox: Locator;
  readonly smartRouterSection: Locator;
  readonly smartRouterToggle: Locator;
  readonly smartRouterThreshold: Locator;
  readonly smartRouterThresholdValue: Locator;

  constructor(page: Page) {
    this.page = page;
    // Two `<h2>Local LLM Provider</h2>` render on the page (the SectionCard
    // wrapper and the panel header itself). Both are valid matches; the panel
    // header is sufficient to confirm hydration so we anchor on the unique
    // health-badge testid via `.first()` for strict-mode compatibility.
    this.heading = page
      .getByRole("heading", { name: "Local LLM Provider" })
      .first();
    this.healthBadge = page.getByTestId("health-badge");
    this.endpointInput = page.getByLabel("Endpoint URL");
    this.modelInput = page.getByLabel("Model name");
    this.testConnectionButton = page.getByRole("button", { name: "Test connection" });
    this.saveButton = page.getByRole("button", { name: "Save provider" });
    this.perSessionPrivacyCheckbox = page.getByLabel("Per-session privacy mode");
    this.globalLockdownCheckbox = page.getByLabel("Global privacy lockdown");
    this.smartRouterSection = page.getByTestId("smart-router-section");
    this.smartRouterToggle = page.getByTestId("smart-router-toggle");
    this.smartRouterThreshold = page.getByTestId("smart-router-threshold");
    this.smartRouterThresholdValue = page.getByTestId("smart-router-threshold-value");
  }

  /** Open admin and expand the Local LLM Provider section card. */
  async goto() {
    await this.page.goto("/admin");
    // The card is open by default (no `defaultOpen={false}`), but we still wait
    // for the heading to be visible to confirm hydration.
    await this.heading.waitFor({ state: "visible", timeout: 15_000 });
  }
}

interface InstallOptions {
  status?: StatusBody;
  router?: RouterBody;
  /** Override the autodetect response. */
  autodetect?: {
    ollama?: { endpoint: string; models: string[]; recommendedModel: string | null } | null;
    vllm?: { endpoint: string; models: string[]; recommendedModel: string | null } | null;
    skipped?: boolean;
  };
}

/**
 * Install hermetic mocks for the Local LLM panel. Mocks are mutable: each
 * mock reads from a closure that the returned controller can update so tests
 * can simulate "save → reload → reflect new state" without re-installing
 * routes.
 */
export interface LocalLlmMockController {
  setStatus(next: StatusBody): void;
  setRouter(next: RouterBody): void;
  /** All POST /provider bodies, in order. */
  providerSaves: Array<Record<string, unknown>>;
  /** All POST /privacy/global bodies, in order. */
  privacySaves: Array<Record<string, unknown>>;
  /** All POST /router bodies, in order. */
  routerSaves: Array<Record<string, unknown>>;
  autodetectCalls: number;
}

export async function installLocalLlmMocks(
  page: Page,
  opts: InstallOptions = {},
): Promise<LocalLlmMockController> {
  let status = opts.status ?? stoppedStatus();
  let router = opts.router ?? defaultRouter();
  const controller: LocalLlmMockController = {
    setStatus: (next) => {
      status = next;
    },
    setRouter: (next) => {
      router = next;
    },
    providerSaves: [],
    privacySaves: [],
    routerSaves: [],
    autodetectCalls: 0,
  };

  const json = (route: Route, body: unknown, statusCode = 200) =>
    route.fulfill({
      status: statusCode,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  await page.route("**/api/admin/local-llm/status", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return json(route, status);
  });

  await page.route("**/api/admin/local-llm/router", (route) => {
    const method = route.request().method();
    if (method === "GET") return json(route, router);
    if (method === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<
        string,
        unknown
      >;
      controller.routerSaves.push(body);
      router = {
        ...router,
        enabled: typeof body.enabled === "boolean" ? body.enabled : router.enabled,
        cloudThresholdTokens:
          typeof body.cloudThresholdTokens === "number"
            ? body.cloudThresholdTokens
            : router.cloudThresholdTokens,
      };
      return json(route, router);
    }
    return route.continue();
  });

  await page.route("**/api/admin/local-llm/autodetect", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    controller.autodetectCalls++;
    const body = opts.autodetect ?? {
      ollama: {
        endpoint: "http://127.0.0.1:11434/v1",
        models: ["gemma4:26b"],
        recommendedModel: "gemma4:26b",
      },
      vllm: null,
    };
    return json(route, body);
  });

  await page.route("**/api/admin/local-llm/provider", (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<
        string,
        unknown
      >;
      controller.providerSaves.push(body);
      // Reflect the save into status so the next refetch shows it.
      status = {
        ...status,
        provider: {
          type: "local-copilot",
          endpoint: String(body.endpoint ?? ""),
          model: String(body.model ?? ""),
          hasApiKey: typeof body.apiKey === "string" && body.apiKey.length > 0,
        },
        health: { ...status.health, status: "healthy" },
      };
      return json(route, { ok: true });
    }
    if (method === "DELETE") {
      status = { ...status, provider: null };
      return json(route, { ok: true });
    }
    return route.continue();
  });

  await page.route("**/api/admin/local-llm/privacy/global", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<
      string,
      unknown
    >;
    controller.privacySaves.push(body);
    status = {
      ...status,
      privacyMode: { globalLockdown: !!body.globalLockdown },
    };
    return json(route, { ok: true });
  });

  return controller;
}
