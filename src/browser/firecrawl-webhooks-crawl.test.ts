import { describe, it, expect, vi, beforeEach } from "vitest";
import { FirecrawlWebhookHandler } from "./firecrawl-webhooks.js";
import type {
  CrawlStartedEvent,
  CrawlProgressEvent,
  CrawlCompletedEvent,
} from "../types/crawl-events.js";

function createHandler() {
  return new FirecrawlWebhookHandler({
    secret: "test-secret-key",
    port: 3000,
    enabled: true,
    jobTimeoutMs: 5000,
  });
}

describe("FirecrawlWebhookHandler crawl tracking", () => {
  let handler: FirecrawlWebhookHandler;

  beforeEach(() => {
    handler = createHandler();
  });

  it("registerCrawl creates stats and emits crawl:started", () => {
    const listener = vi.fn();
    handler.on("crawl:started", listener);

    handler.registerCrawl("job-1", "https://example.com", 50);

    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0][0] as CrawlStartedEvent;
    expect(event.jobId).toBe("job-1");
    expect(event.siteUrl).toBe("https://example.com");
    expect(event.estimatedTotal).toBe(50);
    expect(event.startedAt).toBeTruthy();
  });

  it("getCrawlStats returns stats after registration", () => {
    handler.registerCrawl("job-2", "https://test.com", 30);

    const stats = handler.getCrawlStats("job-2");
    expect(stats).toBeDefined();
    expect(stats!.pagesScraped).toBe(0);
    expect(stats!.status).toBe("running");
    expect(stats!.siteUrl).toBe("https://test.com");
  });

  it("getAllCrawlStats returns all active crawls", () => {
    handler.registerCrawl("job-a", "https://a.com", 10);
    handler.registerCrawl("job-b", "https://b.com", 20);

    const all = handler.getAllCrawlStats();
    expect(all).toHaveLength(2);
  });

  it("handleCrawlPageEvent increments pagesScraped and emits progress", () => {
    const listener = vi.fn();
    handler.on("crawl:progress", listener);

    handler.registerCrawl("job-3", "https://example.com", 10);
    handler.handleCrawlPageEvent("job-3", "https://example.com/about", false);

    const stats = handler.getCrawlStats("job-3");
    expect(stats!.pagesScraped).toBe(1);
    expect(stats!.lastUrl).toBe("https://example.com/about");

    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0][0] as CrawlProgressEvent;
    expect(event.pagesScraped).toBe(1);
    expect(event.lastUrl).toBe("https://example.com/about");
  });

  it("handleCrawlPageEvent increments errorCount on errors", () => {
    handler.registerCrawl("job-4", "https://example.com", 10);
    handler.handleCrawlPageEvent("job-4", "https://example.com/bad", true);

    const stats = handler.getCrawlStats("job-4");
    expect(stats!.errorCount).toBe(1);
  });

  it("handleCrawlPageEvent ignores unknown jobIds", () => {
    const listener = vi.fn();
    handler.on("crawl:progress", listener);

    handler.handleCrawlPageEvent("unknown", "https://example.com", false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("completeCrawl emits crawl:completed and marks status", () => {
    const listener = vi.fn();
    handler.on("crawl:completed", listener);

    handler.registerCrawl("job-5", "https://example.com", 5);
    handler.handleCrawlPageEvent("job-5", "https://example.com/1", false);
    handler.handleCrawlPageEvent("job-5", "https://example.com/2", false);
    handler.completeCrawl("job-5", "completed");

    const stats = handler.getCrawlStats("job-5");
    expect(stats!.status).toBe("completed");
    expect(stats!.completedAt).toBeTruthy();

    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0][0] as CrawlCompletedEvent;
    expect(event.pagesScraped).toBe(2);
    expect(event.status).toBe("completed");
  });

  it("completeCrawl with failed status", () => {
    const listener = vi.fn();
    handler.on("crawl:completed", listener);

    handler.registerCrawl("job-6", "https://example.com", 10);
    handler.completeCrawl("job-6", "failed");

    const event = listener.mock.calls[0][0] as CrawlCompletedEvent;
    expect(event.status).toBe("failed");
  });

  it("shutdown clears crawlStats", () => {
    handler.registerCrawl("job-7", "https://example.com", 5);
    expect(handler.getAllCrawlStats()).toHaveLength(1);

    handler.shutdown();
    expect(handler.getAllCrawlStats()).toHaveLength(0);
  });

  it("multiple page events accumulate correctly", () => {
    handler.registerCrawl("job-8", "https://example.com", 10);

    for (let i = 0; i < 5; i++) {
      handler.handleCrawlPageEvent(
        "job-8",
        `https://example.com/page-${i}`,
        i === 2, // one error
      );
    }

    const stats = handler.getCrawlStats("job-8");
    expect(stats!.pagesScraped).toBe(5);
    expect(stats!.errorCount).toBe(1);
    expect(stats!.lastUrl).toBe("https://example.com/page-4");
  });
});
