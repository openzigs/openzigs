import { test } from "@playwright/test";

/**
 * Epic #910 — Issue #831: UI: Analytics A/B comparison + summary cards + filtering
 *
 * Audit ACs (2026-04-19):
 *   AC1: A/B content comparison component with side-by-side metrics
 *   AC2: Best-time heatmap                                          ✅ pre-existing
 *   AC3: Summary cards exposed as reusable components
 *   AC4: Date range filtering applies to all components
 *
 * Wiring status (PR #913):
 *   - <AnalyticsContentCompare> implemented at
 *       ui/components/analytics/analytics-content-compare.tsx
 *   - It is not imported by analytics-dashboard.tsx, so AC1 has no UI
 *     surface. AC3 (KPICard / StatCard extraction) and AC4 (period filter
 *     on heatmap + Director analytics) are not addressed by this PR.
 */
test.describe("Epic #910 / Issue #831 — Analytics A/B compare, summary cards, filtering", () => {
  test.fixme("AC1: analytics dashboard renders A/B content comparison with side-by-side metrics", async () => {
    // BLOCKED: <AnalyticsContentCompare> exists but is not imported into
    // analytics-dashboard.tsx; no entry point in the live UI.
  });

  test.fixme("AC3: KPICard / StatCard are exported from a shared analytics-summary-cards module", async () => {
    // BLOCKED: KPICard and StatCard remain private functions inside their
    // respective files; no shared module added.
  });

  test.fixme("AC4: period selector filters the best-times query and Director analytics page", async () => {
    // BLOCKED: best-times query still ignores the period selector and the
    // Director analytics page has no date filtering.
  });
});
