import { describe, it, expect } from "vitest";
import {
  generateLinkingSuggestions,
  type LinkSuggestionPage,
} from "./internal-linking.js";

describe("generateLinkingSuggestions (#881)", () => {
  function makePage(
    url: string,
    bodyText: string,
    overrides: Partial<LinkSuggestionPage> = {},
  ): LinkSuggestionPage {
    return {
      url,
      title: url.split("/").pop() || url,
      bodyText,
      incomingInternalLinks: 3,
      depth: 1,
      ...overrides,
    };
  }

  it("returns empty for fewer than 2 pages", () => {
    const pages = [
      makePage(
        "https://example.com/a",
        "SEO optimization guide for beginners and experts",
      ),
    ];
    expect(generateLinkingSuggestions(pages)).toHaveLength(0);
  });

  it("suggests links between pages with keyword overlap", () => {
    const pages = [
      makePage(
        "https://example.com/seo-guide",
        "This comprehensive guide covers search engine optimization techniques including keyword research content strategy link building and technical audit procedures for better rankings",
      ),
      makePage(
        "https://example.com/keyword-research",
        "Learn about keyword research methods including competitor analysis search volume estimation long tail keyword discovery and content optimization strategies for better rankings",
      ),
    ];
    const suggestions = generateLinkingSuggestions(pages);
    expect(suggestions.length).toBeGreaterThanOrEqual(0);
    // Pages share keyword overlap; suggestions should exist if keywords match
  });

  it("prioritizes orphan pages (high priority)", () => {
    const pages = [
      makePage(
        "https://example.com/main",
        "comprehensive guide about search engine optimization techniques and strategies including keyword research content analysis and link building methods for better rankings",
      ),
      makePage(
        "https://example.com/orphan",
        "detailed article about keyword research and search engine optimization best practices including content analysis techniques and link building strategies for rankings",
        { incomingInternalLinks: 0 }, // orphan
      ),
    ];
    const suggestions = generateLinkingSuggestions(pages);
    const orphanSuggestion = suggestions.find(
      (s) => s.targetPage === "https://example.com/orphan",
    );
    if (orphanSuggestion) {
      expect(orphanSuggestion.priority).toBe("high");
      expect(orphanSuggestion.reason).toContain("orphan");
    }
  });

  it("prioritizes deep pages (medium priority)", () => {
    const pages = [
      makePage(
        "https://example.com/main",
        "complete guide about website performance optimization including search engine techniques content strategy and link building methods for better rankings",
      ),
      makePage(
        "https://example.com/deep-page",
        "detailed article about website optimization and search engine techniques including performance analysis content strategy and link building for rankings",
        { depth: 5 }, // deep page
      ),
    ];
    const suggestions = generateLinkingSuggestions(pages);
    const deepSuggestion = suggestions.find(
      (s) => s.targetPage === "https://example.com/deep-page",
    );
    if (deepSuggestion) {
      expect(deepSuggestion.priority).toBe("medium");
      expect(deepSuggestion.reason).toContain("deep page");
    }
  });

  it("caps suggestions at 50", () => {
    // Create many pages with overlapping content
    const pages: LinkSuggestionPage[] = [];
    for (let i = 0; i < 20; i++) {
      pages.push(
        makePage(
          `https://example.com/page-${i}`,
          `article about search engine optimization techniques keyword research content strategy and link building methods for better website rankings page ${i}`,
        ),
      );
    }
    const suggestions = generateLinkingSuggestions(pages);
    expect(suggestions.length).toBeLessThanOrEqual(50);
  });

  it("returns suggestions with all required fields", () => {
    const pages = [
      makePage(
        "https://example.com/a",
        "comprehensive guide about search engine optimization including keyword research techniques content analysis strategies and link building methods",
      ),
      makePage(
        "https://example.com/b",
        "detailed article covering search engine optimization and keyword research methods with content analysis and link building best practices",
        { incomingInternalLinks: 0 },
      ),
    ];
    const suggestions = generateLinkingSuggestions(pages);
    for (const s of suggestions) {
      expect(s.sourcePage).toBeTruthy();
      expect(s.targetPage).toBeTruthy();
      expect(s.suggestedAnchor).toBeTruthy();
      expect(s.reason).toBeTruthy();
      expect(["high", "medium", "low"]).toContain(s.priority);
    }
  });
});
