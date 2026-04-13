/**
 * Full-site SEO Audit Tool — powered by Firecrawl deep crawling.
 *
 * Crawls an entire site, extracts content from every page,
 * and generates a comprehensive SEO audit report covering:
 *   - Broken links & redirect chains
 *   - Missing/duplicate meta tags
 *   - Heading hierarchy issues
 *   - Image accessibility (missing alt text)
 *   - Content thin pages (< 300 words)
 *   - Internal linking structure
 *   - Schema markup coverage
 */

import * as z from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "../../tool-registry.js";
import { extractContent, type ExtractedContent } from "./html-extractor.js";
import {
  getFirecrawlClient,
  isBlockedUrl,
  type CrawlPage,
} from "../../../browser/firecrawl-client.js";
import { buildReportSubdir, buildReportFilename } from "./report-generator.js";
import { saveReportPdf } from "../shared/pdf-export.js";
import {
  calculateHealthScore,
  classifyAuditIssue,
  type ClassifiedIssue,
} from "./health-score.js";
import { AuditHistoryRepository } from "./audit-history.js";
import { getDatabase } from "../../../productivity/database.js";
import {
  analyzeLinks,
  type CrawledPageLinks,
  type LinkAnalysisResult,
} from "./link-analyzer.js";
import {
  analyzeContent,
  type ContentPage,
  type ContentAnalysisResult,
} from "./content-analyzer.js";

const SEO_REPORTS_DIR = path.join(os.homedir(), ".openzigs", "seo-reports");

// ── Types ────────────────────────────────────────────────────────────────

export interface PageAuditResult {
  url: string;
  statusCode?: number;
  title: string;
  metaTitle: string;
  metaDescription: string;
  wordCount: number;
  headingCount: number;
  h1Count: number;
  imagesTotal: number;
  imagesWithoutAlt: number;
  internalLinkCount: number;
  externalLinkCount: number;
  schemaTypes: string[];
  readabilityScore: number;
  issues: AuditIssue[];
}

export interface AuditIssue {
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  url?: string;
}

export interface SiteAuditResult {
  siteUrl: string;
  pagesAudited: number;
  totalIssues: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  pages: PageAuditResult[];
  siteWideIssues: AuditIssue[];
  reportPath: string;
  pdfPath: string | null;
}

// ── Zod Schema ───────────────────────────────────────────────────────────

const seoSiteAuditSchema = z.object({
  url: z.string().url().describe("Root URL of the site to audit"),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(50)
    .describe("Maximum number of pages to crawl (default: 50, max: 500)"),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(3)
    .describe("Maximum crawl depth from root URL (default: 3)"),
  includePaths: z
    .array(z.string())
    .optional()
    .describe("Regex patterns to include specific URL paths"),
  excludePaths: z
    .array(z.string())
    .optional()
    .describe("Regex patterns to exclude URL paths (e.g. ['/admin', '/api'])"),
});

// ── Audit Logic ──────────────────────────────────────────────────────────

