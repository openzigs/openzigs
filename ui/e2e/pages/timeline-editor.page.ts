import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the Timeline Editor (ruler + toolbar).
 * #824 — Enhanced Timeline Editor
 */
export class TimelineEditorPage {
  readonly page: Page;

  // Toolbar
  readonly toolbar: Locator;
  readonly undoButton: Locator;
  readonly redoButton: Locator;
  readonly splitButton: Locator;
  readonly snapButton: Locator;
  readonly zoomInButton: Locator;
  readonly zoomOutButton: Locator;
  readonly zoomLevel: Locator;

  // Ruler (canvas)
  readonly rulerCanvas: Locator;

  constructor(page: Page) {
    this.page = page;
    this.toolbar = page.getByTestId("timeline-toolbar");
    this.undoButton = page.getByTestId("timeline-undo");
    this.redoButton = page.getByTestId("timeline-redo");
    this.splitButton = page.getByTestId("timeline-split");
    this.snapButton = page.getByTestId("timeline-snap");
    this.zoomInButton = page.getByTestId("timeline-zoom-in");
    this.zoomOutButton = page.getByTestId("timeline-zoom-out");
    this.zoomLevel = page.getByTestId("timeline-zoom-level");
    this.rulerCanvas = page.locator("canvas");
  }

  async undo() {
    await this.undoButton.click();
  }

  async redo() {
    await this.redoButton.click();
  }

  async splitAtPlayhead() {
    await this.splitButton.click();
  }

  async toggleSnap() {
    await this.snapButton.click();
  }

  async zoomIn() {
    await this.zoomInButton.click();
  }

  async zoomOut() {
    await this.zoomOutButton.click();
  }
}
