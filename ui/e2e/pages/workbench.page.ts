import type { Page, Locator } from '@playwright/test';

/**
 * Page Object for /workbench — Workbench page.
 * Encapsulates locators and interactions for the workbench,
 * including the SEO Gap Analysis dialog added in Epic #647.
 */
export class WorkbenchPage {
  readonly page: Page;

  // -- Toolbar --
  readonly seoButton: Locator;
  readonly researchButton: Locator;
  readonly importButton: Locator;
  readonly saveButton: Locator;

  // -- SEO Dialog --
  readonly seoDialogTitle: Locator;
  readonly seoDialogDescription: Locator;
  readonly targetUrlInput: Locator;
  readonly targetKeywordInput: Locator;
  readonly searchProviderSelect: Locator;
  readonly analyzeButton: Locator;
  readonly cancelButton: Locator;
  readonly validationError: Locator;

  // -- Sidebar --
  readonly sidebar: Locator;

  constructor(page: Page) {
    this.page = page;

    // Toolbar buttons identified by accessible text
    this.seoButton = page.getByRole('button', { name: 'SEO' });
    this.researchButton = page.getByRole('button', { name: 'Research' });
    this.importButton = page.getByRole('button', { name: 'Import' });
    this.saveButton = page.getByRole('button', { name: /Save|Saving/ });

    // SEO Dialog elements using accessible labels
    this.seoDialogTitle = page.getByRole('heading', { name: 'SEO Gap Analysis' });
    this.seoDialogDescription = page.getByText('Analyze your page against top-ranking competitors');
    this.targetUrlInput = page.getByLabel(/Target URL/);
    this.targetKeywordInput = page.getByLabel(/Target Keyword/);
    this.searchProviderSelect = page.getByLabel(/Search Provider/);
    this.analyzeButton = page.getByRole('button', { name: 'Analyze' });
    this.cancelButton = page.getByRole('button', { name: 'Cancel' });
    this.validationError = page.locator('[class*="destructive"]').locator('span');

    // Sidebar
    this.sidebar = page.locator('aside').first();
  }

  async goto() {
    await this.page.goto('/workbench');
    await this.page.waitForLoadState('domcontentloaded');
    // Wait for the workbench editor area to be present
    await this.page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
  }

  async openSeoDialog() {
    await this.seoButton.click();
    await this.seoDialogTitle.waitFor({ state: 'visible', timeout: 5_000 });
  }

  async fillTargetUrl(url: string) {
    await this.targetUrlInput.fill(url);
  }

  async fillTargetKeyword(keyword: string) {
    await this.targetKeywordInput.fill(keyword);
  }

  async selectSearchProvider(value: string) {
    await this.searchProviderSelect.selectOption(value);
  }

  async submitAnalysis() {
    await this.analyzeButton.click();
  }

  async closeSeoDialog() {
    await this.cancelButton.click();
  }
}
