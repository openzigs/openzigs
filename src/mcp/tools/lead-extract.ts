/**
 * Lead Extract Tool
 *
 * Specialized tool for contact/company extraction from websites.
 * Maps the target site to discover contact-related pages, batch scrapes them,
 * and returns content for LLM-powered contact extraction.
 * Persists results to ~/.openzigs/extractions/leads/.
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

// ── Schema ───────────────────────────────────────────────────────────────

const leadExtractSchema = z.object({
  url: z.string().url().describe("Company website URL"),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Max pages to scan"),
  includePatterns: z
    .array(z.string())
    .optional()
    .describe("Additional URL patterns to include"),
  outputTo: outputToSchema.describe(
    "Optional: write extracted leads to Airtable or Google Sheets",
  ),
});

export type LeadExtractInput = z.infer<typeof leadExtractSchema>;

// ── Built-in contact schema ──────────────────────────────────────────────

const CONTACT_SCHEMA = {
  contacts: [
    {
      name: "string",
      title: "string",
      email: "string (optional)",
      phone: "string (optional)",
      linkedin: "string (optional)",
      department: "string (optional)",
    },
  ],
  company: {
    name: "string",
    website: "string",
    industry: "string (optional)",
    size: "string (optional)",
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────

const CONTACT_PAGE_PATTERNS = [
  /team/i,
  /about/i,
  /contact/i,
  /leadership/i,
  /people/i,
  /staff/i,
  /board/i,
  /management/i,
  /executives/i,
  /who-we-are/i,
];

function getLeadsDir(): string {
  return path.join(os.homedir(), ".openzigs", "extractions", "leads");
}

function sanitizeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  } catch {
    return "unknown";
  }
}

function filterContactUrls(
  urls: string[],
  includePatterns?: string[],
): string[] {
  const extraPatterns = (includePatterns ?? []).map((p) => new RegExp(p, "i"));
  const allPatterns = [...CONTACT_PAGE_PATTERNS, ...extraPatterns];

  return urls.filter((u) => {
    try {
      const urlPath = new URL(u).pathname.toLowerCase();
      return allPatterns.some((p) => p.test(urlPath));
    } catch {
      return false;
    }
  });
}

function persistLeads(url: string, markdown: string): string {
  const domain = sanitizeDomain(url);
  const dir = path.join(getLeadsDir(), domain);
  fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `${ts}.md`);

  const content = [
    `# Lead Extract: ${url}`,
    `\nCaptured: ${new Date().toISOString()}\n`,
    `## Contact Schema\n`,
    "```json",
    JSON.stringify(CONTACT_SCHEMA, null, 2),
    "```\n",
    `## Scraped Content\n`,
    markdown,
  ].join("\n");

  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createLeadExtractTool(
  vault?: SecretVaultService | null,
): ToolDefinition {
  return {
    name: "lead-extract",
    description:
      "Extract contacts and company information from a website. Maps the site to discover " +
      "team/about/contact pages, scrapes them, and returns content for structured contact extraction. " +
      "Results are saved to ~/.openzigs/extractions/leads/.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Company website URL" },
        maxPages: {
          type: "number",
          description: "Max pages to scan (default: 10)",
        },
        includePatterns: {
          type: "array",
          description: "Additional URL path patterns to include (regex)",
        },
        outputTo: {
          type: "object",
          description:
            "Optional: write extracted leads to Airtable or Google Sheets",
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
    zodSchema: leadExtractSchema,
    category: "data",
    riskLevel: "medium",
    handler: async (args) => {
      const parsed = leadExtractSchema.parse(args);
      const { url, maxPages, includePatterns, outputTo } = parsed;

      if (isBlockedUrl(url)) {
        return {
          text: `SSRF blocked: "${url}" targets an internal/private network address`,
          isError: true,
        };
      }

      const client = getFirecrawlClient();
      if (!client.getConfig().enabled) {
        return {
          text: "Firecrawl is not enabled. Enable it in Admin → Settings or set firecrawl.enabled=true in config.",
          isError: true,
        };
      }

      try {
        // Step 1: Map the site to discover contact-related pages
        const searchTerms = "team about contact leadership people";
        const mapResult = await client.map(url, { search: searchTerms });

        if (mapResult.urls.length === 0) {
          return {
            text: `No pages found on ${url}. The site may block crawling or require authentication.`,
            isError: true,
          };
        }

        // Step 2: Filter for contact-related pages
        let contactUrls = filterContactUrls(mapResult.urls, includePatterns);

        // Always include the root URL as a fallback
        const rootUrl = new URL(url).origin;
        if (!contactUrls.includes(url) && !contactUrls.includes(rootUrl)) {
          contactUrls.unshift(url);
        }

        // Limit to maxPages
        contactUrls = contactUrls.slice(0, maxPages);

        if (contactUrls.length === 0) {
          return {
            text: `No contact/team/about pages found on ${url}. Found ${mapResult.urls.length} total URLs but none matched contact patterns.`,
            isError: true,
          };
        }

        // Step 3: Batch scrape the contact pages
        const batchResult = await client.batchScrape(contactUrls, {
          formats: ["markdown"],
        });

        const allMarkdown = batchResult.results
          .map(
            (r, i) =>
              `### Page ${i + 1}: ${r.url ?? contactUrls[i]}\n\n${r.markdown ?? "(no content)"}`,
          )
          .join("\n\n---\n\n");

        // Step 4: Persist
        const savedPath = persistLeads(url, allMarkdown);

        // Step 5: Build response
        const lines: string[] = [
          "## Lead Extract Results\n",
          `**Target**: ${url}`,
          `**Total URLs discovered**: ${mapResult.urls.length}`,
          `**Contact pages found**: ${contactUrls.length}`,
          `**Pages scraped**: ${batchResult.results.length}`,
          `**Results saved to**: ${savedPath}\n`,
          "### Contact Extraction Schema\n",
          "```json",
          JSON.stringify(CONTACT_SCHEMA, null, 2),
          "```\n",
          "### Scraped Contact Pages\n",
          allMarkdown,
        ];
        lines.push(
          "\n\nPlease extract all contacts and company information from the above content, matching the JSON schema provided. Return a JSON object with 'contacts' array and 'company' object.",
        );

        // Optional: write lead rows to Airtable or Sheets
        if (outputTo) {
          const rows = batchResult.results.map((r, i) => ({
            url: r.url ?? contactUrls[i],
            pageTitle: (r.metadata?.title as string) ?? "",
            contentLength: (r.markdown ?? "").length,
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
          text: `Lead extract failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

// Export for testing
export { filterContactUrls, CONTACT_SCHEMA };
