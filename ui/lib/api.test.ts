import { describe, expect, it, vi } from "vitest";
import { authorizeRenderedMedia, fetchJson } from "./api";

describe("fetchJson", () => {
  it("surfaces endpoint, status, and structured backend error messages", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "internal_error", message: "repository unavailable" },
        }),
        { status: 500, statusText: "Internal Server Error" },
      ),
    );

    await expect(fetchJson("/api/admin/pitch/decks")).rejects.toThrow(
      "/api/admin/pitch/decks failed with 500: repository unavailable (internal_error)",
    );
    fetchSpy.mockRestore();
  });
});

describe("authorizeRenderedMedia", () => {
  it("adds query-token auth to pitch asset URLs embedded in rendered deck HTML", async () => {
    vi.stubEnv("NEXT_PUBLIC_OPENZIGS_TOKEN", "test-token");
    vi.resetModules();
    const { authorizeRenderedMedia: authorizeWithToken } = await import("./api");

    const html = '<section data-background-image="/api/admin/pitch/decks/deck-1/assets/asset-1"><img src="/api/admin/pitch/decks/deck-1/assets/asset-2"></section>';
    expect(authorizeWithToken(html)).toContain(
      'data-background-image="/api/admin/pitch/decks/deck-1/assets/asset-1?token=test-token"',
    );
    expect(authorizeWithToken(html)).toContain(
      'src="/api/admin/pitch/decks/deck-1/assets/asset-2?token=test-token"',
    );

    vi.unstubAllEnvs();
  });

  it("leaves pitch asset URLs unchanged when no UI token is configured", () => {
    expect(
      authorizeRenderedMedia(
        '<img src="/api/admin/pitch/decks/deck-1/assets/asset-1">',
      ),
    ).toBe('<img src="/api/admin/pitch/decks/deck-1/assets/asset-1">');
  });
});