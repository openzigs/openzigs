import { describe, it, expect } from "vitest";
import {
  extractContent,
  cleanText,
  extractKeywords,
  fleschKincaid,
  countSyllables,
} from "./html-extractor.js";

describe("html-extractor", () => {
  describe("countSyllables", () => {
    it("counts single-syllable words", () => {
      expect(countSyllables("cat")).toBe(1);
      expect(countSyllables("dog")).toBe(1);
      expect(countSyllables("go")).toBe(1);
    });

    it("counts multi-syllable words", () => {
      expect(countSyllables("beautiful")).toBeGreaterThanOrEqual(3);
      expect(countSyllables("information")).toBeGreaterThanOrEqual(3);
    });

    it("returns 1 for very short words", () => {
      expect(countSyllables("a")).toBe(1);
      expect(countSyllables("an")).toBe(1);
    });

    it("handles non-alphabetic characters", () => {
      expect(countSyllables("don't")).toBeGreaterThanOrEqual(1);
      expect(countSyllables("123")).toBe(1);
    });
  });

  describe("fleschKincaid", () => {
    it("returns 0 for empty text", () => {
      expect(fleschKincaid("")).toBe(0);
    });

    it("returns 0 for whitespace-only", () => {
      expect(fleschKincaid("   ")).toBe(0);
    });

    it("scores simple text as high readability", () => {
      const simple = "The cat sat on the mat. The dog ran fast. The sun is hot.";
      const score = fleschKincaid(simple);
      expect(score).toBeGreaterThan(50);
    });

    it("scores complex text as lower readability", () => {
      const complex =
        "The implementation of sophisticated algorithmic methodologies necessitates comprehensive understanding of computational complexity theory and asymptotic analysis paradigms.";
      const score = fleschKincaid(complex);
      expect(score).toBeLessThan(50);
    });

    it("returns a number", () => {
      expect(typeof fleschKincaid("Hello world. This is a test.")).toBe("number");
    });
  });

  describe("cleanText", () => {
    it("strips HTML entities", () => {
      expect(cleanText("Hello&nbsp;World&amp;Co")).toBe("Hello World&Co");
    });

    it("collapses whitespace", () => {
      expect(cleanText("  hello   world  ")).toBe("hello world");
    });

    it("handles quotes and angle brackets", () => {
      expect(cleanText("&lt;div&gt;&quot;test&quot;&lt;/div&gt;")).toBe('<div>"test"</div>');
    });

    it("strips numeric entities", () => {
      // cleanText replaces &#NNN; with empty string, collapsing whitespace
      expect(cleanText("Hello &#160; World")).toBe("Hello World");
    });
  });

  describe("extractKeywords", () => {
    it("returns an array of keyword entries", () => {
      const text = "coffee brewing methods coffee beans espresso latte cappuccino coffee grounds drip brewing pour over french press cold brew coffee flavor aroma";
      const keywords = extractKeywords(text, 5);
      expect(keywords.length).toBeLessThanOrEqual(5);
      expect(keywords.length).toBeGreaterThan(0);
      for (const k of keywords) {
        expect(k.term).toBeDefined();
        expect(typeof k.tfidf).toBe("number");
        expect(k.term.length).toBeGreaterThanOrEqual(3);
      }
    });

    it("returns empty for empty text", () => {
      const keywords = extractKeywords("");
      expect(keywords).toEqual([]);
    });

    it("defaults to top 15", () => {
      const text = Array.from({ length: 100 }, (_, i) => `word${i} sentence`).join(" ");
      const keywords = extractKeywords(text);
      expect(keywords.length).toBeLessThanOrEqual(15);
    });
  });

  describe("extractContent", () => {
    it("extracts title from h1", () => {
      const html = "<html><body><h1>My Title</h1><p>Some content here.</p></body></html>";
      const result = extractContent(html);
      expect(result.title).toBe("My Title");
    });

    it("falls back to <title> tag if no h1", () => {
      const html = "<html><head><title>Page Title</title></head><body><p>Some content here for reading purposes.</p></body></html>";
      const result = extractContent(html);
      expect(result.title).toBe("Page Title");
    });

    it("extracts headings with correct levels", () => {
      const html = `
        <html><body>
          <h1>Main Title</h1>
          <h2>Section One</h2>
          <h3>Sub Section</h3>
          <p>Paragraph text goes here for content.</p>
        </body></html>
      `;
      const result = extractContent(html);
      expect(result.headings).toEqual([
        { level: 1, text: "Main Title" },
        { level: 2, text: "Section One" },
        { level: 3, text: "Sub Section" },
      ]);
      expect(result.headingCount).toBe(3);
    });

    it("extracts body text from paragraphs", () => {
      const html = `
        <html><body>
          <h1>Title</h1>
          <p>This is a paragraph with enough text to pass the threshold.</p>
          <p>Another paragraph with more content to analyze.</p>
        </body></html>
      `;
      const result = extractContent(html);
      expect(result.bodyText).toContain("paragraph");
      expect(result.wordCount).toBeGreaterThan(0);
    });

    it("removes noise elements (nav, header, footer, aside)", () => {
      const html = `
        <html><body>
          <nav><a href="#">Menu Item</a></nav>
          <header><h1>Site Header</h1></header>
          <main>
            <h1>Article Title</h1>
            <p>Actual article content that should be read and analyzed.</p>
          </main>
          <footer>Footer navigation links and copyright information</footer>
          <aside>Sidebar widget content that is not relevant</aside>
        </body></html>
      `;
      const result = extractContent(html);
      // nav/header/footer/aside content should be stripped
      expect(result.bodyText).not.toContain("Menu Item");
      expect(result.bodyText).toContain("article content");
    });

    it("strips script and style tags", () => {
      const html = `
        <html><body>
          <script>var x = 1;</script>
          <style>.test { color: red; }</style>
          <h1>Page Title</h1>
          <p>Real content that should be extracted properly here.</p>
        </body></html>
      `;
      const result = extractContent(html);
      expect(result.bodyText).not.toContain("var x");
      expect(result.bodyText).not.toContain(".test");
    });

    it("computes reading time", () => {
      const words = Array.from({ length: 476 }, () => "word").join(" ");
      const html = `<html><body><h1>Title</h1><p>${words}</p></body></html>`;
      const result = extractContent(html);
      expect(result.readingTime).toBe(2); // 476 / 238 ≈ 2
    });

    it("reading time is at least 1 minute", () => {
      const html = "<html><body><h1>Title</h1><p>This short paragraph has very few words here.</p></body></html>";
      const result = extractContent(html);
      expect(result.readingTime).toBeGreaterThanOrEqual(1);
    });

    it("counts paragraphs", () => {
      const html = `
        <html><body>
          <h1>Title</h1>
          <p>First paragraph with enough text for the threshold check.</p>
          <p>Second paragraph with enough text for the threshold check.</p>
          <p>Third paragraph with enough text for the threshold check.</p>
        </body></html>
      `;
      const result = extractContent(html);
      expect(result.paragraphCount).toBe(3);
    });

    it("computes readability score", () => {
      const html = `
        <html><body>
          <h1>Title</h1>
          <p>The cat sat on the mat. It was a sunny day. The birds sang. The dog barked. Life was good.</p>
        </body></html>
      `;
      const result = extractContent(html);
      expect(typeof result.readabilityScore).toBe("number");
    });

    it("extracts keywords", () => {
      const html = `
        <html><body>
          <h1>Coffee Brewing Guide</h1>
          <p>Coffee brewing methods include espresso, pour over, french press, and cold brew. The best coffee brewing techniques require fresh coffee beans and clean water.</p>
        </body></html>
      `;
      const result = extractContent(html);
      expect(result.keywords.length).toBeGreaterThan(0);
      const terms = result.keywords.map((k) => k.term);
      expect(terms.some((t) => t.includes("coffee") || t.includes("brewing"))).toBe(true);
    });

    it("handles empty HTML", () => {
      const result = extractContent("<html><body></body></html>");
      expect(result.title).toBe("");
      expect(result.headings).toEqual([]);
      expect(result.wordCount).toBe(0);
    });

    it("handles malformed HTML gracefully", () => {
      const html = "<div><p>Unclosed paragraph with enough text content here<h2>Heading";
      const result = extractContent(html);
      // Should not throw
      expect(result).toBeDefined();
      expect(typeof result.wordCount).toBe("number");
    });

    it("extracts list items and table cells", () => {
      const html = `
        <html><body>
          <h1>Title</h1>
          <ul>
            <li>First list item has enough text to pass threshold</li>
            <li>Second list item has enough text to pass threshold</li>
          </ul>
          <table><tr><td>Table cell with enough text to pass threshold</td></tr></table>
        </body></html>
      `;
      const result = extractContent(html);
      expect(result.bodyText).toContain("list item");
      expect(result.bodyText).toContain("Table cell");
    });

    it("provides default values for new fields when no metadata present", () => {
      const html = "<html><body><h1>Title</h1><p>Some content here for testing.</p></body></html>";
      const result = extractContent(html);
      expect(result.metaTitle).toBe("");
      expect(result.metaDescription).toBe("");
      expect(result.metaTags).toEqual([]);
      expect(result.images).toEqual([]);
      expect(result.imagesWithoutAlt).toBe(0);
      expect(result.schemaMarkup).toEqual([]);
      expect(result.internalLinks).toEqual([]);
      expect(result.externalLinks).toEqual([]);
      expect(result.internalLinkCount).toBe(0);
      expect(result.externalLinkCount).toBe(0);
    });

    it("extracts meta title from <title> tag", () => {
      const html = `<html><head><title>My SEO Title</title></head><body><h1>H1</h1><p>Content.</p></body></html>`;
      const result = extractContent(html);
      expect(result.metaTitle).toBe("My SEO Title");
    });

    it("extracts meta description", () => {
      const html = `<html><head><meta name="description" content="A great page about testing."></head><body><p>Content.</p></body></html>`;
      const result = extractContent(html);
      expect(result.metaDescription).toBe("A great page about testing.");
    });

    it("extracts all meta tags with name and content", () => {
      const html = `
        <html><head>
          <meta name="description" content="Page desc">
          <meta name="keywords" content="test,seo">
          <meta name="robots" content="index,follow">
          <meta charset="utf-8">
        </head><body><p>Content.</p></body></html>
      `;
      const result = extractContent(html);
      expect(result.metaTags).toHaveLength(3);
      expect(result.metaTags).toContainEqual({ name: "description", content: "Page desc" });
      expect(result.metaTags).toContainEqual({ name: "keywords", content: "test,seo" });
      expect(result.metaTags).toContainEqual({ name: "robots", content: "index,follow" });
    });

    it("extracts schema markup from JSON-LD", () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"Article","headline":"Test","author":"John"}
          </script>
        </head><body><p>Content.</p></body></html>
      `;
      const result = extractContent(html);
      expect(result.schemaMarkup).toHaveLength(1);
      expect(result.schemaMarkup[0].type).toBe("Article");
      expect(result.schemaMarkup[0].properties).toContain("headline");
      expect(result.schemaMarkup[0].properties).toContain("author");
    });

    it("handles multiple JSON-LD blocks", () => {
      const html = `
        <html><head>
          <script type="application/ld+json">{"@type":"Article","headline":"H"}</script>
          <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
        </head><body><p>Content.</p></body></html>
      `;
      const result = extractContent(html);
      expect(result.schemaMarkup).toHaveLength(2);
      const types = result.schemaMarkup.map((s) => s.type);
      expect(types).toContain("Article");
      expect(types).toContain("BreadcrumbList");
    });

    it("ignores malformed JSON-LD gracefully", () => {
      const html = `
        <html><head>
          <script type="application/ld+json">NOT VALID JSON</script>
        </head><body><p>Content.</p></body></html>
      `;
      const result = extractContent(html);
      expect(result.schemaMarkup).toEqual([]);
    });

    it("extracts images with alt text info", () => {
      const html = `
        <html><body>
          <img src="/img/hero.jpg" alt="Hero image">
          <img src="/img/chart.png" alt="">
          <img src="/img/logo.svg">
        </body></html>
      `;
      const result = extractContent(html);
      expect(result.images).toHaveLength(3);
      expect(result.images[0]).toEqual({ src: "/img/hero.jpg", alt: "Hero image", hasAlt: true });
      expect(result.images[1]).toEqual({ src: "/img/chart.png", alt: "", hasAlt: false });
      expect(result.images[2]).toEqual({ src: "/img/logo.svg", alt: "", hasAlt: false });
      expect(result.imagesWithoutAlt).toBe(2);
    });

    it("classifies internal and external links with sourceUrl", () => {
      const html = `
        <html><body>
          <a href="/about">About</a>
          <a href="https://example.com/contact">Contact</a>
          <a href="https://external.com/page">External</a>
        </body></html>
      `;
      const result = extractContent(html, "https://example.com/page");
      expect(result.internalLinks.length).toBe(2);
      expect(result.externalLinks.length).toBe(1);
      expect(result.internalLinkCount).toBe(2);
      expect(result.externalLinkCount).toBe(1);
      expect(result.externalLinks[0].href).toBe("https://external.com/page");
    });

    it("classifies all links as external when no sourceUrl provided", () => {
      const html = `
        <html><body>
          <a href="https://example.com/page">Link 1</a>
          <a href="https://other.com/page">Link 2</a>
        </body></html>
      `;
      const result = extractContent(html);
      expect(result.internalLinks.length).toBe(0);
      expect(result.externalLinks.length).toBe(2);
    });

    it("skips hash-only and javascript: and mailto: links", () => {
      const html = `
        <html><body>
          <a href="#">Anchor</a>
          <a href="javascript:void(0)">JS</a>
          <a href="mailto:a@b.com">Email</a>
          <a href="https://real.com">Real</a>
        </body></html>
      `;
      const result = extractContent(html);
      expect(result.externalLinks.length).toBe(1);
      expect(result.externalLinks[0].href).toBe("https://real.com");
    });
  });
});
