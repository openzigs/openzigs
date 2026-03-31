/**
 * Web Extract Tool
 *
 * Scrapes a URL via Firecrawl and returns structured content for LLM extraction.
 * The conversation LLM performs the actual data extraction from the markdown.
 * Persists raw content to SQLite `web_extractions` table and filesystem.
 */

import * as z from "zod";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "../tool-registry.js";
import { getFirecrawlClient, isBlockedUrl, type ScrapeAction } from "../../browser/firecrawl-client.js";

// ── Extraction Templates ─────────────────────────────────────────────────

export const EXTRACTION_TEMPLATES: Record<string, { name: string; schema: Record<string, unknown> }> = {
  contacts: {
    name: "Contacts / Team Members",
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          title: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          linkedin: { type: "string" },
        },
      },
    },
  },
  pricing: {
    name: "Pricing Plans",
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          plan_name: { type: "string" },
          price: { type: "string" },
          billing_cycle: { type: "string" },
          features: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  jobs: {
    name: "Job Listings",
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          location: { type: "string" },
          salary_range: { type: "string" },
          requirements: { type: "array", items: { type: "string" } },
          url: { type: "string" },
        },
      },
    },
  },
  products: {
    name: "Products / Services",
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          price: { type: "string" },
          category: { type: "string" },
          url: { type: "string" },
        },
      },
    },
  },
};

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
  template: z.enum(["contacts", "pricing", "jobs", "products"]).optional().describe("Pre-built extraction template name"),
  actions: z.array(scrapeActionSchema).optional().describe("Actions to perform before extraction (click, scroll, etc.)"),
  maxPages: z.number().int().min(1).max(50).optional().default(1).describe("If >1, crawl and extract from multiple pages"),
  outputFormat: z.enum(["json", "csv", "markdown"]).optional().default("json").describe("Desired output format"),
});

export type WebExtractInput = z.infer<typeof webExtractSchema>;

// ── SQLite Repository ────────────────────────────────────────────────────

export class ExtractionRepository {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    if (db) {
      this.db = db;
    } else {
      const dbPath = path.join(os.homedir(), ".openzigs", "openzigs.db");
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
    }
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_extractions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schema_json TEXT,
        scraped_markdown TEXT NOT NULL,
        extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
        domain TEXT NOT NULL
      );
    `);
  }

  saveExtraction(url: string, prompt: string, markdown: string, schema?: Record<string, unknown>): number {
    const domain = sanitizeDomain(url);
    const result = this.db.prepare(`
      INSERT INTO web_extractions (url, prompt, schema_json, scraped_markdown, domain)
      VALUES (?, ?, ?, ?, ?)
    `).run(url, prompt, schema ? JSON.stringify(schema) : null, markdown, domain);
    return Number(result.lastInsertRowid);
  }

  listExtractions(limit = 50, offset = 0): ExtractionRow[] {
    return this.db.prepare(`
      SELECT id, url, prompt, schema_json as schemaJson, extracted_at as extractedAt, domain,
             substr(scraped_markdown, 1, 200) as preview
      FROM web_extractions
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as ExtractionRow[];
  }

  getExtraction(id: number): ExtractionRow | undefined {
    return this.db.prepare(`
      SELECT id, url, prompt, schema_json as schemaJson, scraped_markdown as scrapedMarkdown,
             extracted_at as extractedAt, domain
      FROM web_extractions
      WHERE id = ?
    `).get(id) as ExtractionRow | undefined;
  }

  count(): number {
    const row = this.db.prepare("SELECT count(*) as cnt FROM web_extractions").get() as { cnt: number };
    return row.cnt;
  }

  getDb(): Database.Database {
    return this.db;
  }
}

export interface ExtractionRow {
  id: number;
  url: string;
  prompt: string;
  schemaJson: string | null;
  scrapedMarkdown?: string;
  extractedAt: string;
  domain: string;
  preview?: string;
}

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

export function createWebExtractTool(repo?: ExtractionRepository): ToolDefinition {
  const repository = repo ?? new ExtractionRepository();

  return {
    name: "web-extract",
    description:
      "Scrape a web page and extract structured data. Provide a URL and optionally a JSON schema, " +
      "natural language prompt, or template name (contacts, pricing, jobs, products). The tool scrapes " +
      "the page via Firecrawl and returns the content for structured extraction. Supports browser actions " +
      "(click, scroll, etc.) for dynamic pages. Results are persisted to SQLite and filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to scrape and extract data from" },
        schema: { type: "object", description: "JSON schema describing desired output structure" },
        prompt: { type: "string", description: "Natural language description of what to extract" },
        template: { type: "string", enum: ["contacts", "pricing", "jobs", "products"], description: "Pre-built extraction template" },
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
      const { url, prompt, actions, maxPages, outputFormat, template } = parsed;
      let { schema } = parsed;

      // Apply template if specified (template provides default schema)
      if (template && EXTRACTION_TEMPLATES[template] && !schema) {
        schema = EXTRACTION_TEMPLATES[template].schema;
      }

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
          text: "Either 'schema' (JSON schema), 'prompt' (natural language description), or 'template' (contacts/pricing/jobs/products) is required for extraction.",
          isError: true,
        };
      }

      try {
        let allMarkdown = "";
        let pageCount = 0;

        if (maxPages && maxPages > 1) {
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
          const result = await client.scrape(url, {
            formats: ["markdown"],
            actions: actions as ScrapeAction[] | undefined,
          });
          pageCount = 1;
          allMarkdown = result.markdown ?? "(no content extracted)";
        }

        // Persist to filesystem
        const savedPath = persistExtraction(url, allMarkdown, schema as Record<string, unknown> | undefined, prompt);

        // Persist to SQLite
        const extractionPrompt = prompt ?? (template ? `Template: ${EXTRACTION_TEMPLATES[template]?.name ?? template}` : "Schema-based extraction");
        repository.saveExtraction(url, extractionPrompt, allMarkdown, schema as Record<string, unknown> | undefined);

        // Build response for the conversation LLM to do extraction
        const lines: string[] = [
          "## Web Extract Results\n",
          `**URL**: ${url}`,
          `**Pages scraped**: ${pageCount}`,
          `**Output format**: ${outputFormat}`,
          template ? `**Template**: ${EXTRACTION_TEMPLATES[template]?.name ?? template}` : "",
          `**Raw content saved to**: ${savedPath}\n`,
        ].filter(Boolean);

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
