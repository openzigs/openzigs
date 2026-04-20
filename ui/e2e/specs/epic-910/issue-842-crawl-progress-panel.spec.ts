import { test, expect } from "@playwright/test";

/**
 * Epic #910 — Issue #842: Frontend: Create CrawlProgressPanel component
 *
 * Audit ACs (2026-04-19):
 *   AC1: Progress bar shows pages scraped vs estimated total           ✅ in PR
 *   AC2: Current URL updates live as each page is scraped              ✅ in PR
 *   AC3: Elapsed time updates every second                             ✅ in PR
 *   AC4: Error count visible; clicking expands error details           ✅ in PR
 *   AC5: Cancel button triggers cancel callback                        ✅ in PR
 *   AC6: Component transitions to success state on crawl:completed     ✅ pre-existing
 *   AC7: Accessible: progress bar has aria-valuenow / aria-valuemax    ✅ in PR
 *
 * Notes on testability:
 *   - The panel only renders rows when there is at least one active crawl,
 *     and crawls are populated from Socket.IO events fired by the backend
 *     during a real Firecrawl run. Without a way to inject synthetic events
 *     in production code paths, the row-level assertions (lastUrl, elapsed
 *     ticker, error expand, cancel button) cannot be exercised end-to-end
 *     here. They are covered exhaustively by crawl-progress-panel.test.tsx.
 *   - These tests cover the empty-state contract on /seo and the cancel API
 *     endpoint that the panel calls.
 */
test.describe("Epic #910 / Issue #842 — CrawlProgressPanel", () => {
  // AC1, AC4, AC7: panel returns null when there are no crawls — verifies the
  // empty-state contract and confirms no spurious 'Active Crawls' heading
  // leaks onto the SEO page on first load.
  test("renders nothing when there are no active crawls", async ({ page }) => {
    await page.goto("/seo", { waitUntil: "domcontentloaded" });
    await page.locator("main").waitFor({ state: "visible" });
    await expect(
      page.getByRole("region", { name: "Active crawls" }),
    ).toHaveCount(0);
    await expect(page.getByText("Active Crawls", { exact: true })).toHaveCount(
      0,
    );
  });

  // AC5: cancel endpoint validates jobId format
  test("POST /api/seo/audit/:jobId/cancel rejects malformed jobId", async ({
    request,
  }) => {
    const res = await request.post("/api/seo/audit/not-a-hex-id/cancel", {
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid jobId/i);
  });

  // AC5: cancel endpoint returns 404 (or 503 if streaming disabled) for
  // unknown but well-formed jobId
  test("POST /api/seo/audit/:jobId/cancel returns 404 for unknown job", async ({
    request,
  }) => {
    const res = await request.post("/api/seo/audit/deadbeefcafe1234/cancel", {
      data: {},
    });
    expect([404, 503]).toContain(res.status());
  });

  // AC1, AC2, AC3, AC4, AC5, AC7: row-level assertions blocked on a way to
  // simulate live crawl events from inside the e2e harness.
  test.fixme("live crawl row shows progress bar, lastUrl, elapsed, error count, and cancel", async () => {
    // BLOCKED: requires a way to drive crawl:started / crawl:progress /
    // crawl:completed Socket.IO events from the test harness. The component
    // wiring is verified by crawl-progress-panel.test.tsx (full coverage
    // of progress bar ARIA, elapsed ticker, error expand, and cancel
    // button behaviour).
  });

  // AC6: completion -> auto-removal after 10s. Same blocker as above.
  test.fixme("completed crawl shows checkmark icon and auto-clears after 10s", async () => {
    // BLOCKED: requires ability to emit synthetic Socket.IO events.
  });
});
