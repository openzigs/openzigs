import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";

// ── Shared constants ────────────────────────────────────────────────────────

const PINTEREST_REGIONS = [
  "US", "CA", "GB", "AU", "DE", "FR", "JP", "BR", "MX", "IT", "ES",
] as const;

const PINTEREST_API_BASE = "https://api.pinterest.com/v5";

// ── Zod Schemas ─────────────────────────────────────────────────────────────

const pinterestTrendsSchema = z.object({
  region: z
    .enum(PINTEREST_REGIONS)
    .default("US")
    .describe("ISO country code for trend region"),
  trend_type: z
    .enum(["growing", "monthly", "weekly", "yearly"])
    .default("growing")
    .describe("Trend type: growing (fastest rising), monthly/weekly/yearly (top by period)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Number of trending keywords to return (default: 25, max: 50)"),
  normalize_against_group: z
    .boolean()
    .optional()
    .describe("Normalize time_series across all returned keywords for comparison"),
});

const pinterestKeywordMetricsSchema = z.object({
  keywords: z
    .array(z.string())
    .min(1)
    .max(100)
    .describe("Keywords to get metrics for (max 100)"),
  country: z
    .enum(PINTEREST_REGIONS)
    .default("US")
    .describe("Country for keyword metrics"),
});

const pinterestAnalyticsSchema = z.object({
  action: z
    .enum(["account_summary", "top_pins"])
    .describe("account_summary: overall metrics; top_pins: best-performing pins"),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Start date (YYYY-MM-DD)"),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("End date (YYYY-MM-DD)"),
  metrics: z
    .array(
      z.enum([
        "IMPRESSION",
        "PIN_CLICK",
        "OUTBOUND_CLICK",
        "SAVE",
        "SAVE_RATE",
        "ENGAGEMENT",
        "ENGAGEMENT_RATE",
        "TOTAL_COMMENTS",
        "TOTAL_REACTIONS",
      ]),
    )
    .optional()
    .describe("Specific metrics to fetch (default: all available)"),
  sort_by: z
    .enum(["IMPRESSION", "SAVE", "PIN_CLICK", "OUTBOUND_CLICK", "ENGAGEMENT"])
    .optional()
    .describe("Sort top_pins by this metric (default: IMPRESSION)"),
});

const pinterestSeoAnalyzeSchema = z
  .object({
    action: z
      .enum(["analyze_pin", "analyze_url", "bulk_analyze"])
      .describe(
        "analyze_pin: single pin by ID; analyze_url: any Pinterest URL; bulk_analyze: batch pin IDs",
      ),
    pin_id: z.string().optional().describe("Pinterest pin ID (for analyze_pin action)"),
    url: z.string().url().optional().describe("Pinterest pin or board URL (for analyze_url action)"),
    pin_ids: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("Array of pin IDs for bulk analysis (max 20)"),
    include_annotations: z
      .boolean()
      .default(true)
      .describe("Extract Pinterest annotation keywords via browser scraping"),
    include_competitors: z
      .boolean()
      .default(false)
      .describe("Also fetch top-ranking pins for the same keywords for comparison"),
  })
  .refine(
    (data) => {
      if (data.action === "analyze_pin") return !!data.pin_id;
      if (data.action === "analyze_url") return !!data.url;
      if (data.action === "bulk_analyze") return !!data.pin_ids?.length;
      return false;
    },
    {
      message:
        "Must provide pin_id for analyze_pin, url for analyze_url, or pin_ids for bulk_analyze",
    },
  );

// ── Helpers ─────────────────────────────────────────────────────────────────

function getToken(): string | undefined {
  return process.env.PINTEREST_ACCESS_TOKEN;
}

async function pinterestApiFetch(
  urlPath: string,
  token: string,
  params?: URLSearchParams,
): Promise<{ text: string; isError?: boolean }> {
  const url = new URL(`${PINTEREST_API_BASE}${urlPath}`);
  if (params) {
    params.forEach((v, k) => url.searchParams.append(k, v));
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!res.ok) {
    const errorBody = await res.text();
    return { text: `Pinterest API error (${res.status}): ${errorBody}`, isError: true };
  }

  const data = await res.json();
  return { text: JSON.stringify(data, null, 2) };
}

/**
 * Extract a numeric pin ID from various Pinterest URL formats.
 * Returns null for short URLs (pin.it) that require redirect resolution.
 */
