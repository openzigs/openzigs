import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { CompetitorRepository, computeDiff, computeContentDiff, aggregatePages, createCompetitorMonitorTool, type CompetitorSnapshot } from "./competitive-monitor.js";
import type { ExtractedContent } from "./seo/html-extractor.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeInMemoryRepo(): CompetitorRepository {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return new CompetitorRepository(db);
}

function makeContent(overrides: Partial<ExtractedContent> = {}): ExtractedContent {
  return {
    title: "Test",
    headings: [{ level: 1, text: "Test" }],
    bodyText: "word ".repeat(500),
    wordCount: 500,
    headingCount: 1,
    paragraphCount: 3,
    readingTime: 2,
    keywords: [{ term: "test", tfidf: 5 }, { term: "page", tfidf: 3 }],
    readabilityScore: 65,
    metaTitle: "Test Page",
    metaDescription: "A test page",
    metaTags: [],
    images: [],
    imagesWithoutAlt: 0,
    imagesMissingAlt: 0,
    imagesEmptyAlt: 0,
    imagesAriaHidden: 0,
    imagesLazyLoaded: 0,
    schemaMarkup: [{ type: "WebPage", properties: ["name"] }],
    internalLinks: [],
    externalLinks: [],
    internalLinkCount: 0,
    externalLinkCount: 0,
    ...overrides,
  };
}

// ── CompetitorRepository ─────────────────────────────────────────────────

describe("CompetitorRepository", () => {
  let repo: CompetitorRepository;

  beforeEach(() => {
    repo = makeInMemoryRepo();
  });

  it("adds and lists competitors", () => {
    repo.addCompetitor("https://competitor1.com", "Comp 1");
    repo.addCompetitor("https://competitor2.com");

    const list = repo.listCompetitors();
    expect(list).toHaveLength(2);
    expect(list[0].url).toBe("https://competitor1.com");
    expect(list[0].name).toBe("Comp 1");
    expect(list[1].name).toBeNull();
  });

  it("removes a competitor", () => {
    repo.addCompetitor("https://competitor1.com");
    expect(repo.removeCompetitor("https://competitor1.com")).toBe(true);
    expect(repo.listCompetitors()).toHaveLength(0);
  });

  it("returns false when removing non-existent competitor", () => {
    expect(repo.removeCompetitor("https://nonexistent.com")).toBe(false);
  });

  it("ignores duplicate adds", () => {
    repo.addCompetitor("https://competitor1.com");
    repo.addCompetitor("https://competitor1.com");
    expect(repo.listCompetitors()).toHaveLength(1);
  });

  it("saves and retrieves snapshots", () => {
    repo.addCompetitor("https://competitor1.com");
    repo.saveSnapshot("https://competitor1.com", {
      pageCount: 10,
      totalWordCount: 5000,
      avgReadability: 65.5,
      schemaTypes: '["WebPage"]',
      topKeywords: '["test","page"]',
      metaTitles: '["Home","About"]',
    });

    const snapshots = repo.getLatestSnapshots("https://competitor1.com");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].pageCount).toBe(10);
    expect(snapshots[0].totalWordCount).toBe(5000);
  });

  it("returns snapshots in reverse chronological order", () => {
    repo.addCompetitor("https://competitor1.com");
    repo.saveSnapshot("https://competitor1.com", {
      pageCount: 10,
      totalWordCount: 5000,
      avgReadability: 65,
      schemaTypes: "[]",
      topKeywords: "[]",
      metaTitles: "[]",
    });
    repo.saveSnapshot("https://competitor1.com", {
      pageCount: 15,
      totalWordCount: 7500,
      avgReadability: 70,
      schemaTypes: '["Article"]',
      topKeywords: "[]",
      metaTitles: "[]",
    });

    const snapshots = repo.getLatestSnapshots("https://competitor1.com", 2);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].pageCount).toBe(15); // newest first
    expect(snapshots[1].pageCount).toBe(10);
  });
});

// ── computeDiff ──────────────────────────────────────────────────────────

