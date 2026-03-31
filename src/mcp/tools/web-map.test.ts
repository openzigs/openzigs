import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createWebMapTool, MapRepository } from "./web-map.js";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../../browser/firecrawl-client.js", () => {
  const mockClient = {
    getConfig: vi.fn(() => ({ enabled: true, url: "http://localhost:3002", idleTimeoutMs: 600_000 })),
    map: vi.fn(async () => ({
      urls: [
        "https://example.com/",
        "https://example.com/about",
        "https://example.com/pricing",
        "https://example.com/blog",
        "https://example.com/blog/post-1",
        "https://example.com/blog/post-2",
        "https://example.com/docs/intro",
        "https://example.com/docs/api",
      ],
    })),
  };
  return {
    getFirecrawlClient: vi.fn(() => mockClient),
    isBlockedUrl: vi.fn((url: string) => url.includes("127.0.0.1") || url.includes("localhost")),
    __mockClient: mockClient,
  };
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("web-map tool", () => {
  let tool: ReturnType<typeof createWebMapTool>;
  let repo: MapRepository;

  beforeEach(() => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    repo = new MapRepository(db);
    tool = createWebMapTool(repo);
    vi.clearAllMocks();
  });

  it("has correct metadata", () => {
    expect(tool.name).toBe("web-map");
    expect(tool.category).toBe("data");
    expect(tool.riskLevel).toBe("low");
    expect(tool.inputSchema.required).toContain("url");
  });

  it("blocks SSRF URLs", async () => {
    const result = await tool.handler({ url: "http://127.0.0.1:8080" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("SSRF blocked");
  });

  it("returns error when Firecrawl is disabled", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as { __mockClient: { getConfig: ReturnType<typeof vi.fn> } };
    __mockClient.getConfig.mockReturnValueOnce({ enabled: false, url: "http://localhost:3002", idleTimeoutMs: 600_000 });
    const result = await tool.handler({ url: "https://example.com" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not enabled");
  });

  it("maps a website and returns URLs", async () => {
    const result = await tool.handler({ url: "https://example.com" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Site Map Results");
    expect(result.text).toContain("https://example.com");
    expect(result.text).toContain("URLs discovered**: 8");
  });

  it("saves map results to SQLite", async () => {
    await tool.handler({ url: "https://example.com" });
    const maps = repo.listMaps();
    expect(maps).toHaveLength(1);
    expect(maps[0].rootUrl).toBe("https://example.com");
    expect(maps[0].urlCount).toBe(8);
  });

  it("passes search and limit to Firecrawl", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as {
      __mockClient: { map: ReturnType<typeof vi.fn> };
    };

    await tool.handler({ url: "https://example.com", search: "blog", limit: 50 });

    expect(__mockClient.map).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ search: "blog", limit: 50 }),
    );
  });

  it("filters out subdomains when includeSubdomains is false", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as {
      __mockClient: { map: ReturnType<typeof vi.fn> };
    };
    __mockClient.map.mockResolvedValueOnce({
      urls: [
        "https://example.com/",
        "https://blog.example.com/post-1",
        "https://example.com/about",
      ],
    });

    const result = await tool.handler({ url: "https://example.com", includeSubdomains: false });
    expect(result.text).toContain("URLs discovered**: 2");
    expect(result.text).not.toContain("blog.example.com");
  });

  it("includes subdomains when requested", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as {
      __mockClient: { map: ReturnType<typeof vi.fn> };
    };
    __mockClient.map.mockResolvedValueOnce({
      urls: [
        "https://example.com/",
        "https://blog.example.com/post-1",
      ],
    });

    const result = await tool.handler({ url: "https://example.com", includeSubdomains: true });
    expect(result.text).toContain("URLs discovered**: 2");
    expect(result.text).toContain("blog.example.com");
  });

  it("groups URLs by path section", async () => {
    const result = await tool.handler({ url: "https://example.com" });
    expect(result.text).toContain("/blog");
    expect(result.text).toContain("/docs");
  });

  it("handles map errors gracefully", async () => {
    const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as {
      __mockClient: { map: ReturnType<typeof vi.fn> };
    };
    __mockClient.map.mockRejectedValueOnce(new Error("Timeout"));
    const result = await tool.handler({ url: "https://example.com" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Timeout");
  });

  it("saves search query in SQLite", async () => {
    await tool.handler({ url: "https://example.com", search: "api" });
    const latest = repo.getLatestMap("https://example.com");
    expect(latest).toBeDefined();
    expect(latest!.searchQuery).toBe("api");
  });
});

// ── MapRepository ────────────────────────────────────────────────────────

describe("MapRepository", () => {
  let repo: MapRepository;

  beforeEach(() => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    repo = new MapRepository(db);
  });

  it("creates web_maps table", () => {
    const tables = repo.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='web_maps'",
    ).all();
    expect(tables).toHaveLength(1);
  });

  it("saves and retrieves maps", () => {
    const urls = ["https://a.com/1", "https://a.com/2"];
    const id = repo.saveMap("https://a.com", urls, "test");
    expect(id).toBeGreaterThan(0);

    const latest = repo.getLatestMap("https://a.com");
    expect(latest).toBeDefined();
    expect(latest!.urlCount).toBe(2);
    expect(latest!.searchQuery).toBe("test");
    expect(JSON.parse(latest!.urlsJson!)).toEqual(urls);
  });

  it("lists maps ordered by newest first", () => {
    repo.saveMap("https://a.com", ["u1"]);
    repo.saveMap("https://b.com", ["u1", "u2"]);

    const maps = repo.listMaps();
    expect(maps).toHaveLength(2);
    expect(maps[0].rootUrl).toBe("https://b.com");
  });

  it("returns latest map for a given URL", () => {
    repo.saveMap("https://a.com", ["u1"]);
    repo.saveMap("https://a.com", ["u1", "u2", "u3"]);

    const latest = repo.getLatestMap("https://a.com");
    expect(latest!.urlCount).toBe(3);
  });
});
