import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the Audio Cleaner Panel.
 * #820 — Filler Word & Pause Removal
 */
export class AudioCleanerPage {
  readonly page: Page;
  readonly heading: Locator;

  // Toggle controls
  readonly removeFillerCheckbox: Locator;
  readonly trimSilenceCheckbox: Locator;
  readonly enhanceSpeechCheckbox: Locator;
  readonly noiseReductionCheckbox: Locator;

  // Aggressiveness selector
  readonly aggressivenessSelect: Locator;

  // Action button
  readonly cleanButton: Locator;
  readonly loadingIndicator: Locator;

  // Result panel
  readonly resultPanel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByText("Audio Cleaner");
    this.removeFillerCheckbox = page
      .getByText("Remove filler words")
      .locator("..")
      .getByRole("checkbox");
    this.trimSilenceCheckbox = page
      .getByText("Trim silence")
      .locator("..")
      .getByRole("checkbox");
    this.enhanceSpeechCheckbox = page
      .getByText("Enhance speech")
      .locator("..")
      .getByRole("checkbox");
    this.noiseReductionCheckbox = page
      .getByText("Noise reduction")
      .locator("..")
      .getByRole("checkbox");
    this.aggressivenessSelect = page.getByLabel("Aggressiveness");
    this.cleanButton = page.getByRole("button", { name: /Clean Audio/i });
    this.loadingIndicator = page.getByText("Cleaning...");
    this.resultPanel = page.getByText("Audio Cleaned");
  }

  async selectAggressiveness(level: "gentle" | "moderate" | "aggressive") {
    const labels: Record<string, string> = {
      gentle: "Gentle (only um, uh, er)",
      moderate: "Moderate (+ like, you know, I mean)",
      aggressive: "Aggressive (+ basically, actually, sort of)",
    };
    await this.aggressivenessSelect.selectOption({ label: labels[level] });
  }

  async clean() {
    await this.cleanButton.click();
  }
}
