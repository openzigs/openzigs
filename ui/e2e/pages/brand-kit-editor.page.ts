import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the BrandKitEditor dialog (`ui/components/pitch/brand-kit-editor.tsx`).
 *
 * Reached by clicking "Edit kit" or "+ New" in the BrandKitPicker
 * (which lives in the deck-editor toolbar). Wraps the new controls
 * shipped in PR #1044 / sub-issue #1047:
 *
 *   - "Default logo placement" `<select>` (5 options + the renderer-default
 *     blank value).
 *   - "Show slide numbers" `<input type="checkbox">`.
 *
 * Locators prefer accessible queries (`getByRole`, `getByLabel`) and only
 * fall back to the `data-testid` attributes that already exist in the
 * production component when no accessible name is exposed.
 */
export class BrandKitEditorDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly nameInput: Locator;
  readonly footerInput: Locator;
  readonly defaultLogoPlacementSelect: Locator;
  readonly showSlideNumbersCheckbox: Locator;
  readonly saveButton: Locator;
  readonly closeButton: Locator;
  readonly starterNotice: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByRole("dialog", {
      name: /Edit brand kit|New brand kit|Starter brand kit/,
    });
    this.nameInput = page.getByTestId("pitch-bk-name");
    this.footerInput = page.getByTestId("pitch-bk-footer");
    // Sub-issue #1047 — the new branding controls.
    this.defaultLogoPlacementSelect = page.getByTestId(
      "pitch-bk-default-logo-placement",
    );
    this.showSlideNumbersCheckbox = page.getByTestId(
      "pitch-bk-show-slide-numbers",
    );
    this.saveButton = page.getByTestId("pitch-bk-save");
    this.closeButton = this.dialog.getByRole("button", { name: "Close" });
    this.starterNotice = page.getByTestId("pitch-brand-kit-starter-notice");
  }
}

export default BrandKitEditorDialog;
