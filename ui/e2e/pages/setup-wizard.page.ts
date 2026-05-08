import type { Page, Locator, Route } from "@playwright/test";

/**
 * Page Object for the offline setup wizard at `/setup/offline`
 * (epic #1053, sub-issues #1062 / #1063).
 *
 * Wraps:
 *   - GET  /api/system/platform                  (platform + recommendation)
 *   - GET  /api/admin/local-llm/provider         (idempotency check)
 *   - POST /api/admin/local-llm/autodetect       (probe step 4)
 *   - POST /api/admin/local-llm/provider         (switch step 5)
 */

export type OsKind = "windows" | "macos" | "linux" | "unknown";
export type GpuKind = "nvidia" | "apple-silicon" | "amd" | "cpu";
export type Backend = "ollama-mlx" | "ollama-cuda" | "ollama-cpu";

export interface PlatformResponse {
  platform: {
    os: OsKind;
    arch: string;
    chip: string | null;
    gpuKind: GpuKind;
    recommendedBackend: Backend;
    detectedAt: string;
  };
  recommended: {
    modelId: string;
    quantisation: string;
    rationale: string;
    minMemoryBytes: number;
  };
  memoryGb: number;
  unifiedMemoryGb: number | null;
  largestGpuVramGb: number | null;
}

export interface AutodetectResponse {
  ollama?: { reachable: boolean; baseUrl?: string; models?: string[] };
  vllm?: { reachable: boolean; baseUrl?: string; models?: string[] };
}

export interface ProviderResponse {
  provider: { type: string; baseUrl?: string; modelId?: string } | null;
}

const GB = 1024 * 1024 * 1024;

export const macM4Max64Platform = (): PlatformResponse => ({
  platform: {
    os: "macos",
    arch: "arm64",
    chip: "Apple M4 Max",
    gpuKind: "apple-silicon",
    recommendedBackend: "ollama-mlx",
    detectedAt: new Date().toISOString(),
  },
  recommended: {
    modelId: "gemma4:31b",
    quantisation: "INT4",
    rationale: "Apple M4 Max with 64 GB unified memory comfortably hosts the 31B INT4 weights.",
    minMemoryBytes: 24 * GB,
  },
  memoryGb: 64,
  unifiedMemoryGb: 64,
  largestGpuVramGb: null,
});

export const linuxNvidia4090Platform = (): PlatformResponse => ({
  platform: {
    os: "linux",
    arch: "x64",
    chip: "AMD Ryzen 9 7950X",
    gpuKind: "nvidia",
    recommendedBackend: "ollama-cuda",
    detectedAt: new Date().toISOString(),
  },
  recommended: {
    modelId: "gemma4:26b",
    quantisation: "AWQ INT4",
    rationale: "Single RTX 4090 hosts gemma4:26b AWQ comfortably with KV headroom.",
    minMemoryBytes: 16 * GB,
  },
  memoryGb: 64,
  unifiedMemoryGb: null,
  largestGpuVramGb: 24,
});

export class SetupWizardPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly stepDetectHeading: Locator;
  readonly stepRecommendHeading: Locator;
  readonly stepInstallHeading: Locator;
  readonly stepTestHeading: Locator;
  readonly stepSwitchHeading: Locator;
  readonly nextButton: Locator;
  readonly backButton: Locator;
  readonly probeButton: Locator;
  readonly switchButton: Locator;
  readonly alreadyOfflineBanner: Locator;
  readonly rerunButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Offline setup wizard" });
    this.stepDetectHeading = page.getByRole("heading", {
      name: "1. Detect your hardware",
    });
    this.stepRecommendHeading = page.getByRole("heading", {
      name: "2. Recommended model",
    });
    this.stepInstallHeading = page.getByRole("heading", {
      name: "3. Install commands",
    });
    this.stepTestHeading = page.getByRole("heading", { name: "4. Test connection" });
    this.stepSwitchHeading = page.getByRole("heading", {
      name: "5. Switch to local provider",
    });
    this.nextButton = page.getByRole("button", { name: "Next" });
    this.backButton = page.getByRole("button", { name: "Back" });
    this.probeButton = page.getByRole("button", { name: /Probe local endpoints|Probing/ });
    this.switchButton = page.getByRole("button", {
      name: /Switch openzigs to local|Switching/,
    });
    this.alreadyOfflineBanner = page.getByText("You're already running offline");
    this.rerunButton = page.getByRole("button", { name: "Re-run wizard" });
  }

  async goto() {
    await this.page.goto("/setup/offline");
    await this.heading.waitFor({ state: "visible", timeout: 15_000 });
  }

  async clickNext() {
    await this.nextButton.click();
  }
}

export interface SetupMockOptions {
  platform?: PlatformResponse;
  /** Provider currently configured server-side (drives idempotency banner). */
  provider?: ProviderResponse["provider"] | null;
  autodetect?: AutodetectResponse;
}

export interface SetupMockController {
  switchCalls: Array<Record<string, unknown>>;
  autodetectCalls: number;
}

export async function installSetupMocks(
  page: Page,
  opts: SetupMockOptions = {},
): Promise<SetupMockController> {
  const platform = opts.platform ?? linuxNvidia4090Platform();
  let provider = opts.provider ?? null;
  const autodetect: AutodetectResponse =
    opts.autodetect ?? {
      ollama: {
        reachable: true,
        baseUrl: "http://127.0.0.1:11434",
        models: [platform.recommended.modelId],
      },
      vllm: { reachable: false },
    };

  const controller: SetupMockController = {
    switchCalls: [],
    autodetectCalls: 0,
  };

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  await page.route("**/api/system/platform", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return json(route, platform);
  });

  await page.route("**/api/admin/local-llm/provider", (route) => {
    const method = route.request().method();
    if (method === "GET") return json(route, { provider });
    if (method === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<
        string,
        unknown
      >;
      controller.switchCalls.push(body);
      provider = {
        type: "local-copilot",
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
        modelId: typeof body.modelId === "string" ? body.modelId : undefined,
      };
      return json(route, { ok: true });
    }
    return route.continue();
  });

  await page.route("**/api/admin/local-llm/autodetect", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    controller.autodetectCalls++;
    return json(route, autodetect);
  });

  return controller;
}
