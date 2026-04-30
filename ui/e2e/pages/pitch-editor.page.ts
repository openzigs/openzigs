import type { Page, Locator, FrameLocator } from "@playwright/test";

/**
 * Page Object for the Pitch deck editor — `/pitch/[deckId]`.
 *
 * Encapsulates the toolbar (Generate-all images, Present, Export
 * dropdown, Share), the slide rail (status badges, thumbnails,
 * Regenerate-image action), the properties panel (Title-template
 * Regenerate background button), and the embedded Reveal preview iframe.
 *
 * All locators use accessible roles or `data-testid` attributes that are
 * already present in the production components (no test-only DOM).
 *
 * Used by `pitch-pro-epic-990.spec.ts` to verify the user-facing
 * acceptance criteria of Epic #990 (sub-issues #991–#998).
 */
export class PitchEditorPage {
  readonly page: Page;
  readonly deckId: string;

  // Toolbar
  readonly shell: Locator;
  readonly topbar: Locator;
  readonly generateAllImagesButton: Locator;
  readonly presentButton: Locator;
  readonly exportTrigger: Locator;
  readonly exportHtmlItem: Locator;
  readonly exportPdfItem: Locator;
  readonly exportPptxItem: Locator;
  readonly exportMdItem: Locator;
  readonly exportNotesItem: Locator;
  readonly exportZipItem: Locator;

  // Slide rail
  readonly slideRail: Locator;

  // Properties panel
  readonly propertiesPanel: Locator;
  readonly propertiesTemplateLabel: Locator;
  readonly titleRegenBackgroundButton: Locator;
  readonly fullBleedRegenButton: Locator;

  // Regenerate-image dialog (shared by title + image_caption + full_bleed)
  readonly regenImageDialog: Locator;
  readonly regenImagePromptTextarea: Locator;
  readonly regenImageSubmit: Locator;

  // Embedded preview (Reveal.js inside an iframe)
  readonly canvas: Locator;

  constructor(page: Page, deckId: string) {
    this.page = page;
    this.deckId = deckId;

    this.shell = page.getByTestId("pitch-editor-shell");
    this.topbar = page.getByTestId("pitch-editor-topbar");

    // Sub-issue #991
    this.generateAllImagesButton = page.getByTestId(
      "pitch-editor-generate-all-images",
    );
    // Sub-issue #992 / #999
    this.presentButton = page.getByTestId("pitch-editor-present");
    // Sub-issue #993 — Export dropdown (HTML item is the new addition)
    this.exportTrigger = page.getByTestId("pitch-editor-export");
    this.exportHtmlItem = page.getByTestId("pitch-editor-export-html");
    this.exportPdfItem = page.getByTestId("pitch-editor-export-pdf");
    this.exportPptxItem = page.getByTestId("pitch-editor-export-pptx");
    this.exportMdItem = page.getByTestId("pitch-editor-export-md");
    this.exportNotesItem = page.getByTestId("pitch-editor-export-notes");
    this.exportZipItem = page.getByTestId("pitch-editor-export-zip");

    this.slideRail = page.getByTestId("slide-rail");

    this.propertiesPanel = page.getByTestId("pitch-properties-panel");
    this.propertiesTemplateLabel = page.getByTestId(
      "pitch-properties-template-label",
    );
    this.titleRegenBackgroundButton = page.getByTestId("prop-title-regen-bg");
    this.fullBleedRegenButton = page.getByTestId("prop-fb-regen");

    this.regenImageDialog = page.getByTestId("pitch-regen-image-dialog");
    this.regenImagePromptTextarea = page.getByTestId(
      "pitch-regen-image-prompt",
    );
    this.regenImageSubmit = page.getByTestId("pitch-regen-image-submit");

    this.canvas = page.getByTestId("pitch-editor-canvas");
  }

  /** Navigate to the deck editor and wait for the toolbar to render. */
  async goto() {
    await this.page.goto(`/pitch/${this.deckId}`, {
      waitUntil: "domcontentloaded",
    });
    await this.shell.waitFor({ state: "visible", timeout: 15_000 });
  }

  /** Locator for an individual slide rail row. */
  rowFor(slideId: string): Locator {
    return this.page.getByTestId(`slide-rail-row-${slideId}`);
  }

  /** Locator for a slide rail row's image-status badge by 1-based slide index. */
  imageStatusBadgeFor(slideIndex: number): Locator {
    return this.page.getByTestId(`slide-rail-image-status-${slideIndex}`);
  }

  /** Locator for a slide rail row's thumbnail wrapper. */
  thumbnailFor(slideId: string): Locator {
    return this.page.getByTestId(`slide-rail-thumbnail-${slideId}`);
  }

  /** Open the per-slide actions dropdown and click "Regenerate text". */
  async regenerateTextFor(slideId: string) {
    await this.page.getByTestId(`slide-rail-actions-${slideId}`).click();
    await this.page
      .getByTestId(`slide-rail-regenerate-${slideId}`)
      .click();
  }

  /** Open the Export dropdown — caller picks the desired item. */
  async openExportMenu() {
    await this.exportTrigger.click();
  }

  /** Embedded Reveal.js preview frame (iframe inside the canvas). */
  revealFrame(): FrameLocator {
    return this.page
      .getByTestId("pitch-editor-canvas")
      .frameLocator("iframe");
  }

  /** Click a slide rail row to make it the selected slide. */
  async selectSlide(slideId: string) {
    await this.rowFor(slideId).click();
  }
}

export default PitchEditorPage;
