import { describe, it, expect, vi } from "vitest";
import {
  BUNDLED_PRICING,
  computeCallCost,
  fetchPricingTable,
  priceForModel,
  readCachedPricing,
} from "./copilot-pricing.js";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDir = async () => mkdtemp(path.join(tmpdir(), "pricing-"));

describe("copilot-pricing", () => {
  describe("BUNDLED_PRICING", () => {
    it("contains expected models", () => {
      expect(BUNDLED_PRICING.models["gpt-4.1"]).toBeDefined();
      expect(BUNDLED_PRICING.models["claude-sonnet-4.5"]).toBeDefined();
      expect(BUNDLED_PRICING.source).toBe("bundled");
      expect(BUNDLED_PRICING.fallback.modelId).toBe("*");
    });
  });

  describe("priceForModel", () => {
    it("returns a known model row", () => {
      const row = priceForModel(BUNDLED_PRICING, "gpt-4.1");
      expect(row.modelId).toBe("gpt-4.1");
      expect(row.inputPerMillion).toBe(2.0);
    });
    it("falls back to table.fallback for unknown model", () => {
      const row = priceForModel(BUNDLED_PRICING, "totally-fake-model:99b");
      expect(row).toEqual(BUNDLED_PRICING.fallback);
    });
  });

  describe("computeCallCost", () => {
    it("computes input + output + cached cost in USD", () => {
      const row = priceForModel(BUNDLED_PRICING, "gpt-4.1");
      // 1M input @ $2 + 500k output @ $8 = $2 + $4 = $6
      const cost = computeCallCost(row, {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cachedTokens: 0,
      });
      expect(cost).toBeCloseTo(6.0, 6);
    });
    it("treats cached tokens at the cached rate", () => {
      const row = priceForModel(BUNDLED_PRICING, "gpt-4.1");
      // 100k cached @ $0.5/M = $0.05
      const cost = computeCallCost(row, {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 100_000,
      });
      expect(cost).toBeCloseTo(0.05, 6);
    });
    it("returns 0 for negative or NaN inputs", () => {
      const row = priceForModel(BUNDLED_PRICING, "gpt-4.1");
      const cost = computeCallCost(row, {
        inputTokens: -100,
        outputTokens: Number.NaN,
        cachedTokens: 0,
      });
      expect(cost).toBe(0);
    });
  });

  describe("fetchPricingTable", () => {
    it("returns live + persists cache on success", async () => {
      const dir = await tempDir();
      const cachePath = path.join(dir, "copilot-pricing.json");
      const fakeFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            version: "test-1",
            models: {
              "gpt-fake": { modelId: "gpt-fake", inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0 },
            },
            fallback: { modelId: "*", inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0 },
          }),
          { status: 200, headers: { etag: "W/abc" } },
        ),
      ) as unknown as typeof fetch;

      const table = await fetchPricingTable({
        fetchImpl: fakeFetch,
        cachePath,
        url: "https://example.test/pricing.json",
        now: () => new Date("2026-05-08T10:00:00Z"),
      });
      expect(table.source).toBe("live");
      expect(table.version).toBe("test-1");
      expect(table.etag).toBe("W/abc");
      const onDisk = JSON.parse(await readFile(cachePath, "utf-8"));
      expect(onDisk.version).toBe("test-1");
    });

    it("falls back to cache when fetch fails", async () => {
      const dir = await tempDir();
      const cachePath = path.join(dir, "copilot-pricing.json");
      // Pre-seed cache
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(
        cachePath,
        JSON.stringify({
          version: "cached-1",
          fetchedAt: "2026-05-01T00:00:00Z",
          source: "live",
          models: {
            "gpt-cached": { modelId: "gpt-cached", inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0 },
          },
          fallback: { modelId: "*", inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0 },
        }),
      );

      const failingFetch = vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;

      const table = await fetchPricingTable({
        fetchImpl: failingFetch,
        cachePath,
        url: "https://example.test/pricing.json",
      });
      expect(table.source).toBe("cached");
      expect(table.version).toBe("cached-1");
    });

    it("falls back to bundled when both fetch and cache fail", async () => {
      const dir = await tempDir();
      const cachePath = path.join(dir, "missing.json");
      const failingFetch = vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;

      const table = await fetchPricingTable({
        fetchImpl: failingFetch,
        cachePath,
        url: "https://example.test/pricing.json",
      });
      expect(table.source).toBe("bundled");
      expect(table.models["gpt-4.1"]).toBeDefined();
    });

    it("falls back to bundled when payload is malformed", async () => {
      const dir = await tempDir();
      const cachePath = path.join(dir, "missing.json");
      const fakeFetch = vi.fn(async () =>
        new Response(JSON.stringify({ no_models_here: true }), { status: 200 }),
      ) as unknown as typeof fetch;

      const table = await fetchPricingTable({
        fetchImpl: fakeFetch,
        cachePath,
        url: "https://example.test/pricing.json",
      });
      expect(table.source).toBe("bundled");
    });
  });

  describe("readCachedPricing", () => {
    it("returns null when cache file missing", async () => {
      const dir = await tempDir();
      const result = await readCachedPricing(path.join(dir, "no.json"));
      expect(result).toBeNull();
    });
  });
});
