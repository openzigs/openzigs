/**
 * Web Map Tool
 *
 * Discovers all URLs on a website using Firecrawl's map endpoint.
 * Returns a structured list of discovered URLs, optionally filtered by search query.
 * Results are saved to SQLite for reuse.
 */

import * as z from "zod";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "../tool-registry.js";
import { getFirecrawlClient, isBlockedUrl } from "../../browser/firecrawl-client.js";

// ── Zod Schema ───────────────────────────────────────────────────────────

const webMapSchema = z.object({
  url: z.string().url().describe("Root URL to map"),
  includeSubdomains: z.boolean().optional().default(false).describe("Include subdomains in map results"),
  limit: z.number().int().min(1).max(5000).optional().default(100).describe("Max number of URLs to discover (default: 100, max: 5000)"),
  search: z.string().optional().describe("Filter URLs matching this query"),
});

export type WebMapInput = z.infer<typeof webMapSchema>;

// ── SQLite Repository ────────────────────────────────────────────────────

export class MapRepository {
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
      CREATE TABLE IF NOT EXISTS web_maps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_url TEXT NOT NULL,
        search_query TEXT,
        url_count INTEGER NOT NULL DEFAULT 0,
        urls_json TEXT NOT NULL DEFAULT '[]',
        mapped_at TEXT NOT NULL DEFAULT (datetime('now')),
        domain TEXT NOT NULL
      );
    `);
  }

  saveMap(rootUrl: string, urls: string[], searchQuery?: string): number {
    const domain = sanitizeDomain(rootUrl);
    const result = this.db.prepare(`
      INSERT INTO web_maps (root_url, search_query, url_count, urls_json, domain)
      VALUES (?, ?, ?, ?, ?)
    `).run(rootUrl, searchQuery ?? null, urls.length, JSON.stringify(urls), domain);
    return Number(result.lastInsertRowid);
  }

  getLatestMap(rootUrl: string): MapRow | undefined {
    return this.db.prepare(`
      SELECT id, root_url as rootUrl, search_query as searchQuery,
             url_count as urlCount, urls_json as urlsJson,
             mapped_at as mappedAt, domain
      FROM web_maps
      WHERE root_url = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(rootUrl) as MapRow | undefined;
  }

  listMaps(limit = 50): MapRow[] {
    return this.db.prepare(`
      SELECT id, root_url as rootUrl, search_query as searchQuery,
             url_count as urlCount, mapped_at as mappedAt, domain
      FROM web_maps
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as MapRow[];
  }

  getDb(): Database.Database {
    return this.db;
  }
}

export interface MapRow {
  id: number;
  rootUrl: string;
  searchQuery: string | null;
  urlCount: number;
  urlsJson?: string;
  mappedAt: string;
  domain: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sanitizeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  } catch {
    return "unknown";
  }
}

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createWebMapTool(repo?: MapRepository): ToolDefinition {
  const repository = repo ?? new MapRepository();

  return {
    name: "web-map",
    description:
      "Discover all URLs on a website without scraping content. Returns a structured list of pages, " +
      "useful for understanding site structure before crawling or extracting. Supports filtering by " +
      "search query and subdomain inclusion. Results are cached in SQLite for reuse.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Root URL to map" },
        includeSubdomains: { type: "boolean", description: "Include subdomains (default: false)" },
        limit: { type: "number", description: "Max URLs to discover (default: 100, max: 5000)" },
        search: { type: "string", description: "Filter URLs matching this query" },
      },
      required: ["url"],
    },
    zodSchema: webMapSchema,
    category: "data",
    riskLevel: "low",
    handler: async (args) => {
      const parsed = webMapSchema.parse(args);
      const { url, includeSubdomains, limit, search } = parsed;

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

      try {
        const mapResult = await client.map(url, {
          limit,
          search,
        });

        let urls = mapResult.urls;

        // Filter subdomains if not requested
        if (!includeSubdomains) {
          const rootDomain = new URL(url).hostname;
          urls = urls.filter((u) => {
            try {
              return new URL(u).hostname === rootDomain;
            } catch {
              return false;
            }
          });
        }

        // Save to SQLite
        repository.saveMap(url, urls, search);

        // Build response
        const lines: string[] = [
          "## Site Map Results\n",
          `**Root URL**: ${url}`,
          `**URLs discovered**: ${urls.length}`,
          search ? `**Search filter**: ${search}` : "",
          includeSubdomains ? "**Including subdomains**: yes" : "",
          "",
        ].filter(Boolean);

        // Group URLs by path depth for better readability
        const grouped = new Map<string, string[]>();
        for (const u of urls) {
          try {
            const parsed = new URL(u);
            const pathParts = parsed.pathname.split("/").filter(Boolean);
            const section = pathParts[0] ?? "(root)";
            if (!grouped.has(section)) grouped.set(section, []);
            grouped.get(section)!.push(u);
          } catch {
            if (!grouped.has("(other)")) grouped.set("(other)", []);
            grouped.get("(other)")!.push(u);
          }
        }

        lines.push("### Discovered URLs\n");
        for (const [section, sectionUrls] of grouped) {
          lines.push(`**/${section}** (${sectionUrls.length} pages)`);
          for (const u of sectionUrls.slice(0, 20)) {
            lines.push(`- ${u}`);
          }
          if (sectionUrls.length > 20) {
            lines.push(`- ... and ${sectionUrls.length - 20} more`);
          }
          lines.push("");
        }

        return { text: lines.join("\n") };
      } catch (err) {
        return { text: `Web map failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}
