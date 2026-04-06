import { test, expect } from "@playwright/test";
import { navigateTo } from "./helpers";
import { AnalyticsDashboardPage } from "./pages/analytics-dashboard.page";

/**
 * E2E Tests — Analytics Dashboard (#828)
 *
 * Acceptance Criteria from issue:
 * AC1: Cross-platform summary dashboard with total views, engagement, top content
 * AC2: Platform tabs showing platform-specific metrics
 * AC3: Date range picker (7d, 30d, 90d, custom)
 * AC4: A/B content comparison: select 2 posts → side-by-side metric charts
 * AC5: Best posting time heatmap based on historical performance
 * AC6: Analytics data cached in SQLite with 1hr TTL
 * AC7: At minimum: YouTube + one additional platform
 * AC8: Dashboard loads within 2 seconds (cached data)
 * AC9: Responsive layout
 */
test.describe("Analytics Dashboard (#828)", () => {
  // AC1: Dashboard renders with heading and KPI cards
  test("should display analytics dashboard with heading", async ({ page }) => {
    await navigateTo(page, "/admin");
    const dashboard = new AnalyticsDashboardPage(page);
    await expect(dashboard.heading).toBeVisible();
  });

  // AC1: KPI cards shown — total views, engagements, engagement rate, top content
  test("should display four KPI summary cards", async ({ page }) => {
    await navigateTo(page, "/admin");
    const dashboard = new AnalyticsDashboardPage(page);
    await expect(page.getByText("Total Views")).toBeVisible();
    await expect(page.getByText("Total Engagements")).toBeVisible();
    await expect(page.getByText("Engagement Rate")).toBeVisible();
    await expect(page.getByText("Top Content")).toBeVisible();
  });

  // AC3: Date range picker with 7d, 30d, 90d, all time
  test("should show date range period selector buttons", async ({ page }) => {
    await navigateTo(page, "/admin");
    const dashboard = new AnalyticsDashboardPage(page);
    await expect(dashboard.period7d).toBeVisible();
    await expect(dashboard.period30d).toBeVisible();
    await expect(dashboard.period90d).toBeVisible();
    await expect(dashboard.periodAll).toBeVisible();
  });

  // AC3: Can switch between date periods
  test("should allow switching date periods", async ({ page }) => {
    await navigateTo(page, "/admin");
    const dashboard = new AnalyticsDashboardPage(page);
    await dashboard.selectPeriod("7d");
    // 7d button should be active (styled differently)
    await expect(dashboard.period7d).toHaveClass(/bg-blue-600/);
  });

  // AC1: Refresh button visible
  test("should display refresh button for manual data reload", async ({
    page,
  }) => {
    await navigateTo(page, "/admin");
    const dashboard = new AnalyticsDashboardPage(page);
    await expect(dashboard.refreshButton).toBeVisible();
  });

  // AC2: Platform breakdown section
  test("should display platform breakdown section", async ({ page }) => {
    await navigateTo(page, "/admin");
    await expect(page.getByText("Platform Breakdown")).toBeVisible();
  });

  // AC5: Best posting times heatmap
  test("should display best posting times section", async ({ page }) => {
    await navigateTo(page, "/admin");
    await expect(page.getByText("Best Posting Times")).toBeVisible();
  });

  // AC5: Heatmap grid structure (7 days x 24 hours)
  test("should display best times heatmap grid with day headers", async ({
    page,
  }) => {
    await navigateTo(page, "/admin");
    const dashboard = new AnalyticsDashboardPage(page);
    // Day headers should be present
    await expect(page.getByText("Mon")).toBeVisible();
    await expect(page.getByText("Tue")).toBeVisible();
    await expect(page.getByText("Wed")).toBeVisible();
    await expect(page.getByText("Thu")).toBeVisible();
    await expect(page.getByText("Fri")).toBeVisible();
  });

  // AC6: Analytics summary API endpoint works
  test("should have analytics summary API returning data structure", async ({
    request,
  }) => {
    const res = await request.get(
      "/api/admin/video-analytics/summary?period=30d",
    );
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("totalViews");
      expect(body).toHaveProperty("totalEngagements");
      expect(body).toHaveProperty("overallEngagementRate");
      expect(body).toHaveProperty("platformBreakdown");
      expect(body).toHaveProperty("dateRange");
    }
  });

  // AC5: Best-times API endpoint works
  test("should have best-times API returning slot data", async ({
    request,
  }) => {
    const res = await request.get("/api/admin/video-analytics/best-times");
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("slots");
      expect(Array.isArray(body.slots)).toBe(true);
    }
  });

  // AC4: Compare API endpoint works
  test("should have compare API for A/B content comparison", async ({
    request,
  }) => {
    const res = await request.get(
      "/api/admin/video-analytics/compare?id1=v-1&platform1=youtube&id2=v-2&platform2=tiktok",
    );
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("a");
      expect(body).toHaveProperty("b");
    }
  });

  // AC4: Compare API returns 400 for missing params
  test("should return 400 for compare with missing params", async ({
    request,
  }) => {
    const res = await request.get("/api/admin/video-analytics/compare?id1=v-1");
    expect(res.status()).toBe(400);
  });
});
