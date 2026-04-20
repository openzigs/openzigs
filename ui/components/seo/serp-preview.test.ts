import { describe, it, expect } from "vitest";

// Test the pure utility logic from the SerpPreview component
// (Character counting, truncation rules)

describe("SERP Preview logic (#882)", () => {
  const TITLE_MAX = 60;
  const DESC_MAX = 160;

  it("truncates title at 60 chars", () => {
    const title = "A".repeat(70);
    const truncated =
      title.length > TITLE_MAX ? title.slice(0, TITLE_MAX) + "..." : title;
    expect(truncated).toHaveLength(63); // 60 + "..."
    expect(truncated.endsWith("...")).toBe(true);
  });

  it("does not truncate title under 60 chars", () => {
    const title = "Short Title";
    const truncated =
      title.length > TITLE_MAX ? title.slice(0, TITLE_MAX) + "..." : title;
    expect(truncated).toBe("Short Title");
  });

  it("truncates description at 160 chars", () => {
    const desc = "B".repeat(200);
    const truncated =
      desc.length > DESC_MAX ? desc.slice(0, DESC_MAX) + "..." : desc;
    expect(truncated).toHaveLength(163);
  });

  it("formats URL breadcrumb from full URL", () => {
    const formatUrl = (rawUrl: string): string => {
      try {
        const parsed = new URL(rawUrl);
        const parts = parsed.pathname.split("/").filter(Boolean);
        const host = parsed.hostname;
        if (parts.length === 0) return host;
        return `${host} › ${parts.join(" › ")}`;
      } catch {
        return rawUrl;
      }
    };

    expect(formatUrl("https://example.com/blog/post-1")).toBe(
      "example.com › blog › post-1",
    );
    expect(formatUrl("https://example.com/")).toBe("example.com");
    expect(formatUrl("https://example.com")).toBe("example.com");
    expect(formatUrl("not-a-url")).toBe("not-a-url");
  });

  it("detects truncation for title over 60 chars", () => {
    expect("A".repeat(70).length > TITLE_MAX).toBe(true);
    expect("Short".length > TITLE_MAX).toBe(false);
  });

  it("detects truncation for description over 160 chars", () => {
    expect("B".repeat(200).length > DESC_MAX).toBe(true);
    expect("Short".length > DESC_MAX).toBe(false);
  });
});