/** Audit a single crawled page for SEO issues. */
export function auditPage(
  page: CrawlPage,
  content: ExtractedContent,
): PageAuditResult {
  const issues: AuditIssue[] = [];

  // Title checks
  if (!content.title && !content.metaTitle) {
    issues.push({
      severity: "error",
      category: "meta",
      message: "Missing page title",
    });
  }
  if (content.metaTitle.length > 60) {
    issues.push({
      severity: "warning",
      category: "meta",
      message: `Meta title too long (${content.metaTitle.length} chars, recommended ≤60)`,
    });
  }
  if (content.metaTitle.length > 0 && content.metaTitle.length < 30) {
    issues.push({
      severity: "warning",
      category: "meta",
      message: `Meta title too short (${content.metaTitle.length} chars, recommended ≥30)`,
    });
  }

  // Meta description checks
  if (!content.metaDescription) {
    issues.push({
      severity: "error",
      category: "meta",
      message: "Missing meta description",
    });
  } else if (content.metaDescription.length > 160) {
    issues.push({
      severity: "warning",
      category: "meta",
      message: `Meta description too long (${content.metaDescription.length} chars, recommended ≤160)`,
    });
  } else if (content.metaDescription.length < 50) {
    issues.push({
      severity: "warning",
      category: "meta",
      message: `Meta description too short (${content.metaDescription.length} chars, recommended ≥50)`,
    });
  }

  // Heading checks
  const h1s = content.headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    issues.push({
      severity: "error",
      category: "headings",
      message: "Missing H1 tag",
    });
  } else if (h1s.length > 1) {
    issues.push({
      severity: "warning",
      category: "headings",
      message: `Multiple H1 tags found (${h1s.length})`,
    });
  }
  if (content.headingCount === 0) {
    issues.push({
      severity: "warning",
      category: "headings",
      message: "No heading tags found on page",
    });
  }

  // Content checks
  if (content.wordCount < 300) {
    issues.push({
      severity: "warning",
      category: "content",
      message: `Thin content (${content.wordCount} words, recommended ≥300)`,
    });
  }
  if (content.readabilityScore < 30) {
    issues.push({
      severity: "info",
      category: "content",
      message: `Low readability score (${content.readabilityScore.toFixed(1)})`,
    });
  }

  // Image checks
  if (content.imagesWithoutAlt > 0) {
    issues.push({
      severity: "warning",
      category: "images",
      message: `${content.imagesWithoutAlt} image(s) missing alt text`,
    });
  }

  // Link checks
  if (content.internalLinkCount === 0) {
    issues.push({
      severity: "warning",
      category: "links",
      message: "No internal links found (orphan page risk)",
    });
  }

  // Schema checks
  if (content.schemaMarkup.length === 0) {
    issues.push({
      severity: "info",
      category: "schema",
      message: "No structured data (JSON-LD) found",
    });
  }

  return {
    url: page.url,
    statusCode: page.statusCode,
    title: content.title,
    metaTitle: content.metaTitle,
    metaDescription: content.metaDescription,
    wordCount: content.wordCount,
    headingCount: content.headingCount,
    h1Count: h1s.length,
    imagesTotal: content.images.length,
    imagesWithoutAlt: content.imagesWithoutAlt,
    internalLinkCount: content.internalLinkCount,
    externalLinkCount: content.externalLinkCount,
    schemaTypes: content.schemaMarkup.map((s) => s.type),
    readabilityScore: content.readabilityScore,
    issues,
  };
}

