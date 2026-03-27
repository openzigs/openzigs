import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import { createSeoGapTools } from "./seo-gap-tools.js";

describe("seo-gap-tools", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("createSeoGapTools", () => {
    it("returns two tools", () => {
      const tools = createSeoGapTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe("seo-gap-analysis");
      expect(tools[1].name).toBe("seo-extract-content");
    });

    it("tools have correct category and riskLevel", () => {
      const tools = createSeoGapTools();
      for (const tool of tools) {
        expect(tool.category).toBe("search");
        expect(tool.riskLevel).toBe("low");
      }
    });

    it("tools have valid input schemas", () => {
      const tools = createSeoGapTools();
      const gap = tools.find((t) => t.name === "seo-gap-analysis")!;
      const extract = tools.find((t) => t.name === "seo-extract-content")!;

      expect(gap.inputSchema.required).toContain("targetUrl");
      expect(gap.inputSchema.required).toContain("targetKeyword");
      expect(extract.inputSchema.required).toContain("url");
    });
  });

  describe("seo-gap-analysis schema validation", () => {
    it("validates valid input", () => {
      const tools = createSeoGapTools();
      const tool = tools.find((t) => t.name === "seo-gap-analysis")!;
      const result = tool.zodSchema!.safeParse({
        targetUrl: "https://example.com",
        targetKeyword: "test keyword",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing targetUrl", () => {
      const tools = createSeoGapTools();
      const tool = tools.find((t) => t.name === "seo-gap-analysis")!;
      const result = tool.zodSchema!.safeParse({ targetKeyword: "test" });
      expect(result.success).toBe(false);
    });

    it("rejects invalid URL", () => {
      const tools = createSeoGapTools();
      const tool = tools.find((t) => t.name === "seo-gap-analysis")!;
      const result = tool.zodSchema!.safeParse({
        targetUrl: "not-a-url",
        targetKeyword: "test",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty keyword", () => {
      const tools = createSeoGapTools();
      const tool = tools.find((t) => t.name === "seo-gap-analysis")!;
      const result = tool.zodSchema!.safeParse({
        targetUrl: "https://example.com",
        targetKeyword: "",
      });
      expect(result.success).toBe(false);
    });

    it("accepts optional searchProvider", () => {
      const tools = createSeoGapTools();
      const tool = tools.find((t) => t.name === "seo-gap-analysis")!;
      const result = tool.zodSchema!.safeParse({
        targetUrl: "https://example.com",
        targetKeyword: "test",
        searchProvider: "serper",
      });
      expect(result.success).toBe(true);
    });

    it("rejects invalid searchProvider", () => {
      const tools = createSeoGapTools();
      const tool = tools.find((t) => t.name === "seo-gap-analysis")!;
      const result = tool.zodSchema!.safeParse({
        targetUrl: "https://example.com",
        targetKeyword: "test",
        searchProvider: "google",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("seo-extract-content schema validation", () => {
    it("validates valid input", () => {
      const tools = createSeoGapTools();
      const tool = tools.find((t) => t.name === "seo-extract-content")!;
      const result = tool.zodSchema!.safeParse({ url: "https://example.com" });
      expect(result.success).toBe(true);
    });

    it("rejects missing url", () => {
      const tools = createSeoGapTools();
      const tool = tools.find((t) => t.name === "seo-extract-content")!;
      const result = tool.zodSchema!.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("seo-extract-content handler", () => {
    it("extracts content from a fetched page", async () => {
      const html = `
        <html>
          <head><title>Test Page</title></head>
          <body>
            <h1>Test Page Title</h1>
            <p>This is a test paragraph with enough content to analyze properly and exceed the threshold.</p>
            <h2>Section Two</h2>
            <p>Another paragraph with good content for keyword extraction and analysis testing.</p>
          </body>
        </html>
      `;

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(html),
      });

      const tools = createSeoGapTools();
      const tool = tools.find((t) => t.name === "seo-extract-content")!;
      const result = await tool.handler({ url: "https://example.com/test" });

      const parsed = JSON.parse(result.text);
      expect(parsed.url).toBe("https://example.com/test");
      expect(parsed.title).toBe("Test Page Title");
      expect(parsed.headings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: 1, text: "Test Page Title" }),
          expect.objectContaining({ level: 2, text: "Section Two" }),
        ]),
      );
      expect(parsed.wordCount).toBeGreaterThan(0);
      expect(parsed.readabilityScore).toBeDefined();
    });

    it("returns error on fetch failure", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const tools = createSeoGapTools();
      const tool = tools.find((t) => t.name === "seo-extract-content")!;
      const result = await tool.handler({ url: "https://example.com/missing" });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Content extraction failed");
    });

    it("returns error on network timeout", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("AbortError: signal timed out"));

      const tools = createSeoGapTools();
      const tool = tools.find((t) => t.name === "seo-extract-content")!;
      const result = await tool.handler({ url: "https://example.com/slow" });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Content extraction failed");
    });
  });

  describe("seo-gap-analysis handler", () => {
    it("runs the full pipeline and saves a report", async () => {
      const targetHtml = `
        <html><body>
          <h1>My Target Page</h1>
          <p>This is the target page content with enough text to properly analyze for SEO purposes and keywords.</p>
        </body></html>
      `;
      const competitorHtml = `
        <html><body>
          <h1>Competitor Page</h1>
          <p>Competitor page content with different keywords and longer text for comparison purposes in gap analysis.</p>
        </body></html>
      `;

      const serperResponse = {
        organic: [
          { link: "https://comp1.com/page", title: "Comp 1", snippet: "Snippet 1", position: 1 },
        ],
        peopleAlsoAsk: [{ question: "What is SEO?" }],
        relatedSearches: [{ query: "seo tools" }],
      };

      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        fetchCallCount++;
        if (typeof url === "string" && url.includes("serper.dev")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(serperResponse),
          });
        }
        // Target or competitor HTML
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(fetchCallCount <= 2 ? targetHtml : competitorHtml),
        });
      });

      // Mock fs.writeFile and fs.mkdir to avoid filesystem side effects
      const fsSpy = vi.spyOn(fs, "writeFile").mockResolvedValue();
      const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);

      const tools = createSeoGapTools({ serperApiKey: "test-key" });
      const tool = tools.find((t) => t.name === "seo-gap-analysis")!;

      const result = await tool.handler({
        targetUrl: "https://mysite.com/page",
        targetKeyword: "seo analysis",
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.reportPath).toContain("seo-reports");
      expect(parsed.filename).toMatch(/^mysite\.com-seo-analysis-\d{4}-\d{2}-\d{2}\.md$/);
      expect(parsed.targetMetrics).toBeDefined();
      expect(parsed.targetMetrics.wordCount).toBeGreaterThan(0);
      expect(parsed.competitorsAnalyzed).toBeGreaterThanOrEqual(0);
      expect(parsed.searchProvider).toBe("serper");
      expect(parsed.analysisPrompt).toContain("expert SEO strategist");
      expect(parsed.message).toContain("SEO gap analysis complete");

      fsSpy.mockRestore();
      mkdirSpy.mockRestore();
    });

    it("returns error when search API and fetch both fail", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const tools = createSeoGapTools({ serperApiKey: "key" });
      const tool = tools.find((t) => t.name === "seo-gap-analysis")!;

      const result = await tool.handler({
        targetUrl: "https://example.com",
        targetKeyword: "test",
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("SEO gap analysis failed");
    });

    it("tolerates competitor fetch failures gracefully", async () => {
      const targetHtml = `<html><body><h1>Target</h1><p>Content here with enough words for the analysis threshold.</p></body></html>`;

      const serperResponse = {
        organic: [
          { link: "https://comp1.com", title: "C1", snippet: "S1", position: 1 },
          { link: "https://comp2.com", title: "C2", snippet: "S2", position: 2 },
        ],
      };

      let callIndex = 0;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        callIndex++;
        if (typeof url === "string" && url.includes("serper.dev")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(serperResponse),
          });
        }
        // First real fetch succeeds (target), competitors fail
        if (callIndex === 1) {
          return Promise.resolve({ ok: true, text: () => Promise.resolve(targetHtml) });
        }
        return Promise.resolve({ ok: false, status: 500, statusText: "Server Error" });
      });

      vi.spyOn(fs, "writeFile").mockResolvedValue();
      vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);

      const tools = createSeoGapTools({ serperApiKey: "key" });
      const tool = tools.find((t) => t.name === "seo-gap-analysis")!;

      const result = await tool.handler({
        targetUrl: "https://mysite.com",
        targetKeyword: "test",
      });

      // Should still succeed even if competitors failed
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.competitorsAnalyzed).toBe(0);
    });

    it("uses brave provider when searchProvider is explicitly set to brave", async () => {
      const targetHtml = `<html><body><h1>Target</h1><p>Content here with enough words for the analysis threshold.</p></body></html>`;

      const braveResponse = {
        web: {
          results: [
            { url: "https://brave-comp.com", title: "Brave Comp", description: "Desc" },
          ],
        },
      };

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (typeof url === "string" && url.includes("brave.com")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(braveResponse),
          });
        }
        return Promise.resolve({ ok: true, text: () => Promise.resolve(targetHtml) });
      });

      vi.spyOn(fs, "writeFile").mockResolvedValue();
      vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);

      const tools = createSeoGapTools({ braveApiKey: "brave-key", serperApiKey: "serper-key" });
      const tool = tools.find((t) => t.name === "seo-gap-analysis")!;

      const result = await tool.handler({
        targetUrl: "https://mysite.com",
        targetKeyword: "test",
        searchProvider: "brave",
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.searchProvider).toBe("brave");
    });

    it("falls back to both keys when neither provider-specific key is set", async () => {
      // Both keys absent from apiKeys initially → fallback assigns both
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("No API key"));

      const tools = createSeoGapTools({});
      const tool = tools.find((t) => t.name === "seo-gap-analysis")!;

      const result = await tool.handler({
        targetUrl: "https://example.com",
        targetKeyword: "test",
      });

      // Should fail since no keys are valid, but it exercises the fallback branch
      expect(result.isError).toBe(true);
    });
  });
});
