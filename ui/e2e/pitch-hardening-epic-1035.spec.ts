import { test, expect, type Locator, type Page } from "@playwright/test";
import { PitchEditorPage } from "./pages/pitch-editor.page";
import { PitchLibraryPage } from "./pages/pitch-library.page";

const DECK_ID = "deck-hardening-e2e";
const TITLE_SLIDE_ID = "slide-title";
const IMAGE_SLIDE_ID = "slide-image";
const KIT_ID = "kit-low-contrast";
const GENERATED_ASSET_ID = "asset-generated-inline";
const GENERATED_IMAGE_PATH = `/api/admin/pitch/decks/${DECK_ID}/assets/${GENERATED_ASSET_ID}`;

const GENERATED_IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

type SocketHandler = (payload: unknown) => void;

interface BrowserSocketForE2E {
  listeners?: (eventName: string) => SocketHandler[];
}

interface BrowserWindowForE2E extends Window {
  __openzigsSocket?: BrowserSocketForE2E;
}

interface MockEditorOptions {
  generatedImageAttached?: boolean;
  renderFailsUntilRecovery?: { recover: boolean };
}

function deckPayload(generatedImageAttached: boolean) {
  return {
    deck: {
      id: DECK_ID,
      title: "Pitch Hardening E2E Deck",
      brand_kit_id: KIT_ID,
      aspect_ratio: "16:9",
      metadata: {
        source_script: "Pitch hardening walkthrough script.",
        tone: "formal",
        audience: "operators",
      },
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
    },
    slides: [
      {
        id: TITLE_SLIDE_ID,
        deck_id: DECK_ID,
        position: 0,
        slide: {
          template: "title",
          content: {
            title: "Readable headline",
            subtitle: "Diagnostic and readable by default.",
          },
          background_image_prompt: "clean command center",
          speaker_notes: "Open with the reliability fix.",
          transition: "slide",
          fragments: [],
        },
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      },
      {
        id: IMAGE_SLIDE_ID,
        deck_id: DECK_ID,
        position: 1,
        slide: {
          template: "image_caption",
          content: {
            caption: "Generated image proof",
            image: generatedImageAttached
              ? {
                  prompt: "workflow dashboard product shot",
                  url: GENERATED_IMAGE_PATH,
                  alt: "Generated product panel",
                }
              : {
                  prompt: "workflow dashboard product shot",
                  alt: "Generated product panel",
                },
          },
          speaker_notes: "Verify the image survives refresh.",
          transition: "slide",
          fragments: [],
        },
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      },
    ],
  };
}

function renderHtml(generatedImageAttached: boolean): string {
  const generatedImage = generatedImageAttached
    ? `<img alt="Generated product panel" src="${GENERATED_IMAGE_PATH}" style="display:block;width:360px;height:200px;object-fit:cover;border-radius:8px" />`
    : "";

  return `
    <!doctype html>
    <html>
      <body style="margin:0">
        <main aria-label="Pitch preview" style="min-height:100vh;background:#f8fafc;color:#0f172a;font-family:Inter,Arial,sans-serif">
          <section aria-label="Slide 1" style="min-height:100vh;display:grid;place-items:center;padding:48px;background:#f8fafc;color:#0f172a">
            <div>
              <h1 style="margin:0 0 16px;font-size:48px;color:#0f172a">Readable headline</h1>
              <p style="margin:0;color:#1f2937;font-size:20px">Diagnostic and readable by default.</p>
              ${generatedImage}
            </div>
          </section>
        </main>
      </body>
    </html>
  `.trim();
}

async function mockBrandKits(page: Page) {
  await page.route("**/api/admin/pitch/brand-kits", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          brandKits: [
            {
              id: KIT_ID,
              name: "Low Contrast Kit",
              primaryColor: "#111111",
              secondaryColor: "#111111",
              accentColor: "#222222",
              fontHeading: "Inter",
              fontBody: "Inter",
              isStarter: false,
            },
          ],
        }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brandKit: { id: KIT_ID } }),
    });
  });
}

async function mockDeckLibrary(page: Page, recover: { enabled: boolean }) {
  await mockBrandKits(page);
  await page.route("**/api/admin/pitch/decks", (route) => {
    if (!recover.enabled) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            message: "SQLite migration stalled while reading pitch_decks",
            code: "PITCH_DECKS_UNAVAILABLE",
          },
        }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        decks: [
          {
            ...deckPayload(false).deck,
            slides: deckPayload(false).slides,
          },
        ],
        pagination: { total: 1, limit: 50, offset: 0 },
      }),
    });
  });
}

