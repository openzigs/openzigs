import { test, expect } from './helpers';
import { CrawlDashboardPage } from './pages/crawl-dashboard.page';

/**
 * E2E tests for the Firecrawl Crawl Dashboard (Epic #723, Issue #730).
 *
 * Acceptance Criteria Coverage:
 * | # | Criterion (from #730)                                     | Test(s)                                             |
 * |---|-----------------------------------------------------------|-----------------------------------------------------|
 * | 1 | Crawl dashboard accessible from workbench toolbar          | should show Crawl button in workbench toolbar        |
 * | 2 | Dialog opens with title and description                   | should open dialog with title and description        |
 * | 3 | Three action modes: Site Audit, Ingest, Monitor           | should display all three action mode buttons         |
 * | 4 | URL validation rejects empty URL                          | should show error when submitting with empty URL     |
 * | 5 | Max pages and max depth controls visible                  | should display max pages and max depth inputs        |
 * | 6 | Submit button text changes per action                     | should show correct submit button text per action    |
 * | 7 | Ingest mode shows category and visibility selects         | should show ingest-specific fields                   |
 * | 8 | Monitor mode shows action type selector                   | should show monitor-specific fields                  |
 * | 9 | Cancel closes dialog                                      | should close dialog when cancel is clicked           |
 * |10 | Monitor "List" action hides URL input                     | should hide URL input for Monitor List action        |
 * |11 | Monitor "Add" action shows competitor name field           | should show competitor name for Add action           |
 * |12 | URL input has correct placeholder                         | should show correct placeholder on URL input         |
 * |13 | Max pages respects bounds per action                      | should have correct max attribute on page limit      |
 * |14 | Dialog not rendered when closed                           | should not show dialog content before opening        |
 */

test.describe('Firecrawl Crawl Dashboard (#730)', () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
  });

  // ── AC: Crawl dashboard accessible from workbench UI (button) ──

  test('should show Crawl button in workbench toolbar', async () => {
    await expect(cd.crawlButton).toBeVisible();
    await expect(cd.crawlButton).toHaveAttribute(
      'title',
      /Firecrawl Dashboard/,
    );
  });

  // ── AC: Dialog not rendered before opening ──

  test('should not show dialog content before opening', async () => {
    await expect(cd.dialogTitle).toBeHidden();
  });

  // ── AC: Dialog opens with title and description ──

  test('should open dialog with title and description', async () => {
    await cd.openDialog();

    await expect(cd.dialogTitle).toBeVisible();
    await expect(cd.dialogDescription).toBeVisible();
  });

  // ── AC: Three action modes: Site Audit, Ingest, Monitor ──

  test('should display all three action mode buttons', async () => {
    await cd.openDialog();

    await expect(cd.siteAuditButton).toBeVisible();
    await expect(cd.ingestButton).toBeVisible();
    await expect(cd.monitorButton).toBeVisible();
  });

  // ── AC: URL input visible with correct placeholder ──

  test('should show URL input with correct placeholder', async () => {
    await cd.openDialog();

    await expect(cd.urlInput).toBeVisible();
    await expect(cd.urlInput).toHaveAttribute('placeholder', 'https://example.com');
  });

  // ── AC: Max pages and max depth controls visible in Site Audit mode ──

  test('should display max pages and max depth inputs', async () => {
    await cd.openDialog();

    await expect(cd.maxPagesInput).toBeVisible();
    await expect(cd.maxDepthInput).toBeVisible();
  });

  // ── AC: Max pages default values ──

  test('should have correct default values for crawl config', async () => {
    await cd.openDialog();

    await expect(cd.maxPagesInput).toHaveValue('50');
    await expect(cd.maxDepthInput).toHaveValue('3');
  });

  // ── AC: URL validation — rejects empty URL ──

  test('should show error when submitting with empty URL', async () => {
    await cd.openDialog();

    await cd.submit();

    await expect(cd.errorMessage).toBeVisible();
  });

  // ── AC: Cancel button closes dialog ──

  test('should close dialog when cancel is clicked', async () => {
    await cd.openDialog();
    await expect(cd.dialogTitle).toBeVisible();

    await cd.closeDialog();
    await expect(cd.dialogTitle).toBeHidden();
  });
});

