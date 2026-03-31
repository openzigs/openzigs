/**
 * Web Extract Tool
 *
 * Scrapes a URL via Firecrawl and returns structured content for LLM extraction.
 * The conversation LLM performs the actual data extraction from the markdown.
 * Persists raw content to ~/.openzigs/extractions/ for future reference.
 */

import * as z from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "../tool-registry.js";
import { getFirecrawlClient, isBlockedUrl, type ScrapeAction } from "../../browser/firecrawl-client.js";

// ── Zod Schema ───────────────────────────────────────────────────────────

const scrapeActionSchema = z.object({
  type: z.enum(["wait", "click", "write", "press", "scroll", "screenshot", "scrape", "executeJavascript", "pdf"]),
  selector: z.string().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  milliseconds: z.number().optional(),
  direction: z.enum(["up", "down"]).optional(),
  fullPage: z.boolean().optional(),
  script: z.string().optional(),
  all: z.boolean().optional(),
});

const webExtractSchema = z.object({
  url: z.string().url().describe("URL to scrape and extract data from"),
  schema: z.record(z.unknown()).optional().describe("JSON schema describing desired output structure"),
  prompt: z.string().optional().describe("Natural language description of what to extract"),
  actions: z.array(scrapeActionSchema).optional().describe("Actions to perform before extraction (click, scroll, etc.)"),
  maxPages: z.number().int().min(1).max(50).optional().default(1).describe("If >1, crawl and extract from multiple pages"),
  outputFormat: z.enum(["json", "csv", "markdown"]).optional().default("json").describe("Desired output format"),
});

export type WebExtractInput = z.infer<typeof webExtractSchema>;

// ── Helpers ──────────────────────────────────────────────────────────────

function getExtractionsDir(): string {
  return path.join(os.homedir(), ".openzigs", "extractions");
}

function sanitizeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  } catch {
    return "unknown";
  }
}

function persistExtraction(url: string, markdown: string, schema?: Record<string, unknown>, prompt?: string): string {
  const domain = sanitizeDomain(url);
  const dir = path.join(getExtractionsDir(), domain);
  fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `${ts}.md`);

  let content = `# Web Extract: ${url}\n\nCaptured: ${new Date().toISOString()}\n\n`;
  if (schema) {
    content += `## Extraction Schema\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\n\n`;
  }
  if (prompt) {
    content += `## Extraction Prompt\n\n${prompt}\n\n`;
  }
  content += `## Page Content\n\n${markdown}\n`;

  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createWebExtractTool(): ToolDefinition {
  return {
    name: "web-extract",
    description:
      "Scrape a web page and extract structured data. Provide a URL and optionally a JSON schema " +
      "or natural language prompt describing what to extract. The tool scrapes the page via Firecrawl " +
      "and returns the content for structured extraction. Supports browser actions (click, scroll, etc.) " +
      "for dynamic pages. Results are persisted to ~/.openzigs/extractions/.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to scrape and extract data from" },
        schema: { type: "object", description: "JSON schema describing desired output structure" },
        prompt: { type: "string", description: "Natural language description of what to extract" },
        actions: {
          type: "array",
          description: "Actions to perform before extraction (click, scroll, etc.)",
        },
        maxPages: { type: "number", description: "If >1, crawl and extract from multiple pages (default: 1)" },
        outputFormat: { type: "string", enum: ["json", "csv", "markdown"], description: "Desired output format (default: json)" },
      },
      required: ["url"],
    },
    zodSchema: webExtractSchema,
    category: "data",
    riskLevel: "medium",
    handler: async (args) => {
      const parsed = webExtractSchema.parse(args);
      const { url, schema, prompt, actions, maxPages, outputFormat } = parsed;

      // SSRF check
      if (isBlockedUrl(url)) {
        return { text: `SSRF blocked: "${url}" targets an internal/private network address`, isError: true };
      }

      const client = getFirecrawlClient();
      if (!client.getConfig().enabled) {
        return {
          text: "Firecrawl is not enabled. Enable it in Admin → Settings or set firecrawl.enabled=true in config.",
          isError: true,
        };
      }

      if (!schema && !prompt) {
        return {
          text: "Either 'schema' (JSON schema) or 'prompt' (natural language description) is required for extraction.",
          isError: true,
        };
      }

      try {
        let allMarkdown = "";
        let pageCount = 0;

        if (maxPages && maxPages > 1) {
          // Multi-page: crawl then collect
          const crawlResult = await client.crawl(url, {
            limit: maxPages,
            scrapeOptions: {
              formats: ["markdown"],
              actions: actions as ScrapeAction[] | undefined,
            },
          });
          pageCount = crawlResult.pages.length;
          allMarkdown = crawlResult.pages
            .map((p, i) => `### Page ${i + 1}: ${p.url}\n\n${p.markdown ?? "(no content)"}`)
            .join("\n\n---\n\n");
        } else {
          // Single page scrape
          const result = await client.scrape(url, {
            formats: ["markdown"],
            actions: actions as ScrapeAction[] | undefined,
          });
          pageCount = 1;
          allMarkdown = result.markdown ?? "(no content extracted)";
        }

        // Persist raw content
        const savedPath = persistExtraction(url, allMarkdown, schema as Record<string, unknown> | undefined, prompt);

        // Build response for the conversation LLM to do extraction
        const lines: string[] = [
          "## Web Extract Results\n",
          `**URL**: ${url}`,
          `**Pages scraped**: ${pageCount}`,
          `**Output format**: ${outputFormat}`,
          `**Raw content saved to**: ${savedPath}\n`,
        ];

        if (schema) {
          lines.push("### Extraction Schema\n");
          lines.push("```json");
          lines.push(JSON.stringify(schema, null, 2));
          lines.push("```\n");
        }

        if (prompt) {
          lines.push(`### Extraction Instructions\n\n${prompt}\n`);
        }

        lines.push("### Page Content\n");
        // Truncate very large content to avoid overwhelming context
        const maxContentLength = 50_000;
        if (allMarkdown.length > maxContentLength) {
          lines.push(allMarkdown.slice(0, maxContentLength));
          lines.push(`\n\n... (truncated, ${allMarkdown.length - maxContentLength} chars omitted, full content saved to file)`);
        } else {
          lines.push(allMarkdown);
        }

        lines.push("\n\nPlease extract the structured data matching the schema/instructions above from this content" +
          (outputFormat === "csv" ? " and format as CSV." : outputFormat === "markdown" ? " and format as markdown." : " and return as JSON."));

        return { text: lines.join("\n") };
      } catch (err) {
        return { text: `Web extract failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}