export function extractPinIdFromUrl(url: string): string | null {
  const match = url.match(/\/pin\/(\d+)/);
  return match?.[1] ?? null;
}

/** Pin Score: composite 0–100 based on API metadata + annotation density. */
export function calculatePinScore(
  apiData: Record<string, unknown> | null,
  annotations: string[],
): number {
  if (!apiData) return 0;

  let score = 0;

  // Title present and reasonable length (up to 20 points)
  const title = apiData.title as string | null | undefined;
  if (title && title.length > 0) {
    score += title.length <= 100 ? 20 : 10;
  }

  // Description present and keyword-rich (up to 25 points)
  const desc = apiData.description as string | null | undefined;
  if (desc && desc.length > 0) {
    if (desc.length >= 100 && desc.length <= 500) score += 25;
    else if (desc.length > 0) score += 10;
  }

  // Link present (10 points)
  if (apiData.link) score += 10;

  // Alt text present (10 points)
  const altText = apiData.alt_text as string | null | undefined;
  if (altText && altText.length > 0) score += 10;

  // Media type is image or video (5 points)
  const media = apiData.media as Record<string, unknown> | undefined;
  if (media?.media_type === "image" || media?.media_type === "video") score += 5;

  // Annotation density (up to 30 points)
  const annotationCount = annotations.length;
  if (annotationCount >= 5) score += 30;
  else if (annotationCount >= 3) score += 20;
  else if (annotationCount >= 1) score += 10;

  return Math.min(score, 100);
}

/** Generate SEO improvement recommendations based on pin data and annotations. */
export function generateSeoRecommendations(
  apiData: Record<string, unknown> | null,
  annotations: string[],
): string[] {
  const recs: string[] = [];

  if (!apiData) {
    recs.push("Unable to fetch pin data — ensure PINTEREST_ACCESS_TOKEN is configured and pin ID is valid.");
    return recs;
  }

  const title = apiData.title as string | null | undefined;
  if (!title || title.length === 0) {
    recs.push("Add a title (max 100 chars) with your primary keyword in the first 40 characters.");
  } else if (title.length > 100) {
    recs.push(`Title is ${title.length} chars — trim to 100 chars max for optimal display.`);
  }

  const desc = apiData.description as string | null | undefined;
  if (!desc || desc.length === 0) {
    recs.push("Add a description (100–500 chars) with 2–4 relevant keywords naturally integrated.");
  } else if (desc.length < 100) {
    recs.push(`Description is only ${desc.length} chars — expand to 100–500 chars for better SEO.`);
  }

  if (!apiData.link) {
    recs.push("Add a link to drive traffic to your website.");
  }

  const altText = apiData.alt_text as string | null | undefined;
  if (!altText || altText.length === 0) {
    recs.push("Add alt text for accessibility and SEO (max 500 chars).");
  }

  // Check which annotation keywords are missing from the description
  if (annotations.length > 0 && desc) {
    const descLower = desc.toLowerCase();
    const missing = annotations.filter((kw) => !descLower.includes(kw.toLowerCase()));
    if (missing.length > 0) {
      recs.push(
        `Include these annotation keywords in your description: ${missing.join(", ")}`,
      );
    }
  } else if (annotations.length === 0) {
    recs.push(
      "No annotation keywords detected — ensure your pin content aligns with Pinterest interest categories.",
    );
  }

  return recs;
}

// ── Annotation extraction strategies (multi-strategy for resilience) ────────

interface AnnotationStrategy {
  name: string;
  extract: (html: string) => string[];
}

/** Strategy 1: Extract from __PWS_DATA__ global JSON. */
const extractFromPwsData: AnnotationStrategy = {
  name: "__PWS_DATA__",
  extract: (html: string) => {
    const match = html.match(/__PWS_DATA__\s*=\s*({[\s\S]*?});\s*<\/script>/);
    if (!match?.[1]) return [];
    try {
      const data = JSON.parse(match[1]);
      const annotations: string[] = [];
      const traverse = (obj: unknown): void => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          for (const item of obj) traverse(item);
          return;
        }
        const record = obj as Record<string, unknown>;
        if (record.name && record.type === "interest") {
          annotations.push(String(record.name));
        }
        for (const val of Object.values(record)) traverse(val);
      };
      traverse(data);
      return [...new Set(annotations)];
    } catch {
      return [];
    }
  },
};