describe("computeDiff", () => {
  const base: CompetitorSnapshot = {
    id: 1,
    competitorUrl: "https://example.com",
    capturedAt: "2024-01-01",
    pageCount: 10,
    totalWordCount: 5000,
    avgReadability: 65,
    schemaTypes: '["WebPage"]',
    topKeywords: '["test"]',
    metaTitles: '["Home"]',
  };

  it("detects page count increase", () => {
    const current = { ...base, id: 2, pageCount: 15 };
    const changes = computeDiff(current, base);
    expect(changes).toContainEqual(
      expect.objectContaining({ field: "pageCount", direction: "increased" }),
    );
  });

  it("detects word count decrease", () => {
    const current = { ...base, id: 2, totalWordCount: 3000 };
    const changes = computeDiff(current, base);
    expect(changes).toContainEqual(
      expect.objectContaining({ field: "totalWordCount", direction: "decreased" }),
    );
  });

  it("detects readability change", () => {
    const current = { ...base, id: 2, avgReadability: 80 };
    const changes = computeDiff(current, base);
    expect(changes).toContainEqual(
      expect.objectContaining({ field: "avgReadability", direction: "increased" }),
    );
  });

  it("ignores small readability changes", () => {
    const current = { ...base, id: 2, avgReadability: 65.5 };
    const changes = computeDiff(current, base);
    expect(changes.find((c) => c.field === "avgReadability")).toBeUndefined();
  });

  it("detects schema type changes", () => {
    const current = { ...base, id: 2, schemaTypes: '["Article", "WebPage"]' };
    const changes = computeDiff(current, base);
    expect(changes).toContainEqual(
      expect.objectContaining({ field: "schemaTypes", direction: "changed" }),
    );
  });

  it("returns empty array for identical snapshots", () => {
    const changes = computeDiff(base, base);
    expect(changes).toHaveLength(0);
  });
});

// ── aggregatePages ───────────────────────────────────────────────────────

describe("aggregatePages", () => {
  it("aggregates metrics from multiple pages", () => {
    const pages = [
      makeContent({ wordCount: 500, readabilityScore: 60, schemaMarkup: [{ type: "WebPage", properties: [] }] }),
      makeContent({ wordCount: 300, readabilityScore: 70, schemaMarkup: [{ type: "Article", properties: [] }] }),
    ];

    const result = aggregatePages(pages);
    expect(result.pageCount).toBe(2);
    expect(result.totalWordCount).toBe(800);
    expect(result.avgReadability).toBe(65);
    expect(JSON.parse(result.schemaTypes)).toContain("WebPage");
    expect(JSON.parse(result.schemaTypes)).toContain("Article");
  });

  it("handles empty pages array", () => {
    const result = aggregatePages([]);
    expect(result.pageCount).toBe(0);
    expect(result.totalWordCount).toBe(0);
    expect(result.avgReadability).toBe(0);
  });

  it("deduplicates schema types", () => {
    const pages = [
      makeContent({ schemaMarkup: [{ type: "WebPage", properties: [] }] }),
      makeContent({ schemaMarkup: [{ type: "WebPage", properties: [] }] }),
    ];
    const result = aggregatePages(pages);
    expect(JSON.parse(result.schemaTypes)).toEqual(["WebPage"]);
  });
});

// ── createCompetitorMonitorTool ──────────────────────────────────────────

