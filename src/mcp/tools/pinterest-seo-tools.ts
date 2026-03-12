import * as z from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { marked } from "marked";
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
    .enum(["growing", "monthly", "seasonal", "yearly"])
    .default("growing")
    .describe("Trend type: growing (fastest rising), monthly/seasonal/yearly (top by period)"),
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

// ── New Schemas: create-pin & pin-insights ──────────────────────────────────

const pinterestCreatePinSchema = z.object({
  board_id: z.string().describe("Board ID to pin to (use GET /v5/boards to list boards)"),
  title: z.string().max(100).describe("Pin title (max 100 chars)"),
  description: z.string().max(800).describe("Pin description with keywords and hashtags (max 800 chars)"),
  link: z.string().url().optional().describe("Destination URL for the pin"),
  alt_text: z.string().max(500).optional().describe("Alt text for accessibility and SEO (max 500 chars)"),
  image_url: z.string().url().optional().describe("Public URL of the image to pin"),
  image_path: z.string().optional().describe("Local file path of the image to pin (base64 uploaded)"),
  board_section_id: z.string().optional().describe("Board section ID for organization"),
}).refine(
  (data) => !!data.image_url || !!data.image_path,
  { message: "Must provide either image_url or image_path" },
);

const pinterestPinInsightsSchema = z.object({
  query: z.string().describe("Topic/subject to research (e.g., 'spring nails', 'AI tools', 'home decor')"),
  region: z.enum(PINTEREST_REGIONS).default("US").describe("Region for trend/keyword data"),
  pin_ids: z.array(z.string()).max(10).optional().describe("Specific pin IDs to include in the competitive analysis"),
  pin_urls: z.array(z.string().url()).max(10).optional().describe("Pinterest pin URLs to include in the analysis"),
  include_keyword_metrics: z.boolean().default(true).describe("Include search volume/competition data for the query keywords"),
  include_trend_data: z.boolean().default(true).describe("Include trending data showing growth rates"),
  include_pin_analysis: z.boolean().default(true).describe("Analyze provided pins for SEO scoring"),
});

const pinterestSearchPinsSchema = z.object({
  query: z.string().describe("Topic to research (e.g., 'spring nails', 'keto recipes', 'home office decor')"),
  pin_urls: z.array(z.string().url()).max(10).optional()
    .describe("Seed pin URLs to start discovery from — the tool will find more pins from the same boards"),
  pin_ids: z.array(z.string()).max(10).optional()
    .describe("Seed pin IDs to start discovery from"),
  count: z.number().int().min(1).max(25).default(10)
    .describe("Maximum number of pins to discover and analyze (default: 10, max: 25)"),
  region: z.enum(PINTEREST_REGIONS).default("US")
    .describe("Region for trend and keyword data"),
  include_board_discovery: z.boolean().default(true)
    .describe("Discover additional pins from the same boards as seed pins"),
});

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

  const rawBody = await res.text();
  if (!rawBody.trim()) {
    return { text: `Pinterest API returned empty response (${res.status})`, isError: true };
  }
  try {
    const data = JSON.parse(rawBody) as unknown;
    return { text: JSON.stringify(data, null, 2) };
  } catch {
    return { text: `Pinterest API returned non-JSON response (${res.status}): ${rawBody.slice(0, 500)}`, isError: true };
  }
}