/** Strategy 2: Extract from application/json script tags. */
const extractFromScriptTags: AnnotationStrategy = {
  name: "script-tags",
  extract: (html: string) => {
    const annotations: string[] = [];
    const scriptRegex = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
    let scriptMatch: RegExpExecArray | null;
    while ((scriptMatch = scriptRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(scriptMatch[1]);
        const str = JSON.stringify(data);
        // Look for annotation/interest arrays
        const interestMatches = str.match(/"interest":\s*"([^"]+)"/g);
        if (interestMatches) {
          for (const m of interestMatches) {
            const val = m.match(/"interest":\s*"([^"]+)"/);
            if (val?.[1]) annotations.push(val[1]);
          }
        }
        // Also check for annotatedInterests or annotations fields
        const annotationMatches = str.match(/"(?:annotated_interests?|annotations?)":\s*\[([^\]]+)\]/g);
        if (annotationMatches) {
          for (const m of annotationMatches) {
            const valMatch = m.match(/"([^"]+)"/g);
            if (valMatch) {
              for (const v of valMatch) {
                const clean = v.replace(/"/g, "");
                if (
                  clean !== "annotated_interests" &&
                  clean !== "annotated_interest" &&
                  clean !== "annotations" &&
                  clean !== "annotation"
                ) {
                  annotations.push(clean);
                }
              }
            }
          }
        }
      } catch {
        // Skip invalid JSON blocks
      }
    }
    return [...new Set(annotations)];
  },
};

/** Strategy 3: Extract from meta tags (og:interests, article:tag, etc.). */
const extractFromMetaTags: AnnotationStrategy = {
  name: "meta-tags",
  extract: (html: string) => {
    const annotations: string[] = [];
    // og: and article: meta tags
    const metaRegex =
      /<meta\s+(?:property|name)="(?:og:interest|article:tag|pinterest:interest)"[^>]*?content="([^"]+)"/g;
    let metaMatch: RegExpExecArray | null;
    while ((metaMatch = metaRegex.exec(html)) !== null) {
      if (metaMatch[1]) annotations.push(metaMatch[1]);
    }
    return [...new Set(annotations)];
  },
};

const ANNOTATION_STRATEGIES: AnnotationStrategy[] = [
  extractFromPwsData,
  extractFromScriptTags,
  extractFromMetaTags,
];

/**
 * Try multiple extraction strategies in order.
 * Returns annotations from the first strategy that produces results.
 */
export function extractAnnotationsFromHtml(html: string): string[] {
  for (const strategy of ANNOTATION_STRATEGIES) {
    try {
      const results = strategy.extract(html);
      if (results.length > 0) return results;
    } catch {
      continue;
    }
  }
  return [];
}

// ── Tool Factory ────────────────────────────────────────────────────────────

