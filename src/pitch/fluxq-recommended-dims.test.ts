import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLUXQ_FALLBACK_DIMS,
  _resetFluxQDimsCacheForTest,
  _setFluxQDimsCacheForTest,
  clampToFluxQRecommendedDims,
  getCachedFluxQRecommendedDims,
  refreshFluxQRecommendedDims,
} from "./fluxq-recommended-dims.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  _resetFluxQDimsCacheForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetFluxQDimsCacheForTest();
});

describe("getCachedFluxQRecommendedDims", () => {
  it("returns the fallback when the cache is empty", () => {
    expect(getCachedFluxQRecommendedDims()).toEqual({ ...FLUXQ_FALLBACK_DIMS });
  });

  it("returns the seeded cache value", () => {
    _setFluxQDimsCacheForTest({ width: 800, height: 448 });
    expect(getCachedFluxQRecommendedDims()).toEqual({
      width: 800,
      height: 448,
    });
  });
});

describe("clampToFluxQRecommendedDims", () => {
  beforeEach(() => {
    _setFluxQDimsCacheForTest({ width: 1024, height: 576 });
  });

  it("clamps an oversized 1920x1080 request down to 1024x576", () => {
    expect(clampToFluxQRecommendedDims(1920, 1080)).toEqual({
      width: 1024,
      height: 576,
    });
  });

  it("preserves a request that is already within the ceiling", () => {
    expect(clampToFluxQRecommendedDims(512, 512)).toEqual({
      width: 512,
      height: 512,
    });
  });

  it("uses the recommended dims when no request is provided", () => {
    expect(clampToFluxQRecommendedDims()).toEqual({
      width: 1024,
      height: 576,
    });
  });

  it("uses the recommended dims when the request is invalid", () => {
    expect(clampToFluxQRecommendedDims(0, -100)).toEqual({
      width: 1024,
      height: 576,
    });
    expect(clampToFluxQRecommendedDims(NaN, NaN)).toEqual({
      width: 1024,
      height: 576,
    });
  });

  it("falls back to FLUXQ_FALLBACK_DIMS when the cache was never populated", () => {
    _resetFluxQDimsCacheForTest();
    expect(clampToFluxQRecommendedDims(1920, 1080)).toEqual({
      ...FLUXQ_FALLBACK_DIMS,
    });
  });
});

describe("refreshFluxQRecommendedDims", () => {
  it("populates the cache from a /health JSON body", async () => {
    const mock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          recommended_width: 1280,
          recommended_height: 720,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;

    const result = await refreshFluxQRecommendedDims("http://fluxq:5005");
    expect(result).toEqual({ width: 1280, height: 720 });
    expect(getCachedFluxQRecommendedDims()).toEqual({
      width: 1280,
      height: 720,
    });
    expect(mock).toHaveBeenCalledWith(
      "http://fluxq:5005/health",
      expect.any(Object),
    );
  });

  it("falls back when /health returns a non-2xx", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("nope", { status: 503 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await refreshFluxQRecommendedDims("http://fluxq:5005");
    expect(result).toEqual({ ...FLUXQ_FALLBACK_DIMS });
  });

  it("falls back when /health omits the recommended dims", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await refreshFluxQRecommendedDims("http://fluxq:5005");
    expect(result).toEqual({ ...FLUXQ_FALLBACK_DIMS });
  });

  it("falls back when fetch throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    const result = await refreshFluxQRecommendedDims("http://fluxq:5005");
    expect(result).toEqual({ ...FLUXQ_FALLBACK_DIMS });
  });

  it("clamps a follow-up enqueue against the freshly probed ceiling", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ recommended_width: 768, recommended_height: 432 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;

    await refreshFluxQRecommendedDims("http://fluxq:5005");
    expect(clampToFluxQRecommendedDims(1920, 1080)).toEqual({
      width: 768,
      height: 432,
    });
  });
});
