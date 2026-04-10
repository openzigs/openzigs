import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the B-Roll Suggestions Panel.
 * #822 — Auto B-Roll Insertion Pipeline
 */
export class BRollPanelPage {
  readonly page: Page;
  readonly heading: Locator;

  // Config
  readonly densitySelect: Locator;

  // Actions
  readonly analyzeButton: Locator;
  readonly loadingIndicator: Locator;

  // Results
  readonly insertionPointsText: Locator;
  readonly acceptedCountText: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByText("Auto B-Roll");
    this.densitySelect = page.getByLabel("Density");
    this.analyzeButton = page.getByRole("button", {
      name: /Find B-Roll Points/i,
    });
    this.loadingIndicator = page.getByText("Analyzing...");
    this.insertionPointsText = page.getByText(/\d+ insertion points/);
    this.acceptedCountText = page.getByText(/\d+ accepted/);
  }

  async selectDensity(density: "sparse" | "moderate" | "dense") {
    const labels: Record<string, string> = {
      sparse: "Sparse (every ~2 min)",
      moderate: "Moderate (every ~1 min)",
      dense: "Dense (every ~30s)",
    };
    await this.densitySelect.selectOption({ label: labels[density] });
  }

  async analyze() {
    await this.analyzeButton.click();
  }

  getSuggestionCard(index: number) {
    return this.page
      .locator("[class*='rounded-lg border']")
      .filter({ has: this.page.locator("[class*='Search']") })
      .nth(index);
  }

  async toggleSuggestion(index: number) {
    const card = this.page
      .locator("button[class*='rounded-lg border']")
      .nth(index);
    await card.click();
  }
}
