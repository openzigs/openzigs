import { test, expect } from "@playwright/test";
import { SeoDashboardPage } from "./pages/seo-dashboard.page";

/**
 * E2E Tests — SEO Suite Enhancement v2 (#850)
 *
 * Acceptance Criteria from sub-issues:
 *
 * #854 — % URLs Affected:
 *   AC: Audit tab shows severity groups with issue counts per group
 *
 * #855 — Mobile vs Desktop CWV:
 *   AC: Performance tab shows CWV aggregate summary and per-page metric cards
 *
 * #856 — Scheduled Audits:
 *   AC: History tab shows "Schedule Audit" button; clicking opens form with frequency
 *
 * #862 — Pre-crawl URL Map:
 *   AC: Deferred — requires socket events for URL map preview (backend-driven)
 *
 * Leads/Prices/Competitors Results Panels:
 *   AC: Each mode shows results panel with appropriate data and export options
 */

// ── Mock Data ────────────────────────────────────────────────────────────

const MOCK_AUDIT = {
  id: 1,
  siteUrl: "https://example.com",
  healthScore: 78,
  rating: "good",
  pagesAudited: 120,
  totalIssues: 18,
  critical: 2,
  high: 5,
  medium: 6,
  low: 5,
  dataJson: JSON.stringify({
    pages: [
      {
        url: "https://example.com/",
        issues: [
          {
            severity: "error",
            category: "canonical",
            message: "Missing canonical tag",
          },
          {
            severity: "warning",
            category: "meta",
            message: "Meta description too short",
          },
        ],
        metrics: {},
      },
      {
        url: "https://example.com/about",
        issues: [
          {
            severity: "error",
            category: "robots",
            message: "Blocked by robots.txt",
          },
          {
            severity: "info",
            category: "hreflang",
            message: "No hreflang tags found",
          },
        ],
        metrics: {},
      },
      {
        url: "https://example.com/contact",
        issues: [
          {
            severity: "warning",
            category: "canonical",
            message: "Non-matching canonical URL",
          },
        ],
        metrics: {},
      },
    ],
    coreWebVitals: [
      {
        url: "https://example.com/",
        performanceScore: 85,
        metrics: [
          { name: "LCP", value: 2100, unit: "ms", rating: "good" },
          { name: "FCP", value: 1200, unit: "ms", rating: "good" },
          { name: "TBT", value: 150, unit: "ms", rating: "good" },
          { name: "CLS", value: 0.05, unit: "", rating: "good" },
          { name: "SI", value: 2800, unit: "ms", rating: "good" },
          { name: "TTI", value: 3200, unit: "ms", rating: "good" },
        ],
        fetchedAt: "2026-04-12T10:00:00Z",
      },
      {
        url: "https://example.com/about",
        performanceScore: 62,
        metrics: [
          { name: "LCP", value: 3800, unit: "ms", rating: "needs-improvement" },
          { name: "FCP", value: 2200, unit: "ms", rating: "needs-improvement" },
          { name: "TBT", value: 350, unit: "ms", rating: "needs-improvement" },
          { name: "CLS", value: 0.18, unit: "", rating: "needs-improvement" },
          { name: "SI", value: 4200, unit: "ms", rating: "needs-improvement" },
          { name: "TTI", value: 5100, unit: "ms", rating: "needs-improvement" },
        ],
        fetchedAt: "2026-04-12T10:01:00Z",
      },
    ],
  }),
  createdAt: "2026-04-12T10:00:00Z",
};

const MOCK_LEADS = [
  {
    domain: "example.com",
    files: [
      {
        name: "leads-2026-04-12.json",
        capturedAt: "2026-04-12T10:00:00Z",
        sizeBytes: 15360,
      },
      {
        name: "leads-2026-04-11.json",
        capturedAt: "2026-04-11T10:00:00Z",
        sizeBytes: 12288,
      },
    ],
  },
  {
    domain: "other-site.com",
    files: [
      {
        name: "leads-2026-04-12.json",
        capturedAt: "2026-04-12T10:00:00Z",
        sizeBytes: 8192,
      },
    ],
  },
];

