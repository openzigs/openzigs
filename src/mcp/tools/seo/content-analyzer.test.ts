import { describe, it, expect } from "vitest";
import {
  simhash,
  hammingDistance,
  simhashSimilarity,
  analyzeContent,
  findOverOptimizedKeywords,
  exportDuplicatesCsv,
  exportThinContentCsv,
  type ContentPage,
  type KeywordDensityEntry,
} from "./content-analyzer.js";

describe("simhash", () => {
  it("returns a bigint", () => {
    const hash = simhash("hello world this is a test document for simhash");
    expect(typeof hash).toBe("bigint");
  });

  it("returns 0 for empty text", () => {
    expect(simhash("")).toBe(0n);
  });

  it("produces similar hashes for similar text", () => {
    const h1 = simhash(
      "The quick brown fox jumps over the lazy dog near the river bank",
    );
    const h2 = simhash(
      "The quick brown fox jumps over the lazy dog near the river side",
    );
    const similarity = simhashSimilarity(h1, h2);
    expect(similarity).toBeGreaterThan(0.7);
  });

  it("produces different hashes for different text", () => {
    const h1 = simhash(
      "The quick brown fox jumps over the lazy dog in the park",
    );
    const h2 = simhash(
      "A completely different document about quantum physics and string theory research",
    );
    const similarity = simhashSimilarity(h1, h2);
    expect(similarity).toBeLessThan(0.85);
  });
});

describe("hammingDistance", () => {
  it("returns 0 for identical hashes", () => {
    expect(hammingDistance(42n, 42n)).toBe(0);
  });

  it("returns the number of differing bits", () => {
    // 0b101 vs 0b100 → 1 bit different
    expect(hammingDistance(5n, 4n)).toBe(1);
  });

  it("returns 64 for maximally different hashes", () => {
    const all1 = (1n << 64n) - 1n;
    expect(hammingDistance(0n, all1)).toBe(64);
  });
});

describe("simhashSimilarity", () => {
  it("returns 1.0 for identical hashes", () => {
    expect(simhashSimilarity(42n, 42n)).toBe(1);
  });

  it("returns 0.0 for maximally different hashes", () => {
    const all1 = (1n << 64n) - 1n;
    expect(simhashSimilarity(0n, all1)).toBe(0);
  });
});

describe("analyzeContent", () => {
  const baseText = "woodworking project plans detailed guide for beginners "
    .repeat(60)
    .trim();

  function makePage(overrides: Partial<ContentPage> = {}): ContentPage {
    return {
      url: "https://example.com/page",
      title: "Test Page",
      bodyText: baseText,
      wordCount: baseText.split(/\s+/).length,
      ...overrides,
    };
  }

  it("identifies thin content pages", () => {
    const pages: ContentPage[] = [
      makePage({
        url: "https://example.com/thin",
        bodyText: "short text",
        wordCount: 2,
      }),
      makePage({ url: "https://example.com/ok" }),
    ];
    const result = analyzeContent(pages);
    expect(result.thinContentPages).toHaveLength(1);
    expect(result.thinContentPages[0].url).toBe("https://example.com/thin");
  });

  it("detects near-duplicate content", () => {
    const text = baseText;
    const pages: ContentPage[] = [
      makePage({ url: "https://example.com/page-1", bodyText: text }),
      makePage({ url: "https://example.com/page-2", bodyText: text }),
      makePage({
        url: "https://example.com/different",
        bodyText:
          "completely unique content about quantum physics research and theory ".repeat(
            60,
          ),
        wordCount: 480,
      }),
    ];
    const result = analyzeContent(pages);
    expect(result.duplicateGroups.length).toBeGreaterThanOrEqual(1);
    const group = result.duplicateGroups[0];
    expect(group.urls).toContain("https://example.com/page-1");
    expect(group.urls).toContain("https://example.com/page-2");
  });

  it("computes keyword density", () => {
    const pages: ContentPage[] = [
      makePage({
        url: "https://example.com/test",
        bodyText:
          "woodworking tools and woodworking techniques for woodworking projects and woodworking crafts are essential for woodworking mastery in woodworking workshops",
        wordCount: 20,
      }),
    ];
    const result = analyzeContent(pages);
    expect(result.keywordDensity.length).toBeGreaterThan(0);
    const woodworking = result.keywordDensity.find(
      (kd) => kd.keyword === "woodworking",
    );
    expect(woodworking).toBeDefined();
    expect(woodworking!.density).toBeGreaterThan(0);
  });

  it("returns empty results for empty pages array", () => {
    const result = analyzeContent([]);
    expect(result.duplicateGroups).toHaveLength(0);
    expect(result.thinContentPages).toHaveLength(0);
    expect(result.keywordDensity).toHaveLength(0);
  });
});

describe("findOverOptimizedKeywords", () => {
  it("flags keywords with density > 3%", () => {
    const densities: KeywordDensityEntry[] = [
      { url: "https://a.com", keyword: "seo", count: 10, density: 5.0 },
      { url: "https://a.com", keyword: "web", count: 3, density: 1.5 },
      { url: "https://b.com", keyword: "rank", count: 8, density: 4.0 },
    ];
    const result = findOverOptimizedKeywords(densities);
    expect(result).toHaveLength(2);
    expect(result[0].keyword).toBe("seo");
    expect(result[1].keyword).toBe("rank");
  });

  it("returns empty for no over-optimized keywords", () => {
    const densities: KeywordDensityEntry[] = [
      { url: "https://a.com", keyword: "test", count: 2, density: 1.0 },
    ];
    expect(findOverOptimizedKeywords(densities)).toHaveLength(0);
  });
});

describe("exportDuplicatesCsv", () => {
  it("exports CSV with header and rows", () => {
    const csv = exportDuplicatesCsv([
      {
        urls: ["https://a.com", "https://b.com"],
        similarity: 92,
        recommendation: "merge",
      },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Group,URLs,Similarity,Recommendation");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("merge");
  });

  it("returns header only for empty input", () => {
    const csv = exportDuplicatesCsv([]);
    expect(csv.split("\n")).toHaveLength(1);
  });
});

describe("exportThinContentCsv", () => {
  it("exports CSV with header and rows", () => {
    const csv = exportThinContentCsv([
      { url: "https://a.com/thin", title: "Thin Page", wordCount: 50 },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("URL,Title,Word Count");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("50");
  });
});