export function createPinterestSeoTools(): ToolDefinition[] {
  return [
    // ── pinterest-trends ──────────────────────────────────────────────
    {
      name: "pinterest-trends",
      description:
        "Fetch trending Pinterest keywords for a region with week-over-week, month-over-month, and year-over-year " +
        "growth percentages plus a 52-week search volume time series. Use to identify rising content opportunities " +
        "and seasonal patterns. Results ordered by trend rank (#1 = top trend).",
      inputSchema: {
        type: "object",
        properties: {
          region: {
            type: "string",
            enum: [...PINTEREST_REGIONS],
            description: "ISO country code for trend region",
          },
          trend_type: {
            type: "string",
            enum: ["growing", "monthly", "weekly", "yearly"],
            description:
              "Trend type: growing (fastest rising), monthly/weekly/yearly (top by period)",
          },
          limit: {
            type: "number",
            description: "Number of trending keywords to return (default: 25, max: 50)",
          },
          normalize_against_group: {
            type: "boolean",
            description:
              "Normalize time_series values across keywords for direct comparison",
          },
        },
      },
      zodSchema: pinterestTrendsSchema,
      category: "social",
      riskLevel: "low",
      source: "pinterest",
      handler: async (args) => {
        const input = pinterestTrendsSchema.parse(args);
        const token = getToken();
        if (!token) return { text: "PINTEREST_ACCESS_TOKEN not configured.", isError: true };

        const params = new URLSearchParams();
        if (input.limit) params.set("limit", String(input.limit));
        if (input.normalize_against_group) params.set("normalize_against_group", "true");

        return pinterestApiFetch(
          `/trends/keywords/${encodeURIComponent(input.region)}/top/${encodeURIComponent(input.trend_type)}`,
          token,
          params,
        );
      },
    },

    // ── pinterest-keyword-metrics ─────────────────────────────────────
    {
      name: "pinterest-keyword-metrics",
      description:
        "Get Pinterest search volume and competition metrics for specific keywords in a country. " +
        "Returns monthly search volume, competition level, and bid ranges. " +
        "Use to evaluate keyword viability before creating pins targeting those terms.",
      inputSchema: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "Keywords to get metrics for (max 100)",
          },
          country: {
            type: "string",
            enum: [...PINTEREST_REGIONS],
            description: "Country for keyword metrics",
          },
        },
        required: ["keywords"],
      },
      zodSchema: pinterestKeywordMetricsSchema,
      category: "social",
      riskLevel: "low",
      source: "pinterest",
      handler: async (args) => {
        const input = pinterestKeywordMetricsSchema.parse(args);
        const token = getToken();
        if (!token) return { text: "PINTEREST_ACCESS_TOKEN not configured.", isError: true };

        const adAccountId = process.env.PINTEREST_AD_ACCOUNT_ID;
        if (!adAccountId) {
          return { text: "PINTEREST_AD_ACCOUNT_ID not configured.", isError: true };
        }

        const params = new URLSearchParams();
        params.set("country", input.country);
        for (const kw of input.keywords) {
          params.append("keyword", kw);
        }

        return pinterestApiFetch(
          `/ad_accounts/${encodeURIComponent(adAccountId)}/keywords/metrics`,
          token,
          params,
        );
      },
    },

    // ── pinterest-analytics ───────────────────────────────────────────
    {
      name: "pinterest-analytics",
      description:
        "Fetch Pinterest account analytics or top-performing pins over a date range. " +
        "Actions: 'account_summary' returns impressions, saves, clicks, engagement; " +
        "'top_pins' returns your 50 highest-performing pins with per-pin metrics. " +
        "Use to identify winning content patterns and track account growth.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["account_summary", "top_pins"],
            description:
              "account_summary: overall metrics; top_pins: best-performing pins",
          },
          start_date: {
            type: "string",
            description: "Start date (YYYY-MM-DD)",
          },
          end_date: {
            type: "string",
            description: "End date (YYYY-MM-DD)",
          },
          metrics: {
            type: "array",
            items: { type: "string" },
            description: "Specific metrics to fetch (default: all available)",
          },
          sort_by: {
            type: "string",
            enum: ["IMPRESSION", "SAVE", "PIN_CLICK", "OUTBOUND_CLICK", "ENGAGEMENT"],
            description: "Sort top_pins by this metric (default: IMPRESSION)",
          },
        },
        required: ["action", "start_date", "end_date"],
      },
      zodSchema: pinterestAnalyticsSchema,
      category: "social",
      riskLevel: "low",
      source: "pinterest",
      handler: async (args) => {
        const input = pinterestAnalyticsSchema.parse(args);
        const token = getToken();
        if (!token) return { text: "PINTEREST_ACCESS_TOKEN not configured.", isError: true };

        const baseMetrics = input.metrics ?? [
          "IMPRESSION",
          "PIN_CLICK",
          "OUTBOUND_CLICK",
          "SAVE",
          "ENGAGEMENT",
        ];

        const endpoint =
          input.action === "top_pins"
            ? "/user_account/analytics/top_pins"
            : "/user_account/analytics";

        const params = new URLSearchParams();
        params.set("start_date", input.start_date);
        params.set("end_date", input.end_date);
        params.set("metric_types", baseMetrics.join(","));
        if (input.action === "top_pins" && input.sort_by) {
          params.set("sort_by", input.sort_by);
        }

        return pinterestApiFetch(endpoint, token, params);
      },
    },

    // ── pinterest-seo-analyze ─────────────────────────────────────────
    {
      name: "pinterest-seo-analyze",
      description:
        "Analyze a Pinterest pin's SEO performance: extract official annotation keywords assigned by Pinterest, " +
        "calculate a Pin Score (composite of title, description, link, alt text, annotation density), and surface " +
        "keyword optimization opportunities. Annotations are the hidden interest keywords Pinterest's algorithm " +
        "uses for distribution — including them in pin descriptions dramatically increases reach. " +
        "Supports single pin, URL, or batch analysis of up to 20 pins.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["analyze_pin", "analyze_url", "bulk_analyze"],
            description:
              "analyze_pin: single pin by ID; analyze_url: any Pinterest URL; bulk_analyze: batch pin IDs",
          },
          pin_id: { type: "string", description: "Pinterest pin ID" },
          url: { type: "string", description: "Pinterest pin/board URL" },
          pin_ids: {
            type: "array",
            items: { type: "string" },
            description: "Array of pin IDs for bulk analysis (max 20)",
          },
          include_annotations: {
            type: "boolean",
            description:
              "Extract Pinterest annotation keywords via browser (default: true)",
          },
          include_competitors: {
            type: "boolean",
            description:
              "Fetch top-ranking pins for same keywords for comparison",
          },
        },
        required: ["action"],
      },
      zodSchema: pinterestSeoAnalyzeSchema,
      category: "social",
      riskLevel: "medium",
      source: "pinterest",
      handler: async (args) => {
        const input = pinterestSeoAnalyzeSchema.parse(args);
        const token = getToken();

        // Resolve pin IDs from input
        let pinIds: string[] = [];
        if (input.action === "analyze_pin" && input.pin_id) {
          pinIds = [input.pin_id];
        } else if (input.action === "analyze_url" && input.url) {
          const extracted = extractPinIdFromUrl(input.url);
          if (!extracted) {
            return {
              text: "Could not extract pin ID from URL. Use a full Pinterest pin URL (e.g., https://pinterest.com/pin/123456789/).",
              isError: true,
            };
          }
          pinIds = [extracted];
        } else if (input.action === "bulk_analyze" && input.pin_ids) {
          pinIds = input.pin_ids;
        }

        if (pinIds.length === 0) {
          return { text: "No pin IDs to analyze.", isError: true };
        }

        const results = [];
        for (const pinId of pinIds) {
          const analysis = await analyzeSinglePin(pinId, token ?? undefined, {
            includeAnnotations: input.include_annotations,
          });
          results.push(analysis);
        }

        return {
          text: JSON.stringify(results.length === 1 ? results[0] : results, null, 2),
        };
      },
    },
  ];
}