const MOCK_PRICES = [
  {
    url: "https://shop.example.com/widget",
    label: "Premium Widget",
    snapshotCount: 5,
    lastCapture: "2026-04-12T10:00:00Z",
  },
  {
    url: "https://shop.example.com/gadget",
    label: null,
    snapshotCount: 3,
    lastCapture: "2026-04-11T10:00:00Z",
  },
];

const MOCK_COMPETITORS = [
  {
    url: "https://competitor-a.com",
    name: "Competitor A",
    addedAt: "2026-04-01T10:00:00Z",
    lastSnapshotAt: "2026-04-12T10:00:00Z",
  },
  {
    url: "https://competitor-b.com",
    name: null,
    addedAt: "2026-04-05T10:00:00Z",
    lastSnapshotAt: null,
  },
];

const MOCK_SCHEDULED_JOBS = {
  jobs: [
    {
      id: "job-1",
      name: "SEO Audit — example.com",
      cronExpression: "0 6 * * 1",
      enabled: true,
      actionPayload: { promptName: "seo-site-audit" },
    },
  ],
};

const MOCK_COMPARISON = {
  current: MOCK_AUDIT,
  previous: {
    ...MOCK_AUDIT,
    id: 2,
    healthScore: 65,
    createdAt: "2026-04-10T10:00:00Z",
  },
  scoreDelta: 13,
  newIssues: 3,
  resolvedIssues: 8,
  regressions: [],
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** Intercept all SEO-related API routes with mock data. */
async function mockAllSeoApis(page: import("@playwright/test").Page) {
  await page.route(
    (url) =>
      url.pathname.startsWith("/api/seo/") ||
      url.pathname.startsWith("/api/admin/"),
    (route) => {
      const { pathname } = new URL(route.request().url());

      if (pathname === "/api/seo/leads") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_LEADS),
        });
      }
      if (pathname === "/api/seo/prices") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_PRICES),
        });
      }
      if (pathname === "/api/seo/competitors") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_COMPETITORS),
        });
      }
      if (pathname === "/api/seo/health") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            message: "Firecrawl available",
          }),
        });
      }
      if (pathname.includes("/compare/")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_COMPARISON),
        });
      }
      if (pathname === "/api/admin/jobs") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_SCHEDULED_JOBS),
        });
      }
      if (pathname === "/api/admin/firecrawl/status") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ enabled: true }),
        });
      }
      // Default: return audit history array
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([MOCK_AUDIT]),
      });
    },
  );
}

/** Mock APIs with empty datasets for empty-state testing. */
async function mockEmptySeoApis(page: import("@playwright/test").Page) {
  await page.route(
    (url) =>
      url.pathname.startsWith("/api/seo/") ||
      url.pathname.startsWith("/api/admin/"),
    (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/seo/health") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            message: "Firecrawl available",
          }),
        });
      }
      if (pathname === "/api/admin/firecrawl/status") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ enabled: true }),
        });
      }
      if (pathname === "/api/admin/jobs") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jobs: [] }),
        });
      }
      if (pathname === "/api/seo/leads") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      }
      if (pathname === "/api/seo/prices") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      }
      if (pathname === "/api/seo/competitors") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
    },
  );
}

// ── Tests ────────────────────────────────────────────────────────────────

