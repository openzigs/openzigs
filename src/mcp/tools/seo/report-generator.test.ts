import { describe, it, expect } from "vitest";
import {
  buildAnalysisPrompt,
  generateMetricsReport,
  buildReportFilename,
  buildReportSubdir,
  type AnalysisInput,
} from "./report-generator.js";

const makeContent = (overrides = {}) => ({
  title: "Test Page",
  headings: [
    { level: 1, text: "Main Heading" },
    { level: 2, text: "Sub Heading" },
  ],
  bodyText: "Test body text content for analysis",
  wordCount: 500,
  headingCount: 2,
  paragraphCount: 5,
  readingTime: 2,
  keywords: [
    { term: "test", tfidf: 1.5 },
    { term: "analysis", tfidf: 1.2 },
    { term: "content", tfidf: 0.9 },
  ],
  readabilityScore: 65.2,
  metaTitle: "Test Page - Example",
  metaDescription: "A test page for SEO analysis with detailed content.",
  metaTags: [{ name: "description", content: "A test page for SEO analysis with detailed content." }],
  images: [
    { src: "/img/hero.jpg", alt: "Hero image", hasAlt: true, altStatus: "present" as const, isAriaHidden: false, isLazyLoaded: false },
    { src: "/img/chart.png", alt: "", hasAlt: false, altStatus: "empty" as const, isAriaHidden: false, isLazyLoaded: false },
  ],
  imagesWithoutAlt: 1,
  imagesMissingAlt: 0,
  imagesEmptyAlt: 1,
  imagesAriaHidden: 0,
  imagesLazyLoaded: 0,
  schemaMarkup: [{ type: "Article", properties: ["headline", "author", "datePublished"] }],
  internalLinks: [{ href: "/about", text: "About Us", isInternal: true }],
  externalLinks: [{ href: "https://external.com", text: "External", isInternal: false }],
  internalLinkCount: 1,
  externalLinkCount: 1,
  ...overrides,
});

const makeInput = (overrides = {}): AnalysisInput => ({
  targetUrl: "https://example.com/page",
  targetKeyword: "test keyword",
  targetContent: makeContent(),
  competitors: [
    { ...makeContent({ title: "Competitor 1", wordCount: 800 }), url: "https://comp1.com/page" },
    { ...makeContent({ title: "Competitor 2", wordCount: 600 }), url: "https://comp2.com/page" },
  ],
  serpFeatures: {
    paa: ["What is testing?", "How to test?"],
    relatedSearches: ["testing tools", "test automation"],
    featuredSnippet: "Testing is the process of evaluating software.",
  },
  ...overrides,
});

