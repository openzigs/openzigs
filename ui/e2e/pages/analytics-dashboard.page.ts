import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the Analytics Dashboard.
 * #828 — Video Performance Analytics Dashboard
 */
export class AnalyticsDashboardPage {
  readonly page: Page;
  readonly dashboard: Locator;

  // Header
  readonly heading: Locator;

  // Period selector buttons
  readonly period7d: Locator;
  readonly period30d: Locator;
  readonly period90d: Locator;
  readonly periodAll: Locator;
  readonly refreshButton: Locator;

  // KPI cards
  readonly totalViewsCard: Locator;
  readonly totalEngagementsCard: Locator;
  readonly engagementRateCard: Locator;
  readonly topContentCard: Locator;

  // Sections
  readonly platformBreakdown: Locator;
  readonly bestTimesGrid: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dashboard = page.getByTestId("analytics-dashboard");
    this.heading = page.getByRole("heading", {
      name: "Video Performance Analytics",
    });
    this.period7d = page.getByRole("button", { name: "7D" });
    this.period30d = page.getByRole("button", { name: "30D" });
    this.period90d = page.getByRole("button", { name: "90D" });
    this.periodAll = page.getByRole("button", { name: "All Time" });
    this.refreshButton = page.getByTitle("Refresh");
    this.totalViewsCard = page.getByText("Total Views").locator("..");
    this.totalEngagementsCard = page
      .getByText("Total Engagements")
      .locator("..");
    this.engagementRateCard = page.getByText("Engagement Rate").locator("..");
    this.topContentCard = page.getByText("Top Content").locator("..");
    this.platformBreakdown = page.getByText("Platform Breakdown").locator("..");
    this.bestTimesGrid = page.getByTestId("best-times-grid");
  }

  async goto() {
    await this.page.goto("/admin");
    // Navigate to analytics section
  }

  async selectPeriod(period: "7d" | "30d" | "90d" | "all") {
    const btn =
      period === "7d"
        ? this.period7d
        : period === "30d"
          ? this.period30d
          : period === "90d"
            ? this.period90d
            : this.periodAll;
    await btn.click();
  }

  async refresh() {
    await this.refreshButton.click();
  }
}
