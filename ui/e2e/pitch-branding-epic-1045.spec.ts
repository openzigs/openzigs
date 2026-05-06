import { test, expect, type Page, type Route } from "@playwright/test";
import { PitchEditorPage } from "./pages/pitch-editor.page";
import { BrandKitEditorDialog } from "./pages/brand-kit-editor.page";
import { BrandKitPicker } from "./pages/brand-kit-picker.page";

/**
 * E2E tests — Epic #1045 "Pitch Branding & Template Library Expansion"
 * (PR #1044, branch `feature/pitch-image-quality-and-layout-fixes`).
 *
 * These tests cover the user-visible UI surface added by the PR:
 *   - Sub-issue #1047 — kit-level "Default logo placement" + "Show
 *     slide numbers" controls in the BrandKitEditor dialog.
 *   - Sub-issue #1048 — "Apply" + "Copy from deck" buttons in the
 *     BrandKitPicker, including the window.confirm / window.prompt
 *     guards and the resulting POSTs.
 *
 * The remaining sub-issues in the epic (#1046, #1049, #1050, #1051,
 * #1052) ship purely server-side or schema-level changes — slide
 * templates, exporter cases, generator-prompt entries, per-slide
 * Zod fields, renderer collision-avoidance — and are exhaustively
 * covered by the Vitest suites referenced in the PR body
 * (`src/pitch/pitch-schema-new-templates.test.ts`,
 * `src/pitch/pitch-renderer.test.ts`, `src/pitch/pitch-export-pptx.test.ts`,
 * `src/api/pitch.test.ts`, etc.). No UI affordance was added for
 * those sub-issues in this PR, so they are intentionally NOT covered
 * here. See the "Unmapped acceptance criteria" section at the bottom
 * of this file for the full explanation.
 *
 * Acceptance-criteria → test mapping:
 *
 * | Sub-issue / AC | Test name |
 * | --- | --- |
 * | #1047 AC1 (controls render + persist) | "exposes the Default logo placement select with all 5 placements + the renderer-default option" |
 * | #1047 AC1 (controls render + persist) | "exposes the Show slide numbers checkbox in the Branding panel" |
 * | #1047 AC1 + AC4 (PATCH round-trip)    | "persists the new defaultLogoPlacement and showSlideNumbers via PATCH on Save" |
 * | #1047 AC1                              | "rehydrates the new controls from the persisted brand kit on open" |
 * | #1048 AC1                              | "shows a confirmation prompt and POSTs to apply-brand-kit when Apply is clicked" |
 * | #1048 AC1 + AC4 (cancel guard)         | "does not POST to apply-brand-kit when the confirmation is cancelled" |
 * | #1048 AC2 + AC3 (extract route)        | "prompts for a kit name and POSTs to extract-brand-kit when Copy from deck is clicked" |
 * | #1048 AC2 (cancel guard)               | "does not POST to extract-brand-kit when the prompt is cancelled" |
 *
 * Network is fully mocked via `page.route()` so the suite is hermetic
 * (no backend, no SQLite, no brand-kit fixtures required).
 */

// ── Fixtures ──────────────────────────────────────────────────────────

const DECK_ID = "deck-branding-e2e";
const KIT_ID = "kit-branding-e2e";

const SLIDE_TITLE = {
  id: "slide-1",
  deck_id: DECK_ID,
  position: 0,
  slide: {
    template: "title",
    content: {
      title: "Branding epic walkthrough",
      subtitle: "Apply / Copy / Defaults",
    },
    speaker_notes: "",
    transition: "slide",
    fragments: [],
  },
  created_at: "2026-05-01T00:00:00.000Z",
  updated_at: "2026-05-01T00:00:00.000Z",
};

const DECK_PAYLOAD = {
  deck: {
    id: DECK_ID,
    title: "Branding E2E Deck",
    brand_kit_id: KIT_ID,
    aspect_ratio: "16:9",
    metadata: {
      source_script: "Hello world.",
      tone: "formal",
      audience: "execs",
    },
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
  },
  slides: [SLIDE_TITLE],
};

/**
 * Brand kit fixture with the new sub-issue #1047 fields populated so
 * the editor can rehydrate them. `defaultLogoPlacement: "top-left"` and
 * `showSlideNumbers: true` are non-default values, which lets us assert
 * round-trip behavior cleanly.
 */
