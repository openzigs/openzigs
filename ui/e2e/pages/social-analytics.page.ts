import type { Page, Locator } from '@playwright/test';

/**
 * Page Object for /social (Analytics tab) — Social Analytics Dashboard.
 * Covers the analytics tab with charts, summary cards, filters, and CSV export.
 */
export class SocialAnalyticsPage {
  readonly page: Page;

  // ── Tab navigation ──────────────────────────────────────────────
  readonly analyticsTab: Locator;

  // ── Header / Filters ────────────────────────────────────────────
  readonly heading: Locator;
  readonly sinceInput: Locator;
  readonly untilInput: Locator;
  readonly platformSelect: Locator;
  readonly clearFiltersButton: Locator;
  readonly exportCsvButton: Locator;

  // ── Summary Cards ───────────────────────────────────────────────
  readonly totalMessagesCard: Locator;
  readonly inboundCard: Locator;
  readonly outboundCard: Locator;
  readonly automationRateCard: Locator;

  // ── Charts ──────────────────────────────────────────────────────
  readonly barChartSection: Locator;
  readonly pieChartSection: Locator;

  // ── Platform Breakdown Table ────────────────────────────────────
  readonly breakdownTable: Locator;
  readonly breakdownRows: Locator;

  // ── Loading / Empty States ──────────────────────────────────────
  readonly loadingText: Locator;
  readonly emptyState: Locator;

  constructor(page: Page) {
    this.page = page;

    // Tab
    this.analyticsTab = page.getByRole('button', { name: 'analytics' });

    // Analytics heading
    this.heading = page.getByRole('heading', { name: 'Conversation Analytics' });

    // Date filters
    this.sinceInput = page.locator('input[type="date"]').first();
    this.untilInput = page.locator('input[type="date"]').nth(1);
    this.platformSelect = page.getByRole('combobox').or(page.locator('select')).first();
    this.clearFiltersButton = page.getByRole('button', { name: 'Clear' });
    this.exportCsvButton = page.getByRole('button', { name: 'Export CSV' });

    // Summary cards
    this.totalMessagesCard = page.getByText('Total Messages');
    this.inboundCard = page.getByText('Inbound');
    this.outboundCard = page.getByText('Outbound');
    this.automationRateCard = page.getByText('Automation Rate');

    // Charts
    this.barChartSection = page.getByText('Messages by Platform');
    this.pieChartSection = page.getByText('Platform Distribution');

    // Breakdown table
    this.breakdownTable = page.locator('table');
    this.breakdownRows = page.locator('table tbody tr');

    // States
    this.loadingText = page.getByText('Loading analytics...');
    this.emptyState = page.getByText('No analytics data yet');
  }

  async goto() {
    await this.page.goto('/social');
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
  }

  async switchToAnalyticsTab() {
    await this.analyticsTab.click();
    // Wait for the analytics heading or loading state
    await this.heading.or(this.loadingText).or(this.emptyState).waitFor({ state: 'visible', timeout: 10_000 });
  }

  async setSinceDate(date: string) {
    await this.sinceInput.fill(date);
  }

  async setUntilDate(date: string) {
    await this.untilInput.fill(date);
  }

  async selectPlatform(platform: string) {
    await this.platformSelect.selectOption(platform);
  }

  async clearFilters() {
    await this.clearFiltersButton.click();
  }

  async exportCsv() {
    await this.exportCsvButton.click();
  }

  /** Get all summary card values */
  getSummaryCardValues() {
    return {
      totalMessages: this.totalMessagesCard.locator('..').getByRole('paragraph').first(),
      inbound: this.inboundCard.locator('..').getByRole('paragraph').first(),
      outbound: this.outboundCard.locator('..').getByRole('paragraph').first(),
      automationRate: this.automationRateCard.locator('..').getByRole('paragraph').first(),
    };
  }

  /** Get table column headers */
  getTableHeaders() {
    return this.page.locator('table thead th');
  }
}
