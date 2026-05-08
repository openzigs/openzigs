/**
 * GitHub Copilot pricing table (epic #1053 / issue #1059).
 *
 * Source-of-truth strategy (locked product-owner decision 2026-05-08):
 *   1. Try to fetch the live pricing table from the GitHub docs URL on
 *      startup (or on-demand from the cost meter).
 *   2. On success, cache to `~/.openzigs/cache/copilot-pricing.json` with
 *      ETag, fetched-at timestamp, and version field.
 *   3. On failure, fall back to the on-disk cache.
 *   4. On both failure, fall back to the BUNDLED constants below — published
 *      with the GitHub token-billing announcement that took effect 2026-06-01.
 *
 * The `source` field on every priced row is propagated into the audit log
 * so cost claims are fully traceable ("we said it would have cost $X because
 * we used the cached pricing table fetched at YYYY-MM-DD").
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import os from "node:os";
import path from "node:path";

import { logger } from "../logging/logger.js";
import {
  secureDirOptions,
  secureWriteOptions,
} from "../config/file-permissions.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type PricingSource = "live" | "cached" | "bundled";

export interface ModelPricing {
  /** Model id as reported by the Copilot SDK / OpenAI-compatible endpoint. */
  modelId: string;
  /** Cost per 1 million input tokens, USD. */
  inputPerMillion: number;
  /** Cost per 1 million output tokens, USD. */
  outputPerMillion: number;
  /** Cost per 1 million cached-input tokens, USD. May be 0 (cached free). */
  cachedInputPerMillion: number;
}

export interface PricingTable {
  /** Schema version of the pricing table. Bumped if shape ever changes. */
  version: string;
  /** When the table was fetched / bundled, ISO8601. */
  fetchedAt: string;
  /** ETag from the upstream fetch, when available. */
  etag?: string;
  /** Where the active table came from on this lookup. */
  source: PricingSource;
  /** Model → pricing rows. */
  models: Record<string, ModelPricing>;
  /**
   * Default fallback row used when the requested model id is not found in
   * `models` (e.g., a custom local-copilot model that has no listed cloud
   * equivalent). The cost meter still uses this to compute a "would have
   * cost" estimate so users see *some* signal.
   */
  fallback: ModelPricing;
}

// ── Bundled fallback (2026-06-01 GitHub publication) ─────────────────────────

const BUNDLED_VERSION = "2026-06-01";

/**
 * Bundled pricing table mirroring the published rates from the GitHub
 * token-billing announcement. Updated whenever GitHub publishes a new
 * pricing table. NOT a substitute for the live fetch — this is the
 * air-gap fallback only.
 */
export const BUNDLED_PRICING: PricingTable = {
  version: BUNDLED_VERSION,
  fetchedAt: "2026-06-01T00:00:00.000Z",
  source: "bundled",
  models: {
    "gpt-4.1": {
      modelId: "gpt-4.1",
      inputPerMillion: 2.0,
      outputPerMillion: 8.0,
      cachedInputPerMillion: 0.5,
    },
    "gpt-4.1-mini": {
      modelId: "gpt-4.1-mini",
      inputPerMillion: 0.4,
      outputPerMillion: 1.6,
      cachedInputPerMillion: 0.1,
    },
    "gpt-5": {
      modelId: "gpt-5",
      inputPerMillion: 2.5,
      outputPerMillion: 10.0,
      cachedInputPerMillion: 0.625,
    },
    "gpt-5-mini": {
      modelId: "gpt-5-mini",
      inputPerMillion: 0.5,
      outputPerMillion: 2.0,
      cachedInputPerMillion: 0.125,
    },
    "claude-sonnet-4.5": {
      modelId: "claude-sonnet-4.5",
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cachedInputPerMillion: 0.3,
    },
    "claude-opus-4.5": {
      modelId: "claude-opus-4.5",
      inputPerMillion: 15.0,
      outputPerMillion: 75.0,
      cachedInputPerMillion: 1.5,
    },
    "gemini-2.5-pro": {
      modelId: "gemini-2.5-pro",
      inputPerMillion: 1.25,
      outputPerMillion: 5.0,
      cachedInputPerMillion: 0.31,
    },
  },
  fallback: {
    modelId: "*",
    // Conservative midpoint — when an unknown model is used we don't want
    // either over- or under-claiming on "would have cost" math.
    inputPerMillion: 2.0,
    outputPerMillion: 8.0,
    cachedInputPerMillion: 0.5,
  },
};

