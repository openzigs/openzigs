# SEO Audit Skill

Perform a comprehensive technical SEO audit on a website using the openzigs SEO Suite.

## Overview

This skill runs a full-site SEO audit that crawls the target website, analyzes each page against SEO best practices, and generates a detailed report with actionable findings.

## When to Use

- User asks to audit a website's SEO health
- User wants to find technical SEO issues (broken links, missing meta tags, slow pages)
- User needs a site-wide SEO report with prioritized fixes
- User wants to compare SEO metrics over time

## Tools Used

- `seo-site-audit` — Primary audit tool. Crawls pages via Firecrawl, checks canonical URLs, hreflang tags, meta robots, robots.txt, XML sitemaps, structured data (JSON-LD), redirect chains, and computes a health score.
- `seo-link-analysis` — Deep link analysis for broken links, redirect chains, and orphan pages.
- `seo-core-web-vitals` — Google PageSpeed Insights integration for Core Web Vitals (LCP, FID/INP, CLS) on mobile and desktop.
- `seo-content-analysis` — Content quality analysis including readability, keyword density, and thin content detection.

## Workflow

1. **Validate the target URL** — Ensure the URL is accessible and uses HTTP/HTTPS.
2. **Run the site audit** — Invoke `seo-site-audit` with the target URL. Optionally specify `maxPages` (default 50) and `maxDepth` (default 3).
3. **Analyze results** — Review the audit output:
   - Health score (0–100)
   - Issue breakdown by severity (critical, warning, info)
   - Per-page findings with specific recommendations
   - Category statistics showing % of URLs affected
4. **Run supplemental checks** (optional):
   - Core Web Vitals for performance metrics
   - Link analysis for deeper broken link detection
   - Content analysis for quality issues
5. **Generate report** — Summarize findings with prioritized action items.

## Example Prompts

- "Run an SEO audit on https://example.com"
- "Check the SEO health of my website at example.com with a max of 100 pages"
- "Audit example.com and focus on mobile performance"
- "Compare the latest SEO audit with the previous one for example.com"

## Configuration

- `maxPages`: Maximum pages to crawl (default: 50, max: 200)
- `maxDepth`: Maximum crawl depth from the root URL (default: 3)
- `includePaths` / `excludePaths`: Filter which URL paths to include or exclude
- Core Web Vitals requires an optional `GOOGLE_PSI_API_KEY` environment variable for higher rate limits

## Output Format

The audit produces a structured JSON result saved as a snapshot in the audit history database. Key fields:

- `healthScore`: Overall site health (0–100)
- `pages`: Array of per-page audit results with issues
- `siteWideIssues`: Issues that affect the entire site
- `categoryStats`: Percentage of URLs affected per issue category
- `robotsTxt`: Robots.txt analysis results
- `sitemapValidation`: XML sitemap validation results
- `structuredDataValidation`: JSON-LD/Schema.org validation results

## Scheduling

SEO audits can be scheduled to run automatically on a cron schedule via the `/api/seo/schedule` endpoint or the Scheduler UI. This enables trend tracking and regression detection.