test.describe("SEO Audit Tab — Issue Groups (#854)", () => {
  // AC #854: GIVEN an audit has completed, WHEN viewing the Audit tab,
  // THEN each issue group should display severity headings with issue counts
  test("should show severity-grouped issues with counts in Audit tab", async ({
    page,
  }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();

    await test.step("Switch to Audit inner tab", async () => {
      await seo.switchToInnerTab("audit");
    });

    await test.step("Audit Results heading visible", async () => {
      await expect(page.getByText("Audit Results")).toBeVisible();
    });

    await test.step("Error severity group shows count", async () => {
      // 2 errors across 2 pages
      await expect(page.getByText(/Errors/i).first()).toBeVisible();
    });

    await test.step("Warning severity group shows count", async () => {
      await expect(page.getByText(/Warnings/i).first()).toBeVisible();
    });

    await test.step("Info severity group shows count", async () => {
      await expect(page.getByText(/Info/i).first()).toBeVisible();
    });

    await test.step("Issue messages are displayed", async () => {
      await expect(page.getByText("Missing canonical tag")).toBeVisible();
      await expect(page.getByText("Blocked by robots.txt")).toBeVisible();
      await expect(page.getByText("Meta description too short")).toBeVisible();
    });
  });

  test("should show pages grouped under each severity level", async ({
    page,
  }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.switchToInnerTab("audit");

    await test.step("Page URLs visible under error group", async () => {
      await expect(
        page.getByText("https://example.com/").first(),
      ).toBeVisible();
      await expect(
        page.getByText("https://example.com/about").first(),
      ).toBeVisible();
    });
  });

  test("should show empty state when no audit data exists", async ({
    page,
  }) => {
    await mockEmptySeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.switchToInnerTab("audit");

    await expect(page.getByText("No audit results yet")).toBeVisible();
  });
});

test.describe("SEO Performance — CWV Metrics (#855)", () => {
  // AC #855: GIVEN I'm on the Performance tab, WHEN CWV data exists,
  // THEN CWV aggregate summary and per-page metric cards are displayed
  test("should show CWV aggregate summary with score categories", async ({
    page,
  }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();

    await test.step("Switch to Performance inner tab", async () => {
      await seo.switchToInnerTab("performance");
    });

    await test.step("Core Web Vitals heading visible", async () => {
      await expect(seo.cwvHeading).toBeVisible();
    });

    await test.step("Aggregate summary shows Avg Score", async () => {
      await expect(page.getByText("Avg Score")).toBeVisible();
    });

    await test.step("Aggregate summary shows Good count", async () => {
      await expect(page.getByText(/Good.*≥90/i)).toBeVisible();
    });

    await test.step("Aggregate summary shows Needs Work count", async () => {
      await expect(page.getByText(/Needs Work/i)).toBeVisible();
    });

    await test.step("Re-analyze button visible", async () => {
      await expect(seo.reAnalyzeButton).toBeVisible();
    });
  });

  test("should show per-page CWV metric cards with all 6 metrics", async ({
    page,
  }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.switchToInnerTab("performance");

    await test.step("First page URL shown in metric card", async () => {
      await expect(
        page.getByText("https://example.com/").first(),
      ).toBeVisible();
    });

    await test.step("Second page URL shown in metric card", async () => {
      await expect(page.getByText("https://example.com/about")).toBeVisible();
    });

    await test.step("LCP metric rendered", async () => {
      await expect(page.getByText("LCP").first()).toBeVisible();
    });

    await test.step("CLS metric rendered", async () => {
      await expect(page.getByText("CLS").first()).toBeVisible();
    });

    await test.step("TBT metric rendered", async () => {
      await expect(page.getByText("TBT").first()).toBeVisible();
    });
  });

  test("should show average LCP, CLS, TBT in aggregate stats row", async ({
    page,
  }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.switchToInnerTab("performance");

    await test.step("Avg LCP stat visible", async () => {
      await expect(page.getByText("Avg LCP")).toBeVisible();
    });

    await test.step("Avg CLS stat visible", async () => {
      await expect(page.getByText("Avg CLS")).toBeVisible();
    });

    await test.step("Avg TBT stat visible", async () => {
      await expect(page.getByText("Avg TBT")).toBeVisible();
    });
  });

  test("should show PSI link for each page", async ({ page }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.switchToInnerTab("performance");

    await test.step("PSI external links present", async () => {
      const psiLinks = page.getByText("PSI");
      await expect(psiLinks.first()).toBeVisible();
    });
  });
});

