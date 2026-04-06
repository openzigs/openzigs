import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the NLE Export Panel.
 * #826 — NLE Export
 */
export class NLEExportPage {
  readonly page: Page;
  readonly heading: Locator;

  // Format picker
  readonly fcpxmlOption: Locator;
  readonly edlOption: Locator;

  // Action
  readonly exportButton: Locator;
  readonly loadingIndicator: Locator;

  // Result
  readonly exportResult: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByText("NLE Export");
    this.fcpxmlOption = page.getByText("FCP XML");
    this.edlOption = page.getByText("EDL");
    this.exportButton = page.getByRole("button", { name: /Export/i });
    this.loadingIndicator = page.getByText("Exporting...");
    this.exportResult = page.getByText(/Exported as/i);
  }

  async selectFormat(format: "fcpxml" | "edl") {
    if (format === "fcpxml") {
      await this.fcpxmlOption.click();
    } else {
      await this.edlOption.click();
    }
  }

  async doExport() {
    await this.exportButton.click();
  }
}
