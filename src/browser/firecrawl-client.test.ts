import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isBlockedUrl,
  FirecrawlClient,
  resetFirecrawlClient,
} from "./firecrawl-client.js";
import { FirecrawlWebhookHandler } from "./firecrawl-webhooks.js";

// ── SSRF Protection Tests ──────────────────────────────────────────────

describe("isBlockedUrl", () => {
  const blocked = [
    "http://localhost/",
    "http://127.0.0.1/",
    "http://127.0.0.99/path",
    "http://10.0.0.1/",
    "http://10.255.255.255/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.0.1/",
    "http://192.168.1.100/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[::0]/",
    "file:///etc/passwd",
    "not-a-url",
  ];

  const allowed = [
    "https://example.com/",
    "https://www.google.com/search?q=test",
    "https://docs.firecrawl.dev/",
    "http://172.32.0.1/",
    "http://192.167.1.1/",
    "https://11.0.0.1/",
  ];

  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(isBlockedUrl(url)).toBe(true);
    });
  }

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(isBlockedUrl(url)).toBe(false);
    });
  }
});

// ── Helper: mock fetch for Firecrawl API ───────────────────────────────

function createMockFetch(
  handlers: Record<string, () => Response>,
): typeof fetch {
  return (async (url: string | URL | Request) => {
    const urlStr =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (urlStr.includes(pattern)) return handler();
    }
    // Default: health check on root URL
    if (
      typeof urlStr === "string" &&
      urlStr.endsWith("/") &&
      !urlStr.includes("/v1/")
    ) {
      return new Response("OK", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
}

// ── FirecrawlClient Tests ──────────────────────────────────────────────

describe("FirecrawlClient", () => {
  beforeEach(() => {
    resetFirecrawlClient();
  });

  afterEach(() => {
    resetFirecrawlClient();
  });

  describe("constructor", () => {
    it("applies default config when no overrides given", () => {
      const c = new FirecrawlClient();
      const config = c.getConfig();
      expect(config.enabled).toBe(false);
      expect(config.url).toBe("http://localhost:3002");
      expect(config.idleTimeoutMs).toBe(600_000);
    });

    it("merges partial config with defaults", () => {
      const c = new FirecrawlClient({ enabled: true, idleTimeoutMs: 5000 });
      const config = c.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.url).toBe("http://localhost:3002");
      expect(config.idleTimeoutMs).toBe(5000);
    });
  });

  describe("isAvailable", () => {
    it("returns false when disabled", async () => {
      const c = new FirecrawlClient({ enabled: false });
      expect(await c.isAvailable()).toBe(false);
    });

    it("returns true when enabled and server responds OK", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response("OK", { status: 200 }));
      const c = new FirecrawlClient(
        { enabled: true },
        mockFetch as typeof fetch,
      );
      expect(await c.isAvailable()).toBe(true);
    });

    it("returns false when fetch throws", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error("connection refused"));
      const c = new FirecrawlClient(
        { enabled: true },
        mockFetch as typeof fetch,
      );
      expect(await c.isAvailable()).toBe(false);
    });
  });

  describe("SSRF validation", () => {
    it("rejects localhost URLs in scrape", async () => {
      const c = new FirecrawlClient({ enabled: true });
      await expect(c.scrape("http://localhost/admin")).rejects.toThrow(
        "SSRF blocked",
      );
    });

    it("rejects internal IPs in crawl", async () => {
      const c = new FirecrawlClient({ enabled: true });
      await expect(c.crawl("http://10.0.0.1/")).rejects.toThrow("SSRF blocked");
    });

    it("rejects metadata endpoint in map", async () => {
      const c = new FirecrawlClient({ enabled: true });
      await expect(
        c.map("http://169.254.169.254/latest/meta-data/"),
      ).rejects.toThrow("SSRF blocked");
    });

    it("rejects 192.168.x.x in scrape", async () => {
      const c = new FirecrawlClient({ enabled: true });
      await expect(c.scrape("http://192.168.1.1/")).rejects.toThrow(
        "SSRF blocked",
      );
    });

    it("rejects 172.16.x.x in scrape", async () => {
      const c = new FirecrawlClient({ enabled: true });
      await expect(c.scrape("http://172.16.0.1/")).rejects.toThrow(
        "SSRF blocked",
      );
    });
  });

  describe("disabled client", () => {
    it("throws when scraping with disabled config", async () => {
      const c = new FirecrawlClient({ enabled: false });
      await expect(c.scrape("https://example.com")).rejects.toThrow(
        "not enabled",
      );
    });

    it("throws when crawling with disabled config", async () => {
      const c = new FirecrawlClient({ enabled: false });
      await expect(c.crawl("https://example.com")).rejects.toThrow(
        "not enabled",
      );
    });

    it("throws when mapping with disabled config", async () => {
      const c = new FirecrawlClient({ enabled: false });
      await expect(c.map("https://example.com")).rejects.toThrow("not enabled");
    });
  });

  describe("shutdown", () => {
    it("completes without error when not running", async () => {
      const c = new FirecrawlClient();
      await expect(c.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("scrape", () => {
    it("returns markdown from successful scrape", async () => {
      const mockFetch = createMockFetch({
        "/v1/scrape": () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                markdown: "# Hello World\n\nTest page.",
                metadata: { sourceURL: "https://example.com" },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      });

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);

      const result = await c.scrape("https://example.com");
      expect(result.markdown).toBe("# Hello World\n\nTest page.");
      expect(result.url).toBe("https://example.com");
      c._setRunning(false);
    });

    it("sends correct formats option", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const mockFetch = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (urlStr.includes("/v1/scrape") && init?.body) {
          capturedBody = JSON.parse(init.body as string);
          return new Response(
            JSON.stringify({
              success: true,
              data: { markdown: "test", html: "<p>test</p>", metadata: {} },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("OK", { status: 200 });
      }) as typeof fetch;

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);

      await c.scrape("https://example.com", { formats: ["markdown", "html"] });
      expect(capturedBody?.formats).toEqual(["markdown", "html"]);
      c._setRunning(false);
    });
  });

  describe("crawl", () => {
    it("polls crawl job and returns pages", async () => {
      let pollCount = 0;
      const mockFetch = (async (url: string | URL | Request) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (urlStr.includes("/v1/crawl/job-123")) {
          pollCount++;
          if (pollCount < 2) {
            return new Response(JSON.stringify({ status: "scraping" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({
              status: "completed",
              data: [
                {
                  markdown: "# Page 1",
                  metadata: { sourceURL: "https://example.com/" },
                  statusCode: 200,
                },
                {
                  markdown: "# Page 2",
                  metadata: { sourceURL: "https://example.com/about" },
                  statusCode: 200,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/v1/crawl")) {
          return new Response(JSON.stringify({ id: "job-123" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("OK", { status: 200 });
      }) as typeof fetch;

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);

      const result = await c.crawl("https://example.com", { limit: 10 });
      expect(result.totalPages).toBe(2);
      expect(result.pages[0].markdown).toBe("# Page 1");
      expect(result.pages[1].url).toBe("https://example.com/about");
      expect(result.jobId).toBe("job-123");
      c._setRunning(false);
    });

    it("handles synchronous crawl response", async () => {
      const mockFetch = createMockFetch({
        "/v1/crawl": () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  markdown: "# Sync Page",
                  metadata: { sourceURL: "https://example.com/" },
                  statusCode: 200,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      });

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);

      const result = await c.crawl("https://example.com");
      expect(result.totalPages).toBe(1);
      expect(result.pages[0].markdown).toBe("# Sync Page");
      c._setRunning(false);
    });
  });

  describe("map", () => {
    it("returns discovered URLs", async () => {
      const mockFetch = createMockFetch({
        "/v1/map": () =>
          new Response(
            JSON.stringify({
              links: [
                "https://example.com/",
                "https://example.com/about",
                "https://example.com/blog",
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      });

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);

      const result = await c.map("https://example.com");
      expect(result.urls).toHaveLength(3);
      expect(result.urls).toContain("https://example.com/blog");
      c._setRunning(false);
    });
  });

  describe("search", () => {
    it("returns search results from /v2/search", async () => {
      const mockFetch = createMockFetch({
        "/v2/search": () =>
          new Response(
            JSON.stringify({
              success: true,
              data: [
                {
                  title: "Example Page",
                  url: "https://example.com",
                  markdown: "# Example Content",
                  description: "A test page",
                  metadata: {},
                },
                {
                  title: "Another Page",
                  url: "https://example.org/page",
                  markdown: "# Another Content",
                  metadata: {},
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      });

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);

      const results = await c.search("test query");
      expect(results).toHaveLength(2);
      expect(results[0].title).toBe("Example Page");
      expect(results[0].url).toBe("https://example.com");
      expect(results[0].markdown).toBe("# Example Content");
      expect(results[1].title).toBe("Another Page");
      c._setRunning(false);
    });

    it("throws on empty query", async () => {
      const c = new FirecrawlClient({ enabled: true });
      c._setRunning(true);
      await expect(c.search("")).rejects.toThrow("must not be empty");
      await expect(c.search("   ")).rejects.toThrow("must not be empty");
      c._setRunning(false);
    });

    it("throws when disabled", async () => {
      const c = new FirecrawlClient({ enabled: false });
      await expect(c.search("test")).rejects.toThrow("not enabled");
    });

    it("filters out SSRF URLs from results", async () => {
      const mockFetch = createMockFetch({
        "/v2/search": () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  title: "Safe",
                  url: "https://example.com",
                  markdown: "safe",
                },
                {
                  title: "Internal",
                  url: "http://127.0.0.1/admin",
                  markdown: "internal",
                },
                {
                  title: "Private",
                  url: "http://10.0.0.1/secret",
                  markdown: "private",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      });

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);

      const results = await c.search("test");
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Safe");
      c._setRunning(false);
    });

    it("clamps limit to 1-20 range", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const mockFetch = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (urlStr.includes("/v2/search") && init?.body) {
          capturedBody = JSON.parse(init.body as string);
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("OK", { status: 200 });
      }) as typeof fetch;

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);

      await c.search("test", { limit: 50 });
      expect(capturedBody?.limit).toBe(20);

      await c.search("test", { limit: -5 });
      expect(capturedBody?.limit).toBe(1);

      c._setRunning(false);
    });

    it("passes lang and country options", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const mockFetch = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (urlStr.includes("/v2/search") && init?.body) {
          capturedBody = JSON.parse(init.body as string);
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("OK", { status: 200 });
      }) as typeof fetch;

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);

      await c.search("test", { lang: "en", country: "us" });
      expect(capturedBody?.lang).toBe("en");
      expect(capturedBody?.country).toBe("us");
      c._setRunning(false);
    });

    it("handles empty data response", async () => {
      const mockFetch = createMockFetch({
        "/v2/search": () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      });

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);

      const results = await c.search("test");
      expect(results).toHaveLength(0);
      c._setRunning(false);
    });

    it("handles API errors", async () => {
      const mockFetch = createMockFetch({
        "/v2/search": () =>
          new Response("Internal Server Error", { status: 500 }),
      });

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);

      await expect(c.search("test")).rejects.toThrow("500");
      c._setRunning(false);
    });
  });

  describe("webhook integration", () => {
    it("crawl uses polling instead of webhook for real-time progress", async () => {
      const secret = "test-secret";
      const handler = new FirecrawlWebhookHandler({
        secret,
        port: 3000,
        enabled: true,
        jobTimeoutMs: 50,
      });

      let capturedBody: Record<string, unknown> | undefined;
      const mockFetch = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (urlStr.includes("/v1/crawl") && init?.method === "POST") {
          capturedBody = JSON.parse(init.body as string);
          return new Response(JSON.stringify({ id: "job-poll" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("/v1/crawl/job-poll")) {
          return new Response(
            JSON.stringify({
              status: "completed",
              data: [
                {
                  markdown: "# Page",
                  metadata: { sourceURL: "https://example.com" },
                  statusCode: 200,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);
      c.setWebhookHandler(handler);

      const result = await c.crawl("https://example.com");
      // Crawl should NOT include a webhook URL — it uses polling for progress
      expect(capturedBody?.webhook).toBeUndefined();
      expect(result.pages).toHaveLength(1);

      c._setRunning(false);
      handler.shutdown();
    });

    it("crawl emits progress and completion events via polling", async () => {
      const secret = "test-secret";
      const handler = new FirecrawlWebhookHandler({
        secret,
        port: 3000,
        enabled: true,
        jobTimeoutMs: 5000,
      });

      let pollCount = 0;
      const mockFetch = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (urlStr.includes("/v1/crawl") && init?.method === "POST") {
          return new Response(JSON.stringify({ id: "job-progress" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("/v1/crawl/job-progress")) {
          pollCount++;
          if (pollCount < 3) {
            return new Response(
              JSON.stringify({
                status: "scraping",
                completed: pollCount,
                total: 5,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              status: "completed",
              data: [
                {
                  markdown: "# Polled",
                  metadata: { sourceURL: "https://example.com" },
                  statusCode: 200,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);
      c.setWebhookHandler(handler);

      // Track emitted events
      const progressEvents: unknown[] = [];
      handler.on("crawl:started", () => {});
      handler.on("crawl:progress", (e) => progressEvents.push(e));

      const result = await c.crawl("https://example.com");
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].markdown).toBe("# Polled");
      // Should have emitted progress events during polling
      expect(progressEvents.length).toBeGreaterThan(0);

      c._setRunning(false);
      handler.shutdown();
    });

    it("passes webhook URL to batchScrape when handler is set", async () => {
      const secret = "test-secret";
      const handler = new FirecrawlWebhookHandler({
        secret,
        port: 3000,
        enabled: true,
        jobTimeoutMs: 50,
      });

      let capturedBody: Record<string, unknown> | undefined;
      const mockFetch = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (urlStr.includes("/v1/batch/scrape") && init?.method === "POST") {
          capturedBody = JSON.parse(init.body as string);
          return new Response(JSON.stringify({ id: "batch-wh" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("/v1/batch/scrape/batch-wh")) {
          return new Response(
            JSON.stringify({
              status: "completed",
              data: [
                {
                  markdown: "# Batch",
                  metadata: {},
                  url: "https://example.com",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("OK", { status: 200 });
      }) as typeof fetch;

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);
      c.setWebhookHandler(handler);

      const result = await c.batchScrape(["https://example.com"]);
      expect(capturedBody?.webhook).toContain("/api/webhooks/firecrawl?jobId=");
      expect(result.results).toHaveLength(1);

      c._setRunning(false);
      handler.shutdown();
    });

    it("crawl without webhook handler uses polling as before", async () => {
      let pollCount = 0;
      const mockFetch = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (urlStr.includes("/v1/crawl/job-poll")) {
          pollCount++;
          return new Response(
            JSON.stringify({
              status: "completed",
              data: [
                {
                  markdown: "# Polled",
                  metadata: { sourceURL: "https://example.com" },
                  statusCode: 200,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/v1/crawl") && init?.method === "POST") {
          const body = JSON.parse(init!.body as string);
          expect(body.webhook).toBeUndefined();
          return new Response(JSON.stringify({ id: "job-poll" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("OK", { status: 200 });
      }) as typeof fetch;

      const c = new FirecrawlClient(
        { enabled: true, url: "http://mock:3002" },
        mockFetch,
      );
      c._setRunning(true);
      // No webhook handler set

      const result = await c.crawl("https://example.com");
      expect(pollCount).toBeGreaterThan(0);
      expect(result.pages[0].markdown).toBe("# Polled");

      c._setRunning(false);
    });
  });
});
