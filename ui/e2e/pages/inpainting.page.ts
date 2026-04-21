import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the Inpainting Studio — Character LoRA injection (#868 / #871).
 *
 * Covers the character picker, prompt textarea, model selector, file upload,
 * and Generate button surfaces that the epic introduces.
 */
export class InpaintingPage {
  readonly page: Page;

  // Header
  readonly heading: Locator;

  // Source image upload
  readonly uploadLabel: Locator;
  readonly uploadInput: Locator;

  // Generation settings
  readonly promptTextarea: Locator;
  readonly artStyleSelect: Locator;
  readonly characterSelect: Locator;
  readonly characterLoadingText: Locator;
  readonly characterErrorText: Locator;
  readonly characterEmptyText: Locator;
  readonly characterKontextWarning: Locator;

  // Model picker buttons
  readonly fluxKontextButton: Locator;
  readonly fluxDevButton: Locator;
  readonly fluxSchnellButton: Locator;
  readonly zImageTurboButton: Locator;

  // Generate
  readonly generateButton: Locator;

  constructor(page: Page) {
    this.page = page;

    this.heading = page.getByRole("heading", { name: "Inpainting Studio" });

    this.uploadLabel = page.getByText("Upload Image", { exact: true });
    // The file <input type="file"> is visually hidden behind the Upload label.
    // setInputFiles works on hidden inputs, so locate it by attributes.
    this.uploadInput = page.locator('input[type="file"][accept^="image/"]');

    this.promptTextarea = page.locator("textarea");
    this.artStyleSelect = page.getByLabel("Art Style");
    this.characterSelect = page.getByLabel("Character", { exact: false });
    this.characterLoadingText = page.getByText("Loading characters…");
    this.characterErrorText = page.getByText("Failed to load characters.");
    this.characterEmptyText = page.getByText(
      "No trained characters yet — train one in the Character Library to inject it into edits.",
    );
    this.characterKontextWarning = page.getByText(
      "(not available with Flux Kontext)",
    );

    this.fluxKontextButton = page.getByRole("button", { name: /Flux Kontext/i });
    this.fluxDevButton = page.getByRole("button", { name: /^Flux Dev/i });
    this.fluxSchnellButton = page.getByRole("button", { name: /Flux Schnell/i });
    this.zImageTurboButton = page.getByRole("button", { name: /Z-Image Turbo/i });

    this.generateButton = page.getByRole("button", { name: /Generate/ });
  }

  async goto() {
    await this.page.goto("/inpainting", { waitUntil: "domcontentloaded" });
    await this.heading.waitFor({ state: "visible", timeout: 15_000 });
  }

  /** Upload a tiny in-memory PNG so the Generate button becomes enabled. */
  async uploadSampleImage() {
    // 1x1 transparent PNG
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );
    await this.uploadInput.setInputFiles({
      name: "sample.png",
      mimeType: "image/png",
      buffer: pngBuffer,
    });
  }

  async selectCharacter(characterId: string) {
    await this.characterSelect.selectOption(characterId);
  }

  async selectCharacterByLabel(label: string | RegExp) {
    await this.characterSelect.selectOption({ label });
  }

  async setPrompt(value: string) {
    await this.promptTextarea.fill(value);
  }

  async selectModel(model: "flux-kontext" | "flux-dev" | "flux-schnell" | "z-image-turbo") {
    const map: Record<typeof model, Locator> = {
      "flux-kontext": this.fluxKontextButton,
      "flux-dev": this.fluxDevButton,
      "flux-schnell": this.fluxSchnellButton,
      "z-image-turbo": this.zImageTurboButton,
    };
    await map[model].click();
  }

  async submit() {
    await this.generateButton.click();
  }
}
