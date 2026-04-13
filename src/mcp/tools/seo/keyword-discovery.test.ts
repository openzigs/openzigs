import { describe, it, expect } from "vitest";
import { discoverKeyword } from "./keyword-discovery.js";
import type { ExtractedContent } from "./html-extractor.js";

function makeContent(
  overrides: Partial<ExtractedContent> = {},
): ExtractedContent {
  return {
    title: "Best Project Management Tools for Teams",
    headings: [
      { level: 1, text: "Best Project Management Tools for Teams" },
      { level: 2, text: "Top Picks" },
      { level: 2, text: "How We Evaluated" },
    ],
    bodyText:
      "Project management tools help teams collaborate effectively. " +
      "The best project management tools include features like task tracking, " +
      "Gantt charts, and team communication. Project management software has evolved " +
      "significantly over the years with tools offering better integrations.",
    wordCount: 50,
    headingCount: 3,
    paragraphCount: 2,
    readingTime: 1,
    keywords: [
      { term: "project", tfidf: 3.2 },
      { term: "management", tfidf: 2.8 },
      { term: "tools", tfidf: 2.5 },
      { term: "team", tfidf: 1.4 },
      { term: "tracking", tfidf: 1.0 },
    ],
    readabilityScore: 62.5,
    metaTitle: "",
    metaDescription: "",
    metaTags: [],
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
    ...overrides,
  };
}

describe("discoverKeyword", () => {
  it("detects keyword from title/H1 content", () => {
    const content = makeContent();
    const result = discoverKeyword(
      content,
      "https://example.com/best-pm-tools",
    );

    expect(result).not.toBeNull();
    expect(result!.keyword).toBeTruthy();
    expect(result!.keyword.length).toBeGreaterThanOrEqual(3);
    expect(result!.intent).toBeDefined();
  });

  it("returns alternatives alongside the primary keyword", () => {
    const content = makeContent();
    const result = discoverKeyword(content, "https://example.com/tools");

    expect(result).not.toBeNull();
    expect(result!.alternatives).toBeDefined();
    expect(Array.isArray(result!.alternatives)).toBe(true);
  });

  it("classifies transactional intent correctly", () => {
    const content = makeContent({
      title: "Buy Cheap Project Management Software",
      headings: [{ level: 1, text: "Buy Cheap Project Management Software" }],
    });
    const result = discoverKeyword(content, "https://store.example.com/buy-pm");

    expect(result).not.toBeNull();
    expect(result!.intent).toBe("transactional");
  });

  it("classifies commercial intent for comparison pages", () => {
    const content = makeContent({
      title: "Best CRM Software Comparison 2026",
      headings: [{ level: 1, text: "Best CRM Software Comparison 2026" }],
      bodyText:
        "We compare the best CRM software tools. The top-rated CRM platforms include...",
      keywords: [
        { term: "crm", tfidf: 3.5 },
        { term: "software", tfidf: 2.0 },
        { term: "comparison", tfidf: 1.8 },
      ],
    });
    const result = discoverKeyword(
      content,
      "https://example.com/best-crm-comparison",
    );

    expect(result).not.toBeNull();
    expect(result!.intent).toBe("commercial");
  });

  it("classifies navigational intent for docs/login pages", () => {
    const content = makeContent({
      title: "Jira Documentation - Getting Started",
      headings: [{ level: 1, text: "Jira Documentation - Getting Started" }],
      bodyText:
        "Welcome to the official Jira documentation. Learn how to install and configure...",
      keywords: [
        { term: "jira", tfidf: 3.0 },
        { term: "documentation", tfidf: 2.5 },
      ],
    });
    const result = discoverKeyword(content, "https://jira.atlassian.com/docs");

    expect(result).not.toBeNull();
    expect(result!.intent).toBe("navigational");
  });

  it("uses URL slug as a signal when title is sparse", () => {
    const content = makeContent({
      title: "",
      headings: [],
      bodyText:
        "Some generic content about various topics and subjects for testing.",
      keywords: [
        { term: "content", tfidf: 1.0 },
        { term: "topics", tfidf: 0.8 },
      ],
    });
    const result = discoverKeyword(
      content,
      "https://example.com/blog/react-performance-optimization",
    );

    expect(result).not.toBeNull();
    expect(result!.keyword).toContain("react performance optimization");
  });

  it("returns null when content has no usable signals", () => {
    const content = makeContent({
      title: "",
      headings: [],
      bodyText: "",
      keywords: [],
    });
    const result = discoverKeyword(content, "https://example.com/");

    expect(result).toBeNull();
  });

  it("prefers multi-word phrases over single terms", () => {
    const content = makeContent();
    const result = discoverKeyword(content, "https://example.com/page");

    expect(result).not.toBeNull();
    const wordCount = result!.keyword.split(/\s+/).length;
    expect(wordCount).toBeGreaterThanOrEqual(2);
  });

  it("boosts keywords that appear frequently in body text", () => {
    const content = makeContent({
      title: "React Hooks Guide",
      headings: [{ level: 1, text: "React Hooks Guide" }],
      bodyText:
        "React hooks are essential. React hooks simplify state management. " +
        "React hooks enable functional components. Use react hooks for cleaner code. " +
        "React hooks provide a modern API.",
      keywords: [
        { term: "react", tfidf: 3.5 },
        { term: "hooks", tfidf: 3.0 },
        { term: "state", tfidf: 1.2 },
      ],
    });
    const result = discoverKeyword(
      content,
      "https://blog.example.com/react-hooks-guide",
    );

    expect(result).not.toBeNull();
    expect(result!.keyword).toContain("react");
  });

  it("handles URL with no meaningful slug", () => {
    const content = makeContent();
    const result = discoverKeyword(content, "https://example.com/");

    expect(result).not.toBeNull();
    // Should still work based on title/tfidf signals
    expect(result!.keyword.length).toBeGreaterThanOrEqual(3);
  });

  it("strips common stop words from title phrases", () => {
    const content = makeContent({
      title: "The Ultimate Guide to Project Management",
      headings: [
        { level: 1, text: "The Ultimate Guide to Project Management" },
      ],
    });
    const result = discoverKeyword(content, "https://example.com/pm-guide");

    expect(result).not.toBeNull();
    // Should not start with "the"
    expect(result!.keyword.startsWith("the ")).toBe(false);
  });
});
