import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { PriceSnapshotRepository, createPriceMonitorTool } from "./price-monitor.js";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../../browser/firecrawl-client.js", () => {
  const mockClient = {
    getConfig: vi.fn(() => ({ enabled: true, url: "http://localhost:3002", idleTimeoutMs: 600_000 })),
    scrape: vi.fn(async () => ({
      markdown: "# Pricing\n\n- Basic: $10/mo\n- Pro: $25/mo\n- Enterprise: Contact us",
      html: undefined,
      metadata: { title: "Pricing" },
      url: "https://example.com/pricing",
    })),
  };
  return {
    getFirecrawlClient: vi.fn(() => mockClient),
    isBlockedUrl: vi.fn((url: string) => url.includes("127.0.0.1") || url.includes("localhost")),
    __mockClient: mockClient,
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────

function makeInMemoryRepo(): PriceSnapshotRepository {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  return new PriceSnapshotRepository(db);
}

// ── PriceSnapshotRepository ──────────────────────────────────────────────

describe("PriceSnapshotRepository", () => {
  let repo: PriceSnapshotRepository;

  beforeEach(() => {
    repo = makeInMemoryRepo();
  });

  it("saves and retrieves snapshots", () => {
    const snapshot = repo.saveSnapshot("https://example.com/pricing", "# Pricing\nBasic: $10", "Example Pricing");
    expect(snapshot.id).toBe(1);
    expect(snapshot.url).toBe("https://example.com/pricing");
    expect(snapshot.label).toBe("Example Pricing");
    expect(snapshot.priceHash).toBeTruthy();
    expect(snapshot.capturedAt).toBeTruthy();
  });

  it("retrieves latest snapshots in order", () => {
    repo.saveSnapshot("https://example.com/pricing", "Version 1");
    repo.saveSnapshot("https://example.com/pricing", "Version 2");
    repo.saveSnapshot("https://example.com/pricing", "Version 3");

    const snapshots = repo.getLatestSnapshots("https://example.com/pricing", 2);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].id).toBe(3);
    expect(snapshots[1].id).toBe(2);
  });

  it("lists monitored URLs", () => {
    repo.saveSnapshot("https://a.com/pricing", "A content");
    repo.saveSnapshot("https://b.com/pricing", "B content", "B Pricing");
    repo.saveSnapshot("https://a.com/pricing", "A content v2");

    const urls = repo.listMonitoredUrls();
    expect(urls).toHaveLength(2);
    expect(urls[0].snapshotCount).toBe(2);
  });

  it("generates different hashes for different content", () => {
    const s1 = repo.saveSnapshot("https://example.com/pricing", "Content A");
    const s2 = repo.saveSnapshot("https://example.com/pricing", "Content B");
    expect(s1.priceHash).not.toBe(s2.priceHash);
  });

  it("generates same hash for same content", () => {
    const content = "Identical content";
    const s1 = repo.saveSnapshot("https://example.com/pricing", content);
    const s2 = repo.saveSnapshot("https://example.com/pricing2", content);
    expect(s1.priceHash).toBe(s2.priceHash);
  });
});

// ── Price Monitor Tool ───────────────────────────────────────────────────

