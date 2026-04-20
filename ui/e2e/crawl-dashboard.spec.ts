import { test, expect } from "./helpers";
import { CrawlDashboardPage } from "./pages/crawl-dashboard.page";

/**
 * E2E tests for the Firecrawl Crawl Dashboard (Epic #723, Issue #730).
 *
 * NOTE: These tests were written for the CrawlDashboardDialog when it was
 * mounted in the Workbench toolbar. The dialog has been removed from the
 * Workbench and its functionality consolidated into the /seo page
 * (see SEO Suite consolidation in Epic #838). The component file itself
 * is kept for potential future standalone use.
 *
 * TODO: Migrate these tests to target the /seo page mode-specific forms,
 * or re-enable if CrawlDashboardDialog is re-mounted elsewhere.
 */

test.describe
  .skip("Firecrawl Crawl Dashboard (#730) — SKIPPED: migrated to /seo", () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
  });

  // ── AC: Crawl dashboard accessible from workbench UI (button) ──

  test("should show Crawl button in workbench toolbar", async () => {
    await expect(cd.crawlButton).toBeVisible();
    await expect(cd.crawlButton).toHaveAttribute(
      "title",
      /Firecrawl Dashboard/,
    );
  });

  // ── AC: Dialog not rendered before opening ──

  test("should not show dialog content before opening", async () => {
    await expect(cd.dialogTitle).toBeHidden();
  });

  // ── AC: Dialog opens with title and description ──

  test("should open dialog with title and description", async () => {
    await cd.openDialog();

    await expect(cd.dialogTitle).toBeVisible();
    await expect(cd.dialogDescription).toBeVisible();
  });

  // ── AC: Three action modes: Site Audit, Ingest, Monitor ──

  test("should display all three action mode buttons", async () => {
    await cd.openDialog();

    await expect(cd.siteAuditButton).toBeVisible();
    await expect(cd.ingestButton).toBeVisible();
    await expect(cd.monitorButton).toBeVisible();
  });

  // ── AC: URL input visible with correct placeholder ──

  test("should show URL input with correct placeholder", async () => {
    await cd.openDialog();

    await expect(cd.urlInput).toBeVisible();
    await expect(cd.urlInput).toHaveAttribute(
      "placeholder",
      "https://example.com",
    );
  });

  // ── AC: Max pages and max depth controls visible in Site Audit mode ──

  test("should display max pages and max depth inputs", async () => {
    await cd.openDialog();

    await expect(cd.maxPagesInput).toBeVisible();
    await expect(cd.maxDepthInput).toBeVisible();
  });

  // ── AC: Max pages default values ──

  test("should have correct default values for crawl config", async () => {
    await cd.openDialog();

    await expect(cd.maxPagesInput).toHaveValue("50");
    await expect(cd.maxDepthInput).toHaveValue("3");
  });

  // ── AC: URL validation — rejects empty URL ──

  test("should show error when submitting with empty URL", async () => {
    await cd.openDialog();

    await cd.submit();

    await expect(cd.errorMessage).toBeVisible();
  });

  // ── AC: Cancel button closes dialog ──

  test("should close dialog when cancel is clicked", async () => {
    await cd.openDialog();
    await expect(cd.dialogTitle).toBeVisible();

    await cd.closeDialog();
    await expect(cd.dialogTitle).toBeHidden();
  });
});

