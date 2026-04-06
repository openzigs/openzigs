import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the Brand Template Editor.
 * #827 — Video Brand Templates
 */
export class BrandTemplatePage {
  readonly page: Page;
  readonly editor: Locator;

  // Section headers
  readonly introsSection: Locator;
  readonly outrosSection: Locator;
  readonly lowerThirdsSection: Locator;

  // Add form
  readonly customTitleInput: Locator;
  readonly autoApplyCheckbox: Locator;
  readonly addTemplateButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.editor = page.getByTestId("brand-template-editor");
    this.introsSection = page.getByText("Intros");
    this.outrosSection = page.getByText("Outros");
    this.lowerThirdsSection = page.getByText("Lower Thirds");
    this.customTitleInput = page.getByPlaceholder("Custom title (optional)");
    this.autoApplyCheckbox = page.getByLabel(/Auto-apply/i);
    this.addTemplateButton = page.getByRole("button", {
      name: /Add to Brand Kit/i,
    });
  }

  getTemplateCard(templateId: string) {
    return this.page.getByTestId(`template-card-${templateId}`);
  }

  async selectTemplate(templateId: string) {
    await this.getTemplateCard(templateId).click();
  }

  async setCustomTitle(title: string) {
    await this.customTitleInput.fill(title);
  }

  async addTemplate() {
    await this.addTemplateButton.click();
  }
}