async function pinterestApiPost(
  urlPath: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; text: string; isError?: boolean }> {
  const url = `${PINTEREST_API_BASE}${urlPath}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const rawBody = await res.text();
  if (!res.ok) {
    return { text: `Pinterest API error (${res.status}): ${rawBody}`, isError: true };
  }
  try {
    const data = JSON.parse(rawBody) as Record<string, unknown>;
    return { data, text: JSON.stringify(data, null, 2) };
  } catch {
    return { text: `Pinterest API returned non-JSON (${res.status}): ${rawBody.slice(0, 500)}`, isError: true };
  }
}

// ── Report saving ───────────────────────────────────────────────────────────

const REPORTS_DIR = path.join(os.homedir(), ".openzigs", "pinterest-reports");

function ensureReportsDir(): void {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function saveReport(filename: string, content: string): string {
  ensureReportsDir();
  const filePath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/** Save structured JSON alongside markdown for UI consumption. */
function saveReportJson(basename: string, data: unknown): void {
  ensureReportsDir();
  const filePath = path.join(REPORTS_DIR, `${basename}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

// ── PDF export ──────────────────────────────────────────────────────────────

const CHROME_PATHS_FOR_PDF: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

function findChromeBinaryForPdf(): string | undefined {
  const paths = CHROME_PATHS_FOR_PDF[os.platform()] ?? [];
  return paths.find((p) => fs.existsSync(p));
}

function wrapMarkdownAsHtml(markdownContent: string): string {
  const body = marked(markdownContent) as string;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #1a1a1a; max-width: 900px; margin: 0 auto; padding: 24px 32px; }
  h1 { font-size: 22px; color: #e60023; border-bottom: 2px solid #e60023; padding-bottom: 8px; margin-bottom: 16px; }
  h2 { font-size: 16px; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 24px; }
  h3 { font-size: 14px; color: #444; margin-top: 16px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 12px; }
  th { background: #f0f0f0; border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-weight: 600; }
  td { border: 1px solid #ddd; padding: 5px 10px; vertical-align: top; }
  tr:nth-child(even) td { background: #fafafa; }
  ul, ol { padding-left: 20px; margin: 8px 0; }
  li { margin: 3px 0; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
  pre { background: #f4f4f4; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 11px; }
  blockquote { border-left: 3px solid #e60023; margin: 8px 0; padding: 4px 12px; color: #555; background: #fff5f5; }
  details { display: none; }
  strong { font-weight: 600; }
  em { color: #555; }
  hr { border: none; border-top: 1px solid #eee; margin: 20px 0; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Saves a markdown report as PDF using the system Chrome headless print feature.
 * Returns the PDF file path on success, or null if Chrome is not found.
 */
async function saveReportPdf(basename: string, markdownContent: string): Promise<string | null> {
  const chrome = findChromeBinaryForPdf();
  if (!chrome) return null;

  ensureReportsDir();
  const htmlContent = wrapMarkdownAsHtml(markdownContent);
  const tempHtml = path.join(os.tmpdir(), `${basename}.html`);
  const pdfPath = path.join(REPORTS_DIR, `${basename}.pdf`);

  try {
    fs.writeFileSync(tempHtml, htmlContent, "utf-8");
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(chrome, [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        `--print-to-pdf=${pdfPath}`,
        "--print-to-pdf-no-header",
        `--virtual-time-budget=5000`,
        tempHtml,
      ], { stdio: "ignore" });
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Chrome exited ${code}`))));
      proc.on("error", reject);
      setTimeout(() => { proc.kill(); reject(new Error("Chrome PDF timeout")); }, 20000);
    });
    return fs.existsSync(pdfPath) ? pdfPath : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(tempHtml, { force: true });
  }
}

interface EnrichedKeyword {
  keyword: string;
  searches: string;
  competition: string;
  source: "pinterest" | "dataforseo" | "google-suggest" | "estimated";
}

/**
 * Google Suggest / Autocomplete (free, no API key).
 * Returns related keyword suggestions with a relative popularity tier.
 * The `relevance` score from Chrome client is a rough proxy for interest.
 */
async function fetchGoogleSuggestKeywords(
  query: string,
): Promise<{ suggestions: string[]; relativePopularity: Map<string, "High" | "Medium" | "Low"> }> {
  const relativePopularity = new Map<string, "High" | "Medium" | "Low">();
  try {
    const url = `https://www.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) return { suggestions: [], relativePopularity };
    // Response format: ["query", ["suggestion1", "suggestion2", ...], [], [], {"google:suggestrelevance":[801,600,...]}]
    const data = (await res.json()) as unknown[];
    const suggestions = (data[1] as string[]) ?? [];
    const meta = data[4] as Record<string, unknown> | undefined;
    const relevances = (meta?.["google:suggestrelevance"] as number[]) ?? [];

    for (let i = 0; i < suggestions.length; i++) {
      const rel = relevances[i] ?? 0;
      const tier = rel >= 800 ? "High" : rel >= 500 ? "Medium" : "Low";
      relativePopularity.set(suggestions[i].toLowerCase(), tier);
    }
    return { suggestions, relativePopularity };
  } catch {
    return { suggestions: [], relativePopularity };
  }
}

/**
 * DataForSEO keyword search volume (optional, paid).
 * Requires DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD env vars.
 * Returns real Google Ads search volume + competition data.
 */
async function fetchDataForSeoKeywordMetrics(
  keywords: string[],
  locationCode = 2840, // US
): Promise<EnrichedKeyword[] | null> {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return null;

  try {
    const res = await fetch(
      "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([{ keywords, location_code: locationCode, language_code: "en" }]),
      },
    );
    if (!res.ok) {
      console.warn(`[pinterest-seo] DataForSEO HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }
    const data = (await res.json()) as {
      tasks?: Array<{
        result?: Array<{
          keyword: string;
          search_volume: number | null;
          competition: string | null;
          competition_index: number | null;
        }>;
      }>;
    };
    const results = data.tasks?.[0]?.result;
    if (!results?.length) {
      console.warn("[pinterest-seo] DataForSEO returned no results for keywords:", keywords.join(", "));
      return null;
    }

    return results.map((r) => ({
      keyword: r.keyword,
      searches: r.search_volume != null ? r.search_volume.toLocaleString() : "—",
      competition: r.competition ?? "—",
      source: "dataforseo" as const,
    }));
  } catch (err) {
    console.warn("[pinterest-seo] DataForSEO request failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Enriched keyword pipeline: tries Pinterest API → DataForSEO → Google Suggest.
 * Returns the best available data for each keyword with source attribution.
 */
async function enrichKeywordMetrics(
  keywords: string[],
  pinterestToken: string,
  region: string,
): Promise<{ keywords: EnrichedKeyword[]; diagnosticNote: string }> {
  const adAccountId = process.env.PINTEREST_AD_ACCOUNT_ID;
  const enriched: EnrichedKeyword[] = [];
  const diagnostics: string[] = [];

  // 1. Try Pinterest Ads keyword metrics
  if (adAccountId) {
    const params = new URLSearchParams();
    params.set("country_code", region);
    params.set("keywords", keywords.join(","));
    const result = await pinterestApiFetch(
      `/ad_accounts/${encodeURIComponent(adAccountId)}/keywords/metrics`,
      pinterestToken,
      params,
    );
    if (!result.isError) {
      const kwData = JSON.parse(result.text) as { data?: Array<Record<string, unknown>> };
      const items = kwData.data ?? [];
      for (const item of items) {
        const metrics = item.metrics as Record<string, unknown> | undefined;
        // Pinterest API returns KEYWORD_QUERY_VOLUME (e.g. "10K-100K"), not monthly_search
        const vol =
          metrics?.KEYWORD_QUERY_VOLUME ??
          metrics?.monthly_search ??
          metrics?.search_volume;
        const comp = metrics?.competition ?? metrics?.COMPETITION;
        if (vol != null) {
          enriched.push({
            keyword: String(item.keyword ?? "—"),
            searches: String(vol),
            competition: comp != null ? String(comp) : "—",
            source: "pinterest",
          });
        }
      }
      if (items.length === 0) {
        diagnostics.push("Pinterest Ads API returned no keyword data for these terms");
      } else if (enriched.length === 0) {
        diagnostics.push("Pinterest Ads API returned keywords but with null metrics (ad account may lack campaign history)");
      }
    } else {
      diagnostics.push(`Pinterest Ads keyword API error: ${result.text.slice(0, 200)}`);
    }
  } else {
    diagnostics.push("PINTEREST_AD_ACCOUNT_ID not configured — skipping Pinterest keyword metrics");
  }

  // Identify which keywords still need data
  const coveredKeywords = new Set(enriched.map((e) => e.keyword.toLowerCase()));
  const uncovered = keywords.filter((k) => !coveredKeywords.has(k.toLowerCase()));

  // 2. Try DataForSEO for uncovered keywords (optional, paid)
  if (uncovered.length > 0) {
    const dfResults = await fetchDataForSeoKeywordMetrics(uncovered);
    if (dfResults === null && process.env.DATAFORSEO_LOGIN) {
      diagnostics.push("DataForSEO API returned no data — check credentials or account status");
    }
    if (dfResults) {
      for (const r of dfResults) {
        if (r.searches !== "—" || r.competition !== "—") {
          enriched.push(r);
          coveredKeywords.add(r.keyword.toLowerCase());
        }
      }
      diagnostics.push(`DataForSEO provided data for ${dfResults.filter((r) => r.searches !== "—").length}/${uncovered.length} keywords`);
    }
  }

  // 3. Google Suggest fallback for any remaining uncovered keywords
  const stillUncovered = keywords.filter((k) => !coveredKeywords.has(k.toLowerCase()));
  if (stillUncovered.length > 0) {
    // Fetch suggestions for the primary query to get relevance data
    const primaryQuery = keywords[0];
    const { relativePopularity } = await fetchGoogleSuggestKeywords(primaryQuery);

    for (const kw of stillUncovered) {
      const tier = relativePopularity.get(kw.toLowerCase());
      enriched.push({
        keyword: kw,
        searches: tier ? `${tier} (estimated)` : "~Popular (in Google Suggest)" ,
        competition: "—",
        source: tier ? "google-suggest" : "estimated",
      });
    }
    if (!relativePopularity.size) {
      // Also try individual keyword lookups for tier data
      for (const kw of stillUncovered) {
        const { suggestions } = await fetchGoogleSuggestKeywords(kw);
        const idx = enriched.findIndex((e) => e.keyword.toLowerCase() === kw.toLowerCase());
        if (idx !== -1 && suggestions.length > 0) {
          enriched[idx].searches = suggestions.length >= 8 ? "High (estimated)" : suggestions.length >= 4 ? "Medium (estimated)" : "Low (estimated)";
          enriched[idx].source = "google-suggest";
        }
      }
    }
    diagnostics.push(`Google Suggest provided estimated data for ${stillUncovered.length} keywords`);
  }

  // Build diagnostic note
  let diagnosticNote = "";
  if (diagnostics.length > 0) {
    diagnosticNote = `\n> **Keyword Data Sources:** ${diagnostics.join("; ")}`;
    if (enriched.some((e) => e.source !== "pinterest" && e.source !== "dataforseo")) {
      diagnosticNote += `\n> _Tip: For accurate search volume data, configure DataForSEO credentials (DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD) or ensure your Pinterest ad account has active campaigns._`;
    }
  }

  return { keywords: enriched, diagnosticNote };
}

// ── Markdown formatters ─────────────────────────────────────────────────────

function formatPct(val: unknown): string {
  if (val == null || val === "—") return "—";
  const n = Number(val);
  if (isNaN(n)) return String(val);
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
}

function formatTrendsMarkdown(data: Record<string, unknown>): string {
  const trends = (data as { trends?: Array<Record<string, unknown>> }).trends ?? [];

  // Build structured data for UI consumption
  const structured = trends.map((t, i) => {
    const timeSeries = t.time_series as Record<string, unknown> | undefined;
    return {
      rank: i + 1,
      keyword: String(t.keyword ?? t.query ?? "—"),
      wow: timeSeries?.weekly_change ?? t.wow_change ?? null,
      mom: timeSeries?.monthly_change ?? t.mom_change ?? null,
      yoy: timeSeries?.yearly_change ?? t.yoy_change ?? null,
    };
  });

  const lines: string[] = [
    `# Pinterest Trends Report`,
    ``,
    `**Generated:** ${new Date().toISOString()}`,
    `**Keywords returned:** ${trends.length}`,
    ``,
  ];

  // Top 10 highlights
  if (structured.length > 0) {
    const topGrowing = [...structured].filter(t => t.yoy != null).sort((a, b) => Number(b.yoy ?? 0) - Number(a.yoy ?? 0)).slice(0, 5);
    if (topGrowing.length > 0) {
      lines.push(`## Top Growing (YoY)`, ``);
      for (const t of topGrowing) {
        lines.push(`- **${t.keyword}** — YoY: ${formatPct(t.yoy)}, MoM: ${formatPct(t.mom)}, WoW: ${formatPct(t.wow)}`);
      }
      lines.push(``);
    }
  }

  lines.push(`## All Trending Keywords`, ``);
  lines.push(`| # | Keyword | WoW | MoM | YoY |`);
  lines.push(`|---|---------|-----|-----|-----|`);
  for (const t of structured) {
    lines.push(`| ${t.rank} | ${t.keyword} | ${formatPct(t.wow)} | ${formatPct(t.mom)} | ${formatPct(t.yoy)} |`);
  }

  if (trends.length === 0) {
    lines.push(``, `_No trending keywords returned._`);
  }

  lines.push(``, `---`, ``, `<details>`, `<summary>Raw API Response</summary>`, ``, "```json", JSON.stringify(data, null, 2), "```", ``, `</details>`);
  return lines.join("\n");
}

function formatEnrichedKeywordMetricsMarkdown(
  enrichedKws: EnrichedKeyword[],
  originalKeywords: string[],
  diagnosticNote: string,
): string {
  const lines: string[] = [
    `# Pinterest Keyword Metrics Report`,
    ``,
    `**Generated:** ${new Date().toISOString()}`,
    `**Keywords queried:** ${originalKeywords.join(", ")}`,
    `**Results returned:** ${enrichedKws.length}`,
    ``,
  ];

  if (diagnosticNote) {
    lines.push(diagnosticNote, ``);
  }

  lines.push(
    `## Keyword Metrics`,
    ``,
    `| Keyword | Monthly Searches | Competition | Source |`,
    `|---------|-----------------|-------------|--------|`,
  );

  for (const kw of enrichedKws) {
    const sourceLabel =
      kw.source === "pinterest" ? "📌 Pinterest Ads" :
      kw.source === "dataforseo" ? "📊 DataForSEO" :
      kw.source === "google-suggest" ? "🔍 Google Suggest" :
      "⚡ Estimated";
    lines.push(`| ${kw.keyword} | ${kw.searches} | ${kw.competition} | ${sourceLabel} |`);
  }

  if (enrichedKws.length === 0) {
    lines.push(``, `_No keyword data available from any source._`);
  }

  lines.push(``, `---`, ``, `<details>`, `<summary>Raw Data</summary>`, ``, "```json", JSON.stringify(enrichedKws, null, 2), "```", ``, `</details>`);
  return lines.join("\n");
}

function formatAnalyticsMarkdown(data: Record<string, unknown>, action: string): string {
  const lines: string[] = [
    `# Pinterest Analytics Report`,
    ``,
    `**Generated:** ${new Date().toISOString()}`,
    `**Action:** ${action}`,
    ``,
  ];

  if (action === "account_summary") {
    const allData = data.all as Record<string, unknown> | undefined;
    const summary = (allData?.summary_metrics ?? data.summary_metrics ?? data) as Record<string, unknown>;

    // Summary totals at the top
    lines.push(`## Summary Totals`, ``);
    lines.push(`| Metric | Total |`);
    lines.push(`|--------|-------|`);
    for (const [k, v] of Object.entries(summary)) {
      lines.push(`| ${k.replace(/_/g, " ")} | **${v}** |`);
    }
    lines.push(``);

    const dailyMetrics = (allData?.daily_metrics ?? data.daily_metrics) as Array<Record<string, unknown>> | undefined;
    if (dailyMetrics && Array.isArray(dailyMetrics)) {
      // Filter to only days with activity
      const activeDays = dailyMetrics.filter((day) => {
        const m = day.metrics as Record<string, unknown> | undefined;
        if (!m) return false;
        return Object.values(m).some((v) => typeof v === "number" && v > 0);
      });

      if (activeDays.length > 0) {
        lines.push(`## Daily Breakdown (days with activity)`, ``);
        lines.push(`| Date | Impressions | Saves | Pin Clicks | Engagement |`);
        lines.push(`|------|------------|-------|-----------|-----------|`);
        for (const day of activeDays) {
          const metrics = day.metrics as Record<string, unknown> | undefined;
          lines.push(`| ${day.date ?? "—"} | ${metrics?.IMPRESSION ?? 0} | ${metrics?.SAVE ?? 0} | ${metrics?.PIN_CLICK ?? 0} | ${metrics?.ENGAGEMENT ?? 0} |`);
        }
      } else {
        lines.push(`_No days with activity in this date range._`);
      }
    }
  } else {
    lines.push(`## Top Pins`, ``);
    const pinsData = (data as Record<string, unknown>).pins as Record<string, unknown>[] | undefined;
    const pins = Array.isArray(data) ? data : pinsData ?? [];
    if (Array.isArray(pins) && pins.length > 0) {
      lines.push(`| # | Pin ID | Impressions | Saves | Clicks |`);
      lines.push(`|---|--------|------------|-------|--------|`);
      for (let i = 0; i < pins.length; i++) {
        const pin = pins[i] as Record<string, unknown>;
        const metrics = pin.metrics as Record<string, unknown> | undefined;
        const pinId = pin.pin_id ?? pin.id ?? "—";
        lines.push(`| ${i + 1} | ${pinId} | ${metrics?.IMPRESSION ?? 0} | ${metrics?.SAVE ?? 0} | ${metrics?.PIN_CLICK ?? 0} |`);
      }
    } else {
      lines.push(`_No pins found with metrics in this date range._`);
    }
  }

  lines.push(``, `---`, ``, `<details>`, `<summary>Raw API Response</summary>`, ``, "```json", JSON.stringify(data, null, 2), "```", ``, `</details>`);
  return lines.join("\n");
}

function formatSeoAnalysisMarkdown(
  results: PinAnalysis | PinAnalysis[],
  keywordData?: { keywords: EnrichedKeyword[]; diagnosticNote: string },
): string {
  const items = Array.isArray(results) ? results : [results];
  const lines: string[] = [
    `# Pinterest SEO Analysis Report`,
    ``,
    `**Generated:** ${new Date().toISOString()}`,
    `**Pins analyzed:** ${items.length}`,
    ``,
  ];

  for (const pin of items) {
    lines.push(`## Pin: [${pin.pin_id}](${pin.pin_url})`);
    lines.push(``);
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| **Title** | ${pin.title ?? "—"} |`);
    lines.push(`| **Pin URL** | [View on Pinterest](${pin.pin_url}) |`);
    lines.push(`| **Description** | ${pin.description?.slice(0, 200) ?? "—"} |`);
    lines.push(`| **Link** | ${pin.link ?? "—"} |`);
    lines.push(`| **Media Type** | ${pin.media_type ?? "—"} |`);
    if (pin.api_data_available || pin.html_data_available) {
      lines.push(`| **Pin Score** | **${pin.pin_score}/100** ${pin.pin_score >= 70 ? "✅" : pin.pin_score >= 40 ? "⚠️" : "❌"} |`);
    } else {
      lines.push(`| **Pin Score** | N/A (no API or HTML data retrieved) |`);
    }
    lines.push(`| **Data Source** | ${pin.api_data_available ? "API" : pin.html_data_available ? "HTML scrape" : "None"} |`);

    if (pin.annotations.length > 0) {
      lines.push(`| **Annotations** | ${pin.annotations.join(", ")} |`);
    } else {
      lines.push(`| **Annotations** | None found |`);
    }
    lines.push(``);

    // Pin metrics (90d/lifetime) if available
    if (pin.pin_metrics) {
      const metrics90d = pin.pin_metrics["90d"] as Record<string, unknown> | undefined;
      const lifetime = pin.pin_metrics.lifetime_metrics as Record<string, unknown> | undefined;
      if (metrics90d || lifetime) {
        lines.push(`### Performance Metrics`);
        lines.push(``);
        lines.push(`| Metric | 90-Day | Lifetime |`);
        lines.push(`|--------|--------|----------|`);
        const metricKeys = ["impression", "pin_click", "clickthrough", "save", "reaction", "comment"];
        for (const k of metricKeys) {
          const d90 = metrics90d?.[k] ?? "—";
          const lt = lifetime?.[k] ?? "—";
          if (d90 !== "—" || lt !== "—") {
            lines.push(`| ${k.replace(/_/g, " ")} | ${d90} | ${lt} |`);
          }
        }
        lines.push(``);
      }
    }

    if (pin.seo_recommendations.length > 0) {
      lines.push(`### Recommendations`);
      lines.push(``);
      for (const rec of pin.seo_recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push(``);
    }
  }

  // Keyword Opportunities section (from enrichment pipeline)
  if (keywordData && keywordData.keywords.length > 0) {
    lines.push(`## Keyword Opportunities`, ``);
    if (keywordData.diagnosticNote) {
      lines.push(keywordData.diagnosticNote, ``);
    }
    lines.push(
      `| Keyword | Monthly Searches | Competition | Source |`,
      `|---------|-----------------|-------------|--------|`,
    );
    for (const kw of keywordData.keywords) {
      const sourceLabel =
        kw.source === "pinterest" ? "📌 Pinterest Ads" :
        kw.source === "dataforseo" ? "📊 DataForSEO" :
        kw.source === "google-suggest" ? "🔍 Google Suggest" :
        "⚡ Estimated";
      lines.push(`| ${kw.keyword} | ${kw.searches} | ${kw.competition} | ${sourceLabel} |`);
    }
    lines.push(``);
  }

  lines.push(`---`, ``, `<details>`, `<summary>Raw JSON Data</summary>`, ``, "```json", JSON.stringify(items, null, 2), "```", ``, `</details>`);
  return lines.join("\n");
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
    const propNames = ["og:interest", "article:tag", "pinterest:interest"];
    for (const propName of propNames) {
      // Order 1: property/name first
      const r1 = new RegExp(
        `<meta\\s+(?:property|name)="${propName}"[^>]*?content="([^"]+)"`, "gi"
      );
      let m: RegExpExecArray | null;
      while ((m = r1.exec(html)) !== null) {
        if (m[1]) annotations.push(m[1]);
      }
      // Order 2: content first
      const r2 = new RegExp(
        `<meta\\s+content="([^"]+)"[^>]*?(?:property|name)="${propName}"`, "gi"
      );
      while ((m = r2.exec(html)) !== null) {
        if (m[1]) annotations.push(m[1]);
      }
    }
    return [...new Set(annotations)];
  },
};

/** Strategy 4: Extract annotations from og:title pipe-separated keywords.
 *  Pinterest embeds annotation keywords in og:title: "Pin Title | Keyword1, Keyword2, ..." */
const extractFromOgTitle: AnnotationStrategy = {
  name: "og-title",
  extract: (html: string) => {
    // Handle both attribute orders
    const r1 = html.match(/<meta\s+(?:property|name)="og:title"[^>]*?content="([^"]+)"/i);
    const r2 = html.match(/<meta\s+content="([^"]+)"[^>]*?(?:property|name)="og:title"/i);
    const title = r1?.[1] ?? r2?.[1];
    if (!title) return [];
    const pipeIdx = title.lastIndexOf("|");
    if (pipeIdx < 0) return [];
    const suffix = title.slice(pipeIdx + 1).trim();
    if (!suffix) return [];
    // Split on comma, clean up HTML entities and whitespace
    return suffix
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'")
      .split(/,/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && s.length <= 60);
  },
};

/** Strategy 5: Extract interest categories from Pinterest /ideas/ breadcrumb URLs.
 *  Pinterest exposes the interest category in breadcrumb links like:
 *  <a href="/ideas/diy-and-crafts/934876475639/">DIY And Crafts</a>
 *  This works even on unauthenticated pages where other strategies fail. */
const extractFromIdeaUrls: AnnotationStrategy = {
  name: "idea-urls",
  extract: (html: string) => {
    const seen = new Set<string>();
    const annotations: string[] = [];
    // Match /ideas/{category-slug}/{numeric-id}/
    const regex = /href="\/ideas\/([a-z0-9]+(?:-[a-z0-9]+)*)\/\d+\//g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(html)) !== null) {
      const slug = m[1];
      if (!seen.has(slug)) {
        seen.add(slug);
        // Convert slug to readable name: "diy-and-crafts" → "DIY And Crafts"
        const name = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        annotations.push(name);
      }
    }
    return annotations;
  },
};

const ANNOTATION_STRATEGIES: AnnotationStrategy[] = [
  extractFromPwsData,
  extractFromScriptTags,
  extractFromMetaTags,
  extractFromOgTitle,
  extractFromIdeaUrls,
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

// ── Pin Insights formatter ──────────────────────────────────────────────────

interface InsightsData {
  query: string;
  region: string;
  trends?: { keyword: string; wow: string; mom: string; yoy: string }[];
  keywords?: { keyword: string; searches: string; competition: string }[];
  keywordDiagnosticNote?: string;
  pinAnalyses?: PinAnalysis[];
}

function formatPinInsightsMarkdown(insights: InsightsData): string {
  const lines: string[] = [
    `# Pinterest Pin Insights: "${insights.query}"`,
    ``,
    `**Generated:** ${new Date().toISOString()}`,
    `**Region:** ${insights.region}`,
    ``,
  ];

  // Trend data
  if (insights.trends && insights.trends.length > 0) {
    lines.push(`## Trending Keywords`, ``);
    lines.push(`These keywords are currently trending on Pinterest and related to your query.`);
    lines.push(`Use these in your pin titles, descriptions, and hashtags for maximum reach.`, ``);
    lines.push(`| Keyword | WoW Growth | MoM Growth | YoY Growth |`);
    lines.push(`|---------|-----------|-----------|-----------|`);
    for (const t of insights.trends) {
      lines.push(`| ${t.keyword} | ${t.wow} | ${t.mom} | ${t.yoy} |`);
    }
    lines.push(``);
  }

  // Keyword metrics
  if (insights.keywords && insights.keywords.length > 0) {
    lines.push(`## Keyword Search Volume & Competition`, ``);
    lines.push(`How many people search for these terms monthly and how competitive they are.`, ``);
    if (insights.keywordDiagnosticNote) {
      lines.push(insights.keywordDiagnosticNote, ``);
    }
    lines.push(`| Keyword | Monthly Searches | Competition |`);
    lines.push(`|---------|-----------------|-------------|`);
    for (const k of insights.keywords) {
      lines.push(`| ${k.keyword} | ${k.searches} | ${k.competition} |`);
    }
    lines.push(``);
  }

  // Pin analyses
  if (insights.pinAnalyses && insights.pinAnalyses.length > 0) {
    lines.push(`## Pin Analysis`, ``);
    lines.push(`Detailed analysis of pins with SEO scoring and recommendations.`, ``);

    for (const pin of insights.pinAnalyses) {
      const scoreEmoji = pin.pin_score >= 70 ? "✅" : pin.pin_score >= 40 ? "⚠️" : "❌";
      lines.push(`### Pin ${pin.pin_id}`);
      lines.push(``);
      lines.push(`| Field | Value |`);
      lines.push(`|-------|-------|`);
      lines.push(`| **Title** | ${pin.title ?? "—"} |`);
      lines.push(`| **Description** | ${(pin.description ?? "—").slice(0, 150)}${(pin.description?.length ?? 0) > 150 ? "..." : ""} |`);
      lines.push(`| **Link** | ${pin.link ?? "—"} |`);
      lines.push(`| **Pin Score** | **${pin.pin_score}/100** ${scoreEmoji} |`);
      lines.push(`| **Annotations** | ${pin.annotations.length > 0 ? pin.annotations.join(", ") : "None"} |`);
      lines.push(`| **Data Source** | ${pin.api_data_available ? "API" : pin.html_data_available ? "HTML" : "None"} |`);
      lines.push(``);

      if (pin.pin_metrics) {
        const lifetime = pin.pin_metrics.lifetime_metrics as Record<string, unknown> | undefined;
        if (lifetime) {
          lines.push(`**Lifetime Metrics:** Impressions: ${lifetime.impression ?? 0} | Saves: ${lifetime.save ?? 0} | Clicks: ${lifetime.pin_click ?? 0} | Reactions: ${lifetime.reaction ?? 0}`);
          lines.push(``);
        }
      }

      if (pin.seo_recommendations.length > 0) {
        lines.push(`**Recommendations:**`);
        for (const rec of pin.seo_recommendations) {
          lines.push(`- ${rec}`);
        }
        lines.push(``);
      }
    }
  }

  // Action items
  lines.push(`## How to Create a Winning Pin for This Topic`, ``);
  lines.push(`1. **Title**: Include the top-trending keyword in the first 40 characters`);
  if (insights.trends && insights.trends.length > 0) {
    lines.push(`   - Try: "${insights.trends[0].keyword}" or a variation`);
  }
  lines.push(`2. **Description**: Write 100–500 chars with 2–4 related keywords naturally integrated`);
  lines.push(`3. **Hashtags**: Add 3–5 relevant hashtags from the trending keywords`);
  lines.push(`4. **Image**: Use a 2:3 vertical image (1000x1500px) with clear, bright visuals`);
  lines.push(`5. **Alt Text**: Describe the image using keywords for accessibility and SEO`);
  lines.push(`6. **Link**: Point to your website or landing page`);
  lines.push(`7. **Timing**: Post during peak hours (2-4 PM, 8-11 PM) for your audience's timezone`);
  lines.push(``);

  return lines.join("\n");
}

// ── Board & Discovery helpers ───────────────────────────────────────────────

/** Extract pin IDs from a Pinterest board page HTML (SSR-rendered). */
function extractPinIdsFromBoardHtml(html: string): string[] {
  const ids = new Set<string>();
  const regex = /\/pin\/(\d{10,25})/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    ids.add(m[1]);
  }
  return [...ids];
}

/** Fetch a board page and extract pin IDs from SSR-rendered HTML. */
async function discoverPinsFromBoard(boardUrl: string): Promise<string[]> {
  try {
    const url = boardUrl.startsWith("http") ? boardUrl : `https://www.pinterest.com${boardUrl}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    return extractPinIdsFromBoardHtml(html);
  } catch {
    return [];
  }
}

/** Extract board URL from a pin's HTML page via pinterestapp:pinboard meta tag. */
function extractBoardUrlFromPinHtml(html: string): string | null {
  // Handle both attribute orders: property then content, or content then property
  const r1 = html.match(/<meta\s+(?:property|name)="pinterestapp:pinboard"[^>]*?content="([^"]+)"/i);
  if (r1?.[1]) return r1[1];
  const r2 = html.match(/<meta\s+content="([^"]+)"[^>]*?(?:property|name)="pinterestapp:pinboard"/i);
  return r2?.[1] ?? null;
}

/** Fetch a pin page and extract its board URL + basic metadata. */
async function fetchPinPageData(pinId: string): Promise<{
  html: string;
  boardUrl: string | null;
  metadata: Record<string, unknown> | null;
  annotations: string[];
} | null> {
  try {
    const pinUrl = `https://www.pinterest.com/pin/${encodeURIComponent(pinId)}/`;
    const res = await fetch(pinUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return {
      html,
      boardUrl: extractBoardUrlFromPinHtml(html),
      metadata: extractMetadataFromHtml(html),
      annotations: extractAnnotationsFromHtml(html),
    };
  } catch {
    return null;
  }
}

// ── Search results types & formatter ────────────────────────────────────────

interface DiscoveredPin {
  pin_id: string;
  title: string | null;
  description: string | null;
  link: string | null;
  image_url: string | null;
  repins: number | null;
  pinner_url: string | null;
  board_url: string | null;
  annotations: string[];
  pin_score: number;
  seo_recommendations: string[];
  source: "seed" | "board_discovery";
}

interface SearchPinsResult {
  query: string;
  region: string;
  discovered_pins: DiscoveredPin[];
  trends?: { keyword: string; wow: string; mom: string; yoy: string }[];
  keywords?: { keyword: string; searches: string; competition: string }[];
  boards_scraped: string[];
}

function formatSearchPinsMarkdown(result: SearchPinsResult): string {
  const lines: string[] = [
    `# Pinterest Competitive Pin Research: "${result.query}"`,
    ``,
    `**Generated:** ${new Date().toISOString()}`,
    `**Region:** ${result.region}`,
    `**Pins analyzed:** ${result.discovered_pins.length}`,
    `**Boards discovered:** ${result.boards_scraped.length}`,
    ``,
  ];

  // Executive Summary
  const avgScore = result.discovered_pins.length > 0
    ? Math.round(result.discovered_pins.reduce((s, p) => s + p.pin_score, 0) / result.discovered_pins.length)
    : 0;
  const topPin = [...result.discovered_pins].sort((a, b) => (b.repins ?? 0) - (a.repins ?? 0))[0];
  const allAnnotations = new Set(result.discovered_pins.flatMap((p) => p.annotations));

  lines.push(`## Executive Summary`, ``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| **Average Pin Score** | ${avgScore}/100 ${avgScore >= 70 ? "✅" : avgScore >= 40 ? "⚠️" : "❌"} |`);
  lines.push(`| **Total Pins Analyzed** | ${result.discovered_pins.length} |`);
  lines.push(`| **Unique Annotations Found** | ${allAnnotations.size} |`);
  if (topPin) {
    lines.push(`| **Most Saved Pin** | ${topPin.title?.slice(0, 50) ?? topPin.pin_id}${topPin.repins != null ? ` (${topPin.repins.toLocaleString()} saves)` : ""} |`);
  }
  lines.push(``);

  // Annotation keyword cloud
  if (allAnnotations.size > 0) {
    lines.push(`## Annotation Keywords (Pinterest's Algorithm Tags)`, ``);
    lines.push(`These are the keywords Pinterest's algorithm associates with top pins for this topic.`);
    lines.push(`**Include these in your pin titles, descriptions, and alt text for maximum distribution.**`, ``);
    const sortedAnnotations = [...allAnnotations].sort();
    lines.push(sortedAnnotations.map((a) => `\`${a}\``).join(" · "));
    lines.push(``);
  }

  // Trend data
  if (result.trends && result.trends.length > 0) {
    lines.push(`## Trending Keywords`, ``);
    lines.push(`| Keyword | WoW | MoM | YoY |`);
    lines.push(`|---------|-----|-----|-----|`);
    for (const t of result.trends.slice(0, 10)) {
      lines.push(`| ${t.keyword} | ${t.wow} | ${t.mom} | ${t.yoy} |`);
    }
    lines.push(``);
  }

  // Keyword metrics
  if (result.keywords && result.keywords.length > 0) {
    lines.push(`## Keyword Search Volume`, ``);
    lines.push(`| Keyword | Monthly Searches | Competition |`);
    lines.push(`|---------|-----------------|-------------|`);
    for (const k of result.keywords) {
      lines.push(`| ${k.keyword} | ${k.searches} | ${k.competition} |`);
    }
    lines.push(``);
  }

  // Pin comparison table
  if (result.discovered_pins.length > 0) {
    const sorted = [...result.discovered_pins].sort((a, b) => (b.repins ?? 0) - (a.repins ?? 0));
    lines.push(`## Competitor Pin Analysis`, ``);
    lines.push(`Pins ranked by saves (engagement). Use these as benchmarks for your own pins.`, ``);
    lines.push(`| # | Pin | Score | Saves | Annotations | Source Link |`);
    lines.push(`|---|-----|-------|-------|-------------|-------------|`);
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const scoreEmoji = p.pin_score >= 70 ? "✅" : p.pin_score >= 40 ? "⚠️" : "❌";
      const title = (p.title ?? "Untitled").slice(0, 40) + ((p.title?.length ?? 0) > 40 ? "..." : "");
      const saves = p.repins != null ? p.repins.toLocaleString() : "—";
      const annCount = p.annotations.length;
      const sourceLink = p.link ? `[link](${p.link})` : "—";
      lines.push(`| ${i + 1} | [${title}](https://pinterest.com/pin/${p.pin_id}/) | ${p.pin_score} ${scoreEmoji} | ${saves} | ${annCount} | ${sourceLink} |`);
    }
    lines.push(``);

    // Detailed per-pin breakdown
    lines.push(`## Detailed Pin Breakdowns`, ``);
    for (const p of sorted) {
      const scoreEmoji = p.pin_score >= 70 ? "✅" : p.pin_score >= 40 ? "⚠️" : "❌";
      lines.push(`### ${p.title ?? `Pin ${p.pin_id}`}`);
      lines.push(``);
      lines.push(`| Field | Value |`);
      lines.push(`|-------|-------|`);
      lines.push(`| **Pin ID** | [${p.pin_id}](https://pinterest.com/pin/${p.pin_id}/) |`);
      lines.push(`| **Score** | ${p.pin_score}/100 ${scoreEmoji} |`);
      if (p.repins != null) lines.push(`| **Saves** | ${p.repins.toLocaleString()} |`);
      if (p.link) lines.push(`| **Source** | ${p.link} |`);
      if (p.annotations.length > 0) lines.push(`| **Annotations** | ${p.annotations.join(", ")} |`);
      lines.push(`| **Discovery** | ${p.source === "seed" ? "Provided" : "Board discovery"} |`);
      lines.push(``);
      if (p.seo_recommendations.length > 0) {
        lines.push(`**SEO Observations:**`);
        for (const r of p.seo_recommendations) lines.push(`- ${r}`);
        lines.push(``);
      }
    }
  }

  // Revenue-focused action plan
  lines.push(`## Revenue Action Plan`, ``);
  lines.push(`Based on the competitive analysis above:`, ``);
  lines.push(`### Content Gaps to Exploit`);
  if (allAnnotations.size > 0) {
    lines.push(`- Target these annotation keywords that top competitors use: **${[...allAnnotations].slice(0, 5).join(", ")}**`);
  }
  lines.push(`- Create pins with better SEO scores than the average (${avgScore}/100)`);
  lines.push(``);
  lines.push(`### Pin Creation Checklist`);
  lines.push(`1. **Title**: Include "${result.query}" + top annotation keyword in first 40 chars`);
  lines.push(`2. **Description**: 200-300 chars with 3-4 annotation keywords from the list above`);
  lines.push(`3. **Image**: 2:3 vertical (1000x1500px), clear, bright, text overlay with keyword`);
  lines.push(`4. **Link**: Point to your landing page or blog post for traffic generation`);
  lines.push(`5. **Alt text**: Describe image with keywords for accessibility + SEO boost`);
  lines.push(``);
  lines.push(`### Traffic Generation Strategy`);
  lines.push(`1. Create 3-5 pin variations targeting different annotation keywords`);
  lines.push(`2. Pin to a topically relevant board (or create one named after the top keyword)`);
  lines.push(`3. Schedule pins during peak hours (2-4 PM, 8-11 PM in target timezone)`);
  lines.push(`4. Repin weekly to maintain algorithmic freshness`);
  lines.push(`5. Monitor with \`pinterest-analytics\` after 7 days to identify winners`);
  lines.push(``);

  return lines.join("\n");
}

// ── Tool Factory ────────────────────────────────────────────────────────────

export function createPinterestSeoTools(): ToolDefinition[] {
  return [
    // ── pinterest-list-boards ─────────────────────────────────────────
    {
      name: "pinterest-list-boards",
      description:
        "List all Pinterest boards for the authenticated user. Returns board IDs, names, " +
        "descriptions, pin counts, and privacy settings. Use this to find the board_id " +
        "needed for creating pins with pinterest-create-pin.",
      inputSchema: { type: "object", properties: {} },
      zodSchema: z.object({}),
      category: "social",
      riskLevel: "low",
      source: "pinterest",
      handler: async () => {
        const token = getToken();
        if (!token) return { text: "PINTEREST_ACCESS_TOKEN not configured.", isError: true };

        const result = await pinterestApiFetch("/boards", token, new URLSearchParams({ page_size: "100" }));
        if (result.isError) return result;

        const data = JSON.parse(result.text) as { items?: Array<Record<string, unknown>> };
        const boards = data.items ?? [];
        if (boards.length === 0) {
          return { text: "No boards found. Create a board first on Pinterest or use the API." };
        }

        const lines = [
          `# Your Pinterest Boards`,
          ``,
          `| Board ID | Name | Pins | Privacy | Description |`,
          `|----------|------|------|---------|-------------|`,
        ];
        for (const b of boards) {
          lines.push(`| ${b.id} | ${b.name} | ${b.pin_count ?? 0} | ${b.privacy ?? "PUBLIC"} | ${String(b.description ?? "—").slice(0, 60)} |`);
        }
        lines.push(``, `_${boards.length} boards found_`);
        return { text: lines.join("\n") };
      },
    },

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
            enum: ["growing", "monthly", "seasonal", "yearly"],
            description:
              "Trend type: growing (fastest rising), monthly/seasonal/yearly (top by period)",
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

        const result = await pinterestApiFetch(
          `/trends/keywords/${encodeURIComponent(input.region)}/top/${encodeURIComponent(input.trend_type)}`,
          token,
          params,
        );

        if (result.isError) return result;

        const data = JSON.parse(result.text);
        const md = formatTrendsMarkdown(data);
        const ts = timestamp();
        const baseName = `trends-${input.region}-${input.trend_type}-${ts}`;
        const filePath = saveReport(`${baseName}.md`, md);
        saveReportJson(baseName, { type: "trends", region: input.region, trend_type: input.trend_type, generated: new Date().toISOString(), data });
        const pdfPathTrends = await saveReportPdf(baseName, md);
        return { text: `${md}\n\n---\n_Report saved to ${filePath}${pdfPathTrends ? ` · PDF: ${pdfPathTrends}` : ""}_` };
      },
    },

    // ── pinterest-keyword-metrics ─────────────────────────────────────
    {
      name: "pinterest-keyword-metrics",
      description:
        "Get keyword search volume and competition metrics from multiple sources. " +
        "Tries Pinterest Ads API first, then DataForSEO (if configured), and falls back to Google Suggest for estimated popularity. " +
        "Returns monthly search volume, competition level, and data source attribution. " +
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

        // Use enriched keyword pipeline (Pinterest → DataForSEO → Google Suggest)
        const { keywords: enrichedKws, diagnosticNote } = await enrichKeywordMetrics(
          input.keywords,
          token,
          input.country,
        );

        const md = formatEnrichedKeywordMetricsMarkdown(enrichedKws, input.keywords, diagnosticNote);
        const slug = input.keywords.slice(0, 3).join("-").replace(/\s+/g, "-").toLowerCase();
        const ts = timestamp();
        const baseName = `keyword-metrics-${slug}-${ts}`;
        const filePath = saveReport(`${baseName}.md`, md);
        saveReportJson(baseName, { type: "keyword-metrics", keywords: input.keywords, country: input.country, generated: new Date().toISOString(), data: enrichedKws });
        const pdfPathKw = await saveReportPdf(baseName, md);
        return { text: `${md}\n\n---\n_Report saved to ${filePath}${pdfPathKw ? ` · PDF: ${pdfPathKw}` : ""}_` };
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

        return pinterestApiFetch(endpoint, token, params).then(async (result) => {
          if (result.isError) return result;
          const data = JSON.parse(result.text);
          const md = formatAnalyticsMarkdown(data, input.action);
          const ts = timestamp();
          const baseName = `analytics-${input.action}-${ts}`;
          const filePath = saveReport(`${baseName}.md`, md);
          saveReportJson(baseName, { type: "analytics", action: input.action, start_date: input.start_date, end_date: input.end_date, generated: new Date().toISOString(), data });
          const pdfPathAnalytics = await saveReportPdf(baseName, md);
          return { text: `${md}\n\n---\n_Report saved to ${filePath}${pdfPathAnalytics ? ` · PDF: ${pdfPathAnalytics}` : ""}_` };
        });
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

        const results: PinAnalysis[] = [];
        for (const pinId of pinIds) {
          const analysis = await analyzeSinglePin(pinId, token ?? undefined, {
            includeAnnotations: input.include_annotations,
          });
          results.push(analysis);
        }

        // Collect unique annotations across all analyzed pins for keyword enrichment
        const allAnnotations = [...new Set(results.flatMap((r) => r.annotations))];
        let keywordData: { keywords: EnrichedKeyword[]; diagnosticNote: string } | null = null;
        if (allAnnotations.length > 0 && token) {
          keywordData = await enrichKeywordMetrics(allAnnotations, token, "US");
        }

        const analysisData = results.length === 1 ? results[0] : results;
        const md = formatSeoAnalysisMarkdown(analysisData, keywordData ?? undefined);
        const ts = timestamp();
        const baseName = `seo-analysis-${pinIds[0]}-${ts}`;
        const filePath = saveReport(`${baseName}.md`, md);
        saveReportJson(baseName, { type: "seo-analysis", pin_ids: pinIds, generated: new Date().toISOString(), data: results, keywordMetrics: keywordData });
        const pdfPathSeo = await saveReportPdf(baseName, md);
        return { text: `${md}\n\n---\n_Report saved to ${filePath}${pdfPathSeo ? ` · PDF: ${pdfPathSeo}` : ""}_` };
      },
    },

    // ── pinterest-create-pin ────────────────────────────────────────────
    {
      name: "pinterest-create-pin",
      description:
        "Create a new pin on Pinterest with an image, title, description, link, and alt text. " +
        "Requires a board_id (use GET /v5/boards to list your boards first). " +
        "Provide either a public image_url or a local image_path (auto base64-encoded). " +
        "Tip: Use 2:3 vertical images (1000x1500px), keyword-rich titles (max 100 chars), " +
        "descriptions with 2-4 keywords and hashtags (100-500 chars), and alt text for SEO.",
      inputSchema: {
        type: "object",
        properties: {
          board_id: { type: "string", description: "Board ID to pin to" },
          title: { type: "string", description: "Pin title (max 100 chars)" },
          description: { type: "string", description: "Pin description with keywords and hashtags" },
          link: { type: "string", description: "Destination URL" },
          alt_text: { type: "string", description: "Alt text for accessibility and SEO" },
          image_url: { type: "string", description: "Public image URL to pin" },
          image_path: { type: "string", description: "Local image file path (base64 uploaded)" },
          board_section_id: { type: "string", description: "Board section ID" },
        },
        required: ["board_id", "title", "description"],
      },
      zodSchema: pinterestCreatePinSchema,
      category: "social",
      riskLevel: "medium",
      source: "pinterest",
      handler: async (args) => {
        const input = pinterestCreatePinSchema.parse(args);
        const token = getToken();
        if (!token) return { text: "PINTEREST_ACCESS_TOKEN not configured.", isError: true };

        // Build the pin payload
        const pin: Record<string, unknown> = {
          board_id: input.board_id,
          title: input.title,
          description: input.description,
        };
        if (input.link) pin.link = input.link;
        if (input.alt_text) pin.alt_text = input.alt_text;
        if (input.board_section_id) pin.board_section_id = input.board_section_id;

        // Handle image source
        if (input.image_path) {
          const absPath = path.resolve(input.image_path);
          if (!fs.existsSync(absPath)) {
            return { text: `Image file not found: ${absPath}`, isError: true };
          }
          const imgBuf = fs.readFileSync(absPath);
          const ext = path.extname(absPath).toLowerCase();
          const contentTypes: Record<string, string> = {
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".gif": "image/gif", ".webp": "image/webp",
          };
          const contentType = contentTypes[ext] ?? "image/png";
          pin.media_source = {
            source_type: "image_base64",
            content_type: contentType,
            data: imgBuf.toString("base64"),
          };
        } else if (input.image_url) {
          pin.media_source = {
            source_type: "image_url",
            url: input.image_url,
          };
        }

        const result = await pinterestApiPost("/pins", token, pin);
        if (result.isError) return result;

        const pinData = result.data!;
        const pinId = pinData.id as string;
        const pinUrl = `https://www.pinterest.com/pin/${pinId}/`;
        const images = (pinData.media as Record<string, unknown>)?.images as Record<string, Record<string, unknown>> | undefined;
        const thumbUrl = images?.["400x300"]?.url || images?.["600x"]?.url || "";

        const md = [
          `# Pin Created Successfully`,
          ``,
          `| Field | Value |`,
          `|-------|-------|`,
          `| **Pin ID** | ${pinId} |`,
          `| **URL** | ${pinUrl} |`,
          `| **Board** | ${pinData.board_id} |`,
          `| **Title** | ${pinData.title} |`,
          `| **Creative Type** | ${pinData.creative_type} |`,
          `| **Image** | ${thumbUrl} |`,
          ``,
          `**Next steps:** Pin will start appearing in feeds and search within 24 hours.`,
          `Use \`pinterest-seo-analyze\` with pin ID \`${pinId}\` to check annotations `,
          `once Pinterest has processed the image.`,
        ].join("\n");

        const ts = timestamp();
        const baseName = `pin-created-${pinId}-${ts}`;
        saveReport(`${baseName}.md`, md);
        saveReportJson(baseName, { type: "pin-created", pin_id: pinId, generated: new Date().toISOString(), data: pinData });
        return { text: `${md}\n\n---\n_Report saved to ${REPORTS_DIR}/${baseName}.md_` };
      },
    },

    // ── pinterest-pin-insights ──────────────────────────────────────────
    {
      name: "pinterest-pin-insights",
      description:
        "Comprehensive competitive research tool for Pinterest. Given a topic/subject, this tool: " +
        "(1) finds trending keywords related to it with growth rates, " +
        "(2) gets search volume and competition data for the query, " +
        "(3) optionally analyzes specific pins (yours or anyone's) with SEO scoring. " +
        "Use this to understand how a topic trends, what keywords to target, and how existing pins " +
        "perform. Great for planning new pins or benchmarking against competitors.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Topic to research (e.g., 'spring nails', 'AI tools')" },
          region: { type: "string", enum: [...PINTEREST_REGIONS], description: "Region for data" },
          pin_ids: { type: "array", items: { type: "string" }, description: "Pin IDs to analyze" },
          pin_urls: { type: "array", items: { type: "string" }, description: "Pinterest URLs to analyze" },
          include_keyword_metrics: { type: "boolean", description: "Include search volume data" },
          include_trend_data: { type: "boolean", description: "Include trend growth data" },
          include_pin_analysis: { type: "boolean", description: "Analyze provided pins" },
        },
        required: ["query"],
      },
      zodSchema: pinterestPinInsightsSchema,
      category: "social",
      riskLevel: "low",
      source: "pinterest",
      handler: async (args) => {
        const input = pinterestPinInsightsSchema.parse(args);
        const token = getToken();
        if (!token) return { text: "PINTEREST_ACCESS_TOKEN not configured.", isError: true };

        const insights: InsightsData = { query: input.query, region: input.region };

        // 1. Get trend data for related keywords
        if (input.include_trend_data) {
          const trendResult = await pinterestApiFetch(
            `/trends/keywords/${encodeURIComponent(input.region)}/top/growing`,
            token,
            new URLSearchParams({ limit: "25" }),
          );
          if (!trendResult.isError) {
            const trendData = JSON.parse(trendResult.text) as { trends?: Array<Record<string, unknown>> };
            const queryWords = input.query.toLowerCase().split(/\s+/);
            // Filter trends that match or relate to the query
            const allTrends = trendData.trends ?? [];
            const matchingTrends = allTrends.filter((t) => {
              const kw = String(t.keyword ?? "").toLowerCase();
              return queryWords.some((w) => kw.includes(w)) || kw.includes(input.query.toLowerCase());
            });
            // If no matching trends, show top trends as context
            const trendsToShow = matchingTrends.length > 0 ? matchingTrends.slice(0, 15) : allTrends.slice(0, 10);
            insights.trends = trendsToShow.map((t) => ({
              keyword: String(t.keyword ?? "—"),
              wow: formatPct(t.pct_growth_wow),
              mom: formatPct(t.pct_growth_mom),
              yoy: formatPct(t.pct_growth_yoy),
            }));
          }
        }

        // 2. Get keyword metrics for the query terms (enriched pipeline)
        if (input.include_keyword_metrics) {
          const queryKeywords = [input.query, ...input.query.split(/\s+/).filter((w) => w.length > 2)];
          const uniqueKeywords = [...new Set(queryKeywords)].slice(0, 10);
          const { keywords: enrichedKws, diagnosticNote } = await enrichKeywordMetrics(
            uniqueKeywords,
            token,
            input.region,
          );
          insights.keywords = enrichedKws.map((e) => ({
            keyword: e.keyword,
            searches: e.searches,
            competition: e.competition,
          }));
          insights.keywordDiagnosticNote = diagnosticNote;
        }

        // 3. Analyze specific pins if provided
        if (input.include_pin_analysis) {
          const pinIds: string[] = [...(input.pin_ids ?? [])];
          // Extract pin IDs from URLs
          if (input.pin_urls) {
            for (const url of input.pin_urls) {
              const id = extractPinIdFromUrl(url);
              if (id) pinIds.push(id);
            }
          }
          if (pinIds.length > 0) {
            const analyses: PinAnalysis[] = [];
            for (const pinId of [...new Set(pinIds)].slice(0, 10)) {
              const analysis = await analyzeSinglePin(pinId, token, { includeAnnotations: true });
              analyses.push(analysis);
            }
            insights.pinAnalyses = analyses;
          }
        }

        const md = formatPinInsightsMarkdown(insights);
        const ts = timestamp();
        const slug = input.query.replace(/\s+/g, "-").toLowerCase().slice(0, 30);
        const baseName = `pin-insights-${slug}-${ts}`;
        const filePath = saveReport(`${baseName}.md`, md);
        saveReportJson(baseName, { type: "pin-insights", ...insights, generated: new Date().toISOString() });
        const pdfPathInsights = await saveReportPdf(baseName, md);
        return { text: `${md}\n\n---\n_Report saved to ${filePath}${pdfPathInsights ? ` · PDF: ${pdfPathInsights}` : ""}_` };
      },
    },

    // ── pinterest-search-pins ───────────────────────────────────────────
    {
      name: "pinterest-search-pins",
      description:
        "Discover and analyze competitor pins for any topic on Pinterest. This is the primary tool for competitive SEO research. " +
        "Provide seed pin URLs/IDs (from web-search or browser-navigate) and the tool will: " +
        "(1) analyze each seed pin's metadata, annotations, and engagement (saves), " +
        "(2) discover more pins from the same boards (board pages contain 15+ pins in SSR HTML), " +
        "(3) cross-reference with Pinterest trend data and keyword metrics, " +
        "(4) generate a competitive landscape report with revenue-focused recommendations. " +
        "To find seed pins: use web-search with 'site:pinterest.com/pin {topic}' or browser-navigate to Pinterest search. " +
        "Works on ANY public pin — not limited to your own pins.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Topic to research" },
          pin_urls: { type: "array", items: { type: "string" }, description: "Seed pin URLs to analyze and discover from" },
          pin_ids: { type: "array", items: { type: "string" }, description: "Seed pin IDs to analyze and discover from" },
          count: { type: "number", description: "Max pins to analyze (default: 10, max: 25)" },
          region: { type: "string", enum: [...PINTEREST_REGIONS], description: "Region for trends/keywords" },
          include_board_discovery: { type: "boolean", description: "Discover more pins from seed pin boards (default: true)" },
        },
        required: ["query"],
      },
      zodSchema: pinterestSearchPinsSchema,
      category: "social",
      riskLevel: "medium",
      source: "pinterest",
      handler: async (args) => {
        const input = pinterestSearchPinsSchema.parse(args);
        const token = getToken();
        if (!token) return { text: "PINTEREST_ACCESS_TOKEN not configured.", isError: true };

        const maxPins = input.count;
        const seedPinIds: string[] = [...(input.pin_ids ?? [])];

        // Extract pin IDs from URLs
        if (input.pin_urls) {
          for (const url of input.pin_urls) {
            const id = extractPinIdFromUrl(url);
            if (id) seedPinIds.push(id);
          }
        }

        // Deduplicate seeds
        const uniqueSeeds = [...new Set(seedPinIds)];
        const discoveredPins: DiscoveredPin[] = [];
        const boardsSscraped: string[] = [];
        const allPinIds = new Set<string>();

        // Phase 1: Analyze seed pins and discover their boards
        const boardUrlsToScrape: string[] = [];
        for (const pinId of uniqueSeeds.slice(0, 10)) {
          if (allPinIds.has(pinId)) continue;
          allPinIds.add(pinId);

          const pageData = await fetchPinPageData(pinId);
          if (!pageData) continue;

          const { metadata, annotations, boardUrl } = pageData;
          if (metadata) {
            const images = (metadata.media as Record<string, unknown> | undefined)?.images as
              Record<string, Record<string, unknown>> | undefined;
            const imageUrl = images?.original?.url as string | undefined;
            discoveredPins.push({
              pin_id: pinId,
              title: (metadata.title as string) ?? null,
              description: (metadata.description as string) ?? null,
              link: (metadata.link as string) ?? null,
              image_url: imageUrl ?? null,
              repins: (metadata.repins as number) ?? null,
              pinner_url: (metadata.pinner_url as string) ?? null,
              board_url: (metadata.board_url as string) ?? null,
              annotations,
              pin_score: calculatePinScore(metadata, annotations),
              seo_recommendations: generateSeoRecommendations(metadata, annotations),
              source: "seed",
            });
          }

          if (boardUrl && input.include_board_discovery) {
            boardUrlsToScrape.push(boardUrl);
          }

          // Rate limit: 2s delay between pin page fetches
          if (uniqueSeeds.indexOf(pinId) < uniqueSeeds.length - 1) {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }

        // Phase 2: Discover pins from boards
        if (input.include_board_discovery && boardUrlsToScrape.length > 0) {
          const uniqueBoards = [...new Set(boardUrlsToScrape)];
          for (const boardUrl of uniqueBoards.slice(0, 3)) {
            const boardPinIds = await discoverPinsFromBoard(boardUrl);
            boardsSscraped.push(boardUrl);

            // Analyze discovered pins (up to max count)
            for (const pinId of boardPinIds) {
              if (discoveredPins.length >= maxPins) break;
              if (allPinIds.has(pinId)) continue;
              allPinIds.add(pinId);

              const pageData = await fetchPinPageData(pinId);
              if (!pageData?.metadata) continue;

              const { metadata, annotations } = pageData;
              const images = (metadata.media as Record<string, unknown> | undefined)?.images as
                Record<string, Record<string, unknown>> | undefined;
              const imageUrl = images?.original?.url as string | undefined;
              discoveredPins.push({
                pin_id: pinId,
                title: (metadata.title as string) ?? null,
                description: (metadata.description as string) ?? null,
                link: (metadata.link as string) ?? null,
                image_url: imageUrl ?? null,
                repins: (metadata.repins as number) ?? null,
                pinner_url: (metadata.pinner_url as string) ?? null,
                board_url: (metadata.board_url as string) ?? null,
                annotations,
                pin_score: calculatePinScore(metadata, annotations),
                seo_recommendations: generateSeoRecommendations(metadata, annotations),
                source: "board_discovery",
              });

              // Rate limit: 2s delay
              await new Promise((r) => setTimeout(r, 2000));
            }

            if (discoveredPins.length >= maxPins) break;
            // Delay between boards
            await new Promise((r) => setTimeout(r, 2000));
          }
        }

        // Phase 3: Cross-reference with trend data
        const result: SearchPinsResult = {
          query: input.query,
          region: input.region,
          discovered_pins: discoveredPins,
          boards_scraped: boardsSscraped,
        };

        // Fetch trend data
        const trendResult = await pinterestApiFetch(
          `/trends/keywords/${encodeURIComponent(input.region)}/top/growing`,
          token,
          new URLSearchParams({ limit: "25" }),
        );
        if (!trendResult.isError) {
          const trendData = JSON.parse(trendResult.text) as { trends?: Array<Record<string, unknown>> };
          const queryWords = input.query.toLowerCase().split(/\s+/);
          const allTrends = trendData.trends ?? [];
          const matchingTrends = allTrends.filter((t) => {
            const kw = String(t.keyword ?? "").toLowerCase();
            return queryWords.some((w) => kw.includes(w)) || kw.includes(input.query.toLowerCase());
          });
          const trendsToShow = matchingTrends.length > 0 ? matchingTrends.slice(0, 15) : allTrends.slice(0, 10);
          result.trends = trendsToShow.map((t) => ({
            keyword: String(t.keyword ?? "—"),
            wow: formatPct(t.pct_growth_wow),
            mom: formatPct(t.pct_growth_mom),
            yoy: formatPct(t.pct_growth_yoy),
          }));
        }

        // Fetch keyword metrics (enriched pipeline)
        {
          const queryKeywords = [input.query, ...input.query.split(/\s+/).filter((w) => w.length > 2)];
          const uniqueKeywords = [...new Set(queryKeywords)].slice(0, 10);
          const { keywords: enrichedKws } = await enrichKeywordMetrics(
            uniqueKeywords,
            token,
            input.region,
          );
          result.keywords = enrichedKws.map((e) => ({
            keyword: e.keyword,
            searches: e.searches,
            competition: e.competition,
          }));
        }

        const md = formatSearchPinsMarkdown(result);
        const ts = timestamp();
        const slug = input.query.replace(/\s+/g, "-").toLowerCase().slice(0, 30);
        const baseName = `search-pins-${slug}-${ts}`;
        const filePath = saveReport(`${baseName}.md`, md);
        saveReportJson(baseName, { type: "search-pins", ...result, generated: new Date().toISOString() });
        const pdfPathSearch = await saveReportPdf(baseName, md);
        const pdfSuffix = pdfPathSearch ? ` · PDF: ${pdfPathSearch}` : "";

        if (discoveredPins.length === 0 && uniqueSeeds.length === 0) {
          return {
            text: `${md}\n\n---\n⚠️ **No seed pins provided.** To discover competitor pins, run one of:\n` +
              `- \`web-search\` with query: \`site:pinterest.com/pin "${input.query}"\`\n` +
              `- \`browser-navigate\` to \`https://pinterest.com/search/pins/?q=${encodeURIComponent(input.query)}\` and extract pin URLs\n\n` +
              `Then re-run this tool with the discovered pin_urls.\n\n_Report saved to ${filePath}${pdfSuffix}_`,
          };
        }

        return { text: `${md}\n\n---\n_Report saved to ${filePath}${pdfSuffix}_` };
      },
    },
  ];
}

