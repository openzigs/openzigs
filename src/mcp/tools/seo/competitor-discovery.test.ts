import { describe, it, expect, vi, afterEach } from "vitest";
import { discoverCompetitors } from "./competitor-discovery.js";

describe("competitor-discovery", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("discoverCompetitors", () => {
    it("throws when no API keys provided", async () => {
      await expect(discoverCompetitors("test keyword", {})).rejects.toThrow(
        "No search API key configured",
      );
    });

    it("uses Serper when serperApiKey is provided", async () => {
      const mockResponse = {
        organic: [
          { link: "https://example.com/1", title: "Result 1", snippet: "Snippet 1", position: 1 },
          { link: "https://example.com/2", title: "Result 2", snippet: "Snippet 2", position: 2 },
        ],
        peopleAlsoAsk: [{ question: "How to test?" }, { question: "Why test?" }],
        relatedSearches: [{ query: "related search 1" }],
        answerBox: { snippet: "Featured snippet text" },
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await discoverCompetitors("test keyword", { serperApiKey: "test-key" });

      expect(result.provider).toBe("serper");
      expect(result.organic).toHaveLength(2);
      expect(result.organic[0].url).toBe("https://example.com/1");
      expect(result.organic[0].title).toBe("Result 1");
      expect(result.organic[0].snippet).toBe("Snippet 1");
      expect(result.organic[0].position).toBe(1);
      expect(result.serpFeatures.paa).toEqual(["How to test?", "Why test?"]);
      expect(result.serpFeatures.relatedSearches).toEqual(["related search 1"]);
      expect(result.serpFeatures.featuredSnippet).toBe("Featured snippet text");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://google.serper.dev/search",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "X-API-KEY": "test-key" }),
        }),
      );
    });

    it("falls back to Brave when Serper fails", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((_url: string) => {
        callCount++;
        if (callCount === 1) {
          // Serper fails
          return Promise.resolve({ ok: false, status: 500, statusText: "Internal Server Error" });
        }
        // Brave succeeds
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              web: {
                results: [
                  { url: "https://brave-result.com/1", title: "Brave Result", description: "Brave snippet" },
                ],
              },
            }),
        });
      });

      const result = await discoverCompetitors("test", {
        serperApiKey: "bad-key",
        braveApiKey: "brave-key",
      });

      expect(result.provider).toBe("brave");
      expect(result.organic).toHaveLength(1);
      expect(result.organic[0].url).toBe("https://brave-result.com/1");
    });

    it("uses Brave directly when only braveApiKey is provided", async () => {
      const braveResponse = {
        web: {
          results: [
            { url: "https://example.com/a", title: "A", description: "Desc A" },
            { url: "https://example.com/b", title: "B", description: "Desc B" },
            { url: "https://example.com/c", title: "C", description: "Desc C" },
          ],
        },
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(braveResponse),
      });

      const result = await discoverCompetitors("my keyword", { braveApiKey: "b-key" });

      expect(result.provider).toBe("brave");
      expect(result.organic).toHaveLength(3);
      expect(result.organic[0].position).toBe(1);
      expect(result.organic[2].position).toBe(3);
      expect(result.serpFeatures.paa).toEqual([]);
      expect(result.serpFeatures.relatedSearches).toEqual([]);
      expect(result.serpFeatures.featuredSnippet).toBeUndefined();
    });

    it("limits to 5 organic results", async () => {
      const mockResponse = {
        organic: Array.from({ length: 10 }, (_, i) => ({
          link: `https://example.com/${i}`,
          title: `Result ${i}`,
          snippet: `Snippet ${i}`,
          position: i + 1,
        })),
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await discoverCompetitors("keyword", { serperApiKey: "key" });
      expect(result.organic.length).toBeLessThanOrEqual(10);
    });

    it("handles missing optional fields in Serper response", async () => {
      const mockResponse = {
        organic: [{ link: "https://example.com/1", title: "Result 1" }],
        // No peopleAlsoAsk, relatedSearches, or answerBox
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await discoverCompetitors("keyword", { serperApiKey: "key" });

      expect(result.organic[0].snippet).toBe("");
      expect(result.serpFeatures.paa).toEqual([]);
      expect(result.serpFeatures.relatedSearches).toEqual([]);
      expect(result.serpFeatures.featuredSnippet).toBeUndefined();
    });

    it("handles empty Brave results gracefully", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ web: { results: [] } }),
      });

      const result = await discoverCompetitors("keyword", { braveApiKey: "key" });
      expect(result.organic).toEqual([]);
    });

    it("throws on Brave API error when no Serper key", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      });

      await expect(discoverCompetitors("keyword", { braveApiKey: "bad" })).rejects.toThrow(
        "Brave Search API error: 403 Forbidden",
      );
    });
  });
});
