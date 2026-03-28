import * as z from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "../tool-registry.js";
import { extractContent } from "./seo/html-extractor.js";
import { discoverCompetitors } from "./seo/competitor-discovery.js";
import { buildAnalysisPrompt, generateMetricsReport, buildReportFilename, buildReportSubdir, type AnalysisInput } from "./seo/report-generator.js";
import { discoverKeyword } from "./seo/keyword-discovery.js";
import { saveReportPdf } from "./shared/pdf-export.js";

// ── Constants ────────────────────────────────────────────────────────────

const SEO_REPORTS_DIR = path.join(os.homedir(), ".openzigs", "seo-reports");

// ── Zod Schemas ─────────────────────────────────────────────────────────

const seoGapAnalysisSchema = z.object({
  targetUrl: z.string().url().describe("URL of the page to analyze"),
  targetKeyword: z.string().min(1).optional().describe("Primary keyword / search query to analyze for. Leave blank to auto-detect from page content."),
  searchProvider: z
    .enum(["serper", "brave"])
    .optional()
    .describe("Search provider for competitor discovery (default: auto-detect from available API keys)"),
  model: z.string().optional().describe("LLM model to use for analysis (passed through — the orchestrator handles model routing)"),
});

const seoExtractContentSchema = z.object({
  url: z.string().url().describe("URL of the page to extract content from"),
});

const exportPdfSchema = z.object({
  markdownPath: z.string().min(1).describe("Absolute path to the markdown file to convert to PDF"),
});

// ── Helpers ──────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; OpenZigs SEO Analyzer/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  }
  return resp.text();
}

async function ensureReportsDir(): Promise<void> {
  await fs.mkdir(SEO_REPORTS_DIR, { recursive: true });
}

// ── Tool Factory ─────────────────────────────────────────────────────────

export type SeoGapToolsOptions = {
  serperApiKey?: string;
  braveApiKey?: string;
};

