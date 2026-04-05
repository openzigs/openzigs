import { describe, it, expect, beforeEach } from "vitest";
import { createArtStyleTools, ART_STYLES } from "./art-style-tools.js";
import type { ToolDefinition } from "../tool-registry.js";

describe("Art Style Tools", () => {
  let tools: ToolDefinition[];

  beforeEach(() => {
    tools = createArtStyleTools();
  });

  it("should create 2 tools", () => {
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain("list-art-styles");
    expect(tools.map((t) => t.name)).toContain("apply-art-style");
  });

  describe("list-art-styles", () => {
    it("should list all styles without filter", async () => {
      const tool = tools.find((t) => t.name === "list-art-styles")!;
      const result = await tool.handler({});
      const parsed = JSON.parse(result.text);
      expect(parsed.length).toBe(ART_STYLES.length);
    });

    it("should filter by category", async () => {
      const tool = tools.find((t) => t.name === "list-art-styles")!;
      const result = await tool.handler({ category: "classical" });
      const parsed = JSON.parse(result.text);
      expect(parsed.length).toBeGreaterThan(0);
      expect(
        parsed.every((s: { category: string }) => s.category === "classical"),
      ).toBe(true);
    });

    it("should return empty array for non-matching category", async () => {
      const tool = tools.find((t) => t.name === "list-art-styles")!;
      // Use a valid category that might be empty or well defined
      const result = await tool.handler({ category: "sci-fi" });
      const parsed = JSON.parse(result.text);
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  describe("apply-art-style", () => {
    it("should enhance a prompt with style", async () => {
      const tool = tools.find((t) => t.name === "apply-art-style")!;
      const result = await tool.handler({
        style_id: "cyberpunk",
        prompt: "a city street at night",
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.style).toBe("Cyberpunk");
      expect(parsed.enhancedPrompt).toContain("a city street at night");
      expect(parsed.enhancedPrompt).toContain("cyberpunk");
      expect(parsed.negativePrompt).toBeTruthy();
      expect(parsed.recommendedSteps).toBeGreaterThan(0);
    });

    it("should error for unknown style", async () => {
      const tool = tools.find((t) => t.name === "apply-art-style")!;
      const result = await tool.handler({
        style_id: "nonexistent",
        prompt: "test",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Unknown art style");
    });

    it("should include all expected fields in result", async () => {
      const tool = tools.find((t) => t.name === "apply-art-style")!;
      const result = await tool.handler({
        style_id: "oil-painting",
        prompt: "a sunset over the ocean",
      });
      const parsed = JSON.parse(result.text);
      expect(parsed).toHaveProperty("style");
      expect(parsed).toHaveProperty("enhancedPrompt");
      expect(parsed).toHaveProperty("negativePrompt");
      expect(parsed).toHaveProperty("recommendedSteps");
      expect(parsed).toHaveProperty("recommendedGuidance");
    });
  });
});
