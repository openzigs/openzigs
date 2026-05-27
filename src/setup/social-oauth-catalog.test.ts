import { describe, it, expect } from "vitest";
import { SOCIAL_PLATFORMS, findPlatform } from "./social-oauth-catalog.js";

describe("SOCIAL_PLATFORMS catalog", () => {
  it("contains all 7 platforms in the order the UI expects", () => {
    expect(SOCIAL_PLATFORMS.map((p) => p.id)).toEqual([
      "meta",
      "linkedin",
      "youtube",
      "pinterest",
      "reddit",
      "x",
      "tiktok",
    ]);
  });

  it("every entry has the required descriptor fields", () => {
    for (const p of SOCIAL_PLATFORMS) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(["oauth", "manual_token"]).toContain(p.authMode);
      expect(p.docsUrl).toMatch(/^https?:\/\//);
    }
  });

  it("OAuth platforms have a non-null authorizeRoute under /api/admin", () => {
    for (const p of SOCIAL_PLATFORMS.filter((p) => p.authMode === "oauth")) {
      expect(p.authorizeRoute).not.toBeNull();
      expect(p.authorizeRoute!).toMatch(/^\/api\/admin\//);
    }
  });

  it("exactly one platform (tiktok) uses manual_token", () => {
    const manual = SOCIAL_PLATFORMS.filter(
      (p) => p.authMode === "manual_token",
    );
    expect(manual).toHaveLength(1);
    expect(manual[0]!.id).toBe("tiktok");
    expect(manual[0]!.authorizeRoute).toBeNull();
  });

  it("findPlatform returns the descriptor for known ids", () => {
    expect(findPlatform("meta")?.label).toMatch(/Meta/);
    expect(findPlatform("tiktok")?.authMode).toBe("manual_token");
  });

  it("findPlatform returns undefined for unknown ids", () => {
    expect(findPlatform("myspace")).toBeUndefined();
    expect(findPlatform("")).toBeUndefined();
  });
});