/** Build link analysis data for the UI Links dashboard tab. */
function buildLinkAnalysis(
  pages: PageAuditResult[],
  crawledContents: Map<string, ExtractedContent>,
  siteUrl: string,
): LinkAnalysisResult & {
  links: { source: string; target: string }[];
} {
  const crawledPages: CrawledPageLinks[] = pages.map((p) => {
    const content = crawledContents.get(p.url);
    const links = content
      ? [
          ...content.internalLinks.map((l) => ({
            href: l.href,
            text: l.text,
            isInternal: true,
          })),
          ...content.externalLinks.map((l) => ({
            href: l.href,
            text: l.text,
            isInternal: false,
          })),
        ]
      : [];
    return { url: p.url, links, statusCode: p.statusCode };
  });

  const result = analyzeLinks(crawledPages, siteUrl);

  // Build source→target link pairs for the force-directed graph (cap at 200)
  const graphLinks: { source: string; target: string }[] = [];
  const seen = new Set<string>();
  for (const page of crawledPages) {
    for (const link of page.links) {
      if (!link.isInternal) continue;
      const key = `${page.url}→${link.href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      graphLinks.push({ source: page.url, target: link.href });
      if (graphLinks.length >= 200) break;
    }
    if (graphLinks.length >= 200) break;
  }

  return { ...result, links: graphLinks };
}

/** Build content analysis data for the UI Content dashboard tab. */
function buildContentAnalysis(
  pages: PageAuditResult[],
  crawledContents: Map<string, ExtractedContent>,
): ContentAnalysisResult {
  const contentPages: ContentPage[] = pages.map((p) => {
    const content = crawledContents.get(p.url);
    return {
      url: p.url,
      title: p.title,
      bodyText: content?.bodyText ?? "",
      wordCount: p.wordCount,
    };
  });

  return analyzeContent(contentPages);
}

/** Detect site-wide issues by analyzing patterns across all pages. */
export function detectSiteWideIssues(pages: PageAuditResult[]): AuditIssue[] {
  const issues: AuditIssue[] = [];

  // Duplicate titles
  const titles = new Map<string, string[]>();
  for (const p of pages) {
    if (p.metaTitle) {
      const existing = titles.get(p.metaTitle) ?? [];
      existing.push(p.url);
      titles.set(p.metaTitle, existing);
    }
  }
  for (const [title, urls] of titles) {
    if (urls.length > 1) {
      issues.push({
        severity: "warning",
        category: "duplicates",
        message: `Duplicate meta title "${title}" on ${urls.length} pages: ${urls.join(", ")}`,
      });
    }
  }

  // Duplicate descriptions
  const descriptions = new Map<string, string[]>();
  for (const p of pages) {
    if (p.metaDescription) {
      const existing = descriptions.get(p.metaDescription) ?? [];
      existing.push(p.url);
      descriptions.set(p.metaDescription, existing);
    }
  }
  for (const [desc, urls] of descriptions) {
    if (urls.length > 1) {
      issues.push({
        severity: "warning",
        category: "duplicates",
        message: `Duplicate meta description on ${urls.length} pages (first 50 chars: "${desc.slice(0, 50)}…")`,
      });
    }
  }

  // Site-wide schema coverage
  const pagesWithSchema = pages.filter((p) => p.schemaTypes.length > 0).length;
  if (pagesWithSchema === 0 && pages.length > 0) {
    issues.push({
      severity: "warning",
      category: "schema",
      message: "No structured data found on any page",
    });
  }

  // Average word count check
  if (pages.length > 0) {
    const avgWords = pages.reduce((a, p) => a + p.wordCount, 0) / pages.length;
    if (avgWords < 300) {
      issues.push({
        severity: "warning",
        category: "content",
        message: `Low average word count across site (${Math.round(avgWords)} words)`,
      });
    }
  }

  return issues;
}

/** Generate a Markdown audit report. */
export function generateAuditReport(result: SiteAuditResult): string {
  const lines: string[] = [];
  lines.push(`# SEO Site Audit: ${result.siteUrl}`);
  lines.push("");
  lines.push(`**Date:** ${new Date().toISOString().split("T")[0]}`);
  lines.push(`**Pages Audited:** ${result.pagesAudited}`);
  lines.push(
    `**Total Issues:** ${result.totalIssues} (${result.errorCount} errors, ${result.warningCount} warnings, ${result.infoCount} info)`,
  );
  lines.push("");

  // Summary table
  lines.push("## Issue Summary");
  lines.push("");
  lines.push("| Severity | Count |");
  lines.push("|----------|-------|");
  lines.push(`| 🔴 Errors | ${result.errorCount} |`);
  lines.push(`| 🟡 Warnings | ${result.warningCount} |`);
  lines.push(`| 🔵 Info | ${result.infoCount} |`);
  lines.push("");

  // Site-wide issues
  if (result.siteWideIssues.length > 0) {
    lines.push("## Site-Wide Issues");
    lines.push("");
    for (const issue of result.siteWideIssues) {
      const icon =
        issue.severity === "error"
          ? "🔴"
          : issue.severity === "warning"
            ? "🟡"
            : "🔵";
      lines.push(`- ${icon} **[${issue.category}]** ${issue.message}`);
    }
    lines.push("");
  }

  // Per-page audit
  lines.push("## Page-by-Page Audit");
  lines.push("");
  for (const page of result.pages) {
    lines.push(`### ${page.url}`);
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Title | ${page.title || "*missing*"} |`);
    lines.push(`| Word Count | ${page.wordCount} |`);
    lines.push(`| H1 Tags | ${page.h1Count} |`);
    lines.push(`| Headings | ${page.headingCount} |`);
    lines.push(
      `| Images (missing alt) | ${page.imagesWithoutAlt}/${page.imagesTotal} |`,
    );
    lines.push(`| Internal Links | ${page.internalLinkCount} |`);
    lines.push(`| External Links | ${page.externalLinkCount} |`);
    lines.push(`| Schema Types | ${page.schemaTypes.join(", ") || "*none*"} |`);
    lines.push(`| Readability | ${page.readabilityScore.toFixed(1)} |`);
    lines.push("");

    if (page.issues.length > 0) {
      lines.push("**Issues:**");
      for (const issue of page.issues) {
        const icon =
          issue.severity === "error"
            ? "🔴"
            : issue.severity === "warning"
              ? "🟡"
              : "🔵";
        lines.push(`- ${icon} **[${issue.category}]** ${issue.message}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createSeoSiteAuditTool(): ToolDefinition {
  return {
    name: "seo-site-audit",
    description:
      "Run a comprehensive SEO audit on an entire website using Firecrawl deep crawling. " +
      "Analyzes every page for: missing/duplicate meta tags, heading hierarchy, thin content, " +
      "image accessibility, internal linking, schema markup coverage. " +
      "Generates a detailed Markdown + PDF report saved to ~/.openzigs/seo-reports/.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Root URL of the site to audit" },
        maxPages: {
          type: "number",
          description: "Max pages to crawl (default: 50, max: 500)",
        },
        maxDepth: {
          type: "number",
          description: "Max crawl depth (default: 3)",
        },
        includePaths: {
          type: "array",
          items: { type: "string" },
          description: "Regex patterns to include specific paths",
        },
        excludePaths: {
          type: "array",
          items: { type: "string" },
          description: "Regex patterns to exclude paths",
        },
      },
      required: ["url"],
    },
    zodSchema: seoSiteAuditSchema,
    category: "search",
    riskLevel: "medium",
    handler: async (args) => {
      const { url, maxPages, maxDepth, includePaths, excludePaths } =
        seoSiteAuditSchema.parse(args);

      if (isBlockedUrl(url)) {
        return {
          text: `SSRF blocked: URL "${url}" targets an internal/private network address`,
          isError: true,
        };
      }

      const client = getFirecrawlClient();
      if (!client.getConfig().enabled) {
        return {
          text: "Firecrawl is not enabled. Set firecrawl.enabled to true in config to use site auditing.",
          isError: true,
        };
      }

      try {
        // 1. Crawl the site
        const crawlResult = await client.crawl(url, {
          limit: maxPages,
          maxDepth,
          includePaths,
          excludePaths,
          scrapeOptions: { formats: ["markdown", "html"] },
        });

        if (crawlResult.pages.length === 0) {
          return {
            text: "Crawl returned no pages. Check that the URL is accessible.",
            isError: true,
          };
        }

        // 2. Audit each page
        const auditedPages: PageAuditResult[] = [];
        const crawledContents = new Map<string, ExtractedContent>();
        for (const page of crawlResult.pages) {
          if (!page.html && !page.markdown) continue;
          const html =
            page.html ?? `<html><body>${page.markdown ?? ""}</body></html>`;
          const content = extractContent(html, page.url);
          crawledContents.set(page.url, content);
          auditedPages.push(auditPage(page, content));
        }

        // 3. Detect site-wide issues
        const siteWideIssues = detectSiteWideIssues(auditedPages);

        // 4. Tally issues
        const allIssues = [
          ...siteWideIssues,
          ...auditedPages.flatMap((p) => p.issues),
        ];
        const errorCount = allIssues.filter(
          (i) => i.severity === "error",
        ).length;
        const warningCount = allIssues.filter(
          (i) => i.severity === "warning",
        ).length;
        const infoCount = allIssues.filter((i) => i.severity === "info").length;

        // 5. Build result
        const subdir = buildReportSubdir(url);
        const filename = buildReportFilename(url, "site-audit");
        const reportDir = path.join(SEO_REPORTS_DIR, subdir);
        await fs.mkdir(reportDir, { recursive: true });
        const reportPath = path.join(reportDir, filename);

        const result: SiteAuditResult = {
          siteUrl: url,
          pagesAudited: auditedPages.length,
          totalIssues: allIssues.length,
          errorCount,
          warningCount,
          infoCount,
          pages: auditedPages,
          siteWideIssues,
          reportPath,
          pdfPath: null,
        };

        // 6. Generate & save report
        const report = generateAuditReport(result);
        await fs.writeFile(reportPath, report, "utf-8");

        const pdfBasename = filename.replace(/\.md$/, "");
        const pdfPath = await saveReportPdf(pdfBasename, report, reportDir);
        result.pdfPath = pdfPath;

        // 7. Compute health score and save audit snapshot
        const classifiedIssues: ClassifiedIssue[] = allIssues.map((i) =>
          classifyAuditIssue(i),
        );
        const healthScore = calculateHealthScore(
          classifiedIssues,
          auditedPages.length,
        );

        try {
          const db = getDatabase();
          const historyRepo = new AuditHistoryRepository(db);

          // Build dashboard-compatible data for the UI tabs
          const dashboardPages = auditedPages.map((p) => ({
            url: p.url,
            issues: p.issues.map((i) => ({
              severity: i.severity,
              category: i.category,
              message: i.message,
            })),
            metrics: {
              wordCount: p.wordCount,
              h1Count: p.h1Count,
              headingCount: p.headingCount,
              imagesTotal: p.imagesTotal,
              imagesWithoutAlt: p.imagesWithoutAlt,
              internalLinkCount: p.internalLinkCount,
              externalLinkCount: p.externalLinkCount,
              readabilityScore: p.readabilityScore,
            },
          }));

          const linkAnalysis = buildLinkAnalysis(
            auditedPages,
            crawledContents,
            url,
          );
          const contentAnalysis = buildContentAnalysis(
            auditedPages,
            crawledContents,
          );

          historyRepo.saveSnapshot(
            url,
            healthScore,
            auditedPages.length,
            JSON.stringify({
              // Dashboard tab data (consumed by ui/app/seo/page.tsx)
              pages: dashboardPages,
              linkAnalysis,
              contentAnalysis,
              // Original audit metadata
              issues: allIssues,
              healthScore,
              reportPath,
              pdfPath: pdfPath ?? null,
            }),
          );
        } catch {
          // Non-fatal: audit history is optional
        }

        return {
          text:
            `REPORT SAVED: ${reportPath}\n${pdfPath ? `PDF SAVED: ${pdfPath}` : "PDF: Not generated"}\n` +
            `Pages audited: ${auditedPages.length}\n` +
            `Issues found: ${allIssues.length} (${errorCount} errors, ${warningCount} warnings, ${infoCount} info)\n` +
            `Health Score: ${healthScore.score}/100 (${healthScore.rating})\n\n` +
            JSON.stringify(
              {
                reportPath,
                pdfPath: pdfPath ?? null,
                siteUrl: url,
                pagesAudited: auditedPages.length,
                totalIssues: allIssues.length,
                errorCount,
                warningCount,
                infoCount,
                healthScore: healthScore.score,
                healthRating: healthScore.rating,
                topIssues: allIssues
                  .filter((i) => i.severity === "error")
                  .slice(0, 10),
                siteWideIssues,
              },
              null,
              2,
            ),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { text: `Site audit failed: ${msg}`, isError: true };
      }
    },
  };
}
