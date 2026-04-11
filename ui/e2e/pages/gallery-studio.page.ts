import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for Gallery Studio — Talking Head / Lip Sync controls.
 * Issue #803 — Gallery Studio UI for lip-sync controls and multi-stage pipeline progress.
 */
export class GalleryStudioPage {
  readonly page: Page;

  // -- Gallery page --
  readonly createAssetButton: Locator;
  readonly studioHeading: Locator;

  // -- Mode Selector --
  readonly talkingHeadModeButton: Locator;

  // -- Talking Head Inputs --
  readonly speechTextInput: Locator;
  readonly voiceSelect: Locator;
  readonly videoPromptInput: Locator;

  // -- Lip Sync Settings Panel --
  readonly lipSyncSettingsHeading: Locator;
  readonly sidecarConnectedBadge: Locator;
  readonly sidecarNotDetectedBadge: Locator;
  readonly modelVersionSelect: Locator;
  readonly inferenceStepsSlider: Locator;
  readonly guidanceScaleSlider: Locator;
  readonly deepCacheCheckbox: Locator;
  readonly sidecarDegradationWarning: Locator;

  // -- Submit --
  readonly submitButton: Locator;
  readonly pipelineSummary: Locator;

  // -- Pipeline Progress (queue panel) --
  readonly queuePanel: Locator;

  constructor(page: Page) {
    this.page = page;

    // Gallery page — "Create Asset" button opens Studio
    this.createAssetButton = page.getByRole("button", {
      name: /Create Asset/i,
    });
    this.studioHeading = page.getByRole("heading", { name: "Gallery Studio" });

    // Mode buttons — Talking Head identified by label text
    this.talkingHeadModeButton = page.getByRole("button", {
      name: /Talking Head/i,
    });

    // Talking Head form controls
    this.speechTextInput = page.getByPlaceholder(
      "Type the words the character should speak...",
    );
    this.voiceSelect = page.getByLabel("Voice");
    this.videoPromptInput = page.getByPlaceholder(
      "A person speaking in a studio...",
    );

    // Lip Sync Settings panel
    this.lipSyncSettingsHeading = page.getByText("Lip Sync Settings");
    this.sidecarConnectedBadge = page.getByText("Connected");
    this.sidecarNotDetectedBadge = page.getByText("Sidecar not detected");
    this.modelVersionSelect = page.getByLabel("Model Version");
    this.inferenceStepsSlider = page
      .locator("label")
      .filter({ hasText: "Inference Steps" })
      .locator("..")
      .getByRole("slider");
    this.guidanceScaleSlider = page
      .locator("label")
      .filter({ hasText: "Guidance Scale" })
      .locator("..")
      .getByRole("slider");
    this.deepCacheCheckbox = page.getByRole("checkbox", { name: "DeepCache" });
    this.sidecarDegradationWarning = page.getByText(
      "Video will be generated without lip sync",
    );

    // Submit area
    this.submitButton = page.getByRole("button", { name: "Submit to Queue" });
    this.pipelineSummary = page.getByText(/Talking Head ·/);

    // Queue progress panel
    this.queuePanel = page.getByText(/Queue \(\d+ active\)/);
  }

  async goto() {
    await this.page.goto("/gallery");
    await this.page.waitForLoadState("domcontentloaded");
  }

  async openStudio() {
    await this.createAssetButton.click();
    await this.studioHeading.waitFor({ state: "visible", timeout: 10_000 });
  }

  async selectTalkingHeadMode() {
    await this.talkingHeadModeButton.click();
  }

  async fillSpeechText(text: string) {
    await this.speechTextInput.fill(text);
  }

  async selectVoice(voiceId: string) {
    await this.voiceSelect.selectOption(voiceId);
  }

  async fillVideoPrompt(prompt: string) {
    await this.videoPromptInput.fill(prompt);
  }

  async selectModelVersion(version: "v1.6" | "v1.5") {
    await this.modelVersionSelect.selectOption(version);
  }

  async submit() {
    await this.submitButton.click();
  }
}