describe("price-monitor tool", () => {
  let tool: ReturnType<typeof createPriceMonitorTool>;
  let repo: PriceSnapshotRepository;

  beforeEach(() => {
    repo = makeInMemoryRepo();
    tool = createPriceMonitorTool(repo);
    vi.clearAllMocks();
  });

  it("has correct metadata", () => {
    expect(tool.name).toBe("price-monitor");
    expect(tool.category).toBe("data");
    expect(tool.riskLevel).toBe("medium");
  });

  describe("snapshot action", () => {
    it("blocks SSRF URLs", async () => {
      const result = await tool.handler({ action: "snapshot", url: "http://127.0.0.1:8080/" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("SSRF blocked");
    });

    it("returns error when Firecrawl disabled", async () => {
      const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as { __mockClient: { getConfig: ReturnType<typeof vi.fn> } };
      __mockClient.getConfig.mockReturnValueOnce({ enabled: false, url: "http://localhost:3002", idleTimeoutMs: 600_000 });
      const result = await tool.handler({ action: "snapshot", url: "https://example.com/pricing" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not enabled");
    });

    it("captures a price snapshot and saves to DB", async () => {
      const result = await tool.handler({ action: "snapshot", url: "https://example.com/pricing", label: "Test" });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("Price Snapshot Captured");
      expect(result.text).toContain("Snapshot ID**: 1");
      expect(result.text).toContain("Basic: $10/mo");

      const snapshots = repo.getLatestSnapshots("https://example.com/pricing");
      expect(snapshots).toHaveLength(1);
    });

    it("detects changes between snapshots", async () => {
      // Save an initial snapshot with different content
      repo.saveSnapshot("https://example.com/pricing", "Old content");

      const result = await tool.handler({ action: "snapshot", url: "https://example.com/pricing" });
      expect(result.text).toContain("CHANGE DETECTED");
    });

    it("reports no change when content is identical", async () => {
      repo.saveSnapshot("https://example.com/pricing", "# Pricing\n\n- Basic: $10/mo\n- Pro: $25/mo\n- Enterprise: Contact us");

      const result = await tool.handler({ action: "snapshot", url: "https://example.com/pricing" });
      expect(result.text).toContain("No change");
    });

    it("adds scroll actions when scrollToLoad is true", async () => {
      const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as {
        __mockClient: { scrape: ReturnType<typeof vi.fn> };
      };

      await tool.handler({ action: "snapshot", url: "https://example.com/pricing", scrollToLoad: true });

      expect(__mockClient.scrape).toHaveBeenCalledWith(
        "https://example.com/pricing",
        expect.objectContaining({
          actions: expect.arrayContaining([
            expect.objectContaining({ type: "scroll", direction: "down" }),
          ]),
        }),
      );
    });

    it("handles scrape errors gracefully", async () => {
      const { __mockClient } = await import("../../browser/firecrawl-client.js") as unknown as { __mockClient: { scrape: ReturnType<typeof vi.fn> } };
      __mockClient.scrape.mockRejectedValueOnce(new Error("Timeout"));
      const result = await tool.handler({ action: "snapshot", url: "https://example.com/pricing" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Timeout");
    });
  });

  describe("compare action", () => {
    it("requires at least 2 snapshots", async () => {
      const result = await tool.handler({ action: "compare", url: "https://example.com/pricing" });
      expect(result.text).toContain("Need at least 2 snapshots");
    });

    it("compares two snapshots", async () => {
      repo.saveSnapshot("https://example.com/pricing", "Content v1");
      repo.saveSnapshot("https://example.com/pricing", "Content v2");

      const result = await tool.handler({ action: "compare", url: "https://example.com/pricing" });
      expect(result.text).toContain("Price Comparison");
      expect(result.text).toContain("Content changed");
    });
  });

  describe("history action", () => {
    it("returns empty when no snapshots", async () => {
      const result = await tool.handler({ action: "history", url: "https://example.com/pricing" });
      expect(result.text).toContain("No snapshots found");
    });

    it("returns history table", async () => {
      repo.saveSnapshot("https://example.com/pricing", "V1");
      repo.saveSnapshot("https://example.com/pricing", "V2");

      const result = await tool.handler({ action: "history", url: "https://example.com/pricing" });
      expect(result.text).toContain("Price History");
      expect(result.text).toContain("Snapshots**: 2");
    });
  });

  describe("list action", () => {
    it("returns empty when no urls", async () => {
      const result = await tool.handler({ action: "list" });
      expect(result.text).toContain("No URLs being monitored");
    });

    it("lists monitored URLs", async () => {
      repo.saveSnapshot("https://example.com/pricing", "Content");
      repo.saveSnapshot("https://other.com/plans", "Plans", "Other Plans");

      const result = await tool.handler({ action: "list" });
      expect(result.text).toContain("Monitored Price URLs");
      expect(result.text).toContain("example.com");
      expect(result.text).toContain("other.com");
    });
  });
});
