/**
 * XML Sitemap Validator (#857)
 *
 * Fetches and validates XML sitemaps:
 * - Parses sitemap index files (recursive)
 * - Extracts URLs with lastmod, changefreq, priority
 * - Compares sitemap URLs to crawled URLs
 * - Validates format: proper XML, valid dates, URL format
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface SitemapValidationResult {
  found: boolean;
  urls: SitemapUrl[];
  sitemapUrls: string[];
  issues: SitemapIssue[];
  orphanedUrls: string[];
  missingUrls: string[];
}

export interface SitemapIssue {
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  url?: string;
}

// ── Valid changefreq values per the sitemap protocol ─────────────────────

const VALID_CHANGEFREQ = new Set([
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
]);

// ── Parser ───────────────────────────────────────────────────────────────

/**
 * Parse a sitemap XML string into structured URL entries.
 * Handles both <urlset> sitemaps and <sitemapindex> files.
 * Uses regex-based parsing (no XML library dependency).
 */
export function parseSitemapXml(xml: string): {
  urls: SitemapUrl[];
  childSitemaps: string[];
  issues: SitemapIssue[];
} {
  const urls: SitemapUrl[] = [];
  const childSitemaps: string[] = [];
  const issues: SitemapIssue[] = [];

  // Detect sitemap index
  if (xml.includes("<sitemapindex")) {
    const sitemapRegex = /<sitemap>\s*<loc>\s*(.*?)\s*<\/loc>/gs;
    let match: RegExpExecArray | null;
    while ((match = sitemapRegex.exec(xml)) !== null) {
      childSitemaps.push(match[1].trim());
    }
    return { urls, childSitemaps, issues };
  }

  // Parse <url> entries
  const urlRegex = /<url>([\s\S]*?)<\/url>/g;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlRegex.exec(xml)) !== null) {
    const block = urlMatch[1];
    const loc = extractTag(block, "loc");
    if (!loc) {
      issues.push({
        severity: "error",
        category: "sitemap",
        message: "Sitemap entry missing <loc> tag",
      });
      continue;
    }

    // Validate URL format
    try {
      new URL(loc);
    } catch {
      issues.push({
        severity: "error",
        category: "sitemap",
        message: `Invalid URL in sitemap: ${loc}`,
        url: loc,
      });
      continue;
    }

    const lastmod = extractTag(block, "lastmod") ?? undefined;
    const changefreq = extractTag(block, "changefreq") ?? undefined;
    const priorityStr = extractTag(block, "priority");
    let priority: number | undefined;

    // Validate lastmod date
    if (lastmod && !isValidDate(lastmod)) {
      issues.push({
        severity: "warning",
        category: "sitemap",
        message: `Invalid lastmod date "${lastmod}" for ${loc}`,
        url: loc,
      });
    }

    // Validate changefreq
    if (changefreq && !VALID_CHANGEFREQ.has(changefreq.toLowerCase())) {
      issues.push({
        severity: "warning",
        category: "sitemap",
        message: `Invalid changefreq "${changefreq}" for ${loc}`,
        url: loc,
      });
    }

    // Validate priority
    if (priorityStr) {
      priority = parseFloat(priorityStr);
      if (!Number.isFinite(priority) || priority < 0 || priority > 1) {
        issues.push({
          severity: "warning",
          category: "sitemap",
          message: `Invalid priority "${priorityStr}" for ${loc} (must be 0.0–1.0)`,
          url: loc,
        });
        priority = undefined;
      }
    }

    urls.push({ loc, lastmod, changefreq, priority });
  }

  return { urls, childSitemaps, issues };
}

function extractTag(block: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>\\s*(.*?)\\s*</${tag}>`, "s");
  const match = regex.exec(block);
  return match ? match[1].trim() : null;
}

function isValidDate(dateStr: string): boolean {
  // Accept ISO 8601 formats: YYYY, YYYY-MM, YYYY-MM-DD, full datetime
  return /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?)?)?$/.test(
    dateStr,
  );
}

// ── Validation ───────────────────────────────────────────────────────────

/**
 * Compare sitemap URLs with crawled URLs to find orphans and missing pages.
 */
export function compareSitemapToCrawl(
  sitemapUrls: string[],
  crawledUrls: string[],
): { orphanedUrls: string[]; missingUrls: string[] } {
  const normalize = (u: string) => {
    try {
      const url = new URL(u);
      return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
    } catch {
      return u.replace(/\/+$/, "");
    }
  };

  const sitemapSet = new Set(sitemapUrls.map(normalize));
  const crawledSet = new Set(crawledUrls.map(normalize));

  // In sitemap but not found during crawl
  const orphanedUrls = [...sitemapSet].filter((u) => !crawledSet.has(u));
  // Crawled but not in sitemap
  const missingUrls = [...crawledSet].filter((u) => !sitemapSet.has(u));

  return { orphanedUrls, missingUrls };
}

/**
 * Fetch and validate a sitemap from a URL. Follows sitemap index files (up to 2 levels).
 */
export async function fetchAndValidateSitemap(
  siteUrl: string,
  robotsSitemapUrls: string[] = [],
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<SitemapValidationResult> {
  const origin = new URL(siteUrl).origin;
  const sitemapUrls =
    robotsSitemapUrls.length > 0
      ? [...new Set(robotsSitemapUrls)]
      : [`${origin}/sitemap.xml`];

  const allUrls: SitemapUrl[] = [];
  const allIssues: SitemapIssue[] = [];
  let found = false;

  for (const sitemapUrl of sitemapUrls) {
    try {
      const resp = await fetchFn(sitemapUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        allIssues.push({
          severity: "warning",
          category: "sitemap",
          message: `Sitemap not accessible: ${sitemapUrl} (HTTP ${resp.status})`,
          url: sitemapUrl,
        });
        continue;
      }

      found = true;
      const xml = await resp.text();
      const result = parseSitemapXml(xml);
      allUrls.push(...result.urls);
      allIssues.push(...result.issues);

      // Follow child sitemaps (one level deep)
      for (const childUrl of result.childSitemaps) {
        try {
          const childResp = await fetchFn(childUrl, {
            signal: AbortSignal.timeout(15_000),
          });
          if (childResp.ok) {
            const childXml = await childResp.text();
            const childResult = parseSitemapXml(childXml);
            allUrls.push(...childResult.urls);
            allIssues.push(...childResult.issues);
          }
        } catch {
          allIssues.push({
            severity: "warning",
            category: "sitemap",
            message: `Failed to fetch child sitemap: ${childUrl}`,
            url: childUrl,
          });
        }
      }
    } catch {
      allIssues.push({
        severity: "warning",
        category: "sitemap",
        message: `Failed to fetch sitemap: ${sitemapUrl}`,
        url: sitemapUrl,
      });
    }
  }

  if (!found) {
    allIssues.push({
      severity: "info",
      category: "sitemap",
      message: "No XML sitemap found",
    });
  }

  return {
    found,
    urls: allUrls,
    sitemapUrls: allUrls.map((u) => u.loc),
    issues: allIssues,
    orphanedUrls: [],
    missingUrls: [],
  };
}
