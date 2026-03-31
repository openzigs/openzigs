/**
 * Website-to-Knowledge-Base Ingestion Tool
 *
 * Uses Firecrawl to crawl a website and ingest all pages
 * into the OpenZigs knowledge base as vector-indexed documents.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { getFirecrawlClient, isBlockedUrl } from "../../browser/firecrawl-client.js";
import type { KnowledgeIngestionService } from "../../knowledge/knowledge-service.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface IngestWebsiteResult {
  url: string;
  pagesIngested: number;
  pagesFailed: number;
  totalChunks: number;
}

// ── Zod Schema ───────────────────────────────────────────────────────────

const ingestWebsiteSchema = z.object({
  url: z.string().url().describe("Root URL of the website to ingest"),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe("Maximum number of pages to crawl and ingest (default: 50)"),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(3)
    .describe("Maximum crawl depth (default: 3)"),
  includePaths: z
    .array(z.string())
    .optional()
    .describe("Regex patterns to include specific URL paths"),
  excludePaths: z
    .array(z.string())
    .optional()
    .describe("Regex patterns to exclude URL paths"),
  category: z
    .enum(["general", "document", "reference", "tutorial", "api-docs", "blog"])
    .optional()
    .default("document")
    .describe("Knowledge category for ingested pages (default: document)"),
  visibility: z
    .enum(["internal", "public"])
    .optional()
    .default("internal")
    .describe("Visibility of ingested documents (default: internal)"),
});

// ── Tool factory ─────────────────────────────────────────────────────────

export function createIngestWebsiteTool(
  knowledgeService: KnowledgeIngestionService | null,
): ToolDefinition {
  return {
    name: "ingest-website",
    description:
      "Crawl a website using Firecrawl and ingest all pages into the OpenZigs knowledge base. " +
      "Each page becomes a searchable document with vector embeddings for RAG retrieval. " +
      "Requires firecrawl.enabled=true and an active knowledge service.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Root URL of the website to ingest" },
        maxPages: { type: "number", description: "Max pages to crawl (default: 50, max: 200)" },
        maxDepth: { type: "number", description: "Max crawl depth (default: 3)" },
        includePaths: { type: "array", description: "Regex patterns to include specific paths" },
        excludePaths: { type: "array", description: "Regex patterns to exclude paths" },
        category: { type: "string", enum: ["general", "document", "reference", "tutorial", "api-docs", "blog"], description: "Knowledge category" },
        visibility: { type: "string", enum: ["internal", "public"], description: "Document visibility" },
      },
      required: ["url"],
    },
    zodSchema: ingestWebsiteSchema,
    category: "knowledge",
    riskLevel: "medium",
    handler: async (args) => {
      const { url, maxPages, maxDepth, includePaths, excludePaths, category, visibility } = ingestWebsiteSchema.parse(args);

      if (isBlockedUrl(url)) {
        return { text: `SSRF blocked: URL "${url}" targets an internal/private network address`, isError: true };
      }

      if (!knowledgeService) {
        return { text: "Knowledge service is not available. Cannot ingest website.", isError: true };
      }

      const client = getFirecrawlClient();
      if (!client.getConfig().enabled) {
        return {
          text: "Firecrawl is not enabled. Set firecrawl.enabled to true in config to use website ingestion.",
          isError: true,
        };
      }

      try {
        // 1. Crawl the website
        const crawlResult = await client.crawl(url, {
          limit: maxPages,
          maxDepth,
          includePaths,
          excludePaths,
          scrapeOptions: { formats: ["markdown"] },
        });

        if (crawlResult.pages.length === 0) {
          return { text: "Crawl returned no pages. Check that the URL is accessible.", isError: true };
        }

        // 2. Ingest each page into the knowledge base
        let pagesIngested = 0;
        let pagesFailed = 0;
        let domain: string;
        try {
          domain = new URL(url).hostname;
        } catch {
          domain = "unknown";
        }

        for (const page of crawlResult.pages) {
          const content = page.markdown ?? "";
          if (!content.trim()) {
            pagesFailed++;
            continue;
          }

          const pageUrl = page.url || url;
          const documentId = `web:${domain}:${pageUrl}`;
          const title = extractTitleFromMarkdown(content) || pageUrl;

          try {
            await knowledgeService.ingestText(documentId, title, content, {
              visibility: visibility as "internal" | "public",
              category: category as "document",
            });
            pagesIngested++;
          } catch {
            pagesFailed++;
          }
        }

        return {
          text: `Website ingestion complete.\n` +
            `URL: ${url}\n` +
            `Pages ingested: ${pagesIngested}\n` +
            `Pages failed: ${pagesFailed}\n` +
            `Total crawled: ${crawlResult.pages.length}\n\n` +
            JSON.stringify({
              url,
              pagesIngested,
              pagesFailed,
              totalCrawled: crawlResult.pages.length,
              category,
              visibility,
            }, null, 2),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { text: `Website ingestion failed: ${msg}`, isError: true };
      }
    },
  };
}

/** Extract title from first heading in markdown content. */
function extractTitleFromMarkdown(markdown: string): string | null {
  const match = markdown.match(/^#+ (.+)$/m);
  return match ? match[1].trim() : null;
}
