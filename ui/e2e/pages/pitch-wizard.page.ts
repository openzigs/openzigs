import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the New Pitch Deck wizard — `/pitch/new`.
 *
 * The wizard is a 3-step flow (Brand kit → Script → Options). The
 * acceptance criteria for Epic #990 / sub-issue #998 only require us to
 * verify the *Options* step, but we expose helpers for the prior steps so
 * a test can drive an end-to-end happy path.
 */
export class PitchWizardPage {
  readonly page: Page;

  readonly root: Locator;
  readonly stepKit: Locator;
  readonly stepScript: Locator;
  readonly stepOptions: Locator;

  readonly nextButton: Locator;
  readonly backButton: Locator;
  readonly generateButton: Locator;

  readonly scriptTextarea: Locator;
  readonly scriptBytesLabel: Locator;

  // Sub-issue #998 — Image style preset selector lives on the Options step.
  readonly imageStyleSelect: Locator;

  readonly tone: Locator;
  readonly audience: Locator;

  constructor(page: Page) {
    this.page = page;

    this.root = page.getByTestId("new-deck-wizard");
    this.stepKit = page.getByTestId("wizard-step-kit");
    this.stepScript = page.getByTestId("wizard-step-script");
    this.stepOptions = page.getByTestId("wizard-step-options");

    this.nextButton = page.getByTestId("wizard-next");
    this.backButton = page.getByTestId("wizard-back");
    this.generateButton = page.getByTestId("wizard-generate");

    this.scriptTextarea = page.getByTestId("wizard-script-textarea");
    this.scriptBytesLabel = page.getByTestId("wizard-script-bytes");

    this.imageStyleSelect = page.getByTestId("wizard-image-style");

    this.tone = page.getByTestId("wizard-tone");
    this.audience = page.getByTestId("wizard-audience");
  }

  async goto() {
    await this.page.goto("/pitch/new", { waitUntil: "domcontentloaded" });
    await this.root.waitFor({ state: "visible", timeout: 15_000 });
  }

  /** Click a brand kit tile by id (rendered as `wizard-kit-{id}`). */
  async pickBrandKit(brandKitId: string) {
    await this.page.getByTestId(`wizard-kit-${brandKitId}`).click();
  }

  async fillScript(text: string) {
    await this.scriptTextarea.fill(text);
  }

  async pickImageStyle(value: string) {
    // Native <select> — Playwright's selectOption handles the value.
    await this.imageStyleSelect.selectOption(value);
  }
}

export default PitchWizardPage;
