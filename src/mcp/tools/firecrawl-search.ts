/**
 * Firecrawl Search Tool
 *
 * Standalone MCP tool for explicit web search via Firecrawl's /v2/search endpoint.
 * Uses DuckDuckGo fallback in self-hosted mode (no API key needed).
 * Returns search results with optional scraped markdown content.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import {
  getFirecrawlClient,
  type SearchResult,
} from "../../browser/firecrawl-client.js";

// ── Zod Schema ───────────────────────────────────────────────────────────

const firecrawlSearchSchema = z.object({
  query: z.string().min(1).describe("Search query string"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe("Number of results to return (default: 5, max: 20)"),
  lang: z
    .string()
    .optional()
    .describe("Language code for search results (e.g., 'en')"),
  country: z
    .string()
    .optional()
    .describe("Country code for search results (e.g., 'us')"),
});

export type FirecrawlSearchInput = z.infer<typeof firecrawlSearchSchema>;

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createFirecrawlSearchTool(): ToolDefinition {
  return {
    name: "firecrawl-search",
    description:
      "Search the web using Firecrawl's self-hosted search engine (DuckDuckGo fallback). " +
      "Returns search results with titles, URLs, and scraped markdown content. " +
      "Requires the Firecrawl Docker sidecar to be running.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        limit: {
          type: "number",
          description: "Number of results to return (default: 5, max: 20)",
        },
        lang: {
          type: "string",
          description: "Language code (e.g., 'en')",
        },
        country: {
          type: "string",
          description: "Country code (e.g., 'us')",
        },
      },
      required: ["query"],
    },
    zodSchema: firecrawlSearchSchema,
    category: "search",
    riskLevel: "low",
    handler: async (args) => {
      const input = args as FirecrawlSearchInput;
      const client = getFirecrawlClient();

      if (!client.getConfig().enabled) {
        return {
          text: "Firecrawl is not enabled. Set firecrawl.enabled to true in config.",
          isError: true,
        };
      }

      try {
        const available = await client.isAvailable();
        if (!available) {
          return {
            text: "Firecrawl sidecar is not running. Start it with: docker compose -f docker-compose.firecrawl.yml up -d",
            isError: true,
          };
        }

        const results = await client.search(input.query, {
          limit: input.limit,
          lang: input.lang,
          country: input.country,
        });

        if (results.length === 0) {
          return { text: `No results found for: "${input.query}"` };
        }

        const formatted = formatSearchResults(input.query, results);
        return { text: formatted };
      } catch (err) {
        return {
          text: `Firecrawl search failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

// ── Formatting ───────────────────────────────────────────────────────────

function formatSearchResults(query: string, results: SearchResult[]): string {
  const lines: string[] = [
    `## Firecrawl Search Results`,
    `**Query**: "${query}"`,
    `**Results**: ${results.length}`,
    "",
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`### ${i + 1}. ${r.title || "(no title)"}`);
    lines.push(`**URL**: ${r.url}`);
    if (r.description) {
      lines.push(`**Description**: ${r.description}`);
    }
    if (r.markdown && r.markdown.trim().length > 0) {
      const preview =
        r.markdown.length > 500 ? r.markdown.slice(0, 500) + "..." : r.markdown;
      lines.push(`\n${preview}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