const BRAND_KIT = {
  id: KIT_ID,
  name: "Branding E2E Kit",
  primaryColor: "#111111",
  secondaryColor: "#ffffff",
  accentColor: "#0066ff",
  fontHeading: "Inter",
  fontBody: "Inter",
  footerText: "Confidential",
  defaultLogoPlacement: "top-left" as const,
  showSlideNumbers: true,
  isStarter: false,
};

const REVEAL_FRAGMENT = `
  <!doctype html>
  <html><body>
    <div class="pitch-deck-wrap pitch-deck-wrap--embedded">
      <div class="reveal"><div class="slides">
        <section><h1>Branding epic walkthrough</h1></section>
      </div></div>
    </div>
  </body></html>
`.trim();

// ── Helpers ───────────────────────────────────────────────────────────

interface BaselineOptions {
  /** When true, kit list returns BRAND_KIT (with #1047 fields populated). */
  populated?: boolean;
}

/**
 * Install the hermetic baseline mocks for the deck editor. Layered tests
 * add specific `page.route()` handlers ON TOP for the routes whose
 * behavior they want to assert (Playwright applies the most-recent
 * matching handler first).
 */
async function mockDeckBaseline(page: Page, opts: BaselineOptions = {}) {
  const populated = opts.populated ?? true;

  await page.route("**/api/admin/pitch/brand-kits", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        brandKits: populated
          ? [BRAND_KIT]
          : [{ ...BRAND_KIT, defaultLogoPlacement: null, showSlideNumbers: false }],
      }),
    });
  });

  await page.route(`**/api/admin/pitch/decks/${DECK_ID}`, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DECK_PAYLOAD),
    });
  });

  await page.route(`**/api/admin/pitch/decks/${DECK_ID}/render**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: REVEAL_FRAGMENT,
    }),
  );

  // The editor's Share dialog mounts a GET on first render; respond
  // with an empty list so it doesn't 404-toast across the surface.
  await page.route(`**/api/admin/pitch/decks/${DECK_ID}/share`, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tokens: [] }),
    });
  });
}

/** Open the editor, click "Edit kit" to reveal the BrandKitEditor dialog. */
async function openBrandKitEditor(
  page: Page,
): Promise<{ editor: PitchEditorPage; dialog: BrandKitEditorDialog }> {
  const editor = new PitchEditorPage(page, DECK_ID);
  await editor.goto();
  await editor.editBrandKitButton.click();
  const dialog = new BrandKitEditorDialog(page);
  await expect(dialog.dialog).toBeVisible();
  return { editor, dialog };
}

// ── Tests ─────────────────────────────────────────────────────────────

test.describe("Epic #1045 — branding controls in the brand-kit editor (#1047)", () => {
  test.beforeEach(async ({ page }) => {
    await mockDeckBaseline(page);
  });

  // AC #1047.1: editor surfaces a "Default logo placement" select with the
  // 4 corners + "none" + the renderer-default blank option.
  test("exposes the Default logo placement select with all 5 placements + the renderer-default option", async ({
    page,
  }) => {
    const { dialog } = await openBrandKitEditor(page);

    await expect(dialog.defaultLogoPlacementSelect).toBeVisible();
    await expect(dialog.defaultLogoPlacementSelect).toBeEnabled();

    // Selecting each value must succeed (asserts every option exists in
    // the rendered <select>). `selectOption` rejects if the value is
    // missing, so this is a strict per-value assertion.
    for (const value of [
      "",
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
      "none",
    ] as const) {
      await dialog.defaultLogoPlacementSelect.selectOption(value);
      await expect(dialog.defaultLogoPlacementSelect).toHaveValue(value);
    }
  });

  // AC #1047.1: editor surfaces a "Show slide numbers" checkbox.
  test("exposes the Show slide numbers checkbox in the Branding panel", async ({
    page,
  }) => {
    const { dialog } = await openBrandKitEditor(page);

    await expect(dialog.showSlideNumbersCheckbox).toBeVisible();
    await expect(dialog.showSlideNumbersCheckbox).toBeEnabled();
    // The fixture kit has showSlideNumbers: true, so the checkbox should
    // rehydrate as checked.
    await expect(dialog.showSlideNumbersCheckbox).toBeChecked();
  });

  // AC #1047.1: rehydration of the persisted values when the dialog opens.
  test("rehydrates the new controls from the persisted brand kit on open", async ({
    page,
  }) => {
    const { dialog } = await openBrandKitEditor(page);

    // BRAND_KIT.defaultLogoPlacement === "top-left".
    await expect(dialog.defaultLogoPlacementSelect).toHaveValue("top-left");
    // BRAND_KIT.showSlideNumbers === true.
    await expect(dialog.showSlideNumbersCheckbox).toBeChecked();
  });

  // AC #1047.1 + AC #1047.4: PATCH /api/admin/pitch/brand-kits/:id
  // round-trips the two new fields.
  test("persists the new defaultLogoPlacement and showSlideNumbers via PATCH on Save", async ({
    page,
  }) => {
    let patchBody: Record<string, unknown> | null = null;
    await page.route(
      `**/api/admin/pitch/brand-kits/${KIT_ID}`,
      async (route: Route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        try {
          patchBody = JSON.parse(route.request().postData() ?? "{}");
        } catch {
          patchBody = {};
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKit: { ...BRAND_KIT, ...patchBody },
          }),
        });
      },
    );

    const { dialog } = await openBrandKitEditor(page);

    // Toggle to a different placement so we can verify the PATCH carries
    // the new value (not the rehydrated one).
    await dialog.defaultLogoPlacementSelect.selectOption("bottom-right");
    // Flip the checkbox off (rehydrated as true).
    await dialog.showSlideNumbersCheckbox.uncheck();

    await dialog.saveButton.click();

    await expect.poll(() => patchBody?.defaultLogoPlacement).toBe(
      "bottom-right",
    );
    await expect.poll(() => patchBody?.showSlideNumbers).toBe(false);
  });
});

test.describe("Epic #1045 — Apply / Copy from deck (#1048)", () => {
  test.beforeEach(async ({ page }) => {
    await mockDeckBaseline(page);
  });

  // AC #1048.1 + AC #1048.3: clicking "Apply" surfaces the confirm
  // prompt and (on accept) POSTs to /apply-brand-kit with the kit id.
  test("shows a confirmation prompt and POSTs to apply-brand-kit when Apply is clicked", async ({
    page,
  }) => {
    let applyBody: Record<string, unknown> | null = null;
    await page.route(
      `**/api/admin/pitch/decks/${DECK_ID}/apply-brand-kit`,
      async (route: Route) => {
        if (route.request().method() !== "POST") return route.continue();
        try {
          applyBody = JSON.parse(route.request().postData() ?? "{}");
        } catch {
          applyBody = {};
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ deck: DECK_PAYLOAD.deck }),
        });
      },
    );

    // The button uses native window.confirm; auto-accept it.
    let confirmMessage: string | null = null;
    page.on("dialog", (dialog) => {
      confirmMessage = dialog.message();
      void dialog.accept();
    });

    const editor = new PitchEditorPage(page, DECK_ID);
    await editor.goto();

    const picker = new BrandKitPicker(page);
    await expect(picker.applyToDeckButton).toBeVisible();
    await picker.applyToDeckButton.click();

    await expect.poll(() => confirmMessage).toMatch(
      /Apply ".*" to the deck/i,
    );
    await expect.poll(() => applyBody?.brandKitId).toBe(KIT_ID);
  });

  // AC #1048.4: cancelling the confirmation makes no changes (no POST fires).
  test("does not POST to apply-brand-kit when the confirmation is cancelled", async ({
    page,
  }) => {
    let applyPostCount = 0;
    await page.route(
      `**/api/admin/pitch/decks/${DECK_ID}/apply-brand-kit`,
      (route: Route) => {
        if (route.request().method() === "POST") applyPostCount += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        });
      },
    );

    page.on("dialog", (dialog) => {
      void dialog.dismiss();
    });

    const editor = new PitchEditorPage(page, DECK_ID);
    await editor.goto();

    const picker = new BrandKitPicker(page);
    await picker.applyToDeckButton.click();

    // Give the (non-)request a moment to be issued — but the click is
    // synchronous behind the confirm, so the count must remain zero.
    await expect.poll(() => applyPostCount).toBe(0);
  });

  // AC #1048.2 + AC #1048.3: clicking "Copy from deck" prompts for a
  // name and POSTs to /extract-brand-kit with that name.
  test("prompts for a kit name and POSTs to extract-brand-kit when Copy from deck is clicked", async ({
    page,
  }) => {
    const NEW_KIT_NAME = "Copied kit";
    let extractBody: Record<string, unknown> | null = null;
    await page.route(
      `**/api/admin/pitch/decks/${DECK_ID}/extract-brand-kit`,
      async (route: Route) => {
        if (route.request().method() !== "POST") return route.continue();
        try {
          extractBody = JSON.parse(route.request().postData() ?? "{}");
        } catch {
          extractBody = {};
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKit: { ...BRAND_KIT, id: "kit-new", name: NEW_KIT_NAME },
          }),
        });
      },
    );

    page.on("dialog", (dialog) => {
      void dialog.accept(NEW_KIT_NAME);
    });

    const editor = new PitchEditorPage(page, DECK_ID);
    await editor.goto();

    const picker = new BrandKitPicker(page);
    await expect(picker.copyFromDeckButton).toBeVisible();
    await picker.copyFromDeckButton.click();

    await expect.poll(() => extractBody?.name).toBe(NEW_KIT_NAME);
  });

  // AC #1048.2 (cancel guard): dismissing the prompt makes no changes.
  test("does not POST to extract-brand-kit when the prompt is cancelled", async ({
    page,
  }) => {
    let extractPostCount = 0;
    await page.route(
      `**/api/admin/pitch/decks/${DECK_ID}/extract-brand-kit`,
      (route: Route) => {
        if (route.request().method() === "POST") extractPostCount += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        });
      },
    );

    page.on("dialog", (dialog) => {
      void dialog.dismiss();
    });

    const editor = new PitchEditorPage(page, DECK_ID);
    await editor.goto();

    const picker = new BrandKitPicker(page);
    await picker.copyFromDeckButton.click();

    await expect.poll(() => extractPostCount).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Unmapped acceptance criteria — covered elsewhere or not applicable.
 *
 * The criteria below were intentionally NOT mapped to e2e tests because
 * the PR shipped them as schema / renderer / exporter / generator-prompt
 * changes with no corresponding new browser-visible UI surface. They are
 * exhaustively covered by the Vitest suites named in the PR body.
 *
 * #1046 — `pricing_table` + `big_number` templates
 *   AC1, AC2 (Zod schemas)        → src/pitch/pitch-schema-new-templates.test.ts
 *   AC3, AC4 (HTML rendering)     → src/pitch/pitch-renderer.test.ts
 *   AC5      (PPTX/PDF parity)    → src/pitch/pitch-export-pptx.test.ts
 *   AC6      (property editors)   → no editor UI shipped in this PR;
 *                                   tracked separately under epic follow-ups
 *
 * #1049 — `team_grid` + `logo_grid` templates
 *   AC1–AC5 — same disposition as #1046 (schema + renderer + exporter
 *             unit tests; no UI shipped for property editors).
 *   AC6      — no editor UI shipped in this PR.
 *
 * #1050 — Generator + wizard awareness of new templates
 *   AC1, AC2 (prompt + generator) → src/pitch/__snapshots__/pitch-prompts.test.ts.snap
 *                                   regenerated; src/pitch/pitch-generator.test.ts
 *   AC3      (wizard template picker) — NOT shipped: the new-deck wizard
 *             still relies on the LLM to pick templates from the source
 *             script; no add-slide-picker UI exists in
 *             `ui/components/pitch/`. Once a picker ships, an e2e test
 *             will assert all 20 template thumbnails render.
 *   AC4      (backward compat)    → src/pitch/pitch-schema.test.ts
 *
 * #1051 — Per-slide branding overrides
 *   AC1–AC5 — schema + renderer + exporter changes only; no
 *             property-panel UI for `branding.logoPlacement` /
 *             `branding.footerOverride` was added in this PR. Covered
 *             by src/pitch/pitch-renderer.test.ts and
 *             src/pitch/pitch-export-pptx.test.ts.
 *
 * #1052 — `roadmap` + `agenda` templates
 *   AC1–AC5 — same disposition as #1046.
 *   AC6     — no editor UI shipped in this PR.
 *
 * If a follow-up PR adds the missing property-editor UIs or a wizard
 * template picker, extend this suite with corresponding spec files
 * (e.g. `pitch-add-slide-picker.spec.ts`).
 * ──────────────────────────────────────────────────────────────────── */