// ── Internal analyzer ───────────────────────────────────────────────────────

interface PinAnalysis {
  pin_id: string;
  pin_url: string;
  title: string | null;
  description: string | null;
  link: string | null;
  media_type: string | null;
  pin_score: number;
  annotations: string[];
  annotation_count: number;
  seo_recommendations: string[];
  api_data_available: boolean;
  html_data_available?: boolean;
  pin_metrics?: Record<string, unknown> | null;
}

/**
 * Extract pin metadata (title, description, link, image) from Pinterest HTML page.
 * Used as fallback when the API can't return data (e.g., pins you don't own).
 * Handles both attribute orders: property="..." content="..." and content="..." property="..."
 */
function extractMetadataFromHtml(html: string): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  let found = false;

  /** Match a meta tag by property/name, regardless of attribute order. */
  const getMetaContent = (propName: string): string | null => {
    // Order 1: property/name first, then content
    const r1 = new RegExp(`<meta\\s+(?:property|name)="${propName}"[^>]*?content="([^"]+)"`, "i");
    const m1 = html.match(r1);
    if (m1?.[1]) return m1[1];
    // Order 2: content first, then property/name
    const r2 = new RegExp(`<meta\\s+content="([^"]+)"[^>]*?(?:property|name)="${propName}"`, "i");
    const m2 = html.match(r2);
    return m2?.[1] ?? null;
  };

  const title = getMetaContent("og:title");
  if (title) { meta.title = title; found = true; }

  const desc = getMetaContent("og:description");
  if (desc) { meta.description = desc; found = true; }

  const image = getMetaContent("pinterestapp:pinimage") ?? getMetaContent("og:image");
  if (image) {
    meta.media = { media_type: "image", images: { original: { url: image } } };
    found = true;
  }

  const link = getMetaContent("pinterestapp:source");
  if (link) { meta.link = link; found = true; }

  // pinterestapp:repins (engagement metric — saves/repins count)
  const repinsStr = getMetaContent("pinterestapp:repins");
  if (repinsStr) {
    const repins = parseInt(repinsStr, 10);
    if (!isNaN(repins)) { meta.repins = repins; found = true; }
  }

  // pinterestapp:pinboard (board URL for discovery)
  const boardUrl = getMetaContent("pinterestapp:pinboard");
  if (boardUrl) { meta.board_url = boardUrl; found = true; }

  // pinterestapp:pinner
  const pinnerUrl = getMetaContent("pinterestapp:pinner");
  if (pinnerUrl) { meta.pinner_url = pinnerUrl; found = true; }

  // Also try __PWS_DATA__ for richer data
  const pwsMatch = html.match(/__PWS_DATA__\s*=\s*({[\s\S]*?});\s*<\/script>/);
  if (pwsMatch?.[1]) {
    try {
      const pws = JSON.parse(pwsMatch[1]);
      const traverse = (obj: unknown): void => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) { for (const item of obj) traverse(item); return; }
        const rec = obj as Record<string, unknown>;
        // Look for pin-level data with title/description
        if (rec.title && typeof rec.title === "string" && rec.description !== undefined && !meta.title) {
          meta.title = rec.title;
          if (rec.description) meta.description = rec.description;
          if (rec.link) meta.link = rec.link;
          if (rec.alt_text) meta.alt_text = rec.alt_text;
          found = true;
        }
        for (const val of Object.values(rec)) traverse(val);
      };
      traverse(pws);
    } catch { /* ignore parse errors */ }
  }

  return found ? meta : null;
}

