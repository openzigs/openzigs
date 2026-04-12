import { expect, type Page, type Locator } from "@playwright/test";

/**
 * Page Object for the SEO Suite Dashboard (/seo).
 * Epic #838 — SEO Suite Enhancement.
 */
export class SeoDashboardPage {
  readonly page: Page;

  // -- Page heading --
  readonly heading: Locator;
  readonly description: Locator;

  // -- Tab navigation --
  readonly overviewTab: Locator;
  readonly historyTab: Locator;
  readonly exportTab: Locator;

  // -- Overview tab: Site Health Score --
  readonly healthScoreSection: Locator;
  readonly healthScoreHeading: Locator;
  readonly noAuditDataMessage: Locator;

  // -- Overview tab: Recent Trends --
  readonly recentTrendsSection: Locator;
  readonly recentTrendsHeading: Locator;

  // -- Overview tab: Latest Audit Details --
  readonly latestAuditHeading: Locator;
  readonly pagesAuditedStat: Locator;
  readonly totalIssuesStat: Locator;
  readonly criticalStat: Locator;
  readonly highStat: Locator;

  // -- Comparison (shown in Recent Trends on Overview tab) --
  readonly comparisonHeading: Locator;
  readonly scoreChangeLabel: Locator;
  readonly newIssuesLabel: Locator;
  readonly resolvedLabel: Locator;
  readonly auditHistoryHeading: Locator;
  readonly noHistoryMessage: Locator;

  // -- Export tab --
  readonly auditSelect: Locator;
  readonly exportHeading: Locator;
  readonly csvButton: Locator;
  readonly jsonButton: Locator;
  readonly pdfButton: Locator;
  readonly selectAuditMessage: Locator;
  readonly noAuditsMessage: Locator;

  // -- Crawl Progress Panel --
  readonly activeCrawlsHeading: Locator;

  constructor(page: Page) {
    this.page = page;

    // Page header
    this.heading = page.getByRole("heading", { name: "SEO Suite" });
    this.description = page.getByText(
      "Monitor site health, track audit history, and export reports.",
    );

    // Tab triggers
    this.overviewTab = page.getByRole("tab", { name: /Overview/i });
    this.historyTab = page.getByRole("tab", { name: /History/i });
    this.exportTab = page.getByRole("tab", { name: /Export/i });

    // Health Score section (scoped to the card containing the heading)
    this.healthScoreSection = page
      .locator(".rounded-xl")
      .filter({ hasText: "Health Score" })
      .first();
    this.healthScoreHeading = page.getByText("Health Score").first();
    this.noAuditDataMessage = page.getByText("No audit data yet");

    // Recent Trends section (scoped to the card)
    this.recentTrendsSection = page
      .locator(".rounded-xl")
      .filter({ hasText: "Recent Trends" });
    this.recentTrendsHeading = page.getByText("Recent Trends");

    // Latest Audit Details
    this.latestAuditHeading = page.getByText("Latest Audit Details");
    this.pagesAuditedStat = page.getByText("Pages Audited");
    this.totalIssuesStat = page.getByText("Total Issues");
    this.criticalStat = page.getByText("Critical", { exact: true });
    this.highStat = page.getByText("High", { exact: true });

    // Comparison — visible in the Recent Trends section on Overview tab
    this.comparisonHeading = page.getByText("Latest vs Previous");
    this.scoreChangeLabel = page.getByText("Score Change");
    this.newIssuesLabel = page.getByText("New Issues");
    this.resolvedLabel = page.getByText("Resolved", { exact: true });
    this.auditHistoryHeading = page.getByRole("heading", {
      name: "Audit History",
    });
    this.noHistoryMessage = page.getByText("No audit history yet");

    // Export tab
    this.auditSelect = page.locator("select");
    this.exportHeading = page.getByText("Export Audit Report");
    this.csvButton = page.getByRole("button", { name: /CSV/i });
    this.jsonButton = page.getByRole("button", { name: /JSON/i });
    this.pdfButton = page.getByRole("button", { name: /PDF/i });
    this.selectAuditMessage = page.getByText("Select an audit to export");
    this.noAuditsMessage = page.getByText("No audits available to export");

    // Crawl Progress
    this.activeCrawlsHeading = page.getByText("Active Crawls");
  }

  async goto() {
    await this.page.goto("/seo", { waitUntil: "load" });
    await this.page
      .locator("main")
      .waitFor({ state: "visible", timeout: 15_000 });
    // Wait for React hydration — tab must be interactive
    await expect(this.overviewTab).toBeVisible({ timeout: 10_000 });
  }

  async switchToTab(tab: "overview" | "history" | "export") {
    const tabLocator =
      tab === "overview"
        ? this.overviewTab
        : tab === "history"
          ? this.historyTab
          : this.exportTab;
    await tabLocator.click();
    await expect(tabLocator).toHaveAttribute("data-state", "active");
  }

  /** Get the SVG ring circle inside the health score gauge. */
  healthScoreRing(): Locator {
    return this.healthScoreSection.locator("svg circle").nth(1);
  }
}
