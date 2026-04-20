import { test } from "@playwright/test";

/**
 * Epic #910 — Issue #840: Backend: Subscribe to crawl.page webhooks from Firecrawl
 *
 * Audit ACs (2026-04-19):
 *   AC1: Crawl requests include events: ['crawl.started','crawl.page','crawl.completed']
 *   AC2–AC4: HMAC-validated parsing, per-crawl stats, EventEmitter      ✅ pre-existing
 *
 * No e2e surface — this is purely a backend webhook subscription concern,
 * documented in code comments per the parent epic. There is no user-visible
 * behaviour change to assert from a browser.
 */
test.describe("Epic #910 / Issue #840 — crawl.page webhook subscription (docs only)", () => {
  test.fixme("AC1: crawl init requests include all three webhook event types", async () => {
    // NOT APPLICABLE TO E2E. The audit accepts the polling-based alternative
    // (3/4 ACs met). The remaining AC1 work is a Firecrawl API conditional
    // — see audit summary on issue #840. Tracked here only for traceability;
    // any future implementation belongs in src/browser tests.
  });
});