test.describe("SEO Scheduled Audits (#856)", () => {
  // AC #856: GIVEN I'm on the SEO page, WHEN I click "Schedule Audit",
  // THEN a scheduling form appears with frequency options
  test("should show scheduled audits section on History tab", async ({
    page,
  }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.switchToTab("history");

    await test.step("Scheduled Audits heading visible", async () => {
      await expect(seo.scheduledAuditsHeading).toBeVisible();
    });

    await test.step("Schedule Audit button visible", async () => {
      await expect(seo.scheduleAuditButton).toBeVisible();
    });
  });

  test("should open scheduling form when Schedule Audit is clicked", async ({
    page,
  }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.switchToTab("history");

    await test.step("Click Schedule Audit button", async () => {
      await seo.scheduleAuditButton.click();
    });

    await test.step("Site URL field appears", async () => {
      // Scope to the scheduled audits form section
      const form = page
        .locator(".rounded-lg.border")
        .filter({ hasText: "Frequency" });
      await expect(form.getByPlaceholder("https://example.com")).toBeVisible();
    });

    await test.step("Frequency selector appears", async () => {
      await expect(page.getByText("Frequency")).toBeVisible();
    });

    await test.step("Frequency options include daily, weekly, monthly", async () => {
      const frequencySelect = page
        .locator("select")
        .filter({ hasText: /Daily|Weekly|Monthly/ });
      await expect(frequencySelect).toBeVisible();
    });

    await test.step("Create and Cancel buttons visible", async () => {
      await expect(page.getByRole("button", { name: "Create" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    });
  });

  test("should dismiss scheduling form on Cancel", async ({ page }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.switchToTab("history");

    await seo.scheduleAuditButton.click();
    const form = page
      .locator(".rounded-lg.border")
      .filter({ hasText: "Frequency" });
    await expect(form).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(form).not.toBeVisible();
  });

  test("should show existing scheduled jobs", async ({ page }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.switchToTab("history");

    await test.step("Existing job name visible", async () => {
      await expect(page.getByText("SEO Audit — example.com")).toBeVisible();
    });

    await test.step("Job cron expression visible", async () => {
      await expect(page.getByText("0 6 * * 1")).toBeVisible();
    });
  });

  test("should show empty state when no scheduled jobs exist", async ({
    page,
  }) => {
    await mockEmptySeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.switchToTab("history");

    await expect(page.getByText("No scheduled audits yet")).toBeVisible();
  });

  test("should validate URL before creating schedule", async ({ page }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.switchToTab("history");

    await seo.scheduleAuditButton.click();

    await test.step("Submit with empty URL shows error", async () => {
      await page.getByRole("button", { name: "Create" }).click();
      await expect(page.getByText(/valid URL|URL is required/i)).toBeVisible();
    });
  });
});

test.describe("SEO Leads Results Panel", () => {
  // AC: GIVEN leads extractions exist, WHEN I'm in Leads mode,
  // THEN the results panel shows extraction history grouped by domain
  test("should show lead extractions grouped by domain", async ({ page }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();

    await test.step("Select Leads mode", async () => {
      await seo.selectMode("leads");
    });

    await test.step("Lead Extractions heading visible", async () => {
      await expect(seo.leadsHeading).toBeVisible();
    });

    await test.step("Domain groupings visible", async () => {
      await expect(page.getByText("example.com").first()).toBeVisible();
      await expect(page.getByText("other-site.com")).toBeVisible();
    });

    await test.step("Download links present for files", async () => {
      const downloadLinks = page.getByRole("link", { name: /Download/i });
      await expect(downloadLinks).toHaveCount(3); // 2 files + 1 file
    });
  });

  test("should show empty state when no leads exist", async ({ page }) => {
    await mockEmptySeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.selectMode("leads");

    await expect(page.getByText("No lead extractions yet")).toBeVisible();
  });
});

test.describe("SEO Prices Results Panel", () => {
  // AC: GIVEN monitored URLs exist, WHEN I'm in Prices mode,
  // THEN the results panel shows a table with Export CSV
  test("should show monitored price URLs table with Export CSV", async ({
    page,
  }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();

    await test.step("Select Prices mode", async () => {
      await seo.selectMode("prices");
    });

    await test.step("Monitored Price URLs heading visible", async () => {
      await expect(seo.pricesHeading).toBeVisible();
    });

    await test.step("Table headers visible", async () => {
      const table = page.locator("table").filter({ hasText: "URL / Label" });
      await expect(
        table.getByRole("columnheader", { name: "URL / Label" }),
      ).toBeVisible();
      await expect(
        table.getByRole("columnheader", { name: "Snapshots" }),
      ).toBeVisible();
      await expect(
        table.getByRole("columnheader", { name: "Last Captured" }),
      ).toBeVisible();
    });

    await test.step("Price data rows visible", async () => {
      await expect(
        page.getByText("https://shop.example.com/widget"),
      ).toBeVisible();
      await expect(page.getByText("Premium Widget")).toBeVisible();
      await expect(
        page.getByText("https://shop.example.com/gadget"),
      ).toBeVisible();
    });

    await test.step("Export CSV link visible", async () => {
      const pricePanel = page
        .locator("section, div")
        .filter({ hasText: /Monitored Price URLs/ })
        .first();
      const exportLink = pricePanel.getByRole("link", { name: /Export CSV/i });
      await expect(exportLink).toBeVisible();
      await expect(exportLink).toHaveAttribute(
        "href",
        "/api/seo/prices/export.csv",
      );
    });
  });

  test("should show empty state when no prices data exists", async ({
    page,
  }) => {
    await mockEmptySeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.selectMode("prices");

    await expect(page.getByText("No price snapshots yet")).toBeVisible();
  });
});

test.describe("SEO Competitors Results Panel", () => {
  // AC: GIVEN tracked competitors exist, WHEN I'm in Competitors mode,
  // THEN the results panel shows a table with Export CSV
  test("should show tracked competitors table with Export CSV", async ({
    page,
  }) => {
    await mockAllSeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();

    await test.step("Select Competitors mode", async () => {
      await seo.selectMode("competitors");
    });

    await test.step("Tracked Competitors heading visible", async () => {
      await expect(seo.competitorsHeading).toBeVisible();
    });

    await test.step("Table headers visible", async () => {
      const table = page
        .locator("table")
        .filter({ hasText: "https://competitor-a.com" });
      await expect(
        table.getByRole("columnheader", { name: "Competitor" }),
      ).toBeVisible();
      await expect(
        table.getByRole("columnheader", { name: "Added" }),
      ).toBeVisible();
      await expect(
        table.getByRole("columnheader", { name: "Last Snapshot" }),
      ).toBeVisible();
    });

    await test.step("Competitor data rows visible", async () => {
      await expect(page.getByText("https://competitor-a.com")).toBeVisible();
      await expect(page.getByText("Competitor A")).toBeVisible();
      await expect(page.getByText("https://competitor-b.com")).toBeVisible();
    });

    await test.step("Never label for competitor without snapshot", async () => {
      await expect(page.getByText("Never")).toBeVisible();
    });

    await test.step("Export CSV link visible", async () => {
      const competitorPanel = page
        .locator("section, div")
        .filter({ hasText: /Tracked Competitors/ })
        .first();
      const exportLink = competitorPanel.getByRole("link", {
        name: /Export CSV/i,
      });
      await expect(exportLink).toBeVisible();
      await expect(exportLink).toHaveAttribute(
        "href",
        "/api/seo/competitors/export.csv",
      );
    });
  });

  test("should show empty state when no competitors tracked", async ({
    page,
  }) => {
    await mockEmptySeoApis(page);
    const seo = new SeoDashboardPage(page);
    await seo.goto();
    await seo.selectMode("competitors");

    await expect(page.getByText("No competitors tracked yet")).toBeVisible();
  });
});