test.describe.skip("Firecrawl Crawl Dashboard — Ingest mode (#730)", () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
    await cd.openDialog();
    await cd.selectIngest();
  });

  // ── AC: Submit button text changes per action ──

  test('should show "Start Ingestion" button text in Ingest mode', async () => {
    await expect(
      cd.page.getByRole("button", { name: "Start Ingestion" }),
    ).toBeVisible();
  });

  // ── AC: Ingest mode shows category and visibility selects ──

  test("should show category and visibility selects", async () => {
    await expect(cd.categorySelect).toBeVisible();
    await expect(cd.visibilitySelect).toBeVisible();
  });

  // ── AC: Category select has expected options ──

  test("should show category options", async () => {
    const options = cd.categorySelect.locator("option");
    await expect(options).toHaveCount(6);
    await expect(options.nth(0)).toHaveText("General");
    await expect(options.nth(1)).toHaveText("Document");
    await expect(options.nth(2)).toHaveText("Reference");
    await expect(options.nth(3)).toHaveText("Tutorial");
    await expect(options.nth(4)).toHaveText("API Docs");
    await expect(options.nth(5)).toHaveText("Blog");
  });

  // ── AC: Visibility select has expected options ──

  test("should show visibility options", async () => {
    const options = cd.visibilitySelect.locator("option");
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveText("Internal");
    await expect(options.nth(1)).toHaveText("Public");
  });

  // ── AC: Max pages and depth still visible in Ingest mode ──

  test("should still display crawl config inputs", async () => {
    await expect(cd.maxPagesInput).toBeVisible();
    await expect(cd.maxDepthInput).toBeVisible();
  });

  // ── AC: URL validation also works in Ingest mode ──

  test("should show error when submitting Ingest with empty URL", async () => {
    await cd.submit();
    await expect(cd.errorMessage).toBeVisible();
  });
});

test.describe.skip("Firecrawl Crawl Dashboard — Monitor mode (#730)", () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
    await cd.openDialog();
    await cd.selectMonitor();
  });

  // ── AC: Submit button text changes per action ──

  test('should show "Execute" button text in Monitor mode', async () => {
    await expect(
      cd.page.getByRole("button", { name: "Execute" }),
    ).toBeVisible();
  });

  // ── AC: Monitor mode shows action type selector ──

  test("should show monitor action selector", async () => {
    await expect(cd.monitorActionSelect).toBeVisible();
  });

  // ── AC: Monitor action select has expected options ──

  test("should show monitor action options", async () => {
    const options = cd.monitorActionSelect.locator("option");
    await expect(options).toHaveCount(4);
    await expect(options.nth(0)).toHaveText("Add Competitor");
    await expect(options.nth(1)).toHaveText("Take Snapshot");
    await expect(options.nth(2)).toHaveText("Generate Report");
    await expect(options.nth(3)).toHaveText("List Competitors");
  });

  // ── AC: Monitor "Add" action shows competitor name field ──

  test("should show competitor name field for Add action", async () => {
    // "Add Competitor" is the default monitor action
    await expect(cd.competitorNameInput).toBeVisible();
    await expect(cd.competitorNameInput).toHaveAttribute(
      "placeholder",
      "Friendly name",
    );
  });

  // ── AC: Max pages/depth hidden in Monitor mode ──

  test("should hide max pages and max depth in Monitor mode", async () => {
    await expect(cd.maxPagesInput).toBeHidden();
    await expect(cd.maxDepthInput).toBeHidden();
  });

  // ── AC: URL input still visible for non-list Monitor actions ──

  test("should show URL input for Add action", async () => {
    await expect(cd.urlInput).toBeVisible();
  });

  // ── AC: Monitor "List" action hides URL input ──

  test("should hide URL input when List Competitors is selected", async () => {
    await cd.monitorActionSelect.selectOption("list");
    await expect(cd.urlInput).toBeHidden();
  });

  // ── AC: URL validation for Monitor actions that require URL ──

  test("should show error when submitting Add without URL", async () => {
    await cd.submit();
    await expect(
      cd.page.getByText("URL is required for this action"),
    ).toBeVisible();
  });
});

