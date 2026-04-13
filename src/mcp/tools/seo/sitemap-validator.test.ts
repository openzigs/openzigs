import { describe, it, expect, vi } from "vitest";
import {
  parseSitemapXml,
  compareSitemapToCrawl,
  fetchAndValidateSitemap,
} from "./sitemap-validator.js";

// ── parseSitemapXml ──────────────────────────────────────────────────────

describe("parseSitemapXml", () => {
  it("parses a standard urlset sitemap", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2025-01-15</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://example.com/about</loc>
    <lastmod>2025-01-10</lastmod>
    <priority>0.8</priority>
  </url>
</urlset>`;
    const result = parseSitemapXml(xml);
    expect(result.urls).toHaveLength(2);
    expect(result.urls[0].loc).toBe("https://example.com/");
    expect(result.urls[0].lastmod).toBe("2025-01-15");
    expect(result.urls[0].changefreq).toBe("daily");
    expect(result.urls[0].priority).toBe(1.0);
    expect(result.urls[1].loc).toBe("https://example.com/about");
    expect(result.childSitemaps).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });

  it("parses a sitemap index", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-pages.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap-posts.xml</loc>
  </sitemap>
</sitemapindex>`;
    const result = parseSitemapXml(xml);
    expect(result.urls).toHaveLength(0);
    expect(result.childSitemaps).toEqual([
      "https://example.com/sitemap-pages.xml",
      "https://example.com/sitemap-posts.xml",
    ]);
  });

  it("reports entries missing <loc>", () => {
    const xml = `<urlset><url><lastmod>2025-01-01</lastmod></url></urlset>`;
    const result = parseSitemapXml(xml);
    expect(result.urls).toHaveLength(0);
    expect(result.issues.some((i) => i.message.includes("missing <loc>"))).toBe(
      true,
    );
  });

  it("reports invalid URLs", () => {
    const xml = `<urlset><url><loc>not-a-url</loc></url></urlset>`;
    const result = parseSitemapXml(xml);
    expect(result.urls).toHaveLength(0);
    expect(result.issues.some((i) => i.message.includes("Invalid URL"))).toBe(
      true,
    );
  });

  it("reports invalid lastmod dates", () => {
    const xml = `<urlset><url><loc>https://example.com/</loc><lastmod>not-a-date</lastmod></url></urlset>`;
    const result = parseSitemapXml(xml);
    expect(result.urls).toHaveLength(1);
    expect(
      result.issues.some((i) => i.message.includes("Invalid lastmod")),
    ).toBe(true);
  });

  it("reports invalid changefreq", () => {
    const xml = `<urlset><url><loc>https://example.com/</loc><changefreq>biweekly</changefreq></url></urlset>`;
    const result = parseSitemapXml(xml);
    expect(
      result.issues.some((i) => i.message.includes("Invalid changefreq")),
    ).toBe(true);
  });

  it("reports invalid priority values", () => {
    const xml = `<urlset><url><loc>https://example.com/</loc><priority>2.0</priority></url></urlset>`;
    const result = parseSitemapXml(xml);
    expect(
      result.issues.some((i) => i.message.includes("Invalid priority")),
    ).toBe(true);
    expect(result.urls[0].priority).toBeUndefined();
  });
});

// ── compareSitemapToCrawl ────────────────────────────────────────────────

describe("compareSitemapToCrawl", () => {
  it("identifies orphaned and missing URLs", () => {
    const sitemapUrls = [
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/old-page",
    ];
    const crawledUrls = [
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/new-page",
    ];
    const result = compareSitemapToCrawl(sitemapUrls, crawledUrls);
    expect(result.orphanedUrls).toEqual(["https://example.com/old-page"]);
    expect(result.missingUrls).toEqual(["https://example.com/new-page"]);
  });

  it("normalizes trailing slashes", () => {
    const result = compareSitemapToCrawl(
      ["https://example.com/about/"],
      ["https://example.com/about"],
    );
    expect(result.orphanedUrls).toHaveLength(0);
    expect(result.missingUrls).toHaveLength(0);
  });

  it("returns empty arrays when both match", () => {
    const urls = ["https://example.com/", "https://example.com/blog"];
    const result = compareSitemapToCrawl(urls, urls);
    expect(result.orphanedUrls).toHaveLength(0);
    expect(result.missingUrls).toHaveLength(0);
  });
});

// ── fetchAndValidateSitemap ──────────────────────────────────────────────

describe("fetchAndValidateSitemap", () => {
  it("fetches and parses a sitemap", async () => {
    const xml = `<urlset><url><loc>https://example.com/</loc></url></urlset>`;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => xml,
    });

    const result = await fetchAndValidateSitemap(
      "https://example.com",
      [],
      mockFetch,
    );
    expect(result.found).toBe(true);
    expect(result.urls).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/sitemap.xml",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("uses robots.txt sitemap URLs when provided", async () => {
    const xml = `<urlset><url><loc>https://example.com/page</loc></url></urlset>`;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => xml,
    });

    await fetchAndValidateSitemap(
      "https://example.com",
      ["https://example.com/custom-sitemap.xml"],
      mockFetch,
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/custom-sitemap.xml",
      expect.any(Object),
    );
  });

  it("follows sitemap index one level deep", async () => {
    const indexXml = `<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>`;
    const childXml = `<urlset><url><loc>https://example.com/deep</loc></url></urlset>`;
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => indexXml })
      .mockResolvedValueOnce({ ok: true, text: async () => childXml });

    const result = await fetchAndValidateSitemap(
      "https://example.com",
      [],
      mockFetch,
    );
    expect(result.found).toBe(true);
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0].loc).toBe("https://example.com/deep");
  });

  it("reports when sitemap is not found", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const result = await fetchAndValidateSitemap(
      "https://example.com",
      [],
      mockFetch,
    );
    expect(result.found).toBe(false);
    expect(result.issues.some((i) => i.severity === "warning")).toBe(true);
  });

  it("handles network errors gracefully", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("timeout"));
    const result = await fetchAndValidateSitemap(
      "https://example.com",
      [],
      mockFetch,
    );
    expect(result.found).toBe(false);
  });
});
