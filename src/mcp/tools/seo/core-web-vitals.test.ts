import { describe, it, expect } from "vitest";
import {
  rateMetric,
  getCachedResult,
  setCachedResult,
  clearCache,
  getCacheSize,
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

// Import beforeEach for cache tests
import { beforeEach } from "vitest";
