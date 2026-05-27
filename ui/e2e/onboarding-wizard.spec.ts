import { test, expect, type Page } from "@playwright/test";

/**
 * Onboarding Wizard 2.0 (epic #1118) — happy path + resume.
 * All /api/admin/setup/* endpoints are stubbed via page.route().
 */

interface WizardState {
  currentStep: string;
  completedSteps: string[];
  data: Record<string, unknown>;
  updatedAt: string;
}

const SIDECARS = [
  {
    name: "audio",
    installed: false,
    hasServer: false,
    hasVenv: false,
    description: "Audio sidecar",
  },
  {
    name: "image-gen",
    installed: true,
    hasServer: true,
    hasVenv: true,
    description: "Image generation",
  },
];

const SOCIAL_PLATFORMS = [
  {
    id: "meta",
    label: "Meta",
    description: "Facebook + Instagram",
    authMode: "oauth",
    authorizeRoute: "/api/admin/social/meta/authorize",
    docsUrl: "https://example.com/meta",
    connected: false,
    connectedAt: null,
  },
  {
    id: "tiktok",
    label: "TikTok",
    description: "TikTok manual token",
    authMode: "manual_token",
    authorizeRoute: null,
    docsUrl: "https://example.com/tiktok",
    connected: false,
    connectedAt: null,
  },
];

const RECIPES = [
  {
    id: "director-first-video",
    name: "First Director Video",
    description: "...",
    tags: ["starter"],
    stageCount: 3,
  },
  {
    id: "social-week",
    name: "Week of Posts",
    description: "...",
    tags: ["starter"],
    stageCount: 3,
  },
];

async function stubWizard(page: Page, initial: Partial<WizardState> = {}) {
  let state: WizardState = {
    currentStep: "welcome",
    completedSteps: [],
    data: {},
    updatedAt: new Date().toISOString(),
    ...initial,
  };

  await page.route("**/api/admin/setup/state", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      await route.fulfill({ json: state });
      return;
    }
    if (req.method() === "POST") {
      const body = req.postDataJSON() as Partial<WizardState>;
      state = {
        ...state,
        ...body,
        updatedAt: new Date().toISOString(),
      };
      await route.fulfill({ json: state });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/admin/setup/state/reset", async (route) => {
    state = {
      currentStep: "welcome",
      completedSteps: [],
      data: {},
      updatedAt: new Date().toISOString(),
    };
    await route.fulfill({ json: state });
  });

  await page.route("**/api/admin/setup/sidecars", async (route) => {
    await route.fulfill({
      json: { sidecars: SIDECARS, supported: true, platform: "darwin" },
    });
  });

  await page.route("**/api/admin/setup/sidecars/**/install", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'data: {"event":"log","data":"installing..."}\n\ndata: {"event":"done"}\n\n',
    });
  });

  await page.route("**/api/admin/setup/social", async (route) => {
    await route.fulfill({ json: { platforms: SOCIAL_PLATFORMS } });
  });

  await page.route(
    "**/api/admin/setup/social/*/manual-token",
    async (route) => {
      await route.fulfill({ json: { ok: true } });
    },
  );

  await page.route("**/api/admin/setup/byok/test", async (route) => {
    await route.fulfill({
      json: {
        provider: "openai",
        ok: true,
        status: 200,
        latencyMs: 42,
        message: "API key is valid.",
      },
    });
  });

  await page.route("**/api/admin/setup/byok/save", async (route) => {
    await route.fulfill({ json: { ok: true } });
  });

  await page.route("**/api/admin/setup/recipes", async (route) => {
    await route.fulfill({ json: { recipes: RECIPES } });
  });

  await page.route("**/api/admin/setup/recipes/*/import", async (route) => {
    await route.fulfill({ json: { ok: true, promptId: "abc-123" } });
  });
}

test.describe("Onboarding Wizard 2.0", () => {
  test("walks through all 7 steps", async ({ page }) => {
    await stubWizard(page);
    await page.goto("/setup");

    await expect(page.getByTestId("step-welcome")).toBeVisible();
    await page.getByRole("button", { name: /next/i }).click();

    await expect(page.getByTestId("step-prereqs")).toBeVisible();
    await page.getByRole("button", { name: /next/i }).click();

    await expect(page.getByTestId("step-sidecars")).toBeVisible();
    await expect(page.getByTestId("sidecar-audio")).toBeVisible();
    await page.getByRole("button", { name: /next/i }).click();

    await expect(page.getByTestId("step-social")).toBeVisible();
    await expect(page.getByTestId("social-meta")).toBeVisible();
    await expect(page.getByTestId("social-tiktok")).toBeVisible();
    await page.getByTestId("token-input-tiktok").fill("secret-token");
    await page.getByTestId("save-token-tiktok").click();
    await page.getByRole("button", { name: /next/i }).click();

    await expect(page.getByTestId("step-byok")).toBeVisible();
    await page.getByTestId("byok-key").fill("sk-test-123");
    await page.getByTestId("byok-test").click();
    await expect(page.getByTestId("byok-result")).toContainText(/valid/i);
    await page.getByTestId("byok-save").click();
    await page.getByRole("button", { name: /next/i }).click();

    await expect(page.getByTestId("step-recipes")).toBeVisible();
    await expect(page.getByTestId("recipe-director-first-video")).toBeVisible();
    await page.getByTestId("import-director-first-video").click();
    await expect(page.getByTestId("import-director-first-video")).toContainText(
      /imported/i,
    );
    await page.getByRole("button", { name: /finish/i }).click();

    await expect(page.getByTestId("step-complete")).toBeVisible();
    await expect(page.getByTestId("go-to-app")).toBeVisible();
    await expect(page.getByTestId("reset-wizard")).toBeVisible();
  });

  test("resumes at saved step after reload", async ({ page }) => {
    await stubWizard(page, {
      currentStep: "byok",
      completedSteps: ["welcome", "prereqs", "sidecars", "social"],
    });
    await page.goto("/setup");
    await expect(page.getByTestId("step-byok")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("step-byok")).toBeVisible();

    const progress = page.getByTestId("wizard-progress");
    await expect(
      progress.locator('[data-step="welcome"][data-completed]'),
    ).toHaveCount(1);
    await expect(
      progress.locator('[data-step="social"][data-completed]'),
    ).toHaveCount(1);
    await expect(
      progress.locator('[data-step="byok"][data-current]'),
    ).toHaveCount(1);
  });
});