export const createSeoGapTools = (opts: SeoGapToolsOptions = {}): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];

  // ── seo-gap-analysis ──────────────────────────────────────────────────
  tools.push({
    name: "seo-gap-analysis",
    description:
      "Run a full SEO content gap analysis: fetch the target page, discover top-ranking competitors, extract content from each, compare metrics, and generate a comprehensive Markdown report saved to ~/.openzigs/seo-reports/. Returns the report path and a metrics summary. Use the `model` parameter to request LLM-enhanced analysis.",
    inputSchema: {
      type: "object",
      properties: {
        targetUrl: { type: "string", description: "URL of the page to analyze" },
        targetKeyword: { type: "string", description: "Primary keyword / search query (leave blank to auto-detect)" },
        searchProvider: { type: "string", enum: ["serper", "brave"], description: "Search provider (default: auto)" },
        model: { type: "string", description: "LLM model for enhanced analysis" },
      },
      required: ["targetUrl"],
    },
    zodSchema: seoGapAnalysisSchema,
    category: "search",
    riskLevel: "medium",
    handler: async (args) => {
      const { targetUrl, targetKeyword: providedKeyword, searchProvider } = seoGapAnalysisSchema.parse(args);

      try {
        await ensureReportsDir();

        // 1. Fetch & extract target content
        const targetHtml = await fetchHtml(targetUrl);
        const targetContent = extractContent(targetHtml, targetUrl);

        // 1b. Auto-detect keyword if not provided
        let targetKeyword = providedKeyword ?? "";
        let detectedKeyword: { keyword: string; alternatives: string[]; intent: string } | undefined;

        if (!targetKeyword) {
          const discovery = discoverKeyword(targetContent, targetUrl);
          if (!discovery) {
            return {
              text: "Could not auto-detect a target keyword from the page content. Please provide a keyword manually.",
              isError: true,
            };
          }
          targetKeyword = discovery.keyword;
          detectedKeyword = discovery;
        }

        // 2. Discover competitors
        let targetDomain: string | undefined;
        try {
          targetDomain = new URL(targetUrl).hostname.replace(/^www\./, "");
        } catch { /* ignore */ }

        const apiKeys: { serperApiKey?: string; braveApiKey?: string; targetDomain?: string } = {};
        if (targetDomain) apiKeys.targetDomain = targetDomain;
        if (searchProvider === "serper" || (!searchProvider && opts.serperApiKey)) {
          apiKeys.serperApiKey = opts.serperApiKey;
        }
        if (searchProvider === "brave" || (!searchProvider && !opts.serperApiKey)) {
          apiKeys.braveApiKey = opts.braveApiKey;
        }
        // Ensure at least one key is present
        if (!apiKeys.serperApiKey && !apiKeys.braveApiKey) {
          apiKeys.braveApiKey = opts.braveApiKey;
          apiKeys.serperApiKey = opts.serperApiKey;
        }

        const discovery = await discoverCompetitors(targetKeyword, apiKeys);

        // 3. Fetch & extract competitor content (parallel, with error tolerance)
        const competitorResults = await Promise.allSettled(
          discovery.organic.map(async (result) => {
            const html = await fetchHtml(result.url);
            const content = extractContent(html, result.url);
            return { ...content, url: result.url };
          }),
        );

        const competitors = competitorResults
          .filter((r): r is PromiseFulfilledResult<ReturnType<typeof extractContent> & { url: string }> => r.status === "fulfilled")
          .map((r) => r.value);

        // 4. Generate metrics report
        const input: AnalysisInput = {
          targetUrl,
          targetKeyword,
          targetContent,
          competitors,
          serpFeatures: discovery.serpFeatures,
        };

        const report = generateMetricsReport(input);
        const analysisPrompt = buildAnalysisPrompt(input);

        // 5. Save report in domain subdirectory
        const filename = buildReportFilename(targetUrl, targetKeyword);
        const subdir = buildReportSubdir(targetUrl);
        const reportDir = path.join(SEO_REPORTS_DIR, subdir);
        await fs.mkdir(reportDir, { recursive: true });
        const reportPath = path.join(reportDir, filename);
        await fs.writeFile(reportPath, report, "utf-8");

        // 5b. Generate PDF alongside markdown
        const pdfBasename = filename.replace(/\.md$/, "");
        const pdfPath = await saveReportPdf(pdfBasename, report, reportDir);

        return {
          text: `REPORT SAVED: ${reportPath}\n${pdfPath ? `PDF SAVED: ${pdfPath}` : "PDF: Not generated (Chrome not found)"}\nCompetitors analyzed: ${competitors.length}\n${detectedKeyword ? `Auto-detected keyword: "${targetKeyword}" (${detectedKeyword.intent})` : ""}\nUse the analysisPrompt field for enhanced LLM analysis. Write enhanced results to the SAME reportPath.\n\n` + JSON.stringify({
            reportPath,
            pdfPath: pdfPath ?? null,
            filename,
            ...(detectedKeyword ? { detectedKeyword } : {}),
            targetKeyword,
            targetMetrics: {
              wordCount: targetContent.wordCount,
              headingCount: targetContent.headingCount,
              readingTime: targetContent.readingTime,
              readabilityScore: targetContent.readabilityScore,
              topKeywords: targetContent.keywords.slice(0, 5).map((k) => k.term),
              metaTitleLength: targetContent.metaTitle.length,
              metaDescriptionLength: targetContent.metaDescription.length,
              schemaTypes: targetContent.schemaMarkup.map((s) => s.type),
              imagesTotal: targetContent.images.length,
              imagesWithoutAlt: targetContent.imagesWithoutAlt,
              internalLinks: targetContent.internalLinkCount,
              externalLinks: targetContent.externalLinkCount,
            },
            competitorsAnalyzed: competitors.length,
            serpFeatures: {
              paaCount: discovery.serpFeatures.paa.length,
              relatedSearchCount: discovery.serpFeatures.relatedSearches.length,
              hasFeaturedSnippet: !!discovery.serpFeatures.featuredSnippet,
            },
            searchProvider: discovery.provider,
            analysisPrompt,
          }, null, 2),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { text: `SEO gap analysis failed: ${msg}`, isError: true };
      }
    },
  });

  // ── seo-extract-content ───────────────────────────────────────────────
  tools.push({
    name: "seo-extract-content",
    description:
      "Extract structured SEO content from a URL: headings (H1–H6), body text, word count, reading time, TF-IDF keywords, and Flesch-Kincaid readability score.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to extract content from" },
      },
      required: ["url"],
    },
    zodSchema: seoExtractContentSchema,
    category: "search",
    riskLevel: "medium",
    handler: async (args) => {
      const { url } = seoExtractContentSchema.parse(args);

      try {
        const html = await fetchHtml(url);
        const content = extractContent(html, url);

        return {
          text: JSON.stringify({
            url,
            title: content.title,
            headings: content.headings,
            wordCount: content.wordCount,
            headingCount: content.headingCount,
            paragraphCount: content.paragraphCount,
            readingTime: content.readingTime,
            readabilityScore: content.readabilityScore,
            keywords: content.keywords,
            metaTitle: content.metaTitle,
            metaDescription: content.metaDescription,
            schemaTypes: content.schemaMarkup.map((s) => s.type),
            imagesTotal: content.images.length,
            imagesWithoutAlt: content.imagesWithoutAlt,
            internalLinks: content.internalLinkCount,
            externalLinks: content.externalLinkCount,
            bodyTextPreview: content.bodyText.slice(0, 500) + (content.bodyText.length > 500 ? "…" : ""),
          }, null, 2),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { text: `Content extraction failed: ${msg}`, isError: true };
      }
    },
  });

  // ── export-pdf ────────────────────────────────────────────────────────
  tools.push({
    name: "export-pdf",
    description:
      "Convert a markdown file to PDF using Chrome headless. Reads the file, renders it (including mermaid diagrams), and writes a .pdf alongside the source.",
    inputSchema: {
      type: "object",
      properties: {
        markdownPath: { type: "string", description: "Absolute path to the markdown file" },
      },
      required: ["markdownPath"],
    },
    zodSchema: exportPdfSchema,
    category: "filesystem",
    riskLevel: "medium",
    handler: async (args) => {
      const { markdownPath } = exportPdfSchema.parse(args);

      try {
        const resolved = path.resolve(markdownPath.replace(/^~\//, `${os.homedir()}/`));
        const content = await fs.readFile(resolved, "utf-8");
        const outputDir = path.dirname(resolved);
        const basename = path.basename(resolved, ".md");
        const pdfPath = await saveReportPdf(basename, content, outputDir);

        if (!pdfPath) {
          return { text: "PDF not generated — Chrome binary not found on this system.", isError: true };
        }

        return { text: `PDF exported: ${pdfPath}` };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { text: `PDF export failed: ${msg}`, isError: true };
      }
    },
  });

  return tools;
};