describe("createCompetitorMonitorTool", () => {
  it("creates tool with correct metadata", () => {
    const repo = makeInMemoryRepo();
    const tool = createCompetitorMonitorTool(repo);
    expect(tool.name).toBe("competitive-monitor");
    expect(tool.category).toBe("search");
    expect(tool.inputSchema.required).toContain("action");
  });

  it("add action adds a competitor", async () => {
    const repo = makeInMemoryRepo();
    const tool = createCompetitorMonitorTool(repo);
    const result = await tool.handler({ action: "add", url: "https://example.com", name: "Example" });
    expect(result.text).toContain("Added competitor");
    expect(repo.listCompetitors()).toHaveLength(1);
  });

  it("add action blocks SSRF URLs", async () => {
    const repo = makeInMemoryRepo();
    const tool = createCompetitorMonitorTool(repo);
    const result = await tool.handler({ action: "add", url: "http://localhost/admin" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("SSRF blocked");
  });

  it("remove action removes a competitor", async () => {
    const repo = makeInMemoryRepo();
    repo.addCompetitor("https://example.com");
    const tool = createCompetitorMonitorTool(repo);
    const result = await tool.handler({ action: "remove", url: "https://example.com" });
    expect(result.text).toContain("Removed");
  });

  it("list action lists competitors", async () => {
    const repo = makeInMemoryRepo();
    repo.addCompetitor("https://example.com", "Example");
    const tool = createCompetitorMonitorTool(repo);
    const result = await tool.handler({ action: "list" });
    expect(result.text).toContain("example.com");
  });

  it("list action handles empty list", async () => {
    const repo = makeInMemoryRepo();
    const tool = createCompetitorMonitorTool(repo);
    const result = await tool.handler({ action: "list" });
    expect(result.text).toContain("No competitors");
  });

  it("report action with no snapshots", async () => {
    const repo = makeInMemoryRepo();
    repo.addCompetitor("https://example.com");
    const tool = createCompetitorMonitorTool(repo);
    const result = await tool.handler({ action: "report", url: "https://example.com" });
    expect(result.text).toContain("No snapshots");
  });

  it("report action with single snapshot", async () => {
    const repo = makeInMemoryRepo();
    repo.addCompetitor("https://example.com");
    repo.saveSnapshot("https://example.com", {
      pageCount: 10,
      totalWordCount: 5000,
      avgReadability: 65,
      schemaTypes: "[]",
      topKeywords: "[]",
      metaTitles: "[]",
    });
    const tool = createCompetitorMonitorTool(repo);
    const result = await tool.handler({ action: "report", url: "https://example.com" });
    expect(result.text).toContain("baseline");
  });

  it("report action with two snapshots shows diff", async () => {
    const repo = makeInMemoryRepo();
    repo.addCompetitor("https://example.com");
    repo.saveSnapshot("https://example.com", {
      pageCount: 10,
      totalWordCount: 5000,
      avgReadability: 65,
      schemaTypes: '["WebPage"]',
      topKeywords: "[]",
      metaTitles: "[]",
    });
    repo.saveSnapshot("https://example.com", {
      pageCount: 15,
      totalWordCount: 7500,
      avgReadability: 65,
      schemaTypes: '["WebPage"]',
      topKeywords: "[]",
      metaTitles: "[]",
    });
    const tool = createCompetitorMonitorTool(repo);
    const result = await tool.handler({ action: "report", url: "https://example.com" });
    expect(result.text).toContain("pageCount");
    expect(result.text).toContain("increased");
  });

  it("snapshot action returns error when firecrawl not enabled", async () => {
    const repo = makeInMemoryRepo();
    repo.addCompetitor("https://example.com");
    const tool = createCompetitorMonitorTool(repo);
    const result = await tool.handler({ action: "snapshot", url: "https://example.com" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not enabled");
  });

  it("report action includes content diff when extracted data exists", async () => {
    const repo = makeInMemoryRepo();
    repo.addCompetitor("https://example.com");
    repo.saveSnapshot("https://example.com", {
      pageCount: 10,
      totalWordCount: 5000,
      avgReadability: 65,
      schemaTypes: "[]",
      topKeywords: "[]",
      metaTitles: "[]",
    }, { price: "$10", plan: "Basic" });
    repo.saveSnapshot("https://example.com", {
      pageCount: 10,
      totalWordCount: 5000,
      avgReadability: 65,
      schemaTypes: "[]",
      topKeywords: "[]",
      metaTitles: "[]",
    }, { price: "$15", plan: "Basic" });
    const tool = createCompetitorMonitorTool(repo);
    const result = await tool.handler({ action: "report", url: "https://example.com" });
    expect(result.text).toContain("extracted.price");
    expect(result.text).toContain("changed");
  });
});

// ── computeContentDiff ───────────────────────────────────────────────────

describe("computeContentDiff", () => {
  it("returns empty array when both are null", () => {
    expect(computeContentDiff(null, null)).toEqual([]);
  });

  it("returns empty when one side is null", () => {
    expect(computeContentDiff({ a: 1 }, null)).toEqual([]);
    expect(computeContentDiff(null, { a: 1 })).toEqual([]);
  });

  it("detects field value changes", () => {
    const changes = computeContentDiff(
      { price: "$15", plan: "Pro" },
      { price: "$10", plan: "Pro" },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe("extracted.price");
    expect(changes[0].direction).toBe("changed");
  });

  it("detects numeric increases", () => {
    const changes = computeContentDiff(
      { count: 20 },
      { count: 10 },
    );
    expect(changes[0].direction).toBe("increased");
  });

  it("detects numeric decreases", () => {
    const changes = computeContentDiff(
      { count: 5 },
      { count: 10 },
    );
    expect(changes[0].direction).toBe("decreased");
  });

  it("detects added keys", () => {
    const changes = computeContentDiff(
      { a: 1, b: 2 },
      { a: 1 },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe("extracted.b");
    expect(changes[0].previous).toBe("(not present)");
  });

  it("detects removed keys", () => {
    const changes = computeContentDiff(
      { a: 1 },
      { a: 1, b: 2 },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe("extracted.b");
    expect(changes[0].current).toBe("(removed)");
  });

  it("returns empty for identical objects", () => {
    expect(computeContentDiff({ a: 1, b: "x" }, { a: 1, b: "x" })).toEqual([]);
  });
});