// ── Cache + fetch ────────────────────────────────────────────────────────────

const DEFAULT_DOCS_URL =
  "https://docs.github.com/api/copilot-pricing.json";

const defaultCachePath = () =>
  path.join(os.homedir(), ".openzigs", "cache", "copilot-pricing.json");

export type FetchPricingOptions = {
  /** Override fetch impl (tests inject this). */
  fetchImpl?: typeof fetch;
  /** Override remote URL. */
  url?: string;
  /** Override on-disk cache path. */
  cachePath?: string;
  /** Per-fetch timeout, ms. Default 5_000. */
  timeoutMs?: number;
  /** Override clock (tests). */
  now?: () => Date;
};

const writeCache = async (cachePath: string, table: PricingTable) => {
  try {
    await mkdir(dirname(cachePath), secureDirOptions());
    await writeFile(cachePath, JSON.stringify(table, null, 2), secureWriteOptions());
  } catch (err) {
    logger.warn("Failed to write copilot pricing cache", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const readCachedPricing = async (
  cachePath = defaultCachePath(),
): Promise<PricingTable | null> => {
  try {
    const raw = await readFile(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as PricingTable;
    if (!parsed?.models || !parsed?.fallback) return null;
    return { ...parsed, source: "cached" };
  } catch {
    return null;
  }
};

const isPricingTableShape = (value: unknown): value is Partial<PricingTable> => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.models === "object" && v.models !== null;
};

/**
 * Fetch the live pricing table. On success, persists to disk and returns the
 * fresh table marked `source: "live"`. On failure, returns the cached table
 * if present, otherwise the bundled fallback. Never throws.
 */
export const fetchPricingTable = async (
  options: FetchPricingOptions = {},
): Promise<PricingTable> => {
  const cachePath = options.cachePath ?? defaultCachePath();
  const url = options.url ?? DEFAULT_DOCS_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const now = options.now ?? (() => new Date());

  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = (await res.json()) as unknown;
    if (!isPricingTableShape(body)) {
      throw new Error("Pricing payload missing required fields");
    }
    const live: PricingTable = {
      version: typeof body.version === "string" ? body.version : BUNDLED_VERSION,
      fetchedAt: now().toISOString(),
      etag: res.headers.get("etag") ?? undefined,
      source: "live",
      models: body.models as Record<string, ModelPricing>,
      fallback: (body.fallback as ModelPricing | undefined) ?? BUNDLED_PRICING.fallback,
    };
    await writeCache(cachePath, live);
    return live;
  } catch (err) {
    logger.warn("Live copilot pricing fetch failed; using cache or bundled", {
      error: err instanceof Error ? err.message : String(err),
    });
    const cached = await readCachedPricing(cachePath);
    if (cached) return cached;
    return BUNDLED_PRICING;
  }
};

/** Look up a model's pricing row, falling back to `table.fallback`. */
export const priceForModel = (
  table: PricingTable,
  modelId: string,
): ModelPricing => {
  return table.models[modelId] ?? table.fallback;
};

/**
 * Compute USD cost given a pricing row + token counts.
 * Returns 0 for any negative / NaN counts (defensive — these come from
 * provider responses we don't fully control).
 */
export const computeCallCost = (
  row: ModelPricing,
  counts: { inputTokens?: number; outputTokens?: number; cachedTokens?: number },
): number => {
  const safe = (n: number | undefined) =>
    typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  const input = safe(counts.inputTokens);
  const output = safe(counts.outputTokens);
  const cached = safe(counts.cachedTokens);
  // Cached tokens are billed at the cached rate, NOT the input rate (they
  // already came out of `inputTokens` upstream — but the GitHub billing model
  // double-charges in some configs. We bias to the standard reading here:
  // `inputTokens` = uncached prompt tokens, `cachedTokens` = separate.)
  const inputCost = (input * row.inputPerMillion) / 1_000_000;
  const cachedCost = (cached * row.cachedInputPerMillion) / 1_000_000;
  const outputCost = (output * row.outputPerMillion) / 1_000_000;
  return inputCost + cachedCost + outputCost;
};