async function analyzeSinglePin(
  pinId: string,
  token: string | undefined,
  options: { includeAnnotations: boolean },
): Promise<PinAnalysis> {
  // Phase 1: API data (if token available) — includes 90d/lifetime metrics
  let apiData: Record<string, unknown> | null = null;
  if (token) {
    try {
      const res = await fetch(
        `${PINTEREST_API_BASE}/pins/${encodeURIComponent(pinId)}?pin_metrics=true`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      );
      if (res.ok) apiData = (await res.json()) as Record<string, unknown>;
    } catch {
      // API fetch failed — continue with browser-only analysis
    }
  }

  // Phase 2: Browser-based scraping — annotations AND metadata fallback
  let annotations: string[] = [];
  let htmlMetadata: Record<string, unknown> | null = null;
  if (options.includeAnnotations) {
    try {
      const pinUrl = `https://www.pinterest.com/pin/${encodeURIComponent(pinId)}/`;
      const res = await fetch(pinUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (res.ok) {
        const html = await res.text();
        annotations = extractAnnotationsFromHtml(html);
        // When API didn't return data, extract metadata from HTML
        if (!apiData) {
          htmlMetadata = extractMetadataFromHtml(html);
        }
      }
    } catch {
      // Browser fetch failed — proceed with API-only analysis
    }
  }

  // Use HTML metadata as fallback when API fails (e.g., analyzing other users' pins)
  const effectiveData = apiData ?? htmlMetadata;

  // Phase 3: Calculate Pin Score
  const pinScore = calculatePinScore(effectiveData, annotations);

  // Phase 4: SEO recommendations
  const seoRecommendations = generateSeoRecommendations(effectiveData, annotations);

  const media = effectiveData?.media as Record<string, unknown> | undefined;
  const pinMetrics = apiData?.pin_metrics as Record<string, unknown> | undefined;

  return {
    pin_id: pinId,
    pin_url: `https://www.pinterest.com/pin/${encodeURIComponent(pinId)}/`,
    title: (effectiveData?.title as string) ?? null,
    description: (effectiveData?.description as string) ?? null,
    link: (effectiveData?.link as string) ?? null,
    media_type: (media?.media_type as string) ?? null,
    pin_score: pinScore,
    annotations,
    annotation_count: annotations.length,
    seo_recommendations: seoRecommendations,
    api_data_available: !!apiData,
    html_data_available: !!htmlMetadata,
    pin_metrics: pinMetrics ?? null,
  };
}
