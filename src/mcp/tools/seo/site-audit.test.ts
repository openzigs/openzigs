import { describe, it, expect } from "vitest";
import {
  auditPage,
  detectSiteWideIssues,
  generateAuditReport,
  type PageAuditResult,
  type SiteAuditResult,
} from "./site-audit.js";
import type { CrawlPage } from "../../../browser/firecrawl-client.js";
import type { ExtractedContent } from "./html-extractor.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function makePage(overrides: Partial<CrawlPage> = {}): CrawlPage {
  return {
    url: "https://example.com/",
    statusCode: 200,
    markdown: "# Test",
    ...overrides,
  };
}

function makeContent(
  overrides: Partial<ExtractedContent> = {},
): ExtractedContent {
  return {
    title: "Test Page",
    headings: [{ level: 1, text: "Test" }],
    bodyText: "a ".repeat(300),
    wordCount: 300,
    headingCount: 1,
    paragraphCount: 3,
    readingTime: 2,
    keywords: [],
    readabilityScore: 65,
    metaTitle: "Test Page — Example",
    metaDescription:
      "A test page for SEO audit with sufficient description length to pass checks.",
    metaTags: [],
    images: [],
    imagesWithoutAlt: 0,
    imagesMissingAlt: 0,
    imagesEmptyAlt: 0,
    imagesAriaHidden: 0,
    imagesLazyLoaded: 0,
    schemaMarkup: [],
    internalLinks: [{ href: "/about", text: "About", isInternal: true }],
    externalLinks: [],
    internalLinkCount: 1,
    externalLinkCount: 0,
    ...overrides,
  };
}

// ── auditPage ────────────────────────────────────────────────────────────

