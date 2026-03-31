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

  // -- Action mode buttons (7 total) --
  readonly siteAuditButton: Locator;
  readonly ingestButton: Locator;
  readonly monitorButton: Locator;
  readonly extractButton: Locator;
  readonly leadsButton: Locator;
  readonly pricesButton: Locator;
  readonly datasetButton: Locator;

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

  // -- Extract-specific fields (#733, #734) --
  readonly extractTemplateSelect: Locator;
  readonly extractPromptTextarea: Locator;
  readonly extractSchemaTextarea: Locator;
  readonly scrollForContentCheckbox: Locator;
  readonly waitForDynamicCheckbox: Locator;
  readonly historyToggleButton: Locator;

  // -- Extraction history (#734) --
  readonly extractionHistoryHeading: Locator;
  readonly exportCsvButton: Locator;
  readonly exportJsonButton: Locator;
  readonly backToListButton: Locator;
  readonly emptyHistoryMessage: Locator;
  readonly extractionTable: Locator;

  // -- Price monitor fields (#736) --
  readonly priceActionSelect: Locator;
  readonly priceLabelInput: Locator;
  readonly scrollToLoadCheckbox: Locator;

  // -- Site-to-dataset fields --
  readonly datasetFormatSelect: Locator;
  readonly includePathsInput: Locator;
  readonly excludePathsInput: Locator;

  // -- Model selector --
  readonly modelLabel: Locator;

  // -- Firecrawl status (#724) --
  readonly firecrawlStatusBanner: Locator;

  // -- Error display --
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;

    // Toolbar button
    this.crawlButton = page.getByRole('button', { name: 'Crawl' });

    // Dialog elements
    this.dialogTitle = page.getByRole('heading', { name: 'Firecrawl Dashboard' });
    this.dialogDescription = page.getByText('Crawl websites for SEO audits, data extraction, price monitoring, and more.');
    this.cancelButton = page.getByRole('button', { name: 'Cancel' });
    this.submitButton = page.getByRole('button', { name: /Run Audit|Start Ingestion|Execute|Extract Data|Find Leads|Monitor Prices|Build Dataset/ });

    // Action mode buttons
    this.siteAuditButton = page.getByRole('button', { name: 'Site Audit' });
    this.ingestButton = page.getByRole('button', { name: 'Ingest' });
    this.monitorButton = page.getByRole('button', { name: 'Monitor' });
    this.extractButton = page.getByRole('button', { name: 'Extract' });
    this.leadsButton = page.getByRole('button', { name: 'Leads' });
    this.pricesButton = page.getByRole('button', { name: 'Prices' });
    this.datasetButton = page.getByRole('button', { name: 'Dataset' });

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

    // Extract-specific
    this.extractTemplateSelect = page.getByLabel('Template');
    this.extractPromptTextarea = page.getByLabel('What to extract');
    this.extractSchemaTextarea = page.getByLabel('JSON Schema (optional)');
    this.scrollForContentCheckbox = page.getByLabel('Scroll to load all content');
    this.waitForDynamicCheckbox = page.getByLabel('Wait for dynamic content');
    this.historyToggleButton = page.getByRole('button', { name: /View extraction history|Back to extract/ });

    // Extraction history
    this.extractionHistoryHeading = page.getByText(/Extraction History/);
    this.exportCsvButton = page.getByRole('button', { name: 'Export CSV' });
    this.exportJsonButton = page.getByRole('button', { name: 'Export JSON' });
    this.backToListButton = page.getByRole('button', { name: 'Back to list' });
    this.emptyHistoryMessage = page.getByText('No extractions yet');
    this.extractionTable = page.locator('table');

    // Price monitor
    this.priceActionSelect = page.getByLabel('Action');
    this.priceLabelInput = page.getByLabel('Label (optional)');
    this.scrollToLoadCheckbox = page.getByLabel('Scroll to load dynamic content');

    // Site-to-dataset
    this.datasetFormatSelect = page.getByLabel('Output Format');
    this.includePathsInput = page.getByLabel('Include paths (comma-separated)');
    this.excludePathsInput = page.getByLabel('Exclude paths (comma-separated)');

    // Model selector
    this.modelLabel = page.getByText('Model', { exact: true });

    // Firecrawl status
    this.firecrawlStatusBanner = page.getByText('Firecrawl is not configured');

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

  async selectExtract() {
    await this.extractButton.click();
  }

  async selectLeads() {
    await this.leadsButton.click();
  }

  async selectPrices() {
    await this.pricesButton.click();
  }

  async selectDataset() {
    await this.datasetButton.click();
  }

  async toggleHistory() {
    await this.historyToggleButton.click();
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