test.describe.skip("Firecrawl Crawl Dashboard — action switching (#730)", () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
    await cd.openDialog();
  });

  // ── AC: Can switch between all three action modes ──

  test("should switch from Site Audit to Ingest and show correct fields", async () => {
    // Start in Site Audit (default) — verify button text
    await expect(
      cd.page.getByRole("button", { name: "Run Audit" }),
    ).toBeVisible();

    // Switch to Ingest
    await cd.selectIngest();
    await expect(
      cd.page.getByRole("button", { name: "Start Ingestion" }),
    ).toBeVisible();
    await expect(cd.categorySelect).toBeVisible();
  });

  test("should switch from Ingest to Monitor and show correct fields", async () => {
    await cd.selectIngest();
    await expect(cd.categorySelect).toBeVisible();

    // Switch to Monitor
    await cd.selectMonitor();
    await expect(cd.categorySelect).toBeHidden();
    await expect(cd.monitorActionSelect).toBeVisible();
  });

  test("should switch from Monitor back to Site Audit", async () => {
    await cd.selectMonitor();
    await expect(cd.monitorActionSelect).toBeVisible();

    // Switch back to Site Audit
    await cd.selectSiteAudit();
    await expect(cd.monitorActionSelect).toBeHidden();
    await expect(cd.maxPagesInput).toBeVisible();
    await expect(
      cd.page.getByRole("button", { name: "Run Audit" }),
    ).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  NEW TESTS — Epic #723 expanded features (PR #731)
// ═══════════════════════════════════════════════════════════════════════

/**
 * AC Coverage for new PR #731 tests:
 * | # | Criterion (from issue)                                        | Test(s)                                                      |
 * |---|---------------------------------------------------------------|--------------------------------------------------------------|
 * | 1 | #724: Firecrawl status shown in dialog                        | should indicate firecrawl configuration status               |
 * | 2 | #734.1: All 7 action modes visible                            | should display all seven action mode buttons                 |
 * | 3 | #734.2: Schema template picker with 5 options                 | should show template selector with correct options           |
 * | 4 | #734.3: Custom schema supports JSON editor + prompt           | should show JSON schema textarea for Custom template         |
 * | 5 | #734.3: Preset templates hide custom schema                   | should hide JSON schema for preset templates                 |
 * | 6 | #734.4: Actions checkboxes (scroll, wait)                     | should show scroll and wait checkboxes                       |
 * | 7 | #733: Extract submits with correct button                     | should show Extract Data submit button                       |
 * | 8 | #733: Extract prompt field present                            | should show extraction prompt textarea                       |
 * | 9 | #733: URL validation in Extract mode                          | should show error for empty URL in Extract mode              |
 * |10 | #734.6: Extraction history toggle                             | should toggle extraction history panel                       |
 * |11 | #734.6: History heading visible                               | should show extraction history heading                       |
 * |12 | #734: History back to extract form                            | should navigate back from history to extract form            |
 * |13 | #734: Empty state shown when no extractions                   | should show empty state or table in history                  |
 * |14 | Leads mode visible with correct button                        | should show Find Leads button in Leads mode                  |
 * |15 | Leads mode shows max pages/depth                              | should show max pages and depth in Leads mode                |
 * |16 | #736: Prices mode action selector                             | should show price action selector in Prices mode             |
 * |17 | #736: Price action options                                    | should show price monitor action options                     |
 * |18 | #736: Price snapshot shows label + scroll checkbox             | should show label and scroll checkbox for snapshot           |
 * |19 | #736: Price list hides URL                                    | should hide URL for list monitored URLs action               |
 * |20 | Dataset mode format selector                                  | should show dataset format selector in Dataset mode          |
 * |21 | Dataset format options                                        | should show Markdown, JSONL, CSV format options              |
 * |22 | Dataset include/exclude paths                                 | should show include and exclude path inputs                  |
 * |23 | Model selector present                                        | should show model selector label in dialog                   |
 * |24 | All 7 modes switchable                                        | should cycle through all seven action modes                  |
 */

test.describe.skip("Firecrawl Crawl Dashboard — all action modes (#723)", () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
    await cd.openDialog();
  });

  // AC #723: All 7 action modes are available in the dashboard

  test("should display all seven action mode buttons", async () => {
    await expect(cd.siteAuditButton).toBeVisible();
    await expect(cd.ingestButton).toBeVisible();
    await expect(cd.monitorButton).toBeVisible();
    await expect(cd.extractButton).toBeVisible();
    await expect(cd.leadsButton).toBeVisible();
    await expect(cd.pricesButton).toBeVisible();
    await expect(cd.datasetButton).toBeVisible();
  });

  // AC #724: Firecrawl connection status indication

  test("should indicate firecrawl configuration status", async () => {
    // The dialog checks firecrawl status on open.
    // If not configured, a banner appears; if configured, submit is enabled.
    const bannerCount = await cd.firecrawlStatusBanner.count();
    if (bannerCount > 0) {
      await expect(cd.firecrawlStatusBanner).toBeVisible();
      await expect(cd.page.getByText("docker compose")).toBeVisible();
    } else {
      await expect(cd.submitButton).toBeEnabled();
    }
  });

  // AC: Model selector is present in the dialog

  test("should show model selector label in dialog", async () => {
    await expect(cd.modelLabel).toBeVisible();
  });

  // AC: Can cycle through all seven action modes

  test("should cycle through all seven action modes", async () => {
    // Site Audit (default)
    await expect(
      cd.page.getByRole("button", { name: "Run Audit" }),
    ).toBeVisible();

    // Ingest
    await cd.selectIngest();
    await expect(
      cd.page.getByRole("button", { name: "Start Ingestion" }),
    ).toBeVisible();

    // Monitor
    await cd.selectMonitor();
    await expect(
      cd.page.getByRole("button", { name: "Execute" }),
    ).toBeVisible();

    // Extract
    await cd.selectExtract();
    await expect(
      cd.page.getByRole("button", { name: "Extract Data" }),
    ).toBeVisible();

    // Leads
    await cd.selectLeads();
    await expect(
      cd.page.getByRole("button", { name: "Find Leads" }),
    ).toBeVisible();

    // Prices
    await cd.selectPrices();
    await expect(
      cd.page.getByRole("button", { name: "Monitor Prices" }),
    ).toBeVisible();

    // Dataset
    await cd.selectDataset();
    await expect(
      cd.page.getByRole("button", { name: "Build Dataset" }),
    ).toBeVisible();
  });
});

