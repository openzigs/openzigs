import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the BrandKitPicker (`ui/components/pitch/brand-kit-picker.tsx`)
 * as it appears in the deck-editor toolbar.
 *
 * Wraps the buttons shipped in PR #1044 / sub-issue #1048:
 *
 *   - "Apply" — applies the selected kit to the open deck and clears
 *     per-slide overrides (window.confirm guard).
 *   - "Copy from deck" — clones the deck's current effective kit into a
 *     new custom brand kit (window.prompt for the name).
 *
 * Plus the pre-existing Edit / + New buttons (already covered by the
 * Pitch Pro epic suite) which we re-expose for navigation convenience.
 */
export class BrandKitPicker {
  readonly page: Page;
  readonly root: Locator;
  readonly select: Locator;
  readonly editKitButton: Locator;
  readonly newKitButton: Locator;
  readonly applyToDeckButton: Locator;
  readonly copyFromDeckButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("pitch-brand-kit-picker");
    this.select = page.getByLabel("Brand kit");
    this.editKitButton = page.getByRole("button", { name: "Edit kit" });
    this.newKitButton = page.getByRole("button", { name: "+ New" });
    // Sub-issue #1048 — Apply / Copy buttons (testids on production DOM).
    this.applyToDeckButton = page.getByTestId("pitch-brand-kit-apply-to-deck");
    this.copyFromDeckButton = page.getByTestId(
      "pitch-brand-kit-copy-from-deck",
    );
  }
}

export default BrandKitPicker;