async function mockEmptyDeckLibrary(page: Page) {
  await mockBrandKits(page);
  await page.route("**/api/admin/pitch/decks", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        decks: [],
        pagination: { total: 0, limit: 50, offset: 0 },
      }),
    }),
  );
}

async function mockEditor(page: Page, options: MockEditorOptions = {}) {
  await mockBrandKits(page);

  await page.route(`**/api/admin/pitch/decks/${DECK_ID}`, (route) => {
    if (route.request().method() !== "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ deck: deckPayload(false).deck }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(deckPayload(options.generatedImageAttached ?? false)),
    });
  });

  await page.route(`**/api/admin/pitch/decks/${DECK_ID}/render**`, (route) => {
    const url = new URL(route.request().url());
    const isThumbnail = url.searchParams.has("slide");
    const recovery = options.renderFailsUntilRecovery;
    if (recovery && !recovery.recover && !isThumbnail) {
      return route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            message: "Renderer rejected malformed slide slide-title",
            code: "PITCH_RENDER_FAILED",
          },
        }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: renderHtml(options.generatedImageAttached ?? false),
    });
  });

  await page.route(`**/api/admin/pitch/decks/${DECK_ID}/share`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tokens: [] }),
    }),
  );

  await page.route(
    `**/api/admin/pitch/decks/${DECK_ID}/assets/${GENERATED_ASSET_ID}**`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: GENERATED_IMAGE_BYTES,
      }),
  );
}

async function dispatchPitchImageEvent(
  page: Page,
  eventName: "pitch:image:failed" | "pitch:image:queued" | "pitch:image:ready",
  payload: Record<string, string>,
) {
  await expect
    .poll(async () =>
      page.evaluate((targetEventName) => {
        const browserWindow = window as BrowserWindowForE2E;
        return browserWindow.__openzigsSocket?.listeners?.(targetEventName)
          .length ?? 0;
      }, eventName),
    )
    .toBeGreaterThan(0);

  await page.evaluate(
    ({ targetEventName, eventPayload }) => {
      const browserWindow = window as BrowserWindowForE2E;
      const handlers =
        browserWindow.__openzigsSocket?.listeners?.(targetEventName) ?? [];
      handlers.forEach((handler) => handler(eventPayload));
    },
    { targetEventName: eventName, eventPayload: payload },
  );
}

async function expectReadableContrast(locator: Locator, minimumRatio: number) {
  await expect(locator).toBeVisible();
  const ratio = await locator.evaluate((node) => {
    function parseRgb(value: string): [number, number, number] {
      const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
      if (!match) return [0, 0, 0];
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    }

    function channel(value: number): number {
      const normalized = value / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    }

    function luminance([red, green, blue]: [number, number, number]): number {
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
    }

    function effectiveBackground(element: Element): string {
      let current: Element | null = element;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        if (color && !color.endsWith(", 0)") && color !== "transparent") {
          return color;
        }
        current = current.parentElement;
      }
      return "rgb(255, 255, 255)";
    }

    const styles = getComputedStyle(node as HTMLElement);
    const foreground = luminance(parseRgb(styles.color));
    const background = luminance(parseRgb(effectiveBackground(node as Element)));
    const lighter = Math.max(foreground, background);
    const darker = Math.min(foreground, background);
    return (lighter + 0.05) / (darker + 0.05);
  });

  expect(ratio).toBeGreaterThanOrEqual(minimumRatio);
}

