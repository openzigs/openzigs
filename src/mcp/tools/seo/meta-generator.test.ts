import { describe, it, expect } from "vitest";
import {
  buildMetaGenerationPrompt,
  parseLlmMetaResponse,
  estimateTitlePixelWidth,
  estimateDescriptionPixelWidth,
} from "./meta-generator.js";

describe("Meta Generator (#878)", () => {
  describe("estimateTitlePixelWidth", () => {
    it("returns a positive number for non-empty text", () => {
      expect(estimateTitlePixelWidth("Hello World")).toBeGreaterThan(0);
    });

    it("gives wider estimates for uppercase text", () => {
      const lower = estimateTitlePixelWidth("hello");
      const upper = estimateTitlePixelWidth("HELLO");
      expect(upper).toBeGreaterThan(lower);
    });

    it("returns 0 for empty string", () => {
      expect(estimateTitlePixelWidth("")).toBe(0);
    });
  });

  describe("estimateDescriptionPixelWidth", () => {
    it("returns a positive number for non-empty text", () => {
      expect(estimateDescriptionPixelWidth("Hello World")).toBeGreaterThan(0);
    });

    it("returns 0 for empty string", () => {
      expect(estimateDescriptionPixelWidth("")).toBe(0);
    });
  });

  describe("buildMetaGenerationPrompt", () => {
    it("includes keyword in prompt", () => {
      const prompt = buildMetaGenerationPrompt("seo tools");
      expect(prompt).toContain("seo tools");
      expect(prompt).toContain("Target keyword");
    });

    it("includes URL when provided", () => {
      const prompt = buildMetaGenerationPrompt("seo", "https://example.com");
      expect(prompt).toContain("https://example.com");
    });

    it("includes content excerpt when provided", () => {
      const prompt = buildMetaGenerationPrompt(
        "seo",
        undefined,
        "This is a long article about SEO optimization...",
      );
      expect(prompt).toContain("Page content excerpt");
    });

    it("truncates content to 500 chars", () => {
      const longContent = "x".repeat(1000);
      const prompt = buildMetaGenerationPrompt("seo", undefined, longContent);
      // The content in the prompt should be truncated
      expect(prompt.length).toBeLessThan(longContent.length + 500);
    });
  });

  describe("parseLlmMetaResponse", () => {
    it("parses valid JSON response", () => {
      const raw = JSON.stringify({
        titles: [
          "Learn SEO Today: A Complete Guide",
          "Master SEO: Expert Tips & Tricks",
          "Get Better Rankings with SEO",
        ],
        descriptions: [
          "Discover proven SEO techniques. Start improving your rankings today.",
          "Expert SEO strategies for 2026. Boost your traffic now.",
          "Complete SEO guide with actionable tips. Get started free.",
        ],
      });
      const result = parseLlmMetaResponse(raw, "SEO", "https://example.com");
      expect(result.titles).toHaveLength(3);
      expect(result.descriptions).toHaveLength(3);
      expect(result.keyword).toBe("SEO");
      expect(result.sourceUrl).toBe("https://example.com");
      // Each variant should have charCount and pixelWidthEstimate
      for (const title of result.titles) {
        expect(title.charCount).toBeGreaterThan(0);
        expect(title.pixelWidthEstimate).toBeGreaterThan(0);
      }
    });

    it("handles markdown code blocks in response", () => {
      const raw = `Here are the suggestions:\n\`\`\`json\n${JSON.stringify({
        titles: ["Title 1", "Title 2", "Title 3"],
        descriptions: ["Desc 1", "Desc 2", "Desc 3"],
      })}\n\`\`\``;
      const result = parseLlmMetaResponse(raw, "test");
      expect(result.titles).toHaveLength(3);
      expect(result.descriptions).toHaveLength(3);
    });

    it("returns empty arrays for unparseable response", () => {
      const result = parseLlmMetaResponse("I cannot help with that", "test");
      expect(result.titles).toHaveLength(0);
      expect(result.descriptions).toHaveLength(0);
      expect(result.keyword).toBe("test");
    });

    it("limits to 3 titles and 3 descriptions", () => {
      const raw = JSON.stringify({
        titles: ["T1", "T2", "T3", "T4", "T5"],
        descriptions: ["D1", "D2", "D3", "D4"],
      });
      const result = parseLlmMetaResponse(raw, "test");
      expect(result.titles).toHaveLength(3);
      expect(result.descriptions).toHaveLength(3);
    });
  });
});
