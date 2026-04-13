/**
 * Core Web Vitals Integration (#844)
 *
 * Integrates with Google PageSpeed Insights API (free tier, 25K/day).
 * Measures LCP, CLS, TBT/FID, FCP, SI, TTI per URL.
 * Caches results for 24 hours. Rate-limits batch processing.
 */

import * as z from "zod";
import { logger } from "../../../logging/logger.js";
import type { ToolDefinition } from "../../tool-registry.js";

// ── Types ────────────────────────────────────────────────────────────────

export type CwvRating = "good" | "needs-improvement" | "poor";

export interface CoreWebVitalsMetric {
  name: string;
  value: number;
  unit: string;
  rating: CwvRating;
}

export interface CoreWebVitalsResult {
  url: string;
  performanceScore: number;
  metrics: CoreWebVitalsMetric[];
  fetchedAt: string;
  strategy?: CwvStrategy;
  /** Set when PSI fetch failed or returned no lighthouse data. */
  error?: string;
}

// ── Thresholds (Google's official thresholds) ────────────────────────────

const THRESHOLDS: Record<string, { good: number; poor: number }> = {
  LCP: { good: 2500, poor: 4000 },
  FID: { good: 100, poor: 300 },
  CLS: { good: 0.1, poor: 0.25 },
  FCP: { good: 1800, poor: 3000 },
  TBT: { good: 200, poor: 600 },
  SI: { good: 3400, poor: 5800 },
  TTI: { good: 3800, poor: 7300 },
};

export function rateMetric(name: string, value: number): CwvRating {
  const threshold = THRESHOLDS[name];
  if (!threshold) return "needs-improvement";
  if (value <= threshold.good) return "good";
  if (value >= threshold.poor) return "poor";
  return "needs-improvement";
}

// ── Cache ────────────────────────────────────────────────────────────────

const cache = new Map<
  string,
  { result: CoreWebVitalsResult; expiresAt: number }
>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_MAX_SIZE = 1000;
const CACHE_EVICT_COUNT = 200;

/** Evict oldest entries when cache exceeds max size. */
function evictIfNeeded(): void {
  if (cache.size <= CACHE_MAX_SIZE) return;
  const entries = [...cache.entries()].sort(
    (a, b) => a[1].expiresAt - b[1].expiresAt,
  );
  for (let i = 0; i < CACHE_EVICT_COUNT && i < entries.length; i++) {
    cache.delete(entries[i][0]);
  }
}

export function getCachedResult(url: string): CoreWebVitalsResult | undefined {
  const entry = cache.get(url);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(url);
    return undefined;
  }
  return entry.result;
}

