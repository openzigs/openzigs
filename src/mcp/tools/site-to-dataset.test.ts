import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSiteToDatasetTool, chunkText } from "./site-to-dataset.js";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../../browser/firecrawl-client.js", () => {
  const mockClient = {
    getConfig: vi.fn(() => ({ enabled: true, url: "http://localhost:3002", idleTimeoutMs: 600_000 })),
    crawl: vi.fn(async () => ({
      pages: [
        { markdown: "# Home\n\nWelcome to Example", url: "https://example.com/", metadata: { title: "Home" } },
        { markdown: "# About\n\nWe are Example Inc", url: "https://example.com/about", metadata: { title: "About" } },
        { markdown: "# Products\n\nProduct A\n\nProduct B", url: "https://example.com/products", metadata: { title: "Products" } },
      ],
      totalPages: 3,
    })),
  };
  return {
    getFirecrawlClient: vi.fn(() => mockClient),
    isBlockedUrl: vi.fn((url: string) => url.includes("127.0.0.1") || url.includes("localhost")),
    __mockClient: mockClient,
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────

function getDatasetsDir(): string {
  return path.join(os.homedir(), ".openzigs", "datasets");
}

function cleanupDatasets(): void {
  const dir = path.join(getDatasetsDir(), "example.com");
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("site-to-dataset tool", () => {
  let tool: ReturnType<typeof createSiteToDatasetTool>;

  beforeEach(() => {
    tool = createSiteToDatasetTool();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupDatasets();
  });

  it("has correct metadata", () => {
    expect(tool.name).toBe("site-to-dataset");
    expect(tool.category).toBe("data");
    expect(tool.riskLevel).toBe("medium");
    expect(tool.inputSchema.required).toContain("url");
  });

  it("blocks SSRF URLs", async () => {
    const result = await tool.handler({ url: "http://127.0.0.1:8080/admin" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("SSRF blocked");
  });

  it("returns error when Firecrawl disabled", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as { __mockClient: { getConfig: ReturnType<typeof vi.fn> } };
    __mockClient.getConfig.mockReturnValueOnce({ enabled: false, url: "http://localhost:3002", idleTimeoutMs: 600_000 });
    const result = await tool.handler({ url: "https://example.com" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not enabled");
  });

  it("crawls site and saves as markdown", async () => {
    const result = await tool.handler({ url: "https://example.com", format: "markdown" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Site-to-Dataset Results");
    expect(result.text).toContain("Pages crawled**: 3");
    expect(result.text).toContain("Format**: markdown");

    // Verify files were created
    const datasetsDir = getDatasetsDir();
    const domainDirs = fs.readdirSync(path.join(datasetsDir, "example.com"));
    expect(domainDirs.length).toBeGreaterThan(0);

    const outputDir = path.join(datasetsDir, "example.com", domainDirs[0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf-8"));
    expect(manifest.pageCount).toBe(3);
    expect(manifest.format).toBe("markdown");
    expect(manifest.files.length).toBe(3);
  });

  it("creates JSONL output", async () => {
    const result = await tool.handler({ url: "https://example.com", format: "jsonl", chunkSize: 500 });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Format**: jsonl");

    const datasetsDir = getDatasetsDir();
    const domainDirs = fs.readdirSync(path.join(datasetsDir, "example.com"));
    const outputDir = path.join(datasetsDir, "example.com", domainDirs[0]);
    const jsonlContent = fs.readFileSync(path.join(outputDir, "dataset.jsonl"), "utf-8");
    const lines = jsonlContent.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]);
    expect(first).toHaveProperty("url");
    expect(first).toHaveProperty("content");
    expect(first).toHaveProperty("chunk_index");
  });

  it("creates CSV output", async () => {
    const result = await tool.handler({ url: "https://example.com", format: "csv" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Format**: csv");

    const datasetsDir = getDatasetsDir();
    const domainDirs = fs.readdirSync(path.join(datasetsDir, "example.com"));
    const outputDir = path.join(datasetsDir, "example.com", domainDirs[0]);
    const csvContent = fs.readFileSync(path.join(outputDir, "dataset.csv"), "utf-8");
    expect(csvContent).toContain("url,title,word_count,content");
  });

  it("handles empty crawl results", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as { __mockClient: { crawl: ReturnType<typeof vi.fn> } };
    __mockClient.crawl.mockResolvedValueOnce({ pages: [], totalPages: 0 });
    const result = await tool.handler({ url: "https://example.com" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("No pages crawled");
  });

  it("passes crawl options correctly", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as {
      __mockClient: { crawl: ReturnType<typeof vi.fn> };
    };

    await tool.handler({
      url: "https://example.com",
      maxPages: 10,
      maxDepth: 2,
      includePaths: ["/docs"],
      excludePaths: ["/blog"],
    });

    expect(__mockClient.crawl).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        limit: 10,
        maxDepth: 2,
        includePaths: ["/docs"],
        excludePaths: ["/blog"],
      }),
    );
  });

  it("handles crawl errors gracefully", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as { __mockClient: { crawl: ReturnType<typeof vi.fn> } };
    __mockClient.crawl.mockRejectedValueOnce(new Error("Docker unavailable"));
    const result = await tool.handler({ url: "https://example.com" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Docker unavailable");
  });
});

describe("chunkText", () => {
  it("chunks text by paragraph boundaries", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const chunks = chunkText(text, 30);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toContain("Paragraph one");
  });

  it("handles single paragraph longer than chunk size", () => {
    const text = "a".repeat(200);
    const chunks = chunkText(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("returns empty array for empty text", () => {
    const chunks = chunkText("", 100);
    expect(chunks).toHaveLength(0);
  });

  it("keeps paragraphs together when possible", () => {
    const text = "Short.\n\nAlso short.";
    const chunks = chunkText(text, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Short.");
    expect(chunks[0]).toContain("Also short.");
  });
});