describe("auditPage", () => {
  it("returns no issues for a well-optimized page", () => {
    const page = makePage();
    const content = makeContent({
      schemaMarkup: [{ type: "WebPage", properties: ["name"] }],
    });
    const result = auditPage(page, content);
    expect(result.url).toBe("https://example.com/");
    // Only expected issue: none since we have schema, H1, meta, etc.
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("detects missing title", () => {
    const result = auditPage(
      makePage(),
      makeContent({ title: "", metaTitle: "" }),
    );
    expect(result.issues.some((i) => i.message === "Missing page title")).toBe(
      true,
    );
  });

  it("detects meta title too long", () => {
    const result = auditPage(
      makePage(),
      makeContent({ metaTitle: "A".repeat(65) }),
    );
    expect(
      result.issues.some(
        (i) => i.category === "meta" && i.message.includes("too long"),
      ),
    ).toBe(true);
  });

  it("detects meta title too short", () => {
    const result = auditPage(makePage(), makeContent({ metaTitle: "Hi" }));
    expect(
      result.issues.some(
        (i) => i.category === "meta" && i.message.includes("too short"),
      ),
    ).toBe(true);
  });

  it("detects missing meta description", () => {
    const result = auditPage(makePage(), makeContent({ metaDescription: "" }));
    expect(
      result.issues.some((i) => i.message === "Missing meta description"),
    ).toBe(true);
  });

  it("detects meta description too long", () => {
    const result = auditPage(
      makePage(),
      makeContent({ metaDescription: "X".repeat(165) }),
    );
    expect(
      result.issues.some((i) => i.message.includes("description too long")),
    ).toBe(true);
  });

  it("detects missing H1", () => {
    const result = auditPage(
      makePage(),
      makeContent({ headings: [{ level: 2, text: "Sub" }] }),
    );
    expect(result.issues.some((i) => i.message === "Missing H1 tag")).toBe(
      true,
    );
  });

  it("detects multiple H1 tags", () => {
    const result = auditPage(
      makePage(),
      makeContent({
        headings: [
          { level: 1, text: "A" },
          { level: 1, text: "B" },
        ],
      }),
    );
    expect(result.issues.some((i) => i.message.includes("Multiple H1"))).toBe(
      true,
    );
  });

  it("detects thin content", () => {
    const result = auditPage(
      makePage(),
      makeContent({ wordCount: 50, bodyText: "short" }),
    );
    expect(
      result.issues.some(
        (i) => i.category === "content" && i.message.includes("Thin content"),
      ),
    ).toBe(true);
  });

  it("detects images without alt text", () => {
    const result = auditPage(
      makePage(),
      makeContent({
        images: [
          {
            src: "/img.jpg",
            alt: "",
            hasAlt: false,
            altStatus: "empty" as const,
            isLazyLoaded: false,
            isAriaHidden: false,
          },
        ],
        imagesWithoutAlt: 1,
      }),
    );
    expect(
      result.issues.some(
        (i) => i.category === "images" && i.message.includes("missing alt"),
      ),
    ).toBe(true);
  });

  it("detects orphan pages (no internal links)", () => {
    const result = auditPage(
      makePage(),
      makeContent({ internalLinks: [], internalLinkCount: 0 }),
    );
    expect(
      result.issues.some((i) => i.message.includes("No internal links")),
    ).toBe(true);
  });

  it("records schema types", () => {
    const result = auditPage(
      makePage(),
      makeContent({
        schemaMarkup: [{ type: "Article", properties: ["headline"] }],
      }),
    );
    expect(result.schemaTypes).toEqual(["Article"]);
  });
});

// ── detectSiteWideIssues ─────────────────────────────────────────────────

describe("detectSiteWideIssues", () => {
  it("detects duplicate meta titles", () => {
    const pages: PageAuditResult[] = [
      auditPage(
        makePage({ url: "https://example.com/" }),
        makeContent({ metaTitle: "Same Title" }),
      ),
      auditPage(
        makePage({ url: "https://example.com/about" }),
        makeContent({ metaTitle: "Same Title" }),
      ),
    ];
    const issues = detectSiteWideIssues(pages);
    expect(
      issues.some(
        (i) =>
          i.category === "duplicates" &&
          i.message.includes("Duplicate meta title"),
      ),
    ).toBe(true);
  });

  it("detects duplicate meta descriptions", () => {
    const desc =
      "This is the same description used on multiple pages for testing.";
    const pages: PageAuditResult[] = [
      auditPage(
        makePage({ url: "https://example.com/" }),
        makeContent({ metaDescription: desc }),
      ),
      auditPage(
        makePage({ url: "https://example.com/about" }),
        makeContent({ metaDescription: desc }),
      ),
    ];
    const issues = detectSiteWideIssues(pages);
    expect(
      issues.some(
        (i) =>
          i.category === "duplicates" &&
          i.message.includes("Duplicate meta description"),
      ),
    ).toBe(true);
  });

  it("detects no schema markup across entire site", () => {
    const pages: PageAuditResult[] = [
      auditPage(makePage(), makeContent({ schemaMarkup: [] })),
    ];
    const issues = detectSiteWideIssues(pages);
    expect(issues.some((i) => i.category === "schema")).toBe(true);
  });

  it("detects low average word count", () => {
    const pages: PageAuditResult[] = [
      auditPage(makePage(), makeContent({ wordCount: 50, bodyText: "short" })),
      auditPage(
        makePage({ url: "https://example.com/2" }),
        makeContent({ wordCount: 100, bodyText: "short" }),
      ),
    ];
    const issues = detectSiteWideIssues(pages);
    expect(
      issues.some((i) => i.message.includes("Low average word count")),
    ).toBe(true);
  });

  it("returns no issues for unique, well-structured pages", () => {
    const pages: PageAuditResult[] = [
      auditPage(
        makePage(),
        makeContent({
          metaTitle: "Page One",
          metaDescription:
            "Description for page one is long enough to pass validation.",
          schemaMarkup: [{ type: "WebPage", properties: [] }],
        }),
      ),
      auditPage(
        makePage({ url: "https://example.com/two" }),
        makeContent({
          metaTitle: "Page Two",
          metaDescription:
            "Description for page two is different and also long enough.",
          schemaMarkup: [{ type: "Article", properties: [] }],
        }),
      ),
    ];
    const issues = detectSiteWideIssues(pages);
    expect(issues).toHaveLength(0);
  });
});

// ── generateAuditReport ──────────────────────────────────────────────────

describe("generateAuditReport", () => {
  it("generates valid Markdown report", () => {
    const result: SiteAuditResult = {
      siteUrl: "https://example.com",
      pagesAudited: 2,
      totalIssues: 3,
      errorCount: 1,
      warningCount: 1,
      infoCount: 1,
      pages: [
        {
          url: "https://example.com/",
          statusCode: 200,
          title: "Home",
          metaTitle: "Home — Example",
          metaDescription: "Welcome to Example",
          wordCount: 500,
          headingCount: 5,
          h1Count: 1,
          imagesTotal: 3,
          imagesWithoutAlt: 1,
          internalLinkCount: 10,
          externalLinkCount: 2,
          schemaTypes: ["WebPage"],
          readabilityScore: 65.5,
          issues: [
            {
              severity: "warning",
              category: "images",
              message: "1 image(s) missing alt text",
            },
          ],
        },
      ],
      siteWideIssues: [
        {
          severity: "error",
          category: "meta",
          message: "Missing canonical tags",
        },
      ],
      reportPath: "/tmp/report.md",
      pdfPath: null,
    };

    const report = generateAuditReport(result);

    expect(report).toContain("# SEO Site Audit: https://example.com");
    expect(report).toContain("Pages Audited:** 2");
    expect(report).toContain("Total Issues:** 3");
    expect(report).toContain("| 🔴 Errors | 1 |");
    expect(report).toContain("Site-Wide Issues");
    expect(report).toContain("Missing canonical tags");
    expect(report).toContain("### https://example.com/");
    expect(report).toContain("| Word Count | 500 |");
  });
});
