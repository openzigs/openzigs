import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFirecrawlSearchTool } from "./firecrawl-search.js";

// ── Mocks ────────────────────────────────────────────────────────────────

const mockClient = {
  getConfig: vi.fn(() => ({
    enabled: true,
    url: "http://localhost:3002",
    idleTimeoutMs: 600_000,
  })),
  isAvailable: vi.fn(async () => true),
  search: vi.fn(async () => [
    {
      title: "Example Page",
      url: "https://example.com",
      markdown: "# Example\n\nSome content here",
      description: "An example page",
      metadata: { sourceURL: "https://example.com" },
    },
    {
      title: "Another Result",
      url: "https://example.org/page",
      markdown: "# Another\n\nMore content",
      description: undefined,
      metadata: {},
    },
  ]),
};

vi.mock("../../browser/firecrawl-client.js", () => ({
  getFirecrawlClient: vi.fn(() => mockClient),
  isBlockedUrl: vi.fn(
    (url: string) => url.includes("127.0.0.1") || url.includes("localhost"),
  ),
}));

// ── Tests ────────────────────────────────────────────────────────────────

describe("firecrawl-search tool", () => {
  let tool: ReturnType<typeof createFirecrawlSearchTool>;

  beforeEach(() => {
    tool = createFirecrawlSearchTool();
    vi.clearAllMocks();
    mockClient.getConfig.mockReturnValue({
      enabled: true,
      url: "http://localhost:3002",
      idleTimeoutMs: 600_000,
    });
    mockClient.isAvailable.mockResolvedValue(true);
    mockClient.search.mockResolvedValue([
      {
        title: "Example Page",
        url: "https://example.com",
        markdown: "# Example\n\nSome content here",
        description: "An example page",
        metadata: { sourceURL: "https://example.com" },
      },
      {
        title: "Another Result",
        url: "https://example.org/page",
        markdown: "# Another\n\nMore content",
        description: undefined,
        metadata: {},
      },
    ]);
  });

  it("has correct metadata", () => {
    expect(tool.name).toBe("firecrawl-search");
    expect(tool.category).toBe("search");
    expect(tool.riskLevel).toBe("low");
    expect(tool.inputSchema.required).toContain("query");
  });

  it("returns error when Firecrawl is not enabled", async () => {
    mockClient.getConfig.mockReturnValue({
      enabled: false,
      url: "http://localhost:3002",
      idleTimeoutMs: 600_000,
    });
    const result = await tool.handler({ query: "test query" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not enabled");
  });

  it("returns error when sidecar is not available", async () => {
    mockClient.isAvailable.mockResolvedValue(false);
    const result = await tool.handler({ query: "test query" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not running");
  });

  it("returns formatted results on success", async () => {
    const result = await tool.handler({ query: "test query" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Firecrawl Search Results");
    expect(result.text).toContain("test query");
    expect(result.text).toContain("Example Page");
    expect(result.text).toContain("https://example.com");
    expect(result.text).toContain("Another Result");
    expect(result.text).toContain("Results**: 2");
  });

  it("passes options to client.search()", async () => {
    await tool.handler({ query: "test", limit: 10, lang: "en", country: "us" });
    expect(mockClient.search).toHaveBeenCalledWith("test", {
      limit: 10,
      lang: "en",
      country: "us",
    });
  });

  it("returns 'no results' message when search returns empty", async () => {
    mockClient.search.mockResolvedValue([]);
    const result = await tool.handler({ query: "nothing found" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("No results found");
    expect(result.text).toContain("nothing found");
  });

  it("handles search errors gracefully", async () => {
    mockClient.search.mockRejectedValue(new Error("Network timeout"));
    const result = await tool.handler({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Network timeout");
  });

  it("truncates long markdown in results", async () => {
    const longMarkdown = "A".repeat(600);
    mockClient.search.mockResolvedValue([
      {
        title: "Long",
        url: "https://example.com/long",
        markdown: longMarkdown,
        description: undefined,
        metadata: {},
      },
    ]);
    const result = await tool.handler({ query: "long content" });
    expect(result.text).toContain("...");
    expect(result.text.length).toBeLessThan(longMarkdown.length + 200);
  });

  it("includes description when present", async () => {
    const result = await tool.handler({ query: "test" });
    expect(result.text).toContain("An example page");
  });
});