test.describe("Epic #1035 - Pitch hardening", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("openzigs:e2e-socket-hook", "1");
    });
  });

  // AC #1035.1/#1040.3: Empty libraries remain usable and do not collapse to the old generic error dead end.
  test("Pitch library shows an actionable empty state when no decks are available", async ({
    page,
  }) => {
    await mockEmptyDeckLibrary(page);

    const library = new PitchLibraryPage(page);
    await library.goto();

    await expect(library.emptyHeading).toBeVisible();
    await expect(page.getByText("Generate your first AI-drafted pitch deck")).toBeVisible();
    await expect(library.newDeckLink).toHaveAttribute("href", "/pitch/new");
    await expect(library.loadErrorMessage).toHaveCount(0);
  });

  // AC #1035.1/#1040.3/#1039.1: Deck-list failures include endpoint/status diagnostics and recover in-place.
  test("Pitch library surfaces API diagnostics and recovers with Retry", async ({
    page,
  }) => {
    const recovery = { enabled: false };
    await mockDeckLibrary(page, recovery);

    const library = new PitchLibraryPage(page);
    await library.goto();

    await expect(library.loadErrorMessage).toBeVisible({ timeout: 15_000 });
    await expect(
      library.errorDetail(
        /GET \/api\/admin\/pitch\/decks: .*503.*SQLite migration stalled.*PITCH_DECKS_UNAVAILABLE/i,
      ),
    ).toBeVisible();

    recovery.enabled = true;
    await library.retryButton.click();

    await expect(library.deckTitle("Pitch Hardening E2E Deck")).toBeVisible();
    await expect(library.loadErrorMessage).toHaveCount(0);
    await expect(page).toHaveURL(/\/pitch$/);
  });

  // AC #1035.2/#1039.2: Render failures do not collapse the editor and can recover without a full reload.
  test("Deck editor keeps controls available when render fails and retries the canvas", async ({
    page,
  }) => {
    const renderRecovery = { recover: false };
    await mockEditor(page, { renderFailsUntilRecovery: renderRecovery });

    const editor = new PitchEditorPage(page, DECK_ID);
    await editor.goto();

    await expect(editor.topbar).toBeVisible();
    await expect(editor.slideRail).toBeVisible();
    await expect(editor.propertiesPanel).toBeVisible();
    await expect(editor.renderErrorMessage).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/GET \/api\/admin\/pitch\/decks\/deck-hardening-e2e\/render failed with 502: Renderer rejected malformed slide slide-title/i),
    ).toBeVisible();

    renderRecovery.recover = true;
    await editor.renderRetryButton.click();

    await expect(
      editor.revealFrame().getByRole("heading", { name: "Readable headline" }),
    ).toBeVisible();
  });

  // AC #1035.3/#1038.1/#1036.5: Generated images remain attached and visible after a refresh.
  test("Generated slide image is visible in the editor after reconciliation and refresh", async ({
    page,
  }) => {
    let generatedImageAttached = false;
    await mockEditor(page, {
      get generatedImageAttached() {
        return generatedImageAttached;
      },
    });
    await page.route(
      `**/api/admin/pitch/decks/${DECK_ID}/images/generate-all`,
      (route) => {
        generatedImageAttached = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ enqueued: 1, skipped: 0, total: 1 }),
        });
      },
    );

    const editor = new PitchEditorPage(page, DECK_ID);
    await editor.goto();

    await editor.generateAllImagesControl.click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(editor.shell).toBeVisible();

    const generatedImage = editor
      .revealFrame()
      .getByRole("img", { name: "Generated product panel" });
    await expect(generatedImage).toBeVisible();
    await expect(generatedImage).toHaveAttribute(
      "src",
      new RegExp(`${GENERATED_ASSET_ID}(?:\\?token=.+)?$`),
    );
  });

  // AC #1035.4/#1037.2/#1037.6/#1036.4: Low-contrast kit edits warn, while rendered text stays WCAG-readable.
  test("Brand kit contrast warnings pair with readable rendered slides", async ({
    page,
  }) => {
    await mockEditor(page, { generatedImageAttached: true });

    const editor = new PitchEditorPage(page, DECK_ID);
    await page.setViewportSize({ width: 1280, height: 800 });
    await editor.goto();

    await editor.editBrandKitButton.click();
    await expect(editor.brandKitDialog).toBeVisible();
    await expect(editor.contrastWarning).toBeVisible();
    await expect(editor.brandKitDialog.getByRole("button", { name: "Save" })).toBeEnabled();

    const headline = editor
      .revealFrame()
      .getByRole("heading", { name: "Readable headline" });
    await expectReadableContrast(headline, 4.5);

    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(headline).toBeVisible();
    await expectReadableContrast(headline, 4.5);
  });

  // AC #1035.5/#1039.3: Failed image jobs expose a scoped retry affordance in the slide rail.
  test("Image failure state exposes a slide-scoped retry control", async ({
    page,
  }) => {
    let retryCount = 0;
    await mockEditor(page);
    await page.route(
      `**/api/admin/pitch/decks/${DECK_ID}/images/generate-all`,
      (route) => {
        retryCount += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ enqueued: 1, skipped: 0, total: 1 }),
        });
      },
    );

    const editor = new PitchEditorPage(page, DECK_ID);
    await editor.goto();
    await dispatchPitchImageEvent(page, "pitch:image:failed", {
      deckId: DECK_ID,
      slideId: IMAGE_SLIDE_ID,
      slot: "image",
      error: "FluxQ worker returned missing asset file",
    });

    const retryButton = editor.retryImageButtonForSlide(2);
    await expect(retryButton).toBeVisible();
    await retryButton.click();

    await expect.poll(() => retryCount).toBe(1);
  });
});