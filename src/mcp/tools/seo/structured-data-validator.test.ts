import { describe, it, expect } from "vitest";
import {
  validateJsonLdBlock,
  validateStructuredData,
  type StructuredDataIssue,
} from "./structured-data-validator.js";

// ── validateJsonLdBlock ──────────────────────────────────────────────────

describe("validateJsonLdBlock", () => {
  it("validates a valid Article schema", () => {
    const issues: StructuredDataIssue[] = [];
    const types = validateJsonLdBlock(
      {
        "@type": "Article",
        headline: "Test Article",
        author: { "@type": "Person", name: "Alice" },
        datePublished: "2025-01-15",
        image: "https://example.com/img.jpg",
        publisher: { "@type": "Organization", name: "TestOrg" },
      },
      issues,
    );
    expect(types).toContain("Article");
    expect(types).toContain("Person");
    expect(types).toContain("Organization");
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("reports missing required properties", () => {
    const issues: StructuredDataIssue[] = [];
    validateJsonLdBlock({ "@type": "Article" }, issues);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.some((e) => e.message.includes("headline"))).toBe(true);
    expect(errors.some((e) => e.message.includes("author"))).toBe(true);
    expect(errors.some((e) => e.message.includes("datePublished"))).toBe(true);
  });

  it("reports missing recommended properties as warnings", () => {
    const issues: StructuredDataIssue[] = [];
    validateJsonLdBlock(
      {
        "@type": "Article",
        headline: "Test",
        author: "Alice",
        datePublished: "2025-01-01",
      },
      issues,
    );
    const warnings = issues.filter((i) => i.severity === "warning");
    expect(warnings.some((w) => w.message.includes("image"))).toBe(true);
    expect(warnings.some((w) => w.message.includes("publisher"))).toBe(true);
  });

  it("validates URL fields", () => {
    const issues: StructuredDataIssue[] = [];
    validateJsonLdBlock(
      {
        "@type": "WebSite",
        name: "Test",
        url: "not-a-url",
      },
      issues,
    );
    expect(issues.some((i) => i.message.includes("invalid URL"))).toBe(true);
  });

  it("validates date fields", () => {
    const issues: StructuredDataIssue[] = [];
    validateJsonLdBlock(
      {
        "@type": "Event",
        name: "Party",
        startDate: "invalid-date",
        location: "NYC",
      },
      issues,
    );
    expect(issues.some((i) => i.message.includes("invalid date"))).toBe(true);
  });

  it("handles @graph arrays", () => {
    const issues: StructuredDataIssue[] = [];
    const types = validateJsonLdBlock(
      {
        "@graph": [
          { "@type": "WebSite", name: "Test", url: "https://example.com" },
          { "@type": "WebPage", name: "Home" },
        ],
      },
      issues,
    );
    expect(types).toContain("WebSite");
    expect(types).toContain("WebPage");
  });

  it("handles arrays at top level", () => {
    const issues: StructuredDataIssue[] = [];
    const types = validateJsonLdBlock(
      [
        { "@type": "Organization", name: "Org" },
        { "@type": "Person", name: "Alice" },
      ],
      issues,
    );
    expect(types).toContain("Organization");
    expect(types).toContain("Person");
  });

  it("skips unknown schema types without error", () => {
    const issues: StructuredDataIssue[] = [];
    const types = validateJsonLdBlock(
      { "@type": "CustomType", name: "Foo" },
      issues,
    );
    expect(types).toContain("CustomType");
    expect(issues).toHaveLength(0);
  });

  it("handles null and non-object input gracefully", () => {
    const issues: StructuredDataIssue[] = [];
    expect(validateJsonLdBlock(null, issues)).toEqual([]);
    expect(validateJsonLdBlock("string", issues)).toEqual([]);
    expect(validateJsonLdBlock(42, issues)).toEqual([]);
  });

  it("validates Product schema", () => {
    const issues: StructuredDataIssue[] = [];
    validateJsonLdBlock({ "@type": "Product" }, issues);
    expect(
      issues.some((i) =>
        i.message.includes('missing required property "name"'),
      ),
    ).toBe(true);
  });

  it("validates BreadcrumbList schema", () => {
    const issues: StructuredDataIssue[] = [];
    validateJsonLdBlock({ "@type": "BreadcrumbList" }, issues);
    expect(issues.some((i) => i.message.includes("itemListElement"))).toBe(
      true,
    );
  });

  it("validates VideoObject with valid dates", () => {
    const issues: StructuredDataIssue[] = [];
    validateJsonLdBlock(
      {
        "@type": "VideoObject",
        name: "Video",
        description: "A video",
        thumbnailUrl: "https://example.com/thumb.jpg",
        uploadDate: "2025-06-01T12:00:00Z",
      },
      issues,
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });
});

// ── validateStructuredData ───────────────────────────────────────────────

describe("validateStructuredData", () => {
  it("validates multiple JSON-LD blocks", () => {
    const result = validateStructuredData([
      {
        parsed: {
          "@type": "WebSite",
          name: "Test Site",
          url: "https://example.com",
        },
      },
      {
        parsed: {
          "@type": "Article",
          headline: "Post",
          author: "A",
          datePublished: "2025-01-01",
        },
      },
    ]);
    expect(result.totalBlocks).toBe(2);
    expect(result.typesFound).toContain("WebSite");
    expect(result.typesFound).toContain("Article");
  });

  it("deduplicates found types", () => {
    const result = validateStructuredData([
      {
        parsed: {
          "@type": "Article",
          headline: "A",
          author: "X",
          datePublished: "2025-01-01",
        },
      },
      {
        parsed: {
          "@type": "Article",
          headline: "B",
          author: "Y",
          datePublished: "2025-02-01",
        },
      },
    ]);
    expect(result.typesFound.filter((t) => t === "Article")).toHaveLength(1);
  });

  it("returns empty result for no blocks", () => {
    const result = validateStructuredData([]);
    expect(result.totalBlocks).toBe(0);
    expect(result.typesFound).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });
});