describe("report-generator", () => {
  describe("buildAnalysisPrompt", () => {
    it("includes the target URL and keyword", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("https://example.com/page");
      expect(prompt).toContain("test keyword");
    });

    it("includes target metrics", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("500");
      expect(prompt).toContain("65.2");
      expect(prompt).toContain("2 min");
    });

    it("includes competitor data", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("https://comp1.com/page");
      expect(prompt).toContain("https://comp2.com/page");
      expect(prompt).toContain("Competitor 1");
    });

    it("includes headings for target and competitors", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("H1: Main Heading");
      expect(prompt).toContain("H2: Sub Heading");
    });

    it("includes PAA questions", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("What is testing?");
      expect(prompt).toContain("How to test?");
    });

    it("includes related searches", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("testing tools");
      expect(prompt).toContain("test automation");
    });

    it("includes featured snippet", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("Testing is the process");
    });

    it("includes analysis task instructions", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("Content Depth & Topical Coverage");
      expect(prompt).toContain("Actionable Content Brief");
      expect(prompt).toContain("Search Intent Alignment");
    });

    it("includes keyword TF-IDF scores", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("test (1.5)");
      expect(prompt).toContain("analysis (1.2)");
    });

    it("handles empty competitors", () => {
      const prompt = buildAnalysisPrompt(makeInput({ competitors: [] }));
      expect(prompt).toContain("## Target Page");
      expect(prompt).toContain("## Competitors");
    });

    it("handles empty PAA and related searches", () => {
      const prompt = buildAnalysisPrompt(
        makeInput({
          serpFeatures: { paa: [], relatedSearches: [], featuredSnippet: undefined },
        }),
      );
      expect(prompt).not.toContain("People Also Ask");
      expect(prompt).not.toContain("Related Searches");
      expect(prompt).not.toContain("Featured Snippet");
    });
  });

  describe("generateMetricsReport", () => {
    it("generates a markdown report", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("# SEO Gap Analysis");
      expect(report).toContain("test keyword");
    });

    it("includes a metrics comparison table", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("| Page | Words | Headings |");
      expect(report).toContain("**Target**");
      expect(report).toContain("500");
    });

    it("includes Target Page SEO Audit section", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("## Target Page SEO Audit");
      expect(report).toContain("### Content Quality");
      expect(report).toContain("### Meta Tags");
      expect(report).toContain("### Technical SEO");
      expect(report).toContain("### Top Keywords (TF-IDF)");
    });

    it("includes Topic Landscape section when SERP features present", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("## Topic Landscape");
      expect(report).toContain("### People Also Ask");
      expect(report).toContain("### Related Searches");
    });

    it("includes Content Gap Score section", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("## Content Gap Score");
      expect(report).toContain("Competitor Avg Word Count");
      expect(report).toContain("Content Gap");
    });

    it("includes competitor entries in the table", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("comp1.com");
      expect(report).toContain("comp2.com");
    });

    it("includes a Mermaid chart", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("```mermaid");
      expect(report).toContain("xychart-beta");
      expect(report).toContain("```");
    });

    it("includes header structure in collapsible section", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("Header Structure Comparison");
      expect(report).toContain("**H1**: Main Heading");
      expect(report).toContain("**H2**: Sub Heading");
    });

    it("includes keyword coverage table", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("## Keyword Coverage");
      expect(report).toContain("| Keyword |");
    });

    it("includes SERP features section", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("## SERP Feature Opportunities");
      expect(report).toContain("What is testing?");
      expect(report).toContain("testing tools");
    });

    it("includes featured snippet when available", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("Current Featured Snippet");
      expect(report).toContain("Testing is the process");
    });

    it("omits SERP section when empty", () => {
      const report = generateMetricsReport(
        makeInput({
          serpFeatures: { paa: [], relatedSearches: [], featuredSnippet: undefined },
        }),
      );
      expect(report).not.toContain("SERP Feature Opportunities");
    });

    it("handles no competitors", () => {
      const report = generateMetricsReport(makeInput({ competitors: [] }));
      expect(report).toContain("**Target**");
      // Should not crash, averages should be 0
    });

    it("includes the date", () => {
      const report = generateMetricsReport(makeInput());
      // Date format: YYYY-MM-DD
      expect(report).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it("includes On-Page SEO Signals table", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("## On-Page SEO Signals");
      expect(report).toContain("Meta Title (len)");
      expect(report).toContain("Schema Types");
      expect(report).toContain("Imgs No Alt");
    });

    it("includes Schema Markup Comparison when schema exists", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("## Schema Markup Comparison");
      expect(report).toContain("Article");
    });

    it("omits Schema Markup Comparison when no schema present", () => {
      const report = generateMetricsReport(
        makeInput({
          targetContent: makeContent({ schemaMarkup: [] }),
          competitors: [
            { ...makeContent({ title: "C1", wordCount: 800, schemaMarkup: [] }), url: "https://comp1.com/page" },
          ],
        }),
      );
      expect(report).not.toContain("## Schema Markup Comparison");
    });

    it("includes Internal Linking Profile table", () => {
      const report = generateMetricsReport(makeInput());
      expect(report).toContain("## Internal Linking Profile");
      expect(report).toContain("Internal Links");
      expect(report).toContain("External Links");
    });
  });

  describe("buildAnalysisPrompt includes technical SEO data", () => {
    it("includes meta title and description info", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("Meta Title");
      expect(prompt).toContain("Meta Description");
    });

    it("includes schema types in prompt", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("Schema Types");
      expect(prompt).toContain("Article");
    });

    it("includes image and link data in prompt", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("Images");
      expect(prompt).toContain("Internal Links");
      expect(prompt).toContain("External Links");
    });

    it("includes Technical SEO Gaps in task instructions", () => {
      const prompt = buildAnalysisPrompt(makeInput());
      expect(prompt).toContain("Technical SEO Gaps");
    });
  });

  describe("buildReportFilename", () => {
    it("generates a filename with domain and keyword slug", () => {
      const name = buildReportFilename("https://example.com/page", "best coffee makers");
      expect(name).toMatch(/^example\.com-best-coffee-makers-\d{4}-\d{2}-\d{2}\.md$/);
    });

    it("strips www. from domain", () => {
      const name = buildReportFilename("https://www.example.com/page", "test");
      expect(name).toMatch(/^example\.com-test-/);
    });

    it("handles special characters in keyword", () => {
      const name = buildReportFilename("https://example.com", "what's the best way?");
      expect(name).not.toContain("?");
      expect(name).not.toContain("'");
      expect(name).toMatch(/\.md$/);
    });

    it("handles invalid URL gracefully", () => {
      const name = buildReportFilename("not-a-url", "test");
      expect(name).toMatch(/^unknown-test-/);
    });

    it("truncates long keywords", () => {
      const longKeyword = "a".repeat(100);
      const name = buildReportFilename("https://example.com", longKeyword);
      // slug is capped at 50 chars
      expect(name.length).toBeLessThan(100);
    });

    it("includes the date", () => {
      const name = buildReportFilename("https://example.com", "test");
      const date = new Date().toISOString().split("T")[0];
      expect(name).toContain(date);
    });
  });

  describe("buildReportSubdir", () => {
    it("extracts the domain from a URL", () => {
      expect(buildReportSubdir("https://example.com/page")).toBe("example.com");
    });

    it("strips www. prefix", () => {
      expect(buildReportSubdir("https://www.example.com/page")).toBe("example.com");
    });

    it("returns 'unknown' for invalid URLs", () => {
      expect(buildReportSubdir("not-a-url")).toBe("unknown");
    });

    it("preserves subdomains other than www", () => {
      expect(buildReportSubdir("https://blog.example.com/post")).toBe("blog.example.com");
    });
  });
});
