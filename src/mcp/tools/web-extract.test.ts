import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWebExtractTool } from "./web-extract.js";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../../browser/firecrawl-client.js", () => {
  const mockClient = {
    getConfig: vi.fn(() => ({ enabled: true, url: "http://localhost:3002", idleTimeoutMs: 600_000 })),
    scrape: vi.fn(async () => ({
      markdown: "# Pricing\n\n- Basic: $10/mo\n- Pro: $25/mo\n- Enterprise: Contact us",
      html: undefined,
      metadata: { title: "Pricing Page" },
      url: "https://example.com/pricing",
    })),
    crawl: vi.fn(async () => ({
      pages: [
        { markdown: "# Page 1\nContent A", url: "https://example.com/a", metadata: {} },
        { markdown: "# Page 2\nContent B", url: "https://example.com/b", metadata: {} },
      ],
      totalPages: 2,
    })),
  };
  return {
    getFirecrawlClient: vi.fn(() => mockClient),
    isBlockedUrl: vi.fn((url: string) => url.includes("127.0.0.1") || url.includes("localhost")),
    __mockClient: mockClient,
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────

function getExtractionsDir(): string {
  return path.join(os.homedir(), ".openzigs", "extractions");
}

function cleanupExtractions(): void {
  const dir = path.join(getExtractionsDir(), "example.com");
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("web-extract tool", () => {
  let tool: ReturnType<typeof createWebExtractTool>;

  beforeEach(() => {
    tool = createWebExtractTool();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupExtractions();
  });

  it("has correct metadata", () => {
    expect(tool.name).toBe("web-extract");
    expect(tool.category).toBe("data");
    expect(tool.riskLevel).toBe("medium");
    expect(tool.inputSchema.required).toContain("url");
  });

  it("blocks SSRF URLs", async () => {
    const result = await tool.handler({ url: "http://127.0.0.1:8080/admin", prompt: "extract" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("SSRF blocked");
  });

  it("requires schema or prompt", async () => {
    const result = await tool.handler({ url: "https://example.com/pricing" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Either 'schema'");
  });

  it("returns Firecrawl disabled error when not enabled", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as { __mockClient: { getConfig: ReturnType<typeof vi.fn> } };
    __mockClient.getConfig.mockReturnValueOnce({ enabled: false, url: "http://localhost:3002", idleTimeoutMs: 600_000 });
    const result = await tool.handler({ url: "https://example.com/pricing", prompt: "extract prices" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not enabled");
  });

  it("scrapes single page and returns extraction content", async () => {
    const result = await tool.handler({
      url: "https://example.com/pricing",
      schema: { prices: [{ name: "string", price: "number" }] },
    });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Web Extract Results");
    expect(result.text).toContain("https://example.com/pricing");
    expect(result.text).toContain("Pages scraped**: 1");
    expect(result.text).toContain("Basic: $10/mo");
    expect(result.text).toContain("extract the structured data");
  });

  it("persists extraction to file", async () => {
    await tool.handler({
      url: "https://example.com/pricing",
      prompt: "extract all prices",
    });
    const dir = path.join(getExtractionsDir(), "example.com");
    expect(fs.existsSync(dir)).toBe(true);
    const files = fs.readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(dir, files[0]), "utf-8");
    expect(content).toContain("Web Extract");
    expect(content).toContain("extract all prices");
  });

  it("supports multi-page crawl", async () => {
    const result = await tool.handler({
      url: "https://example.com",
      prompt: "extract content",
      maxPages: 5,
    });
    expect(result.text).toContain("Pages scraped**: 2");
    expect(result.text).toContain("Page 1");
    expect(result.text).toContain("Page 2");
  });

  it("includes schema in output when provided", async () => {
    const schema = { items: [{ name: "string", price: "number" }] };
    const result = await tool.handler({
      url: "https://example.com/pricing",
      schema,
    });
    expect(result.text).toContain("Extraction Schema");
    expect(result.text).toContain('"items"');
  });

  it("handles scrape errors gracefully", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as { __mockClient: { scrape: ReturnType<typeof vi.fn> } };
    __mockClient.scrape.mockRejectedValueOnce(new Error("Connection refused"));
    const result = await tool.handler({
      url: "https://example.com/pricing",
      prompt: "extract prices",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Connection refused");
  });

  it("passes actions to scrape", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as {
      __mockClient: { scrape: ReturnType<typeof vi.fn> };
    };

    await tool.handler({
      url: "https://example.com/pricing",
      prompt: "extract",
      actions: [{ type: "scroll", direction: "down" }, { type: "wait", milliseconds: 1000 }],
    });

    expect(__mockClient.scrape).toHaveBeenCalledWith(
      "https://example.com/pricing",
      expect.objectContaining({
        actions: [{ type: "scroll", direction: "down" }, { type: "wait", milliseconds: 1000 }],
      }),
    );
  });
});