test.describe.skip("Firecrawl Crawl Dashboard — Extract mode (#733, #734)", () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
    await cd.openDialog();
    await cd.selectExtract();
  });

  // AC #733: Extract Data button visible

  test("should show Extract Data submit button", async () => {
    await expect(
      cd.page.getByRole("button", { name: "Extract Data" }),
    ).toBeVisible();
  });

  // AC #734.2: Schema template picker with 5 options (Custom + 4 presets)

  test("should show template selector with correct options", async () => {
    await expect(cd.extractTemplateSelect).toBeVisible();

    const options = cd.extractTemplateSelect.locator("option");
    await expect(options).toHaveCount(5);
    await expect(options.nth(0)).toHaveText("Custom");
    await expect(options.nth(1)).toHaveText("Contacts");
    await expect(options.nth(2)).toHaveText("Pricing");
    await expect(options.nth(3)).toHaveText("Job Listings");
    await expect(options.nth(4)).toHaveText("Products");
  });

  // AC #733: Extraction prompt textarea present

  test("should show extraction prompt textarea", async () => {
    await expect(cd.extractPromptTextarea).toBeVisible();
    await expect(cd.extractPromptTextarea).toHaveAttribute(
      "placeholder",
      /all product names and prices/,
    );
  });

  // AC #734.3: Custom template shows JSON Schema textarea

  test("should show JSON schema textarea for Custom template", async () => {
    // Custom is default — schema field should be visible
    await expect(cd.extractSchemaTextarea).toBeVisible();
  });

  // AC #734.3: Preset templates hide custom schema field

  test("should hide JSON schema for preset templates", async () => {
    await cd.extractTemplateSelect.selectOption("contacts");
    await expect(cd.extractSchemaTextarea).toBeHidden();
  });

  // AC #734.4: Action checkboxes visible (scroll, wait)

  test("should show scroll and wait checkboxes", async () => {
    await expect(cd.scrollForContentCheckbox).toBeVisible();
    await expect(cd.waitForDynamicCheckbox).toBeVisible();
  });

  // AC: Checkboxes are unchecked by default

  test("should have checkboxes unchecked by default", async () => {
    await expect(cd.scrollForContentCheckbox).not.toBeChecked();
    await expect(cd.waitForDynamicCheckbox).not.toBeChecked();
  });

  // AC: Checkboxes are toggleable

  test("should toggle checkboxes on click", async () => {
    await cd.scrollForContentCheckbox.check();
    await expect(cd.scrollForContentCheckbox).toBeChecked();

    await cd.waitForDynamicCheckbox.check();
    await expect(cd.waitForDynamicCheckbox).toBeChecked();
  });

  // AC #733: URL validation in Extract mode

  test("should show error for empty URL in Extract mode", async () => {
    await cd.submit();
    await expect(cd.errorMessage).toBeVisible();
  });

  // AC #734: URL input remains visible in Extract mode

  test("should show URL input in Extract mode", async () => {
    await expect(cd.urlInput).toBeVisible();
  });

  // AC #734: Max pages/depth hidden in Extract mode (Extract only shows URL)

  test("should hide max pages and depth in Extract mode", async () => {
    await expect(cd.maxPagesInput).toBeHidden();
    await expect(cd.maxDepthInput).toBeHidden();
  });
});

