import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  aggregateKeywords,
  discoverCompetitorsFromAudit,
  type AuditPageInput,
} from "./competitive-discover.js";

// Mock the competitor-discovery module
vi.mock("./competitor-discovery.js", () => ({
  discoverCompetitors: vi.fn(),
}));

import { discoverCompetitors } from "./competitor-discovery.js";
const mockDiscover = vi.mocked(discoverCompetitors);

describe("aggregateKeywords", () => {
  it("sums scores for the same keyword across pages", () => {
    const pages: AuditPageInput[] = [
      {
        url: "https://example.com/a",
        keywords: [
          { word: "react", score: 5 },
          { word: "node", score: 3 },
        ],
      },
      {
        url: "https://example.com/b",
        keywords: [
          { word: "react", score: 7 },
          { word: "vue", score: 2 },
        ],
      },
    ];
    const result = aggregateKeywords(pages, 10);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ word: "react", score: 12 });
    expect(result[1]).toEqual({ word: "node", score: 3 });
    expect(result[2]).toEqual({ word: "vue", score: 2 });
  });

  it("normalizes keywords to lowercase", () => {
    const pages: AuditPageInput[] = [
      { url: "https://x.com", keywords: [{ word: "React", score: 5 }] },
      { url: "https://y.com", keywords: [{ word: "REACT", score: 3 }] },
    ];
    const result = aggregateKeywords(pages, 10);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ word: "react", score: 8 });
  });

  it("limits to maxKeywords", () => {
    const pages: AuditPageInput[] = [
      {
        url: "https://x.com",
        keywords: [
          { word: "a", score: 10 },
          { word: "b", score: 8 },
          { word: "c", score: 6 },
          { word: "d", score: 4 },
        ],
      },
    ];
    const result = aggregateKeywords(pages, 2);
    expect(result).toHaveLength(2);
    expect(result[0].word).toBe("a");
    expect(result[1].word).toBe("b");
  });

  it("handles pages with no keywords", () => {
    const pages: AuditPageInput[] = [
      { url: "https://x.com" },
      { url: "https://y.com", keywords: [] },
    ];
    const result = aggregateKeywords(pages, 10);
    expect(result).toHaveLength(0);
  });

  it("skips empty keyword strings", () => {
    const pages: AuditPageInput[] = [
      {
        url: "https://x.com",
        keywords: [
          { word: "", score: 10 },
          { word: "  ", score: 5 },
        ],
      },
    ];
    const result = aggregateKeywords(pages, 10);
    expect(result).toHaveLength(0);
  });
});

