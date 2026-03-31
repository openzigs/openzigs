import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLeadExtractTool, filterContactUrls, CONTACT_SCHEMA } from "./lead-extract.js";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../../browser/firecrawl-client.js", () => {
  const mockClient = {
    getConfig: vi.fn(() => ({ enabled: true, url: "http://localhost:3002", idleTimeoutMs: 600_000 })),
    map: vi.fn(async () => ({
      urls: [
        "https://acme.com/",
        "https://acme.com/about",
        "https://acme.com/team",
        "https://acme.com/contact",
        "https://acme.com/products",
        "https://acme.com/leadership",
        "https://acme.com/blog",
      ],
    })),
    batchScrape: vi.fn(async (urls: string[]) => ({
      results: urls.map((u) => ({
        markdown: `# Content for ${u}\n\nJohn Doe - CEO\njohn@acme.com`,
        url: u,
        metadata: {},
      })),
      totalUrls: urls.length,
    })),
  };
  return {
    getFirecrawlClient: vi.fn(() => mockClient),
    isBlockedUrl: vi.fn((url: string) => url.includes("127.0.0.1") || url.includes("localhost")),
    __mockClient: mockClient,
  };
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("lead-extract tool", () => {
  let tool: ReturnType<typeof createLeadExtractTool>;

  beforeEach(() => {
    tool = createLeadExtractTool();
    vi.clearAllMocks();
  });

  it("has correct metadata", () => {
    expect(tool.name).toBe("lead-extract");
    expect(tool.category).toBe("data");
    expect(tool.riskLevel).toBe("medium");
    expect(tool.inputSchema.required).toContain("url");
  });

  it("blocks SSRF URLs", async () => {
    const result = await tool.handler({ url: "http://127.0.0.1:8080/admin" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("SSRF blocked");
  });

  it("returns error when Firecrawl is disabled", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as { __mockClient: { getConfig: ReturnType<typeof vi.fn> } };
    __mockClient.getConfig.mockReturnValueOnce({ enabled: false, url: "http://localhost:3002", idleTimeoutMs: 600_000 });
    const result = await tool.handler({ url: "https://acme.com" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not enabled");
  });

  it("maps site and extracts contact pages", async () => {
    const result = await tool.handler({ url: "https://acme.com" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Lead Extract Results");
    expect(result.text).toContain("Total URLs discovered**: 7");
    expect(result.text).toContain("Contact pages found");
    expect(result.text).toContain("John Doe");
    expect(result.text).toContain("Contact Extraction Schema");
  });

  it("respects maxPages limit", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as {
      __mockClient: { batchScrape: ReturnType<typeof vi.fn> };
    };

    await tool.handler({ url: "https://acme.com", maxPages: 2 });

    const batchArgs = __mockClient.batchScrape.mock.calls[0][0] as string[];
    expect(batchArgs.length).toBeLessThanOrEqual(2);
  });

  it("handles empty map results", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as { __mockClient: { map: ReturnType<typeof vi.fn> } };
    __mockClient.map.mockResolvedValueOnce({ urls: [] });
    const result = await tool.handler({ url: "https://acme.com" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("No pages found");
  });

  it("includes custom URL patterns", async () => {
    const result = await tool.handler({
      url: "https://acme.com",
      includePatterns: ["products"],
    });
    expect(result.isError).toBeUndefined();
  });

  it("handles scrape errors gracefully", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as {
      __mockClient: { batchScrape: ReturnType<typeof vi.fn> };
    };
    __mockClient.batchScrape.mockRejectedValueOnce(new Error("Batch failed"));
    const result = await tool.handler({ url: "https://acme.com" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Batch failed");
  });
});

describe("filterContactUrls", () => {
  const urls = [
    "https://acme.com/",
    "https://acme.com/about",
    "https://acme.com/team",
    "https://acme.com/contact",
    "https://acme.com/products",
    "https://acme.com/leadership",
    "https://acme.com/blog/post-1",
  ];

  it("filters for contact-related pages", () => {
    const result = filterContactUrls(urls);
    expect(result).toContain("https://acme.com/about");
    expect(result).toContain("https://acme.com/team");
    expect(result).toContain("https://acme.com/contact");
    expect(result).toContain("https://acme.com/leadership");
    expect(result).not.toContain("https://acme.com/blog/post-1");
  });

  it("supports additional patterns", () => {
    const result = filterContactUrls(urls, ["products"]);
    expect(result).toContain("https://acme.com/products");
  });

  it("handles malformed URLs", () => {
    const result = filterContactUrls(["not-a-url", ...urls]);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("CONTACT_SCHEMA", () => {
  it("has contacts and company fields", () => {
    expect(CONTACT_SCHEMA.contacts).toBeDefined();
    expect(CONTACT_SCHEMA.company).toBeDefined();
    expect(CONTACT_SCHEMA.contacts[0]).toHaveProperty("name");
    expect(CONTACT_SCHEMA.company).toHaveProperty("name");
  });
});