test.describe.skip("Firecrawl Crawl Dashboard — Extraction History (#734)", () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
    await cd.openDialog();
    await cd.selectExtract();
  });

  // AC #734: History toggle shows extraction history panel

  test("should show history toggle button in Extract mode", async () => {
    await expect(cd.historyToggleButton).toBeVisible();
    await expect(cd.historyToggleButton).toContainText(
      "View extraction history",
    );
  });

  // AC #734.6: Toggle to extraction history panel

  test("should toggle extraction history panel", async () => {
    // Initially extract form is visible
    await expect(cd.extractTemplateSelect).toBeVisible();

    // Toggle to history
    await cd.toggleHistory();
    await expect(cd.extractionHistoryHeading).toBeVisible();
    // Extract form fields should be hidden
    await expect(cd.extractTemplateSelect).toBeHidden();
  });

  // AC #734: History heading visible with count

  test("should show extraction history heading", async () => {
    await cd.toggleHistory();
    await expect(cd.extractionHistoryHeading).toBeVisible();
  });

  // AC #734: Empty state or table shown depending on data

  test("should show empty state or table in extraction history", async () => {
    await cd.toggleHistory();

    // Either empty state message or table should be visible
    const emptyCount = await cd.emptyHistoryMessage.count();
    const tableCount = await cd.extractionTable.count();
    const hasContent = emptyCount > 0 || tableCount > 0;
    expect(hasContent).toBe(true);
  });

  // AC #734: Navigate back from history to extract form

  test("should navigate back from history to extract form", async () => {
    await cd.toggleHistory();
    await expect(cd.extractionHistoryHeading).toBeVisible();

    // Toggle back
    await cd.toggleHistory();
    await expect(cd.extractTemplateSelect).toBeVisible();
    await expect(cd.extractPromptTextarea).toBeVisible();
  });

  // AC #734: History toggle text changes based on state

  test("should update toggle button text based on view", async () => {
    await expect(cd.historyToggleButton).toContainText(
      "View extraction history",
    );

    await cd.toggleHistory();
    await expect(
      cd.page.getByRole("button", { name: "Back to extract" }),
    ).toBeVisible();
  });
});

test.describe.skip("Firecrawl Crawl Dashboard — Leads mode (#723)", () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
    await cd.openDialog();
    await cd.selectLeads();
  });

  // AC: Find Leads button visible in Leads mode

  test("should show Find Leads submit button", async () => {
    await expect(
      cd.page.getByRole("button", { name: "Find Leads" }),
    ).toBeVisible();
  });

  // AC: Max pages and depth visible in Leads mode

  test("should show max pages and depth in Leads mode", async () => {
    await expect(cd.maxPagesInput).toBeVisible();
    await expect(cd.maxDepthInput).toBeVisible();
  });

  // AC: URL input visible in Leads mode

  test("should show URL input in Leads mode", async () => {
    await expect(cd.urlInput).toBeVisible();
  });

  // AC: URL validation in Leads mode

  test("should show error when submitting Leads with empty URL", async () => {
    await cd.submit();
    await expect(cd.errorMessage).toBeVisible();
  });
});

