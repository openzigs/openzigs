/**
 * Site-to-Dataset Tool
 *
 * Crawls a website via Firecrawl and produces a structured dataset.
 * Saves pages as markdown files in ~/.openzigs/datasets/{domain}/
 * and generates a manifest JSON with metadata.
 */

import * as z from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "../tool-registry.js";
import {
  getFirecrawlClient,
  isBlockedUrl,
} from "../../browser/firecrawl-client.js";
import {
  outputToSchema,
  writeToOutput,
  outputSummaryLine,
} from "./data-output-helper.js";
import type { SecretVaultService } from "../../vault/secret-vault-service.js";

// ── Zod Schema ───────────────────────────────────────────────────────────

const siteToDatasetSchema = z.object({
  url: z.string().url().describe("Site to crawl"),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(50)
    .describe("Max pages to crawl"),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(3)
    .describe("Crawl depth"),
  includePaths: z
    .array(z.string())
    .optional()
    .describe("URL patterns to include"),
  excludePaths: z
    .array(z.string())
    .optional()
    .describe("URL patterns to exclude"),
  format: z
    .enum(["markdown", "jsonl", "csv"])
    .optional()
    .default("markdown")
    .describe("Output format"),
  chunkSize: z
    .number()
    .int()
    .min(100)
    .max(10_000)
    .optional()
    .default(1000)
    .describe("Characters per chunk for JSONL output"),
  outputTo: outputToSchema.describe(
    "Optional: write extracted data to Airtable or Google Sheets",
  ),
});

export type SiteToDatasetInput = z.infer<typeof siteToDatasetSchema>;

// ── Types ────────────────────────────────────────────────────────────────

export interface DatasetManifest {
  url: string;
  domain: string;
  createdAt: string;
  pageCount: number;
  totalChunks: number;
  totalCharacters: number;
  format: string;
  outputDir: string;
  files: { path: string; url: string; characters: number }[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getDatasetsDir(): string {
  return path.join(os.homedir(), ".openzigs", "datasets");
}

function sanitizeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  } catch {
    return "unknown";
  }
}

