import { describe, it, expect } from "vitest";
import {
  analyzeContentFreshness,
  type FreshnessRating,
} from "./content-analyzer.js";

describe("analyzeContentFreshness (#877)", () => {
  const NOW = new Date("2026-04-15T00:00:00Z");

  function makePage(url: string, jsonLdBlocks: Array<{ parsed: unknown }>) {
    return { url, jsonLdBlocks };
  }

  it("returns 'Fresh' for content published < 6 months ago", () => {
    const pages = [
      makePage("https://example.com/new", [
        { parsed: { "@type": "Article", datePublished: "2026-02-01" } },
      ]),
    ];
    const results = analyzeContentFreshness(pages, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].freshnessRating).toBe("Fresh" as FreshnessRating);
    expect(results[0].datePublished).toBe("2026-02-01");
    expect(results[0].ageInDays).toBeLessThan(182);
  });

  it("returns 'Aging' for content published 6–12 months ago", () => {
    const pages = [
      makePage("https://example.com/aging", [
        { parsed: { "@type": "Article", datePublished: "2025-07-15" } },
      ]),
    ];
    const results = analyzeContentFreshness(pages, NOW);
    expect(results[0].freshnessRating).toBe("Aging" as FreshnessRating);
  });

  it("returns 'Stale' for content published > 12 months ago", () => {
    const pages = [
      makePage("https://example.com/stale", [
        { parsed: { "@type": "Article", datePublished: "2024-01-01" } },
      ]),
    ];
    const results = analyzeContentFreshness(pages, NOW);
    expect(results[0].freshnessRating).toBe("Stale" as FreshnessRating);
    expect(results[0].ageInDays).toBeGreaterThan(365);
  });

  it("returns 'Unknown' when no date is available", () => {
    const pages = [
      makePage("https://example.com/nodate", [
        { parsed: { "@type": "Article", headline: "No date" } },
      ]),
    ];
    const results = analyzeContentFreshness(pages, NOW);
    expect(results[0].freshnessRating).toBe("Unknown" as FreshnessRating);
    expect(results[0].ageInDays).toBeNull();
  });

  it("prefers dateModified over datePublished", () => {
    const pages = [
      makePage("https://example.com/modified", [
        {
          parsed: {
            "@type": "Article",
            datePublished: "2024-01-01", // stale
            dateModified: "2026-03-01", // fresh
          },
        },
      ]),
    ];
    const results = analyzeContentFreshness(pages, NOW);
    expect(results[0].freshnessRating).toBe("Fresh" as FreshnessRating);
    expect(results[0].dateModified).toBe("2026-03-01");
  });

  it("handles @graph blocks", () => {
    const pages = [
      makePage("https://example.com/graph", [
        {
          parsed: {
            "@graph": [
              { "@type": "WebPage" },
              { "@type": "Article", datePublished: "2026-04-01" },
            ],
          },
        },
      ]),
    ];
    const results = analyzeContentFreshness(pages, NOW);
    expect(results[0].freshnessRating).toBe("Fresh" as FreshnessRating);
  });

  it("returns 'Unknown' for empty jsonLdBlocks", () => {
    const pages = [makePage("https://example.com/empty", [])];
    const results = analyzeContentFreshness(pages, NOW);
    expect(results[0].freshnessRating).toBe("Unknown" as FreshnessRating);
  });

  it("returns 'Unknown' for invalid date string", () => {
    const pages = [
      makePage("https://example.com/bad-date", [
        { parsed: { "@type": "Article", datePublished: "not-a-date" } },
      ]),
    ];
    const results = analyzeContentFreshness(pages, NOW);
    expect(results[0].freshnessRating).toBe("Unknown" as FreshnessRating);
  });

  it("handles multiple pages", () => {
    const pages = [
      makePage("https://example.com/a", [
        { parsed: { "@type": "Article", datePublished: "2026-04-01" } },
      ]),
      makePage("https://example.com/b", [
        { parsed: { "@type": "Article", datePublished: "2024-01-01" } },
      ]),
    ];
    const results = analyzeContentFreshness(pages, NOW);
    expect(results).toHaveLength(2);
    expect(results[0].freshnessRating).toBe("Fresh");
    expect(results[1].freshnessRating).toBe("Stale");
  });
});