describe("discoverCompetitorsFromAudit", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup.SERPER_API_KEY = process.env.SERPER_API_KEY;
    envBackup.BRAVE_API_KEY = process.env.BRAVE_API_KEY;
    mockDiscover.mockReset();
  });

  afterEach(() => {
    process.env.SERPER_API_KEY = envBackup.SERPER_API_KEY;
    process.env.BRAVE_API_KEY = envBackup.BRAVE_API_KEY;
  });

  it("returns requiresApiKey=true when no API keys configured", async () => {
    delete process.env.SERPER_API_KEY;
    delete process.env.BRAVE_API_KEY;

    const result = await discoverCompetitorsFromAudit(
      [{ url: "https://example.com", keywords: [{ word: "test", score: 5 }] }],
      "example.com",
    );
    expect(result.requiresApiKey).toBe(true);
    expect(result.competitors).toHaveLength(0);
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("returns empty competitors for empty pages", async () => {
    process.env.SERPER_API_KEY = "test-key";

    const result = await discoverCompetitorsFromAudit([], "example.com");
    expect(result.competitors).toHaveLength(0);
    expect(result.keywordsSearched).toHaveLength(0);
    expect(result.requiresApiKey).toBe(false);
  });

  it("returns empty competitors for pages with no keywords", async () => {
    process.env.SERPER_API_KEY = "test-key";

    const result = await discoverCompetitorsFromAudit(
      [{ url: "https://example.com" }],
      "example.com",
    );
    expect(result.competitors).toHaveLength(0);
    expect(result.keywordsSearched).toHaveLength(0);
  });

  it("deduplicates competitors by domain and merges keywords", async () => {
    process.env.SERPER_API_KEY = "test-key";

    mockDiscover.mockResolvedValueOnce({
      organic: [
        {
          url: "https://www.competitor-a.com/page1",
          title: "Comp A Page 1",
          snippet: "Snippet 1",
          position: 3,
        },
        {
          url: "https://competitor-b.com/page1",
          title: "Comp B",
          snippet: "Snippet B",
          position: 5,
        },
      ],
      serpFeatures: {
        paa: ["What is react?"],
        relatedSearches: ["react tutorial"],
      },
      provider: "serper",
    });
    mockDiscover.mockResolvedValueOnce({
      organic: [
        {
          url: "https://competitor-a.com/page2",
          title: "Comp A Page 2",
          snippet: "Snippet 2",
          position: 1,
        },
      ],
      serpFeatures: { paa: ["What is node?"], relatedSearches: [] },
      provider: "serper",
    });

    const pages: AuditPageInput[] = [
      {
        url: "https://example.com/a",
        keywords: [{ word: "react", score: 10 }],
      },
      { url: "https://example.com/b", keywords: [{ word: "node", score: 8 }] },
    ];

    const result = await discoverCompetitorsFromAudit(pages, "example.com");

    expect(result.requiresApiKey).toBe(false);
    expect(result.keywordsSearched).toEqual(["react", "node"]);

    // competitor-a.com appears for both keywords, so frequencyScore=2
    const compA = result.competitors.find(
      (c) => c.domain === "competitor-a.com",
    );
    expect(compA).toBeDefined();
    expect(compA!.frequencyScore).toBe(2);
    expect(compA!.keywordsFound).toContain("react");
    expect(compA!.keywordsFound).toContain("node");
    // Best position is 1 (from the node search)
    expect(compA!.bestPosition).toBe(1);
    expect(compA!.url).toBe("https://competitor-a.com/page2");

    // competitor-b.com appears for 1 keyword
    const compB = result.competitors.find(
      (c) => c.domain === "competitor-b.com",
    );
    expect(compB).toBeDefined();
    expect(compB!.frequencyScore).toBe(1);
  });

  it("sorts by frequencyScore DESC, then bestPosition ASC", async () => {
    process.env.SERPER_API_KEY = "test-key";

    mockDiscover.mockResolvedValueOnce({
      organic: [
        {
          url: "https://low-freq.com/a",
          title: "Low",
          snippet: "",
          position: 1,
        },
        {
          url: "https://high-freq.com/a",
          title: "High",
          snippet: "",
          position: 5,
        },
        {
          url: "https://high-freq2.com/a",
          title: "High2",
          snippet: "",
          position: 2,
        },
      ],
      serpFeatures: { paa: [], relatedSearches: [] },
      provider: "serper",
    });
    mockDiscover.mockResolvedValueOnce({
      organic: [
        {
          url: "https://high-freq.com/b",
          title: "High",
          snippet: "",
          position: 3,
        },
        {
          url: "https://high-freq2.com/b",
          title: "High2",
          snippet: "",
          position: 4,
        },
      ],
      serpFeatures: { paa: [], relatedSearches: [] },
      provider: "serper",
    });

    const pages: AuditPageInput[] = [
      { url: "https://example.com/a", keywords: [{ word: "kw1", score: 10 }] },
      { url: "https://example.com/b", keywords: [{ word: "kw2", score: 8 }] },
    ];

    const result = await discoverCompetitorsFromAudit(pages, "example.com");

    // high-freq & high-freq2 both have frequency 2; low-freq has 1
    expect(result.competitors[0].domain).toBe("high-freq2.com"); // freq=2, bestPos=2
    expect(result.competitors[1].domain).toBe("high-freq.com"); // freq=2, bestPos=3
    expect(result.competitors[2].domain).toBe("low-freq.com"); // freq=1, bestPos=1
  });

  it("limits competitors to maxCompetitors", async () => {
    process.env.SERPER_API_KEY = "test-key";

    mockDiscover.mockResolvedValue({
      organic: Array.from({ length: 5 }, (_, i) => ({
        url: `https://comp${i}.com/page`,
        title: `Comp ${i}`,
        snippet: "",
        position: i + 1,
      })),
      serpFeatures: { paa: [], relatedSearches: [] },
      provider: "serper",
    });

    const pages: AuditPageInput[] = [
      { url: "https://example.com", keywords: [{ word: "test", score: 10 }] },
    ];

    const result = await discoverCompetitorsFromAudit(pages, "example.com", {
      maxCompetitors: 2,
    });

    expect(result.competitors).toHaveLength(2);
  });

  it("collects unique PAA and related searches", async () => {
    process.env.SERPER_API_KEY = "test-key";

    mockDiscover.mockResolvedValueOnce({
      organic: [],
      serpFeatures: {
        paa: ["Question 1", "Question 2"],
        relatedSearches: ["related A"],
      },
      provider: "serper",
    });
    mockDiscover.mockResolvedValueOnce({
      organic: [],
      serpFeatures: {
        paa: ["Question 1", "Question 3"],
        relatedSearches: ["related A", "related B"],
      },
      provider: "serper",
    });

    const pages: AuditPageInput[] = [
      { url: "https://example.com/a", keywords: [{ word: "kw1", score: 10 }] },
      { url: "https://example.com/b", keywords: [{ word: "kw2", score: 8 }] },
    ];

    const result = await discoverCompetitorsFromAudit(pages, "example.com");

    expect(result.serpFeatures.paa).toEqual([
      "Question 1",
      "Question 2",
      "Question 3",
    ]);
    expect(result.serpFeatures.relatedSearches).toEqual([
      "related A",
      "related B",
    ]);
  });

  it("continues if a single keyword search throws", async () => {
    process.env.SERPER_API_KEY = "test-key";

    mockDiscover.mockRejectedValueOnce(new Error("API error"));
    mockDiscover.mockResolvedValueOnce({
      organic: [
        {
          url: "https://survivor.com/page",
          title: "Survivor",
          snippet: "",
          position: 1,
        },
      ],
      serpFeatures: { paa: [], relatedSearches: [] },
      provider: "serper",
    });

    const pages: AuditPageInput[] = [
      { url: "https://example.com/a", keywords: [{ word: "fail", score: 10 }] },
      { url: "https://example.com/b", keywords: [{ word: "pass", score: 8 }] },
    ];

    const result = await discoverCompetitorsFromAudit(pages, "example.com");
    expect(result.competitors).toHaveLength(1);
    expect(result.competitors[0].domain).toBe("survivor.com");
  });

  it("strips www. from domain for deduplication", async () => {
    process.env.SERPER_API_KEY = "test-key";

    mockDiscover.mockResolvedValueOnce({
      organic: [
        {
          url: "https://www.example-comp.com/page1",
          title: "With www",
          snippet: "",
          position: 3,
        },
      ],
      serpFeatures: { paa: [], relatedSearches: [] },
      provider: "serper",
    });
    mockDiscover.mockResolvedValueOnce({
      organic: [
        {
          url: "https://example-comp.com/page2",
          title: "Without www",
          snippet: "",
          position: 1,
        },
      ],
      serpFeatures: { paa: [], relatedSearches: [] },
      provider: "serper",
    });

    const pages: AuditPageInput[] = [
      { url: "https://example.com/a", keywords: [{ word: "kw1", score: 10 }] },
      { url: "https://example.com/b", keywords: [{ word: "kw2", score: 8 }] },
    ];

    const result = await discoverCompetitorsFromAudit(pages, "example.com");

    // Both URLs should map to the same domain
    expect(result.competitors).toHaveLength(1);
    expect(result.competitors[0].domain).toBe("example-comp.com");
    expect(result.competitors[0].frequencyScore).toBe(2);
  });

  it("caps maxKeywords to 10 even if requested higher", async () => {
    process.env.SERPER_API_KEY = "test-key";

    mockDiscover.mockResolvedValue({
      organic: [],
      serpFeatures: { paa: [], relatedSearches: [] },
      provider: "serper",
    });

    const keywords = Array.from({ length: 20 }, (_, i) => ({
      word: `kw${i}`,
      score: 20 - i,
    }));
    const pages: AuditPageInput[] = [{ url: "https://example.com", keywords }];

    const result = await discoverCompetitorsFromAudit(pages, "example.com", {
      maxKeywords: 50,
    });

    // Should only search top 10
    expect(result.keywordsSearched).toHaveLength(10);
    expect(mockDiscover).toHaveBeenCalledTimes(10);
  });
});