function sanitizeFilename(urlString: string): string {
  try {
    const u = new URL(urlString);
    return (
      (u.pathname + u.search)
        .replace(/^\//, "")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 100) || "index"
    );
  } catch {
    return "page";
  }
}

export function chunkText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  // Split on paragraph boundaries when possible
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }

  if (current.trim()) {
    // If the remaining chunk is too large, split by character
    if (current.length > chunkSize * 2) {
      for (let i = 0; i < current.length; i += chunkSize) {
        chunks.push(current.slice(i, i + chunkSize).trim());
      }
    } else {
      chunks.push(current.trim());
    }
  }

  return chunks;
}

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createSiteToDatasetTool(
  vault?: SecretVaultService | null,
): ToolDefinition {
  return {
    name: "site-to-dataset",
    description:
      "Crawl a website and produce a structured dataset. " +
      "Saves all pages to ~/.openzigs/datasets/{domain}/ as markdown, JSONL, or CSV. " +
      "Generates a manifest with metadata. Useful for building training data, research corpora, " +
      "or knowledge bases from websites.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Site to crawl" },
        maxPages: {
          type: "number",
          description: "Max pages to crawl (default: 50)",
        },
        maxDepth: { type: "number", description: "Crawl depth (default: 3)" },
        includePaths: { type: "array", description: "URL patterns to include" },
        excludePaths: { type: "array", description: "URL patterns to exclude" },
        format: {
          type: "string",
          enum: ["markdown", "jsonl", "csv"],
          description: "Output format (default: markdown)",
        },
        chunkSize: {
          type: "number",
          description: "Characters per chunk for JSONL output (default: 1000)",
        },
        outputTo: {
          type: "object",
          description:
            "Optional: write extracted data to Airtable or Google Sheets",
          properties: {
            type: { type: "string", enum: ["airtable", "sheets"] },
            baseId: { type: "string" },
            tableIdOrName: { type: "string" },
            spreadsheetId: { type: "string" },
            range: { type: "string" },
          },
        },
      },
      required: ["url"],
    },
    zodSchema: siteToDatasetSchema,
    category: "data",
    riskLevel: "medium",
    handler: async (args) => {
      const parsed = siteToDatasetSchema.parse(args);
      const {
        url,
        maxPages,
        maxDepth,
        includePaths,
        excludePaths,
        format,
        chunkSize,
        outputTo,
      } = parsed;

      if (isBlockedUrl(url)) {
        return {
          text: `SSRF blocked: "${url}" targets an internal/private network address`,
          isError: true,
        };
      }

      const client = getFirecrawlClient();
      if (!client.getConfig().enabled) {
        return {
          text: "Firecrawl is not enabled. Enable it in Admin → Settings.",
          isError: true,
        };
      }

      try {
        // Step 1: Crawl the site
        const crawlResult = await client.crawl(url, {
          limit: maxPages,
          maxDepth,
          includePaths,
          excludePaths,
          scrapeOptions: { formats: ["markdown"] },
        });

        if (crawlResult.pages.length === 0) {
          return {
            text: `No pages crawled from ${url}. Site may block crawling or require authentication.`,
            isError: true,
          };
        }

        // Step 2: Create output directory
        const domain = sanitizeDomain(url);
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const outputDir = path.join(getDatasetsDir(), domain, ts);
        fs.mkdirSync(outputDir, { recursive: true });

        // Step 3: Write files based on format
        const manifest: DatasetManifest = {
          url,
          domain,
          createdAt: new Date().toISOString(),
          pageCount: crawlResult.pages.length,
          totalChunks: 0,
          totalCharacters: 0,
          format,
          outputDir,
          files: [],
        };

        if (format === "markdown") {
          for (const page of crawlResult.pages) {
            const content = page.markdown ?? "";
            const filename = `${sanitizeFilename(page.url)}.md`;
            const filePath = path.join(outputDir, filename);
            const header = `---\nurl: ${page.url}\ncaptured: ${new Date().toISOString()}\n---\n\n`;
            fs.writeFileSync(filePath, header + content, "utf-8");
            manifest.files.push({
              path: filename,
              url: page.url,
              characters: content.length,
            });
            manifest.totalCharacters += content.length;
          }
          manifest.totalChunks = crawlResult.pages.length;
        } else if (format === "jsonl") {
          const jsonlPath = path.join(outputDir, "dataset.jsonl");
          const lines: string[] = [];
          let totalChunks = 0;

          for (const page of crawlResult.pages) {
            const content = page.markdown ?? "";
            const chunks = chunkText(content, chunkSize);
            for (let i = 0; i < chunks.length; i++) {
              lines.push(
                JSON.stringify({
                  url: page.url,
                  chunk_index: i,
                  total_chunks: chunks.length,
                  content: chunks[i],
                  metadata: page.metadata ?? {},
                }),
              );
              totalChunks++;
            }
            manifest.totalCharacters += content.length;
          }

          fs.writeFileSync(jsonlPath, lines.join("\n"), "utf-8");
          manifest.files.push({
            path: "dataset.jsonl",
            url,
            characters: manifest.totalCharacters,
          });
          manifest.totalChunks = totalChunks;
        } else if (format === "csv") {
          const csvPath = path.join(outputDir, "dataset.csv");
          const header = "url,title,word_count,content\n";
          const rows: string[] = [];

          for (const page of crawlResult.pages) {
            const content = page.markdown ?? "";
            const title = (page.metadata?.title as string) ?? "";
            const wordCount = content.split(/\s+/).filter(Boolean).length;
            // CSV escape: wrap in quotes, double any interior quotes
            const escaped = `"${content.replace(/"/g, '""').replace(/\n/g, "\\n")}"`;
            rows.push(
              `"${page.url}","${title.replace(/"/g, '""')}",${wordCount},${escaped}`,
            );
            manifest.totalCharacters += content.length;
          }

          fs.writeFileSync(csvPath, header + rows.join("\n"), "utf-8");
          manifest.files.push({
            path: "dataset.csv",
            url,
            characters: manifest.totalCharacters,
          });
          manifest.totalChunks = crawlResult.pages.length;
        }

        // Step 4: Write manifest
        const manifestPath = path.join(outputDir, "manifest.json");
        fs.writeFileSync(
          manifestPath,
          JSON.stringify(manifest, null, 2),
          "utf-8",
        );

        // Step 5: Build response
        const lines: string[] = [
          "## Site-to-Dataset Results\n",
          `**URL**: ${url}`,
          `**Pages crawled**: ${crawlResult.pages.length}`,
          `**Format**: ${format}`,
          `**Total characters**: ${manifest.totalCharacters.toLocaleString()}`,
          `**Total chunks**: ${manifest.totalChunks}`,
          `**Output directory**: ${outputDir}`,
          `**Manifest**: ${manifestPath}\n`,
          "### Pages\n",
          "| # | URL | Characters |",
          "|---|-----|------------|",
        ];

        for (let i = 0; i < Math.min(crawlResult.pages.length, 20); i++) {
          const p = crawlResult.pages[i];
          const chars = (p.markdown ?? "").length;
          lines.push(`| ${i + 1} | ${p.url} | ${chars.toLocaleString()} |`);
        }

        if (crawlResult.pages.length > 20) {
          lines.push(`\n... and ${crawlResult.pages.length - 20} more pages.`);
        }

        lines.push(
          "\nDataset is ready for processing. You can read the files or use them for further analysis.",
        );

        // Optional: write to Airtable or Sheets
        if (outputTo) {
          const rows = crawlResult.pages.map((p) => ({
            url: p.url,
            title: (p.metadata?.title as string) ?? "",
            characters: (p.markdown ?? "").length,
            words: (p.markdown ?? "").split(/\s+/).filter(Boolean).length,
          }));
          const outputResult = await writeToOutput(
            outputTo,
            rows,
            vault ?? null,
          );
          lines.push(outputSummaryLine(outputResult));
        }

        return { text: lines.join("\n") };
      } catch (err) {
        return {
          text: `Site-to-dataset failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
