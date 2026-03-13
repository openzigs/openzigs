import { describe, expect, it, vi, afterEach } from "vitest";
import { createBraveSearchHandler } from "./brave-search.js";

describe("brave search handler", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws when BRAVE_API_KEY is missing", async () => {
    const handler = createBraveSearchHandler({ apiKey: "" });
    await expect(handler({ query: "typescript" })).rejects.toThrow(
      /BRAVE_API_KEY/i
    );
  });

  it("returns search results for a successful response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        web: {
          results: [
            { title: "TypeScript Docs", url: "https://typescriptlang.org", description: "Official docs" },
            { title: "TS Handbook", url: "https://handbook.ts", description: "The handbook" },
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const handler = createBraveSearchHandler({ apiKey: "test-key" });
    const output = await handler({ query: "typescript", count: 5 });

    expect(output.results).toHaveLength(2);
    expect(output.results[0].title).toBe("TypeScript Docs");
    expect(output.results[0].url).toBe("https://typescriptlang.org");
    expect(output.results[0].snippet).toBe("Official docs");

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = fetchCall[0] as URL;
    expect(url.searchParams.get("q")).toBe("typescript");
    expect(url.searchParams.get("count")).toBe("5");
    expect(fetchCall[1].headers["X-Subscription-Token"]).toBe("test-key");
  });

  it("filters out results without URL", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        web: {
          results: [
            { title: "Has URL", url: "https://example.com", description: "Good" },
            { title: "No URL", description: "Bad" },
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const handler = createBraveSearchHandler({ apiKey: "key" });
    const output = await handler({ query: "test" });
    expect(output.results).toHaveLength(1);
    expect(output.results[0].url).toBe("https://example.com");
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    }) as unknown as typeof fetch;

    const handler = createBraveSearchHandler({ apiKey: "key" });
    await expect(handler({ query: "test" })).rejects.toThrow("429");
  });

  it("throws on invalid response schema", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue("not an object"),
    }) as unknown as typeof fetch;

    const handler = createBraveSearchHandler({ apiKey: "key" });
    await expect(handler({ query: "test" })).rejects.toThrow("validation failed");
  });

  it("handles empty web results", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ web: { results: [] } }),
    }) as unknown as typeof fetch;

    const handler = createBraveSearchHandler({ apiKey: "key" });
    const output = await handler({ query: "test" });
    expect(output.results).toHaveLength(0);
  });

  it("handles missing web field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    }) as unknown as typeof fetch;

    const handler = createBraveSearchHandler({ apiKey: "key" });
    const output = await handler({ query: "test" });
    expect(output.results).toHaveLength(0);
  });

  it("defaults to count of 10 and standard endpoint", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ web: { results: [] } }),
    }) as unknown as typeof fetch;

    const handler = createBraveSearchHandler({ apiKey: "key" });
    await handler({ query: "test" });

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as URL;
    expect(url.searchParams.get("count")).toBe("10");
    expect(url.origin).toBe("https://api.search.brave.com");
  });
});
