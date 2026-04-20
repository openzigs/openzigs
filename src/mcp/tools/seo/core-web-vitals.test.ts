import { describe, it, expect, beforeEach } from "vitest";
import {
  rateMetric,
  getCachedResult,
  setCachedResult,
  clearCache,
  getCacheSize,
  aggregateCwvStats,
  type CoreWebVitalsResult,
} from "./core-web-vitals.js";

describe("rateMetric", () => {
  it("rates LCP good when <= 2500", () => {
    expect(rateMetric("LCP", 2000)).toBe("good");
    expect(rateMetric("LCP", 2500)).toBe("good");
  });

  it("rates LCP needs-improvement when between thresholds", () => {
    expect(rateMetric("LCP", 3000)).toBe("needs-improvement");
  });

  it("rates LCP poor when >= 4000", () => {
    expect(rateMetric("LCP", 4000)).toBe("poor");
    expect(rateMetric("LCP", 5000)).toBe("poor");
  });

  it("rates CLS good when <= 0.1", () => {
    expect(rateMetric("CLS", 0.05)).toBe("good");
    expect(rateMetric("CLS", 0.1)).toBe("good");
  });

  it("rates CLS poor when >= 0.25", () => {
    expect(rateMetric("CLS", 0.3)).toBe("poor");
  });

  it("rates FCP correctly", () => {
    expect(rateMetric("FCP", 1500)).toBe("good");
    expect(rateMetric("FCP", 2500)).toBe("needs-improvement");
    expect(rateMetric("FCP", 3500)).toBe("poor");
  });

  it("rates TBT correctly", () => {
    expect(rateMetric("TBT", 150)).toBe("good");
    expect(rateMetric("TBT", 400)).toBe("needs-improvement");
    expect(rateMetric("TBT", 700)).toBe("poor");
  });

  it("returns needs-improvement for unknown metrics", () => {
    expect(rateMetric("UNKNOWN", 100)).toBe("needs-improvement");
  });
});

describe("CWV cache", () => {
  beforeEach(() => clearCache());

  it("returns undefined for uncached URL", () => {
    expect(getCachedResult("https://example.com")).toBeUndefined();
  });

  it("stores and retrieves cached results", () => {
    const result: CoreWebVitalsResult = {
      url: "https://example.com",
      performanceScore: 85,
      metrics: [{ name: "LCP", value: 2000, unit: "ms", rating: "good" }],
      fetchedAt: new Date().toISOString(),
    };
    setCachedResult("https://example.com", result);

    const cached = getCachedResult("https://example.com");
    expect(cached).toBeDefined();
    expect(cached!.performanceScore).toBe(85);
  });

  it("clearCache removes all entries", () => {
    const result: CoreWebVitalsResult = {
      url: "https://test.com",
      performanceScore: 75,
      metrics: [],
      fetchedAt: new Date().toISOString(),
    };
    setCachedResult("https://test.com", result);
    clearCache();
    expect(getCachedResult("https://test.com")).toBeUndefined();
  });

  it("evicts oldest entries when cache exceeds 1000", () => {
    // Fill cache beyond max size (1000)
    for (let i = 0; i < 1010; i++) {
      setCachedResult(`https://example.com/page-${i}`, {
        url: `https://example.com/page-${i}`,
        performanceScore: 50,
        metrics: [],
        fetchedAt: new Date().toISOString(),
      });
    }
    // After eviction, should be 1010 - 200 = 810
    expect(getCacheSize()).toBeLessThanOrEqual(1000);
    expect(getCacheSize()).toBeGreaterThan(0);
  });

  it("getCacheSize returns correct count", () => {
    setCachedResult("https://a.com", {
      url: "https://a.com",
      performanceScore: 90,
      metrics: [],
      fetchedAt: new Date().toISOString(),
    });
    setCachedResult("https://b.com", {
      url: "https://b.com",
      performanceScore: 80,
      metrics: [],
      fetchedAt: new Date().toISOString(),
    });
    expect(getCacheSize()).toBe(2);
  });
});

describe("aggregateCwvStats", () => {
  it("returns zeroes for empty input", () => {
    const stats = aggregateCwvStats([]);
    expect(stats.totalPages).toBe(0);
    expect(stats.avgPerformanceScore).toBe(0);
    expect(stats.good).toBe(0);
  });

  it("categorises pages by performance score", () => {
    const results: CoreWebVitalsResult[] = [
      {
        url: "https://a.com",
        performanceScore: 95,
        metrics: [],
        fetchedAt: "",
      },
      {
        url: "https://b.com",
        performanceScore: 70,
        metrics: [],
        fetchedAt: "",
      },
      {
        url: "https://c.com",
        performanceScore: 30,
        metrics: [],
        fetchedAt: "",
      },
    ];
    const stats = aggregateCwvStats(results);
    expect(stats.good).toBe(1);
    expect(stats.needsImprovement).toBe(1);
    expect(stats.poor).toBe(1);
    expect(stats.totalPages).toBe(3);
    expect(stats.avgPerformanceScore).toBe(65);
  });

  it("computes average LCP, CLS, TBT", () => {
    const results: CoreWebVitalsResult[] = [
      {
        url: "https://a.com",
        performanceScore: 90,
        metrics: [
          { name: "LCP", value: 2000, unit: "ms", rating: "good" },
          { name: "CLS", value: 0.05, unit: "", rating: "good" },
          { name: "TBT", value: 100, unit: "ms", rating: "good" },
        ],
        fetchedAt: "",
      },
      {
        url: "https://b.com",
        performanceScore: 80,
        metrics: [
          { name: "LCP", value: 3000, unit: "ms", rating: "needs-improvement" },
          { name: "CLS", value: 0.15, unit: "", rating: "needs-improvement" },
          { name: "TBT", value: 300, unit: "ms", rating: "needs-improvement" },
        ],
        fetchedAt: "",
      },
    ];
    const stats = aggregateCwvStats(results);
    expect(stats.avgLcp).toBe(2500);
    expect(stats.avgCls).toBe(0.1);
    expect(stats.avgTbt).toBe(200);
  });

  it("returns null averages when no metrics present", () => {
    const results: CoreWebVitalsResult[] = [
      {
        url: "https://a.com",
        performanceScore: 50,
        metrics: [],
        fetchedAt: "",
      },
    ];
    const stats = aggregateCwvStats(results);
    expect(stats.avgLcp).toBeNull();
    expect(stats.avgCls).toBeNull();
    expect(stats.avgTbt).toBeNull();
  });
});

// ── Dual strategy & strategy-aware cache (#855) ─────────────────────────

describe("strategy-aware cache", () => {
  beforeEach(() => clearCache());

  it("caches mobile and desktop results separately", () => {
    const mobileResult: CoreWebVitalsResult = {
      url: "https://a.com",
      performanceScore: 60,
      metrics: [],
      fetchedAt: "",
      strategy: "mobile",
    };
    const desktopResult: CoreWebVitalsResult = {
      url: "https://a.com",
      performanceScore: 90,
      metrics: [],
      fetchedAt: "",
      strategy: "desktop",
    };

    setCachedResult("mobile:https://a.com", mobileResult);
    setCachedResult("desktop:https://a.com", desktopResult);

    const cached1 = getCachedResult("mobile:https://a.com");
    const cached2 = getCachedResult("desktop:https://a.com");

    expect(cached1?.performanceScore).toBe(60);
    expect(cached2?.performanceScore).toBe(90);
  });
});
