import { describe, it, expect } from "vitest";
import { auditSocialMeta } from "./site-audit.js";
import type { ExtractedContent } from "./html-extractor.js";

function makeContent(
  metaTags: Array<{ name: string; content: string }> = [],
): ExtractedContent {
  return {
    title: "Test",
    headings: [],
    bodyText: "",
    wordCount: 0,
    headingCount: 0,
    paragraphCount: 0,
    readingTime: 0,
    keywords: [],
    readabilityScore: 60,
    metaTitle: "Test",
    metaDescription: "Test description that is long enough",
    metaTags,
    images: [],
    imagesWithoutAlt: 0,
    imagesMissingAlt: 0,
    imagesEmptyAlt: 0,
    imagesAriaHidden: 0,
    imagesLazyLoaded: 0,
    schemaMarkup: [],
    internalLinks: [],
    externalLinks: [],
    internalLinkCount: 0,
    externalLinkCount: 0,
    canonical: null,
    hreflangTags: [],
    metaRobots: null,
    jsonLdBlocks: [],
  };
}

describe("auditSocialMeta (#876)", () => {
  it("returns no issues when all OG and Twitter tags are present", () => {
    const content = makeContent([
      { name: "og:title", content: "My Title" },
      { name: "og:description", content: "My Description" },
      { name: "og:image", content: "https://example.com/img.jpg" },
      { name: "og:url", content: "https://example.com" },
      { name: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ]);
    const issues = auditSocialMeta(content);
    expect(issues).toHaveLength(0);
  });

  it("detects missing og:title as error", () => {
    const content = makeContent([
      { name: "og:description", content: "Desc" },
      { name: "og:image", content: "https://example.com/img.jpg" },
      { name: "twitter:card", content: "summary" },
    ]);
    const issues = auditSocialMeta(content);
    const ogTitle = issues.find((i) => i.message.includes("og:title"));
    expect(ogTitle).toBeDefined();
    expect(ogTitle!.severity).toBe("error");
    expect(ogTitle!.category).toBe("Social");
  });

  it("detects missing og:description as error", () => {
    const content = makeContent([
      { name: "og:title", content: "Title" },
      { name: "twitter:card", content: "summary" },
    ]);
    const issues = auditSocialMeta(content);
    expect(
      issues.some(
        (i) => i.message.includes("og:description") && i.severity === "error",
      ),
    ).toBe(true);
  });

  it("detects missing og:image as warning", () => {
    const content = makeContent([
      { name: "og:title", content: "Title" },
      { name: "og:description", content: "Desc" },
      { name: "twitter:card", content: "summary" },
    ]);
    const issues = auditSocialMeta(content);
    expect(
      issues.some(
        (i) => i.message.includes("og:image") && i.severity === "warning",
      ),
    ).toBe(true);
  });

  it("detects missing og:url as info", () => {
    const content = makeContent([
      { name: "og:title", content: "Title" },
      { name: "og:description", content: "Desc" },
      { name: "og:image", content: "https://example.com/img.jpg" },
      { name: "twitter:card", content: "summary" },
    ]);
    const issues = auditSocialMeta(content);
    expect(
      issues.some((i) => i.message.includes("og:url") && i.severity === "info"),
    ).toBe(true);
  });

  it("detects missing og:type as info", () => {
    const content = makeContent([
      { name: "og:title", content: "Title" },
      { name: "og:description", content: "Desc" },
      { name: "og:image", content: "https://example.com/img.jpg" },
      { name: "og:url", content: "https://example.com" },
      { name: "twitter:card", content: "summary" },
    ]);
    const issues = auditSocialMeta(content);
    expect(
      issues.some(
        (i) => i.message.includes("og:type") && i.severity === "info",
      ),
    ).toBe(true);
  });

  it("detects missing twitter:card as warning", () => {
    const content = makeContent([
      { name: "og:title", content: "Title" },
      { name: "og:description", content: "Desc" },
      { name: "og:image", content: "https://example.com/img.jpg" },
      { name: "og:url", content: "https://example.com" },
      { name: "og:type", content: "website" },
    ]);
    const issues = auditSocialMeta(content);
    expect(
      issues.some(
        (i) => i.message.includes("twitter:card") && i.severity === "warning",
      ),
    ).toBe(true);
  });

  it("detects invalid twitter:card value as warning", () => {
    const content = makeContent([
      { name: "og:title", content: "Title" },
      { name: "og:description", content: "Desc" },
      { name: "og:image", content: "https://example.com/img.jpg" },
      { name: "og:url", content: "https://example.com" },
      { name: "og:type", content: "website" },
      { name: "twitter:card", content: "invalid_type" },
    ]);
    const issues = auditSocialMeta(content);
    const invalid = issues.find((i) =>
      i.message.includes("Invalid twitter:card"),
    );
    expect(invalid).toBeDefined();
    expect(invalid!.severity).toBe("warning");
  });

  it("accepts valid twitter:card values", () => {
    for (const cardType of [
      "summary",
      "summary_large_image",
      "app",
      "player",
    ]) {
      const content = makeContent([
        { name: "og:title", content: "Title" },
        { name: "og:description", content: "Desc" },
        { name: "og:image", content: "https://example.com/img.jpg" },
        { name: "og:url", content: "https://example.com" },
        { name: "og:type", content: "website" },
        { name: "twitter:card", content: cardType },
      ]);
      const issues = auditSocialMeta(content);
      expect(
        issues.some((i) => i.message.includes("Invalid twitter:card")),
      ).toBe(false);
    }
  });

  it("reports all missing tags when page has zero social meta", () => {
    const content = makeContent([]);
    const issues = auditSocialMeta(content);
    // og:title, og:description = error (2), og:image = warning (1),
    // og:url, og:type = info (2), twitter:card = warning (1)
    expect(issues).toHaveLength(6);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(2);
    expect(issues.filter((i) => i.severity === "warning")).toHaveLength(2);
    expect(issues.filter((i) => i.severity === "info")).toHaveLength(2);
  });
});
