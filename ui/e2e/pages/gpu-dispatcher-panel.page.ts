import type { Page, Locator, Route } from "@playwright/test";

/**
 * Page Object for the GPU Dispatcher section inside the Admin "GPU & VRAM"
 * panel (epic #1053, sub-issues #1056 / #1059 / #1060).
 *
 * Wraps:
 *   - GET  /api/system/gpu                              (profile + dispatcher lanes)
 *   - GET  /api/admin/gpu/ollama/{tags,ps}              (ollama status — stubbed empty)
 *   - POST /api/admin/gpu/dispatcher/:idx/cancel        (cancel running job)
 *   - POST /api/admin/gpu/dispatcher/:idx/clear-error   (retry)
 */

export type DispatcherWorkloadType = "llm" | "image" | "video";
export type DispatcherLaneState = "idle" | "busy" | "error";

export interface DispatcherLaneSnapshot {
  index: number;
  state: DispatcherLaneState;
  currentJob?: {
    id: string;
    workloadType: DispatcherWorkloadType;
    startedAt: number;
  };
  lastError?: string;
  queueDepth: number;
  mutexBlockedBy?: DispatcherWorkloadType;
}

export interface GpuInfo {
  index: number;
  name: string;
  total_mb: number;
  free_mb: number;
}

export interface GpuProfile {
  detected: boolean;
  gpus: GpuInfo[];
  total_vram_gb: number;
  largest_gpu_gb: number;
  recommended_tier: string;
  recommended_tier_pooled?: string;
  pooling_supported: boolean;
  pooling_mode?: string;
  same_arch: boolean;
  pinning: Record<string, number>;
  detected_at: string;
  dispatcher?: { gpus: DispatcherLaneSnapshot[] };
}

export const singleGpuProfile = (
  overrides: Partial<GpuProfile> = {},
): GpuProfile => ({
  detected: true,
  gpus: [
    { index: 0, name: "NVIDIA GeForce RTX 4090", total_mb: 24_576, free_mb: 18_000 },
  ],
  total_vram_gb: 24,
  largest_gpu_gb: 24,
  recommended_tier: "ultra",
  pooling_supported: false,
  pooling_mode: "off",
  same_arch: true,
  pinning: { llm: 0 },
  detected_at: new Date().toISOString(),
  dispatcher: {
    gpus: [{ index: 0, state: "idle", queueDepth: 0 }],
  },
  ...overrides,
});

export const dualGpuProfile = (
  overrides: Partial<GpuProfile> = {},
): GpuProfile => ({
  detected: true,
  gpus: [
    { index: 0, name: "NVIDIA GeForce RTX 4090", total_mb: 24_576, free_mb: 16_000 },
    { index: 1, name: "NVIDIA GeForce RTX 4090", total_mb: 24_576, free_mb: 4_000 },
  ],
  total_vram_gb: 48,
  largest_gpu_gb: 24,
  recommended_tier: "ultra",
  pooling_supported: true,
  pooling_mode: "off",
  same_arch: true,
  pinning: { llm: 0, image: 1, video: 1 },
  detected_at: new Date().toISOString(),
  dispatcher: {
    gpus: [
      // GPU 0 wants to run LLM but is mutex-blocked by GPU 1's video render.
      { index: 0, state: "idle", queueDepth: 1, mutexBlockedBy: "video" },
      {
        index: 1,
        state: "busy",
        queueDepth: 0,
        currentJob: {
          id: "job-video-abc12345",
          workloadType: "video",
          startedAt: Date.now() - 12_000,
        },
      },
    ],
  },
  ...overrides,
});

export class GpuDispatcherPanelPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly emptyState: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "GPU Dispatcher" });
    this.emptyState = page.getByTestId("gpu-dispatcher-empty");
  }

  /** Open the admin page and expand the "GPU & VRAM" SectionCard. */
  async goto() {
    await this.page.goto("/admin");
    // The GPU & VRAM card is collapsed by default → expand it.
    const toggle = this.page.getByRole("button", { name: /GPU & VRAM/ });
    await toggle.waitFor({ state: "visible", timeout: 15_000 });
    await toggle.click();
  }

  card(index: number): Locator {
    return this.page.getByTestId(`gpu-dispatcher-card-${index}`);
  }

  state(index: number): Locator {
    return this.page.getByTestId(`gpu-dispatcher-state-${index}`);
  }

  mutexLabel(index: number): Locator {
    return this.page.getByTestId(`gpu-dispatcher-mutex-${index}`);
  }

  cancelButton(index: number): Locator {
    return this.page.getByTestId(`gpu-dispatcher-cancel-${index}`);
  }
}

export interface GpuMockController {
  setProfile(next: GpuProfile): void;
  cancelCalls: Array<{ index: number }>;
  clearErrorCalls: Array<{ index: number }>;
}

export interface GpuInstallOptions {
  profile?: GpuProfile;
  /** Whether to fulfil cancel POSTs as `{cancelled: true}` (default true). */
  cancelSucceeds?: boolean;
}

export async function installGpuMocks(
  page: Page,
  opts: GpuInstallOptions = {},
): Promise<GpuMockController> {
  let profile = opts.profile ?? singleGpuProfile();
  const cancelSucceeds = opts.cancelSucceeds ?? true;

  const controller: GpuMockController = {
    setProfile: (next) => {
      profile = next;
    },
    cancelCalls: [],
    clearErrorCalls: [],
  };

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  await page.route("**/api/system/gpu", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return json(route, profile);
  });

  // Stub Ollama status to "no Ollama" — keeps the GPU panel render simple.
  await page.route("**/api/admin/gpu/ollama/tags", (route) =>
    json(route, { models: [] }),
  );
  await page.route("**/api/admin/gpu/ollama/ps", (route) =>
    json(route, { models: [] }),
  );

  await page.route(
    /\/api\/admin\/gpu\/dispatcher\/(\d+)\/cancel$/,
    (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const match = route.request().url().match(/dispatcher\/(\d+)\/cancel$/);
      const index = match ? Number(match[1]) : -1;
      controller.cancelCalls.push({ index });
      // Mutate the profile so a subsequent /api/system/gpu refetch shows idle.
      if (profile.dispatcher) {
        profile = {
          ...profile,
          dispatcher: {
            gpus: profile.dispatcher.gpus.map((lane) =>
              lane.index === index
                ? { ...lane, state: "idle" as const, currentJob: undefined }
                : lane,
            ),
          },
        };
      }
      return json(route, { cancelled: cancelSucceeds });
    },
  );

  await page.route(
    /\/api\/admin\/gpu\/dispatcher\/(\d+)\/clear-error$/,
    (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const match = route
        .request()
        .url()
        .match(/dispatcher\/(\d+)\/clear-error$/);
      controller.clearErrorCalls.push({ index: match ? Number(match[1]) : -1 });
      return json(route, { cleared: true });
    },
  );

  return controller;
}