// ── Internal analyzer ───────────────────────────────────────────────────────

interface PinAnalysis {
  pin_id: string;
  title: string | null;
  description: string | null;
  link: string | null;
  media_type: string | null;
  pin_score: number;
  annotations: string[];
  annotation_count: number;
  seo_recommendations: string[];
  api_data_available: boolean;
}

async function analyzeSinglePin(
  pinId: string,
  token: string | undefined,
  options: { includeAnnotations: boolean },
): Promise<PinAnalysis> {
  // Phase 1: API data (if token available)
  let apiData: Record<string, unknown> | null = null;
  if (token) {
    try {
      const res = await fetch(`${PINTEREST_API_BASE}/pins/${encodeURIComponent(pinId)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (res.ok) apiData = (await res.json()) as Record<string, unknown>;
    } catch {
      // API fetch failed — continue with browser-only analysis
    }
  }

  // Phase 2: Browser-based annotation extraction
  let annotations: string[] = [];
  if (options.includeAnnotations) {
    try {
      const pinUrl = `https://www.pinterest.com/pin/${encodeURIComponent(pinId)}/`;
      const res = await fetch(pinUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html",
        },
      });
      if (res.ok) {
        const html = await res.text();
        annotations = extractAnnotationsFromHtml(html);
      }
    } catch {
      // Browser fetch failed — proceed with API-only analysis
    }
  }

  // Phase 3: Calculate Pin Score
  const pinScore = calculatePinScore(apiData, annotations);

  // Phase 4: SEO recommendations
  const seoRecommendations = generateSeoRecommendations(apiData, annotations);

  const media = apiData?.media as Record<string, unknown> | undefined;

  return {
    pin_id: pinId,
    title: (apiData?.title as string) ?? null,
    description: (apiData?.description as string) ?? null,
    link: (apiData?.link as string) ?? null,
    media_type: (media?.media_type as string) ?? null,
    pin_score: pinScore,
    annotations,
    annotation_count: annotations.length,
    seo_recommendations: seoRecommendations,
    api_data_available: !!apiData,
  };
}
