/**
 * Unit tests for FirecrawlWebhookHandler clientId scoping (#841) and
 * crawl cancellation (#842).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FirecrawlWebhookHandler } from "./firecrawl-webhooks.js";

function makeHandler(): FirecrawlWebhookHandler {
  return new FirecrawlWebhookHandler({
    secret: "a".repeat(64),
    port: 0,
    enabled: true,
  });
}

describe("FirecrawlWebhookHandler — clientId scoping (#841)", () => {
  let handler: FirecrawlWebhookHandler;

  beforeEach(() => {
    handler = makeHandler();
  });

  it("attaches clientId from claim to crawl events", () => {
    const started = vi.fn();
    const progress = vi.fn();
    const completed = vi.fn();
    handler.on("crawl:started", started);
    handler.on("crawl:progress", progress);
    handler.on("crawl:completed", completed);

    handler.claimCrawlForClient("https://example.com", "client-abc");
    handler.registerCrawl("job-1", "https://example.com", 10);
    handler.handleCrawlPageEvent("job-1", "https://example.com/a", false);
    handler.completeCrawl("job-1", "completed");

    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "client-abc", jobId: "job-1" }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "client-abc", pagesScraped: 1 }),
    );
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "client-abc",
        status: "completed",
      }),
    );
  });

  it("normalizes URL when matching claims (trailing slash, scheme case)", () => {
    handler.claimCrawlForClient("HTTPS://Example.com/", "client-x");
    const started = vi.fn();
    handler.on("crawl:started", started);
    handler.registerCrawl("j2", "https://example.com", 0);
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "client-x" }),
    );
  });

  it("registers without clientId when no claim exists", () => {
    const started = vi.fn();
    handler.on("crawl:started", started);
    handler.registerCrawl("j3", "https://other.com", 0);
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "j3", clientId: undefined }),
    );
  });

  it("expires claims after TTL", async () => {
    vi.useFakeTimers();
    handler.claimCrawlForClient("https://stale.com", "client-stale");
    vi.advanceTimersByTime(61_000);
    const started = vi.fn();
    handler.on("crawl:started", started);
    handler.registerCrawl("j4", "https://stale.com", 0);
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: undefined }),
    );
    vi.useRealTimers();
  });

  it("explicit clientId param overrides any claim lookup", () => {
    handler.claimCrawlForClient("https://example.com", "claim-id");
    const started = vi.fn();
    handler.on("crawl:started", started);
    handler.registerCrawl("j5", "https://example.com", 0, "explicit-id");
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "explicit-id" }),
    );
  });
});

describe("FirecrawlWebhookHandler — error tracking", () => {
  it("records up to 50 page errors and forwards lastError on progress", () => {
    const handler = makeHandler();
    const progress = vi.fn();
    handler.on("crawl:progress", progress);
    handler.registerCrawl("job-err", "https://example.com", 100);

    for (let i = 0; i < 60; i++) {
      handler.handleCrawlPageEvent(
        "job-err",
        `https://example.com/p${i}`,
        true,
        { statusCode: 500, message: "boom" },
      );
    }

    const stats = handler.getCrawlStats("job-err");
    expect(stats?.errorCount).toBe(60);
    expect(stats?.errors.length).toBe(50);
    expect(stats?.errors[0].url).toBe("https://example.com/p10");
    const lastCall = progress.mock.calls.at(-1)?.[0];
    expect(lastCall?.lastError?.statusCode).toBe(500);
  });
});

describe("FirecrawlWebhookHandler — cancellation (#842)", () => {
  it("cancels a running crawl and emits completed with status=cancelled", () => {
    const handler = makeHandler();
    const completed = vi.fn();
    handler.on("crawl:completed", completed);
    handler.registerCrawl("c1", "https://example.com", 0);

    expect(handler.cancelCrawl("c1")).toBe(true);
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", jobId: "c1" }),
    );
    expect(handler.getCrawlStats("c1")?.status).toBe("cancelled");
  });

  it("returns false when cancelling unknown or already-completed jobs", () => {
    const handler = makeHandler();
    expect(handler.cancelCrawl("nope")).toBe(false);
    handler.registerCrawl("done", "https://example.com", 0);
    handler.completeCrawl("done", "completed");
    expect(handler.cancelCrawl("done")).toBe(false);
  });
});