test.describe.skip("Firecrawl Crawl Dashboard — Prices mode (#736)", () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
    await cd.openDialog();
    await cd.selectPrices();
  });

  // AC #736: Monitor Prices button visible

  test("should show Monitor Prices submit button", async () => {
    await expect(
      cd.page.getByRole("button", { name: "Monitor Prices" }),
    ).toBeVisible();
  });

  // AC #736: Price action selector visible

  test("should show price action selector", async () => {
    await expect(cd.priceActionSelect).toBeVisible();
  });

  // AC #736: Price action options

  test("should show price monitor action options", async () => {
    const options = cd.priceActionSelect.locator("option");
    await expect(options).toHaveCount(4);
    await expect(options.nth(0)).toHaveText("Capture Snapshot");
    await expect(options.nth(1)).toHaveText("Compare Snapshots");
    await expect(options.nth(2)).toHaveText("View History");
    await expect(options.nth(3)).toHaveText("List Monitored URLs");
  });

  // AC #736: Snapshot action shows label input and scroll checkbox

  test("should show label and scroll checkbox for snapshot action", async () => {
    // Snapshot is the default action
    await expect(cd.priceLabelInput).toBeVisible();
    await expect(cd.priceLabelInput).toHaveAttribute(
      "placeholder",
      "e.g. Competitor Pro Plan",
    );
    await expect(cd.scrollToLoadCheckbox).toBeVisible();
  });

  // AC #736: URL visible for snapshot action

  test("should show URL input for snapshot action", async () => {
    await expect(cd.urlInput).toBeVisible();
  });

  // AC #736: List action hides URL input

  test("should hide URL for list monitored URLs action", async () => {
    await cd.priceActionSelect.selectOption("list");
    await expect(cd.urlInput).toBeHidden();
  });

  // AC #736: Label and scroll hidden for non-snapshot actions

  test("should hide label and scroll for compare action", async () => {
    await cd.priceActionSelect.selectOption("compare");
    await expect(cd.priceLabelInput).toBeHidden();
    await expect(cd.scrollToLoadCheckbox).toBeHidden();
  });

  // AC: Max pages and depth hidden in Prices mode

  test("should hide max pages and depth in Prices mode", async () => {
    await expect(cd.maxPagesInput).toBeHidden();
    await expect(cd.maxDepthInput).toBeHidden();
  });
});

test.describe.skip("Firecrawl Crawl Dashboard — Dataset mode (#723)", () => {
  let cd: CrawlDashboardPage;

  test.beforeEach(async ({ page }) => {
    cd = new CrawlDashboardPage(page);
    await cd.goto();
    await cd.openDialog();
    await cd.selectDataset();
  });

  // AC: Build Dataset button visible

  test("should show Build Dataset submit button", async () => {
    await expect(
      cd.page.getByRole("button", { name: "Build Dataset" }),
    ).toBeVisible();
  });

  // AC: Output format selector visible with correct options

  test("should show dataset format selector with options", async () => {
    await expect(cd.datasetFormatSelect).toBeVisible();

    const options = cd.datasetFormatSelect.locator("option");
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toHaveText("Markdown");
    await expect(options.nth(1)).toHaveText("JSONL");
    await expect(options.nth(2)).toHaveText("CSV");
  });

  // AC: Include and exclude path inputs visible

  test("should show include and exclude path inputs", async () => {
    await expect(cd.includePathsInput).toBeVisible();
    await expect(cd.includePathsInput).toHaveAttribute(
      "placeholder",
      "/docs, /blog",
    );
    await expect(cd.excludePathsInput).toBeVisible();
    await expect(cd.excludePathsInput).toHaveAttribute(
      "placeholder",
      "/admin, /login",
    );
  });

  // AC: Max pages and depth visible in Dataset mode

  test("should show max pages and depth in Dataset mode", async () => {
    await expect(cd.maxPagesInput).toBeVisible();
    await expect(cd.maxDepthInput).toBeVisible();
  });

  // AC: URL input visible

  test("should show URL input in Dataset mode", async () => {
    await expect(cd.urlInput).toBeVisible();
  });

  // AC: URL validation in Dataset mode

  test("should show error when submitting Dataset with empty URL", async () => {
    await cd.submit();
    await expect(cd.errorMessage).toBeVisible();
  });
});
