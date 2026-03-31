import type { Page, Locator } from '@playwright/test';

/**
 * Page Object for the Firecrawl Crawl Dashboard dialog.
 * Encapsulates locators and interactions for the CrawlDashboardDialog
 * component added in Epic #723 (Firecrawl Self-Hosted Integration).
 */
export class CrawlDashboardPage {
  readonly page: Page;

  // -- Toolbar trigger --
  readonly crawlButton: Locator;

  // -- Dialog chrome --
  readonly dialogTitle: Locator;
  readonly dialogDescription: Locator;
  readonly cancelButton: Locator;
  readonly submitButton: Locator;

  // -- Action mode buttons --
  readonly siteAuditButton: Locator;
  readonly ingestButton: Locator;
  readonly monitorButton: Locator;

  // -- URL input --
  readonly urlInput: Locator;

  // -- Crawl config inputs --
  readonly maxPagesInput: Locator;
  readonly maxDepthInput: Locator;

  // -- Ingest-specific fields --
  readonly categorySelect: Locator;
  readonly visibilitySelect: Locator;

  // -- Monitor-specific fields --
  readonly monitorActionSelect: Locator;
  readonly competitorNameInput: Locator;

  // -- Error display --
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;

    // Toolbar button
    this.crawlButton = page.getByRole('button', { name: 'Crawl' });

    // Dialog elements
    this.dialogTitle = page.getByRole('heading', { name: 'Firecrawl Dashboard' });
    this.dialogDescription = page.getByText('Crawl websites for SEO audits, knowledge ingestion, or competitive monitoring.');
    this.cancelButton = page.getByRole('button', { name: 'Cancel' });
    this.submitButton = page.getByRole('button', { name: /Run Audit|Start Ingestion|Execute/ });

    // Action mode buttons
    this.siteAuditButton = page.getByRole('button', { name: 'Site Audit' });
    this.ingestButton = page.getByRole('button', { name: 'Ingest' });
    this.monitorButton = page.getByRole('button', { name: 'Monitor' });

    // Form fields
    this.urlInput = page.getByLabel('Website URL');
    this.maxPagesInput = page.getByLabel('Max Pages');
    this.maxDepthInput = page.getByLabel('Max Depth');

    // Ingest-specific
    this.categorySelect = page.getByLabel('Category');
    this.visibilitySelect = page.getByLabel('Visibility');

    // Monitor-specific
    this.monitorActionSelect = page.getByLabel('Action');
    this.competitorNameInput = page.getByLabel('Name (optional)');

    // Error
    this.errorMessage = page.getByText('URL is required');
  }

  async goto() {
    await this.page.goto('/workbench');
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
  }

  async openDialog() {
    await this.crawlButton.click();
    await this.dialogTitle.waitFor({ state: 'visible', timeout: 5_000 });
  }

  async selectSiteAudit() {
    await this.siteAuditButton.click();
  }

  async selectIngest() {
    await this.ingestButton.click();
  }

  async selectMonitor() {
    await this.monitorButton.click();
  }

  async fillUrl(url: string) {
    await this.urlInput.fill(url);
  }

  async fillMaxPages(value: string) {
    await this.maxPagesInput.fill(value);
  }

  async fillMaxDepth(value: string) {
    await this.maxDepthInput.fill(value);
  }

  async submit() {
    await this.submitButton.click();
  }

  async closeDialog() {
    await this.cancelButton.click();
  }
}
