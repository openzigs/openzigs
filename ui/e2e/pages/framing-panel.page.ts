import { expect, type Page, type Locator } from "@playwright/test";

/**
 * Page Object for the Director Studio Framing Panel and its
 * embedded Reframe Preview / Subject Overlay (Epic #910 — Issue #834).
 *
 * The panel is rendered inside the Scene Inspector when a clip is selected
 * on the Director Studio page (`/director/studio/[id]`).
 */
export class FramingPanelPage {
  readonly page: Page;

  // Panel header / controls
  readonly panelHeading: Locator;
  readonly resetButton: Locator;
  readonly fitButton: Locator;
  readonly cropButton: Locator;
  readonly offsetSlider: Locator;

  // Reframe preview (rendered only when sourceVideoUrl prop is wired)
  readonly reframePreview: Locator;
  readonly sourceVideo: Locator;
  readonly reframedVideo: Locator;
  readonly subjectOverlay: Locator;
  readonly playButton: Locator;
  readonly pauseButton: Locator;

  constructor(page: Page) {
    this.page = page;

    this.panelHeading = page.getByText("9:16 Framing");
    this.resetButton = page.getByRole("button", { name: /Reset/i }).first();
    this.fitButton = page.getByRole("button", { name: /Fit \(Blur BG\)/i });
    this.cropButton = page.getByRole("button", { name: /^Crop$/i });
    this.offsetSlider = page.locator('input[type="range"]').first();

    this.reframePreview = page.getByTestId("reframe-preview");
    this.sourceVideo = page.getByTestId("reframe-source-video");
    this.reframedVideo = page.getByTestId("reframe-reframed-video");
    this.subjectOverlay = page.getByTestId("subject-overlay");
    this.playButton = page.getByRole("button", { name: "Play preview" });
    this.pauseButton = page.getByRole("button", { name: "Pause preview" });
  }

  async gotoStudio(draftId = "test-draft") {
    await this.page.goto(`/director/studio/${encodeURIComponent(draftId)}`, {
      waitUntil: "domcontentloaded",
    });
    await this.page
      .locator("main")
      .waitFor({ state: "visible", timeout: 15_000 });
  }

  async expectPanelVisible() {
    await expect(this.panelHeading).toBeVisible();
  }
}