export function setCachedResult(
  url: string,
  result: CoreWebVitalsResult,
): void {
  cache.set(url, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  evictIfNeeded();
}

export function clearCache(): void {
  cache.clear();
}

export function getCacheSize(): number {
  return cache.size;
}

// ── PageSpeed Insights API ───────────────────────────────────────────────

interface PsiAudit {
  id: string;
  numericValue?: number;
  score?: number;
}

interface PsiResponse {
  lighthouseResult?: {
    categories?: {
      performance?: { score?: number };
    };
    audits?: Record<string, PsiAudit>;
  };
  error?: { message?: string };
}

export type CwvStrategy = "mobile" | "desktop";

export async function fetchCoreWebVitals(
  url: string,
  apiKey?: string,
  strategy: CwvStrategy = "mobile",
): Promise<CoreWebVitalsResult> {
  const cacheKey = `${strategy}:${url}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    url,
    strategy,
    category: "performance",
  });
  if (apiKey) params.set("key", apiKey);

  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`;

  const resp = await fetch(endpoint, {
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    throw new Error(
      `PageSpeed Insights API error: ${resp.status} ${resp.statusText}`,
    );
  }

  const data = (await resp.json()) as PsiResponse;

  if (data.error?.message) {
    throw new Error(`PageSpeed Insights: ${data.error.message}`);
  }

  const audits = data.lighthouseResult?.audits ?? {};
  const perfScore = Math.round(
    (data.lighthouseResult?.categories?.performance?.score ?? 0) * 100,
  );

  const metricMap: Record<string, { auditId: string; unit: string }> = {
    LCP: { auditId: "largest-contentful-paint", unit: "ms" },
    FCP: { auditId: "first-contentful-paint", unit: "ms" },
    TBT: { auditId: "total-blocking-time", unit: "ms" },
    CLS: { auditId: "cumulative-layout-shift", unit: "" },
    SI: { auditId: "speed-index", unit: "ms" },
    TTI: { auditId: "interactive", unit: "ms" },
  };

  const metrics: CoreWebVitalsMetric[] = [];
  for (const [name, { auditId, unit }] of Object.entries(metricMap)) {
    const audit = audits[auditId];
    if (audit?.numericValue !== undefined) {
      const value =
        name === "CLS"
          ? Math.round(audit.numericValue * 1000) / 1000
          : Math.round(audit.numericValue);
      metrics.push({ name, value, unit, rating: rateMetric(name, value) });
    }
  }

  const result: CoreWebVitalsResult = {
    url,
    performanceScore: perfScore,
    metrics,
    fetchedAt: new Date().toISOString(),
    strategy,
  };

  setCachedResult(cacheKey, result);
  return result;
}

// ── Batch processing with rate limiting ──────────────────────────────────

export async function fetchCoreWebVitalsBatch(
  urls: string[],
  apiKey?: string,
  delayMs = 1200,
): Promise<CoreWebVitalsResult[]> {
  const results: CoreWebVitalsResult[] = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const result = await fetchCoreWebVitals(urls[i], apiKey);
      results.push(result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn("[CoreWebVitals] Failed to fetch for URL", {
        url: urls[i],
        error: errMsg,
      });
      results.push({
        url: urls[i],
        performanceScore: 0,
        metrics: [],
        fetchedAt: new Date().toISOString(),
        error: errMsg,
      });
      results.push({
        url: urls[i],
        performanceScore: 0,
        metrics: [],
        fetchedAt: new Date().toISOString(),
      });
    }
    // Rate limit: wait between requests (except after last)
    if (i < urls.length - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return results;
}

// ── Dual-strategy fetch (#855) ───────────────────────────────────────────

export interface DualStrategyResult {
  url: string;
  mobile: CoreWebVitalsResult;
  desktop: CoreWebVitalsResult;
}

/**
 * Fetch CWV for both mobile and desktop strategies for a single URL.
 */
export async function fetchCoreWebVitalsDual(
  url: string,
  apiKey?: string,
): Promise<DualStrategyResult> {
  const [mobile, desktop] = await Promise.all([
    fetchCoreWebVitals(url, apiKey, "mobile"),
    fetchCoreWebVitals(url, apiKey, "desktop"),
  ]);
  return { url, mobile, desktop };
}

// ── Aggregate CWV stats ──────────────────────────────────────────────────

export interface AggregateCwvStats {
  avgPerformanceScore: number;
  good: number;
  needsImprovement: number;
  poor: number;
  totalPages: number;
  avgLcp: number | null;
  avgCls: number | null;
  avgTbt: number | null;
}

/**
 * Compute aggregate CWV statistics across multiple results.
 * Performance score thresholds: good ≥ 90, needs-improvement 50–89, poor < 50.
 */
export function aggregateCwvStats(
  results: CoreWebVitalsResult[],
): AggregateCwvStats {
  if (results.length === 0) {
    return {
      avgPerformanceScore: 0,
      good: 0,
      needsImprovement: 0,
      poor: 0,
      totalPages: 0,
      avgLcp: null,
      avgCls: null,
      avgTbt: null,
    };
  }

  let good = 0;
  let needsImprovement = 0;
  let poor = 0;
  let totalScore = 0;
  const lcpValues: number[] = [];
  const clsValues: number[] = [];
  const tbtValues: number[] = [];

  for (const r of results) {
    totalScore += r.performanceScore;
    if (r.performanceScore >= 90) good++;
    else if (r.performanceScore >= 50) needsImprovement++;
    else poor++;

    for (const m of r.metrics) {
      if (m.name === "LCP") lcpValues.push(m.value);
      else if (m.name === "CLS") clsValues.push(m.value);
      else if (m.name === "TBT") tbtValues.push(m.value);
    }
  }

  const avg = (arr: number[]) =>
    arr.length > 0
      ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100
      : null;

  return {
    avgPerformanceScore: Math.round(totalScore / results.length),
    good,
    needsImprovement,
    poor,
    totalPages: results.length,
    avgLcp: avg(lcpValues),
    avgCls: avg(clsValues),
    avgTbt: avg(tbtValues),
  };
}

// ── Zod Schema ───────────────────────────────────────────────────────────

const coreWebVitalsSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(20).describe("URLs to analyze"),
  apiKey: z
    .string()
    .optional()
    .describe(
      "Google PageSpeed Insights API key (optional, increases rate limit)",
    ),
});

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createCoreWebVitalsTool(): ToolDefinition {
  return {
    name: "seo-core-web-vitals",
    description:
      "Measure Core Web Vitals (LCP, CLS, TBT, FCP, SI, TTI) for one or more URLs " +
      "using Google PageSpeed Insights API. Results are cached for 24 hours.",
    inputSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "URLs to analyze (max 20)",
        },
        apiKey: {
          type: "string",
          description: "Optional PageSpeed Insights API key",
        },
      },
      required: ["urls"],
    },
    zodSchema: coreWebVitalsSchema,
    category: "search",
    riskLevel: "low",
    handler: async (args) => {
      const { urls, apiKey } = coreWebVitalsSchema.parse(args);
      try {
        const results = await fetchCoreWebVitalsBatch(urls, apiKey);
        return { text: JSON.stringify(results, null, 2) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          text: `Core Web Vitals analysis failed: ${msg}`,
          isError: true,
        };
      }
    },
  };
}
