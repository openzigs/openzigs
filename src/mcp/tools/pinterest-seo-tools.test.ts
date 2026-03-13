import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createPinterestSeoTools,
  extractPinIdFromUrl,
  calculatePinScore,
  generateSeoRecommendations,
  extractAnnotationsFromHtml,
} from "./pinterest-seo-tools.js";
import type { ToolDefinition } from "../tool-registry.js";

vi.mock("node:fs", () => ({
  default: { mkdirSync: vi.fn(), writeFileSync: vi.fn(), existsSync: vi.fn().mockReturnValue(false), rmSync: vi.fn() },
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  rmSync: vi.fn(),
}));

const mockAddContentIdea = vi.fn();
const mockMigrate = vi.fn();

vi.mock("../../productivity/database.js", () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock("./pinterest-tracker.js", () => {
  return {
    PinterestTrackerRepository: class {
      migrate() { mockMigrate(); }
      addContentIdea(data: unknown) { mockAddContentIdea(data); }
    },
  };
});

describe("Pinterest SEO Tools", () => {
  let tools: ToolDefinition[];
  let toolMap: Map<string, ToolDefinition>;

  beforeEach(() => {
    tools = createPinterestSeoTools();
    toolMap = new Map(tools.map((t) => [t.name, t]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PINTEREST_ACCESS_TOKEN;
    delete process.env.PINTEREST_AD_ACCOUNT_ID;
  });

  // ─── Factory Tests ──────────────────────────────────

  describe("createPinterestSeoTools", () => {
    it("returns all 10 tools", () => {
      expect(tools).toHaveLength(10);
      const names = tools.map((t) => t.name);
      expect(names).toContain("pinterest-list-boards");
      expect(names).toContain("pinterest-trends");
      expect(names).toContain("pinterest-keyword-metrics");
      expect(names).toContain("pinterest-analytics");
      expect(names).toContain("pinterest-seo-analyze");
      expect(names).toContain("pinterest-create-pin");
      expect(names).toContain("pinterest-pin-insights");
      expect(names).toContain("pinterest-search-pins");
      expect(names).toContain("pinterest-content-ideas");
      expect(names).toContain("pinterest-related-keywords");
    });

    it("all tools have category 'social'", () => {
      for (const tool of tools) {
        expect(tool.category).toBe("social");
      }
    });

    it("all tools have source 'pinterest'", () => {
      for (const tool of tools) {
        expect(tool.source).toBe("pinterest");
      }
    });

    it("pinterest-seo-analyze has riskLevel 'medium'", () => {
      expect(toolMap.get("pinterest-seo-analyze")!.riskLevel).toBe("medium");
    });

    it("trend/keyword/analytics tools have riskLevel 'low'", () => {
      expect(toolMap.get("pinterest-trends")!.riskLevel).toBe("low");
      expect(toolMap.get("pinterest-keyword-metrics")!.riskLevel).toBe("low");
      expect(toolMap.get("pinterest-analytics")!.riskLevel).toBe("low");
    });

    it("all tools have valid inputSchema", () => {
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("all tools have non-empty descriptions", () => {
      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(20);
      }
    });
  });

  // ─── pinterest-trends ───────────────────────────────

  describe("pinterest-trends", () => {
    const mockTrendsResponse = {
      trends: [
        {
          keyword: "summer nails",
          pct_growth_wow: 30,
          pct_growth_mom: 100,
          pct_growth_yoy: 10,
          time_series: { "2024-05-06": 61, "2024-05-13": 71 },
        },
      ],
    };

    it("returns trending keywords for default region US", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(JSON.stringify(mockTrendsResponse)),
        }),
      );
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";

      const tool = toolMap.get("pinterest-trends")!;
      const result = await tool.handler({});
      expect(result.text).toContain("# Pinterest Trends Report");
      expect(result.text).toContain("summer nails");
      expect(result.text).toContain("Report saved to");
    });

    it("returns error when PINTEREST_ACCESS_TOKEN missing", async () => {
      delete process.env.PINTEREST_ACCESS_TOKEN;
      const tool = toolMap.get("pinterest-trends")!;
      const result = await tool.handler({});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("PINTEREST_ACCESS_TOKEN");
    });

    it("handles Pinterest API 429 rate limit", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          text: () => Promise.resolve("Rate limit exceeded"),
        }),
      );
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";

      const tool = toolMap.get("pinterest-trends")!;
      const result = await tool.handler({});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("429");
    });

    it("passes region and trend_type as URL path params", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ trends: [] })),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";

      const tool = toolMap.get("pinterest-trends")!;
      await tool.handler({ region: "GB", trend_type: "monthly", limit: 5 });

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/v5/trends/keywords/GB/top/monthly");
      expect(calledUrl).toContain("limit=5");
    });

    it("sets normalize_against_group when specified", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ trends: [] })),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";

      const tool = toolMap.get("pinterest-trends")!;
      await tool.handler({ normalize_against_group: true });

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("normalize_against_group=true");
    });

    it("sends Authorization header with Bearer token", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ trends: [] })),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "my-test-token";

      const tool = toolMap.get("pinterest-trends")!;
      await tool.handler({});

      const calledOptions = fetchMock.mock.calls[0][1] as RequestInit;
      expect((calledOptions.headers as Record<string, string>).Authorization).toBe(
        "Bearer my-test-token",
      );
    });
  });

  // ─── pinterest-keyword-metrics ──────────────────────

  describe("pinterest-keyword-metrics", () => {
    it("sends keywords as query params", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: [] })),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      process.env.PINTEREST_AD_ACCOUNT_ID = "ad-123";

      const tool = toolMap.get("pinterest-keyword-metrics")!;
      await tool.handler({ keywords: ["summer", "nails"], country: "US" });

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("keywords=summer%2Cnails");
      expect(calledUrl).toContain("country_code=US");
    });

    it("includes ad account ID in URL path", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: [] })),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      process.env.PINTEREST_AD_ACCOUNT_ID = "ad-456";

      const tool = toolMap.get("pinterest-keyword-metrics")!;
      await tool.handler({ keywords: ["test"] });

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/ad_accounts/ad-456/keywords/metrics");
    });

    it("returns error when PINTEREST_ACCESS_TOKEN missing", async () => {
      delete process.env.PINTEREST_ACCESS_TOKEN;
      const tool = toolMap.get("pinterest-keyword-metrics")!;
      const result = await tool.handler({ keywords: ["test"] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("PINTEREST_ACCESS_TOKEN");
    });

    it("falls back to Google Suggest when PINTEREST_AD_ACCOUNT_ID missing", async () => {
      // Mock Google Suggest response
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(JSON.stringify(["test", ["test result"], [], [], { "google:suggestrelevance": [800] }])),
          json: () => Promise.resolve(["test", ["test result"], [], [], { "google:suggestrelevance": [800] }]),
        }),
      );
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      delete process.env.PINTEREST_AD_ACCOUNT_ID;

      const tool = toolMap.get("pinterest-keyword-metrics")!;
      const result = await tool.handler({ keywords: ["test"] });
      // Should NOT error — falls back to Google Suggest
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("Keyword Metrics");
      expect(result.text).toContain("PINTEREST_AD_ACCOUNT_ID not configured");
    });

    it("falls back gracefully on 500 server error", async () => {
      const fetchMock = vi.fn()
        // First call: Pinterest API 500
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        })
        // Second call: Google Suggest fallback
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify(["test", ["test idea"], [], [], { "google:suggestrelevance": [700] }])),
          json: () => Promise.resolve(["test", ["test idea"], [], [], { "google:suggestrelevance": [700] }]),
        });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      process.env.PINTEREST_AD_ACCOUNT_ID = "ad-123";

      const tool = toolMap.get("pinterest-keyword-metrics")!;
      const result = await tool.handler({ keywords: ["test"] });
      // Should NOT hard error — falls back to other sources
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("Keyword Metrics");
      expect(result.text).toContain("500");
    });
  });

  // ─── pinterest-analytics ───────────────────────────

  describe("pinterest-analytics", () => {
    it("calls account endpoint for account_summary", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ all: { summary_metrics: {} } })),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";

      const tool = toolMap.get("pinterest-analytics")!;
      await tool.handler({
        action: "account_summary",
        start_date: "2024-01-01",
        end_date: "2024-01-31",
      });

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/user_account/analytics");
      expect(calledUrl).not.toContain("top_pins");
    });

    it("calls top_pins endpoint for top_pins action", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ pins: [] })),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";

      const tool = toolMap.get("pinterest-analytics")!;
      await tool.handler({
        action: "top_pins",
        start_date: "2024-01-01",
        end_date: "2024-01-31",
        sort_by: "SAVE",
      });

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/user_account/analytics/top_pins");
      expect(calledUrl).toContain("sort_by=SAVE");
    });

    it("sends date range and metrics as query params", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";

      const tool = toolMap.get("pinterest-analytics")!;
      await tool.handler({
        action: "account_summary",
        start_date: "2024-03-01",
        end_date: "2024-03-31",
        metrics: ["IMPRESSION", "SAVE"],
      });

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("start_date=2024-03-01");
      expect(calledUrl).toContain("end_date=2024-03-31");
      expect(calledUrl).toContain("metric_types=IMPRESSION%2CSAVE");
    });

    it("uses default metrics when none specified", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";

      const tool = toolMap.get("pinterest-analytics")!;
      await tool.handler({
        action: "account_summary",
        start_date: "2024-01-01",
        end_date: "2024-01-31",
      });

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("IMPRESSION");
      expect(calledUrl).toContain("PIN_CLICK");
      expect(calledUrl).toContain("SAVE");
    });

    it("returns error when token missing", async () => {
      delete process.env.PINTEREST_ACCESS_TOKEN;
      const tool = toolMap.get("pinterest-analytics")!;
      const result = await tool.handler({
        action: "account_summary",
        start_date: "2024-01-01",
        end_date: "2024-01-31",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("PINTEREST_ACCESS_TOKEN");
    });
  });

  // ─── pinterest-seo-analyze ──────────────────────────

  describe("pinterest-seo-analyze", () => {
    it("analyzes a single pin by ID", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/v5/pins/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                title: "Test Pin",
                description: "A great test pin description with keywords",
                link: "https://example.com",
                alt_text: "test image",
                media: { media_type: "image" },
              }),
          });
        }
        // Browser fetch for annotations
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve("<html><body>no annotations</body></html>"),
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";

      const tool = toolMap.get("pinterest-seo-analyze")!;
      const result = await tool.handler({
        action: "analyze_pin",
        pin_id: "123456789",
        include_annotations: false,
      });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("# Pinterest SEO Analysis Report");
      expect(result.text).toContain("123456789");
      expect(result.text).toContain("Test Pin");
      expect(result.text).toContain("Report saved to");
    });

    it("analyzes a pin by URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            title: "URL Pin",
            description: "desc",
            link: null,
            media: { media_type: "image" },
          }),
        text: () => Promise.resolve("<html></html>"),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";

      const tool = toolMap.get("pinterest-seo-analyze")!;
      const result = await tool.handler({
        action: "analyze_url",
        url: "https://www.pinterest.com/pin/987654321/",
        include_annotations: false,
      });
      expect(result.text).toContain("987654321");
    });

    it("returns error for invalid URL format", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      const tool = toolMap.get("pinterest-seo-analyze")!;
      const result = await tool.handler({
        action: "analyze_url",
        url: "https://pin.it/abc123",
        include_annotations: false,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Could not extract pin ID");
    });

    it("handles bulk analysis of multiple pins", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            title: "Bulk Pin",
            description: "desc",
            media: { media_type: "image" },
          }),
        text: () => Promise.resolve("<html></html>"),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";

      const tool = toolMap.get("pinterest-seo-analyze")!;
      const result = await tool.handler({
        action: "bulk_analyze",
        pin_ids: ["111", "222", "333"],
        include_annotations: false,
      });
      expect(result.text).toContain("# Pinterest SEO Analysis Report");
      expect(result.text).toContain("111");
      expect(result.text).toContain("222");
      expect(result.text).toContain("333");
      expect(result.text).toContain("**Pins analyzed:** 3");
    });

    it("works without token (API-only fields are null)", async () => {
      delete process.env.PINTEREST_ACCESS_TOKEN;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve("<html></html>"),
        }),
      );

      const tool = toolMap.get("pinterest-seo-analyze")!;
      const result = await tool.handler({
        action: "analyze_pin",
        pin_id: "123",
        include_annotations: false,
      });
      expect(result.text).toContain("**Data Source** | None");
      expect(result.text).toContain("**Pin Score** | N/A");
    });
  });

  // ─── extractPinIdFromUrl ────────────────────────────

  describe("extractPinIdFromUrl", () => {
    it("extracts from standard URL", () => {
      expect(extractPinIdFromUrl("https://www.pinterest.com/pin/123456789/")).toBe(
        "123456789",
      );
    });

    it("extracts from URL without trailing slash", () => {
      expect(extractPinIdFromUrl("https://pinterest.com/pin/123456789")).toBe("123456789");
    });

    it("returns null for short URLs", () => {
      expect(extractPinIdFromUrl("https://pin.it/abc123")).toBeNull();
    });

    it("returns null for non-pin URLs", () => {
      expect(extractPinIdFromUrl("https://www.pinterest.com/user/boards/")).toBeNull();
    });

    it("extracts from mobile URL format", () => {
      expect(
        extractPinIdFromUrl("https://www.pinterest.com/pin/555555555/?mt=login"),
      ).toBe("555555555");
    });
  });

  // ─── calculatePinScore ──────────────────────────────

  describe("calculatePinScore", () => {
    it("returns 0 for null data", () => {
      expect(calculatePinScore(null, [])).toBe(0);
    });

    it("scores well-optimized pin high", () => {
      const score = calculatePinScore(
        {
          title: "Easy Summer Dinner Ideas for Families",
          description:
            "Looking for quick summer dinner ideas? These 15 easy recipes include grilled chicken and pasta salad.",
          link: "https://example.com",
          alt_text: "Summer dinner table with food",
          media: { media_type: "image" },
        },
        ["summer recipes", "dinner ideas", "grilled chicken", "easy recipes", "meal prep"],
      );
      expect(score).toBeGreaterThanOrEqual(80);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("scores poorly optimized pin low", () => {
      const score = calculatePinScore(
        {
          title: "",
          description: "hi",
          link: null,
          alt_text: null,
          media: {},
        },
        [],
      );
      expect(score).toBeLessThan(30);
    });

    it("caps score at 100", () => {
      const score = calculatePinScore(
        {
          title: "Perfect Title Under 100 Chars",
          description:
            "A perfectly crafted description between 100 and 500 characters with all the right keywords and phrases that make Pinterest happy and optimize for SEO.",
          link: "https://example.com",
          alt_text: "Descriptive alt text",
          media: { media_type: "video" },
        },
        ["kw1", "kw2", "kw3", "kw4", "kw5"],
      );
      expect(score).toBeLessThanOrEqual(100);
    });

    it("gives partial credit for long titles", () => {
      const shortTitle = calculatePinScore(
        { title: "Good Title", description: null, media: {} },
        [],
      );
      const longTitle = calculatePinScore(
        {
          title: "A".repeat(150),
          description: null,
          media: {},
        },
        [],
      );
      expect(shortTitle).toBeGreaterThan(longTitle);
    });
  });

  // ─── generateSeoRecommendations ─────────────────────

  describe("generateSeoRecommendations", () => {
    it("recommends adding title when missing", () => {
      const recs = generateSeoRecommendations(
        { title: null, description: "some desc", link: "https://x.com" },
        [],
      );
      expect(recs.some((r) => r.toLowerCase().includes("title"))).toBe(true);
    });

    it("recommends adding description when missing", () => {
      const recs = generateSeoRecommendations(
        { title: "Has Title", description: null, link: "https://x.com" },
        [],
      );
      expect(recs.some((r) => r.toLowerCase().includes("description"))).toBe(true);
    });

    it("recommends adding link when missing", () => {
      const recs = generateSeoRecommendations(
        { title: "Title", description: "Desc", link: null },
        [],
      );
      expect(recs.some((r) => r.toLowerCase().includes("link"))).toBe(true);
    });

    it("recommends alt text when missing", () => {
      const recs = generateSeoRecommendations(
        { title: "Title", description: "Desc", link: "https://x.com", alt_text: null },
        [],
      );
      expect(recs.some((r) => r.toLowerCase().includes("alt text"))).toBe(true);
    });

    it("recommends missing annotation keywords", () => {
      const recs = generateSeoRecommendations(
        {
          title: "Summer Recipes",
          description: "summer recipes for families",
          link: "https://x.com",
          alt_text: "test",
        },
        ["summer recipes", "dinner ideas", "meal prep"],
      );
      const kwRec = recs.find((r) => r.includes("annotation keywords"));
      expect(kwRec).toBeDefined();
      expect(kwRec).toContain("dinner ideas");
      expect(kwRec).toContain("meal prep");
    });

    it("does not recommend keywords already in description", () => {
      const recs = generateSeoRecommendations(
        {
          title: "Title",
          description: "summer recipes and dinner ideas for the whole family",
          link: "https://x.com",
          alt_text: "test",
        },
        ["summer recipes", "dinner ideas"],
      );
      // All annotation keywords are present — no keyword recommendation
      const kwRec = recs.find((r) => r.includes("annotation keywords"));
      expect(kwRec).toBeUndefined();
    });

    it("returns API error message when data is null", () => {
      const recs = generateSeoRecommendations(null, []);
      expect(recs).toHaveLength(1);
      expect(recs[0]).toContain("PINTEREST_ACCESS_TOKEN");
    });

    it("recommends expanding short descriptions", () => {
      const recs = generateSeoRecommendations(
        { title: "Title", description: "short", link: "https://x.com", alt_text: "test" },
        [],
      );
      expect(recs.some((r) => r.includes("expand"))).toBe(true);
    });
  });

  // ─── extractAnnotationsFromHtml ─────────────────────

  describe("extractAnnotationsFromHtml", () => {
    it("extracts from __PWS_DATA__ global", () => {
      const html = `
        <html><head></head><body>
        <script>__PWS_DATA__ = {"props":{"data":{"interests":[{"name":"summer recipes","type":"interest"},{"name":"dinner ideas","type":"interest"}]}}};</script>
        </body></html>
      `;
      const annotations = extractAnnotationsFromHtml(html);
      expect(annotations).toContain("summer recipes");
      expect(annotations).toContain("dinner ideas");
    });

    it("deduplicates annotations", () => {
      const html = `
        <html><body>
        <script>__PWS_DATA__ = {"a":{"name":"kw1","type":"interest"},"b":{"name":"kw1","type":"interest"}};</script>
        </body></html>
      `;
      const annotations = extractAnnotationsFromHtml(html);
      expect(annotations.filter((a) => a === "kw1")).toHaveLength(1);
    });

    it("extracts from script tags with interest fields", () => {
      const html = `
        <html><body>
        <script type="application/json">{"pin":{"interest":"home decor","annotations":["garden","outdoor"]}}</script>
        </body></html>
      `;
      const annotations = extractAnnotationsFromHtml(html);
      expect(annotations.length).toBeGreaterThan(0);
    });

    it("extracts from meta tags", () => {
      const html = `
        <html><head>
        <meta property="article:tag" content="modern kitchen">
        <meta property="article:tag" content="interior design">
        </head><body></body></html>
      `;
      const annotations = extractAnnotationsFromHtml(html);
      expect(annotations).toContain("modern kitchen");
      expect(annotations).toContain("interior design");
    });

    it("returns empty array for HTML with no annotations", () => {
      const html = "<html><body><p>Hello world</p></body></html>";
      expect(extractAnnotationsFromHtml(html)).toEqual([]);
    });

    it("handles malformed JSON gracefully", () => {
      const html = `
        <html><body>
        <script>__PWS_DATA__ = {invalid json};</script>
        </body></html>
      `;
      expect(extractAnnotationsFromHtml(html)).toEqual([]);
    });

    it("falls back to script tags when __PWS_DATA__ has no interests", () => {
      const html = `
        <html><body>
        <script>__PWS_DATA__ = {"noInterestsHere": true};</script>
        <script type="application/json">{"interest":"fallback topic"}</script>
        </body></html>
      `;
      const annotations = extractAnnotationsFromHtml(html);
      expect(annotations).toContain("fallback topic");
    });

    it("extracts annotations from og:title pipe-separated keywords", () => {
      const html = `
        <html><head>
        <meta content="Nail art inspiration | Polka dot nails, Nail designs, Spring nails" property="og:title"/>
        </head><body></body></html>
      `;
      const annotations = extractAnnotationsFromHtml(html);
      expect(annotations).toContain("Polka dot nails");
      expect(annotations).toContain("Nail designs");
      expect(annotations).toContain("Spring nails");
    });

    it("handles og:title with content-first attribute order", () => {
      const html = `
        <html><head>
        <meta content="Great recipe | Italian, Pasta, Easy dinners" data-app="true" name="og:title" property="og:title"/>
        </head><body></body></html>
      `;
      const annotations = extractAnnotationsFromHtml(html);
      expect(annotations).toContain("Italian");
      expect(annotations).toContain("Pasta");
      expect(annotations).toContain("Easy dinners");
    });

    it("extracts meta tags with content-first attribute order", () => {
      const html = `
        <html><head>
        <meta content="modern kitchen" property="article:tag"/>
        <meta content="interior design" name="article:tag"/>
        </head><body></body></html>
      `;
      const annotations = extractAnnotationsFromHtml(html);
      expect(annotations).toContain("modern kitchen");
      expect(annotations).toContain("interior design");
    });

    it("extracts interest categories from /ideas/ breadcrumb URLs (unauthenticated fallback)", () => {
      const html = `
        <html><body>
        <a href="/ideas/diy-and-crafts/934876475639/">DIY And Crafts</a>
        <a href="/ideas/home-decor/123456789/">Home Decor</a>
        <a href="/ideas/diy-and-crafts/934876475639/">DIY And Crafts</a>
        </body></html>
      `;
      const annotations = extractAnnotationsFromHtml(html);
      expect(annotations).toContain("Diy And Crafts");
      expect(annotations).toContain("Home Decor");
      expect(annotations).toHaveLength(2);
    });
  });

  // ─── pinterest-list-boards ─────────────────────────────────────────

  describe("pinterest-list-boards", () => {
    const callTool = (args: Record<string, unknown> = {}) =>
      toolMap.get("pinterest-list-boards")!.handler(args);

    it("returns error when token is not set", async () => {
      const result = await callTool();
      expect(result.isError).toBe(true);
      expect(result.text).toContain("PINTEREST_ACCESS_TOKEN not configured");
    });

    it("returns boards as markdown table", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              items: [
                { id: "b1", name: "Board One", pin_count: 42, privacy: "PUBLIC", description: "My first board" },
                { id: "b2", name: "Board Two", pin_count: 10, privacy: "SECRET", description: null },
              ],
            }),
          ),
      });
      const result = await callTool();
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("# Your Pinterest Boards");
      expect(result.text).toContain("b1");
      expect(result.text).toContain("Board One");
      expect(result.text).toContain("42");
      expect(result.text).toContain("b2");
      expect(result.text).toContain("_2 boards found_");
    });

    it("returns message when no boards found", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ items: [] })),
      });
      const result = await callTool();
      expect(result.text).toContain("No boards found");
    });

    it("returns API error on fetch failure", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });
      const result = await callTool();
      expect(result.isError).toBe(true);
      expect(result.text).toContain("401");
    });
  });

  // ─── pinterest-create-pin ──────────────────────────────────────────

  describe("pinterest-create-pin", () => {
    const callTool = (args: Record<string, unknown>) =>
      toolMap.get("pinterest-create-pin")!.handler(args);

    it("returns error when token is not set", async () => {
      const result = await callTool({ board_id: "b1", title: "Test", description: "Desc", image_url: "https://example.com/img.jpg" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("PINTEREST_ACCESS_TOKEN not configured");
    });

    it("creates a pin with image_url", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              id: "pin-123",
              board_id: "b1",
              title: "Test Pin",
              creative_type: "IMAGE",
              media: { images: { "400x300": { url: "https://img.test/400.jpg" } } },
            }),
          ),
      });
      const result = await callTool({
        board_id: "b1",
        title: "Test Pin",
        description: "A test pin description",
        image_url: "https://example.com/image.jpg",
        link: "https://example.com",
        alt_text: "Alt text",
      });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("Pin Created Successfully");
      expect(result.text).toContain("pin-123");
      // Verify the fetch was called with POST /pins
      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain("/v5/pins");
      const body = JSON.parse(fetchCall[1].body);
      expect(body.board_id).toBe("b1");
      expect(body.media_source.source_type).toBe("image_url");
    });

    it("returns error when image_path file not found", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      // fs.existsSync is mocked to return false
      const result = await callTool({
        board_id: "b1",
        title: "Test",
        description: "Desc",
        image_path: "/nonexistent/image.png",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Image file not found");
    });

    it("handles API error response", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad Request: missing board_id"),
      });
      const result = await callTool({
        board_id: "b1",
        title: "Test",
        description: "Desc",
        image_url: "https://example.com/img.jpg",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("400");
    });
  });

  // ─── pinterest-pin-insights ────────────────────────────────────────

  describe("pinterest-pin-insights", () => {
    const callTool = (args: Record<string, unknown>) =>
      toolMap.get("pinterest-pin-insights")!.handler(args);

    it("returns error when token is not set", async () => {
      const result = await callTool({ query: "test topic" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("PINTEREST_ACCESS_TOKEN not configured");
    });

    it("returns insights with trends and keyword data", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          // Trends API call
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                trends: [
                  { keyword: "test topic ideas", pct_growth_wow: 5, pct_growth_mom: 10, pct_growth_yoy: 50 },
                  { keyword: "unrelated", pct_growth_wow: 1, pct_growth_mom: 2, pct_growth_yoy: 3 },
                ],
              }),
            ),
        })
        .mockResolvedValueOnce({
          // Keyword metrics API call
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify([
                { keyword: "test topic", search_volume: 1000, competition: "MEDIUM" },
              ]),
            ),
        });
      const result = await callTool({
        query: "test topic",
        include_trend_data: true,
        include_keyword_metrics: true,
      });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("test topic");
    });

    it("returns insights without optional sections", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      const result = await callTool({
        query: "minimal query",
        include_trend_data: false,
        include_keyword_metrics: false,
        include_pin_analysis: false,
      });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("minimal query");
    });
  });

  // ─── pinterest-search-pins ─────────────────────────────────────────

  describe("pinterest-search-pins", () => {
    const callTool = (args: Record<string, unknown>) =>
      toolMap.get("pinterest-search-pins")!.handler(args);

    it("returns error when token is not set", async () => {
      const result = await callTool({ query: "test topic" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("PINTEREST_ACCESS_TOKEN not configured");
    });

    it("analyzes seed pins by ID", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      // Mock pin page fetch + trends + keyword metrics
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          // fetchPinPageData for pin-abc: the page HTML
          ok: true,
          text: () =>
            Promise.resolve(
              `<html><head>
                <script id="__PWS_DATA__">window.__PWS_DATA__ = ${JSON.stringify({
                  props: { initialReduxState: { pins: { "pin-abc": {
                    id: "pin-abc", title: "Test Pin", description: "A great pin about nails",
                    link: "https://example.com", repins: 100, board_url: "/user/board/",
                    media: { images: { original: { url: "https://img.test/orig.jpg" } } },
                  } } } },
                })};</script>
              </head><body></body></html>`,
            ),
        })
        .mockResolvedValueOnce({
          // trends API call
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ trends: [] })),
        })
        .mockResolvedValueOnce({
          // keyword metrics API call
          ok: true,
          text: () => Promise.resolve(JSON.stringify([])),
        });
      const result = await callTool({
        query: "nails",
        pin_ids: ["pin-abc"],
        include_board_discovery: false,
      });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("nails");
    });

    it("handles empty seed pins gracefully", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          // trends API
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ trends: [] })),
        })
        .mockResolvedValueOnce({
          // keyword metrics
          ok: true,
          text: () => Promise.resolve(JSON.stringify([])),
        });
      const result = await callTool({ query: "test" });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("test");
    });
  });

  // ─── pinterest-content-ideas ────────────────────────

  describe("pinterest-content-ideas", () => {
    const callTool = (args: Record<string, unknown>) =>
      toolMap.get("pinterest-content-ideas")!.handler(args);

    /** Build a fetch mock for the content-ideas flow:
     *  call 1: Pinterest trends API
     *  call 2: Google Suggest (topic expansion)
     *  call 3+: enrichKeywordMetrics calls (Pinterest ads + Google Suggest fallback)
     */
    function stubContentIdeasFetch(opts?: { trendsError?: boolean }) {
      const trendResponse = opts?.trendsError
        ? { ok: false, status: 403, text: () => Promise.resolve("Forbidden") }
        : {
            ok: true,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  trends: [
                    { keyword: "home office setup", pct_growth_mom: 20, pct_growth_yoy: 50 },
                    { keyword: "home office ideas", pct_growth_mom: 15, pct_growth_yoy: 30 },
                  ],
                }),
              ),
          };

      const googleSuggestResponse = {
        ok: true,
        json: () =>
          Promise.resolve([
            "home office decor pinterest",
            ["home office decor ideas", "home office decor diy", "small home office decor"],
            [],
            [],
            { "google:suggestrelevance": [800, 600, 500] },
          ]),
      };

      const googleSuggestFallback = {
        ok: true,
        json: () =>
          Promise.resolve([
            "home office",
            ["home office", "home office decor"],
            [],
            [],
            { "google:suggestrelevance": [900, 700] },
          ]),
      };

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(trendResponse)       // Pinterest trends
        .mockResolvedValueOnce(googleSuggestResponse) // Google Suggest expansion
        .mockResolvedValue(googleSuggestFallback);    // Any remaining Google Suggest calls

      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("requires PINTEREST_ACCESS_TOKEN", async () => {
      const result = await callTool({ topic: "home office decor" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("PINTEREST_ACCESS_TOKEN");
    });

    it("generates content ideas and returns markdown", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      mockAddContentIdea.mockClear();
      stubContentIdeasFetch();

      const result = await callTool({ topic: "home office decor" });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("Pinterest Content Ideas");
      expect(result.text).toContain("home office decor");
      expect(result.text).toContain("saved to your Content Ideas tracker");
    });

    it("saves ideas to tracker DB", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      mockAddContentIdea.mockClear();
      stubContentIdeasFetch();

      await callTool({ topic: "home office decor", count: 3 });
      expect(mockAddContentIdea).toHaveBeenCalled();
      const call = mockAddContentIdea.mock.calls[0][0];
      expect(call.topic).toBe("home office decor");
      expect(call.status).toBe("new");
      expect(call.suggested_title).toBeTruthy();
    });

    it("respects count parameter", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      mockAddContentIdea.mockClear();
      stubContentIdeasFetch();

      const result = await callTool({ topic: "home office decor", count: 2 });
      expect(result.isError).toBeUndefined();
      // Should cap at the requested count
      expect(mockAddContentIdea.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it("handles trends API error gracefully", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      stubContentIdeasFetch({ trendsError: true });

      const result = await callTool({ topic: "home office decor" });
      // Should still succeed with Google Suggest data alone
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("Pinterest Content Ideas");
    });

    it("uses custom region", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      const fetchMock = stubContentIdeasFetch();

      await callTool({ topic: "home office", region: "GB" });
      const firstCallUrl = fetchMock.mock.calls[0][0] as string;
      expect(firstCallUrl).toContain("/GB/");
    });

    it("reports output includes region and topic metadata", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      stubContentIdeasFetch();

      const result = await callTool({ topic: "nail art", region: "CA" });
      expect(result.text).toContain("Region:** CA");
    });
  });

  // ─── pinterest-related-keywords ─────────────────────

  describe("pinterest-related-keywords", () => {
    const callTool = (args: Record<string, unknown>) =>
      toolMap.get("pinterest-related-keywords")!.handler(args);

    /** Build a fetch mock for the related-keywords flow:
     *  calls 1-5: Google Suggest for 5 variations
     *  call 6: Pinterest autocomplete
     *  calls 7+: enrichKeywordMetrics
     */
    function stubRelatedKeywordsFetch(opts?: { pinterestAcError?: boolean }) {
      const makeSuggestResponse = (suggestions: string[]) => ({
        ok: true,
        json: () =>
          Promise.resolve([
            "query",
            suggestions,
            [],
            [],
            { "google:suggestrelevance": suggestions.map((_, i) => 900 - i * 100) },
          ]),
      });

      const pinterestAcResponse = opts?.pinterestAcError
        ? { ok: false, status: 500, text: () => Promise.resolve("error") }
        : {
            ok: true,
            text: () =>
              Promise.resolve(
                JSON.stringify([
                  { keyword: "home office decor modern" },
                  { keyword: "home office decor minimalist" },
                ]),
              ),
          };

      const fetchMock = vi.fn()
        // 5 Google Suggest calls for variations
        .mockResolvedValueOnce(makeSuggestResponse(["home office decor ideas", "home office decor diy"]))
        .mockResolvedValueOnce(makeSuggestResponse(["home office decor ideas pinterest"]))
        .mockResolvedValueOnce(makeSuggestResponse(["home office decor inspiration board"]))
        .mockResolvedValueOnce(makeSuggestResponse(["home office decor diy budget"]))
        .mockResolvedValueOnce(makeSuggestResponse(["best home office decor 2025"]))
        // Pinterest autocomplete
        .mockResolvedValueOnce(pinterestAcResponse)
        // Remaining calls (enrichKeywordMetrics Google Suggest fallback)
        .mockResolvedValue(makeSuggestResponse(["home office", "home office setup"]));

      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("requires PINTEREST_ACCESS_TOKEN", async () => {
      const result = await callTool({ seed: "home office decor" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("PINTEREST_ACCESS_TOKEN");
    });

    it("expands seed keyword and returns markdown table", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      stubRelatedKeywordsFetch();

      const result = await callTool({ seed: "home office decor" });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("Related Keywords");
      expect(result.text).toContain("home office decor");
      expect(result.text).toContain("| Keyword |");
      expect(result.text).toContain("Suggested Pin Strategy");
    });

    it("includes Pinterest autocomplete keywords", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      stubRelatedKeywordsFetch();

      const result = await callTool({ seed: "home office decor" });
      expect(result.text).toContain("home office decor modern");
    });

    it("handles Pinterest autocomplete failure gracefully", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      stubRelatedKeywordsFetch({ pinterestAcError: true });

      const result = await callTool({ seed: "home office decor" });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("Related Keywords");
    });

    it("uses custom region", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      stubRelatedKeywordsFetch();

      const result = await callTool({ seed: "home office", region: "DE" });
      expect(result.text).toContain("Region:** DE");
    });

    it("includes opportunity scoring with stars", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      stubRelatedKeywordsFetch();

      const result = await callTool({ seed: "home office decor" });
      expect(result.text).toMatch(/[★☆]/);
    });

    it("saves report to file", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      stubRelatedKeywordsFetch();

      const result = await callTool({ seed: "home office decor" });
      expect(result.text).toContain("Report saved to");
    });
  });
});