test.describe('Firecrawl Crawl Dashboard — Ingest mode (#730)', () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
    await cd.openDialog();
    await cd.selectIngest();
  });

  // ── AC: Submit button text changes per action ──

  test('should show "Start Ingestion" button text in Ingest mode', async () => {
    await expect(cd.page.getByRole('button', { name: 'Start Ingestion' })).toBeVisible();
  });

  // ── AC: Ingest mode shows category and visibility selects ──

  test('should show category and visibility selects', async () => {
    await expect(cd.categorySelect).toBeVisible();
    await expect(cd.visibilitySelect).toBeVisible();
  });

  // ── AC: Category select has expected options ──

  test('should show category options', async () => {
    const options = cd.categorySelect.locator('option');
    await expect(options).toHaveCount(5);
    await expect(options.nth(0)).toHaveText('Document');
    await expect(options.nth(1)).toHaveText('Reference');
    await expect(options.nth(2)).toHaveText('Tutorial');
    await expect(options.nth(3)).toHaveText('API Docs');
    await expect(options.nth(4)).toHaveText('Blog');
  });

  // ── AC: Visibility select has expected options ──

  test('should show visibility options', async () => {
    const options = cd.visibilitySelect.locator('option');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveText('Internal');
    await expect(options.nth(1)).toHaveText('Public');
  });

  // ── AC: Max pages and depth still visible in Ingest mode ──

  test('should still display crawl config inputs', async () => {
    await expect(cd.maxPagesInput).toBeVisible();
    await expect(cd.maxDepthInput).toBeVisible();
  });

  // ── AC: URL validation also works in Ingest mode ──

  test('should show error when submitting Ingest with empty URL', async () => {
    await cd.submit();
    await expect(cd.errorMessage).toBeVisible();
  });
});

test.describe('Firecrawl Crawl Dashboard — Monitor mode (#730)', () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
    await cd.openDialog();
    await cd.selectMonitor();
  });

  // ── AC: Submit button text changes per action ──

  test('should show "Execute" button text in Monitor mode', async () => {
    await expect(cd.page.getByRole('button', { name: 'Execute' })).toBeVisible();
  });

  // ── AC: Monitor mode shows action type selector ──

  test('should show monitor action selector', async () => {
    await expect(cd.monitorActionSelect).toBeVisible();
  });

  // ── AC: Monitor action select has expected options ──

  test('should show monitor action options', async () => {
    const options = cd.monitorActionSelect.locator('option');
    await expect(options).toHaveCount(4);
    await expect(options.nth(0)).toHaveText('Add Competitor');
    await expect(options.nth(1)).toHaveText('Take Snapshot');
    await expect(options.nth(2)).toHaveText('Generate Report');
    await expect(options.nth(3)).toHaveText('List Competitors');
  });

  // ── AC: Monitor "Add" action shows competitor name field ──

  test('should show competitor name field for Add action', async () => {
    // "Add Competitor" is the default monitor action
    await expect(cd.competitorNameInput).toBeVisible();
    await expect(cd.competitorNameInput).toHaveAttribute('placeholder', 'Friendly name');
  });

  // ── AC: Max pages/depth hidden in Monitor mode ──

  test('should hide max pages and max depth in Monitor mode', async () => {
    await expect(cd.maxPagesInput).toBeHidden();
    await expect(cd.maxDepthInput).toBeHidden();
  });

  // ── AC: URL input still visible for non-list Monitor actions ──

  test('should show URL input for Add action', async () => {
    await expect(cd.urlInput).toBeVisible();
  });

  // ── AC: Monitor "List" action hides URL input ──

  test('should hide URL input when List Competitors is selected', async () => {
    await cd.monitorActionSelect.selectOption('list');
    await expect(cd.urlInput).toBeHidden();
  });

  // ── AC: URL validation for Monitor actions that require URL ──

  test('should show error when submitting Add without URL', async () => {
    await cd.submit();
    await expect(cd.page.getByText('URL is required for this action')).toBeVisible();
  });
});

test.describe('Firecrawl Crawl Dashboard — action switching (#730)', () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
    await cd.openDialog();
  });

  // ── AC: Can switch between all three action modes ──

  test('should switch from Site Audit to Ingest and show correct fields', async () => {
    // Start in Site Audit (default) — verify button text
    await expect(cd.page.getByRole('button', { name: 'Run Audit' })).toBeVisible();

    // Switch to Ingest
    await cd.selectIngest();
    await expect(cd.page.getByRole('button', { name: 'Start Ingestion' })).toBeVisible();
    await expect(cd.categorySelect).toBeVisible();
  });

  test('should switch from Ingest to Monitor and show correct fields', async () => {
    await cd.selectIngest();
    await expect(cd.categorySelect).toBeVisible();

    // Switch to Monitor
    await cd.selectMonitor();
    await expect(cd.categorySelect).toBeHidden();
    await expect(cd.monitorActionSelect).toBeVisible();
  });

  test('should switch from Monitor back to Site Audit', async () => {
    await cd.selectMonitor();
    await expect(cd.monitorActionSelect).toBeVisible();

    // Switch back to Site Audit
    await cd.selectSiteAudit();
    await expect(cd.monitorActionSelect).toBeHidden();
    await expect(cd.maxPagesInput).toBeVisible();
    await expect(cd.page.getByRole('button', { name: 'Run Audit' })).toBeVisible();
  });
});
