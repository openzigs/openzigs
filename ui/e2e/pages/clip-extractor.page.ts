import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the Clip Extractor Panel in Director Studio.
 * #821 — Intelligent Video Clipping
 */
export class ClipExtractorPage {
  readonly page: Page;

  // Panel header
  readonly heading: Locator;

  // Configuration inputs
  readonly promptInput: Locator;
  readonly clipCountInput: Locator;
  readonly styleSelect: Locator;
  readonly minDurationInput: Locator;
  readonly maxDurationInput: Locator;

  // Actions
  readonly extractButton: Locator;

  // Results
  readonly clipList: Locator;
  readonly loadingIndicator: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByText("AI Clip Extraction");
    this.promptInput = page.getByPlaceholder(
      "Describe what clips to extract (optional)...",
    );
    this.clipCountInput = page.getByLabel("Clips");
    this.styleSelect = page.getByLabel("Style");
    this.minDurationInput = page.getByLabel("Min Duration (s)");
    this.maxDurationInput = page.getByLabel("Max Duration (s)");
    this.extractButton = page.getByRole("button", { name: /Extract Clips/i });
    this.clipList = page.locator("[class*='rounded-lg border']");
    this.loadingIndicator = page.getByText("Analyzing...");
  }

  async setPrompt(text: string) {
    await this.promptInput.fill(text);
  }

  async setClipCount(count: number) {
    await this.clipCountInput.fill(String(count));
  }

  async selectStyle(style: "Highlights" | "Reactions" | "Summary" | "Teaser") {
    await this.styleSelect.selectOption({ label: style });
  }

  async setMinDuration(seconds: number) {
    await this.minDurationInput.fill(String(seconds));
  }

  async setMaxDuration(seconds: number) {
    await this.maxDurationInput.fill(String(seconds));
  }

  async extract() {
    await this.extractButton.click();
  }

  getClipCard(index: number) {
    return this.page
      .locator("[class*='rounded-lg border border-border p-2.5']")
      .nth(index);
  }

  getViralityScore(clipCard: Locator) {
    return clipCard.locator("[class*='text-xs font-medium']").last();
  }

  getHookBadge(clipCard: Locator) {
    return clipCard.getByText("Hook");
  }

  getFoundClipsText() {
    return this.page.getByText(/Found \d+ clips/);
  }
}
