/**
 * Competitive Intelligence Monitor Tool
 *
 * Periodically crawls competitor websites using Firecrawl and compares
 * content changes, metadata updates, and SEO strategy shifts against
 * a baseline snapshot. Uses SQLite for persistence.
 */

import * as z from "zod";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "../tool-registry.js";
import { getFirecrawlClient, isBlockedUrl } from "../../browser/firecrawl-client.js";
import { extractContent, type ExtractedContent } from "./seo/html-extractor.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface CompetitorSnapshot {
  id: number;
  competitorUrl: string;
  capturedAt: string;
  pageCount: number;
  totalWordCount: number;
  avgReadability: number;
  schemaTypes: string;
  topKeywords: string;
  metaTitles: string;
}

export interface CompetitorDiff {
  competitorUrl: string;
  previous: CompetitorSnapshot;
  current: CompetitorSnapshot;
  changes: DiffChange[];
}

export interface DiffChange {
  field: string;
  previous: string | number;
  current: string | number;
  direction: "increased" | "decreased" | "changed";
}

// ── Zod Schemas ──────────────────────────────────────────────────────────

const addCompetitorSchema = z.object({
  action: z.literal("add"),
  url: z.string().url().describe("Competitor website URL to monitor"),
  name: z.string().optional().describe("Friendly name for the competitor"),
});

const removeCompetitorSchema = z.object({
  action: z.literal("remove"),
  url: z.string().url().describe("Competitor URL to stop monitoring"),
});

const snapshotCompetitorSchema = z.object({
  action: z.literal("snapshot"),
  url: z.string().url().optional().describe("Specific competitor URL, or omit for all"),
  maxPages: z.number().int().min(1).max(100).optional().default(20).describe("Max pages to crawl per competitor"),
});

const reportSchema = z.object({
  action: z.literal("report"),
  url: z.string().url().optional().describe("Specific competitor URL, or omit for all"),
});

const listSchema = z.object({
  action: z.literal("list"),
});

const competitorMonitorSchema = z.discriminatedUnion("action", [
  addCompetitorSchema,
  removeCompetitorSchema,
  snapshotCompetitorSchema,
  reportSchema,
  listSchema,
]);

// ── Repository ───────────────────────────────────────────────────────────

export class CompetitorRepository {
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
      CREATE TABLE IF NOT EXISTS competitive_monitors (
        url TEXT PRIMARY KEY,
        name TEXT,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_snapshot_at TEXT
      );
      CREATE TABLE IF NOT EXISTS competitive_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        competitor_url TEXT NOT NULL REFERENCES competitive_monitors(url) ON DELETE CASCADE,
        captured_at TEXT NOT NULL DEFAULT (datetime('now')),
        page_count INTEGER NOT NULL DEFAULT 0,
        total_word_count INTEGER NOT NULL DEFAULT 0,
        avg_readability REAL NOT NULL DEFAULT 0,
        schema_types TEXT NOT NULL DEFAULT '[]',
        top_keywords TEXT NOT NULL DEFAULT '[]',
        meta_titles TEXT NOT NULL DEFAULT '[]'
      );
    `);
  }

  addCompetitor(url: string, name?: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO competitive_monitors (url, name) VALUES (?, ?)",
    ).run(url, name ?? null);
  }

  removeCompetitor(url: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM competitive_monitors WHERE url = ?",
    ).run(url);
    return result.changes > 0;
  }

  listCompetitors(): { url: string; name: string | null; addedAt: string; lastSnapshotAt: string | null }[] {
    return this.db.prepare(
      "SELECT url, name, added_at as addedAt, last_snapshot_at as lastSnapshotAt FROM competitive_monitors ORDER BY added_at",
    ).all() as { url: string; name: string | null; addedAt: string; lastSnapshotAt: string | null }[];
  }

  saveSnapshot(competitorUrl: string, snapshot: Omit<CompetitorSnapshot, "id" | "competitorUrl" | "capturedAt">): void {
    this.db.prepare(`
      INSERT INTO competitive_snapshots (competitor_url, page_count, total_word_count, avg_readability, schema_types, top_keywords, meta_titles)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      competitorUrl,
      snapshot.pageCount,
      snapshot.totalWordCount,
      snapshot.avgReadability,
      snapshot.schemaTypes,
      snapshot.topKeywords,
      snapshot.metaTitles,
    );
    this.db.prepare(
      "UPDATE competitive_monitors SET last_snapshot_at = datetime('now') WHERE url = ?",
    ).run(competitorUrl);
  }

  getLatestSnapshots(competitorUrl: string, limit = 2): CompetitorSnapshot[] {
    return this.db.prepare(`
      SELECT id, competitor_url as competitorUrl, captured_at as capturedAt,
             page_count as pageCount, total_word_count as totalWordCount,
             avg_readability as avgReadability, schema_types as schemaTypes,
             top_keywords as topKeywords, meta_titles as metaTitles
      FROM competitive_snapshots
      WHERE competitor_url = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(competitorUrl, limit) as CompetitorSnapshot[];
  }

  /** Expose the database for testing. */
  getDb(): Database.Database {
    return this.db;
  }
}

// ── Diff Logic ───────────────────────────────────────────────────────────

export function computeDiff(current: CompetitorSnapshot, previous: CompetitorSnapshot): DiffChange[] {
  const changes: DiffChange[] = [];

  if (current.pageCount !== previous.pageCount) {
    changes.push({
      field: "pageCount",
      previous: previous.pageCount,
      current: current.pageCount,
      direction: current.pageCount > previous.pageCount ? "increased" : "decreased",
    });
  }

  if (current.totalWordCount !== previous.totalWordCount) {
    changes.push({
      field: "totalWordCount",
      previous: previous.totalWordCount,
      current: current.totalWordCount,
      direction: current.totalWordCount > previous.totalWordCount ? "increased" : "decreased",
    });
  }

  if (Math.abs(current.avgReadability - previous.avgReadability) > 1) {
    changes.push({
      field: "avgReadability",
      previous: Number(previous.avgReadability.toFixed(1)),
      current: Number(current.avgReadability.toFixed(1)),
      direction: current.avgReadability > previous.avgReadability ? "increased" : "decreased",
    });
  }

  if (current.schemaTypes !== previous.schemaTypes) {
    changes.push({
      field: "schemaTypes",
      previous: previous.schemaTypes,
      current: current.schemaTypes,
      direction: "changed",
    });
  }

  return changes;
}

/** Aggregate extracted content from multiple pages into snapshot metrics. */
export function aggregatePages(pages: ExtractedContent[]): Omit<CompetitorSnapshot, "id" | "competitorUrl" | "capturedAt"> {
  const totalWordCount = pages.reduce((a, p) => a + p.wordCount, 0);
  const avgReadability = pages.length > 0
    ? pages.reduce((a, p) => a + p.readabilityScore, 0) / pages.length
    : 0;

  const allSchemaTypes = [...new Set(pages.flatMap((p) => p.schemaMarkup.map((s) => s.type)))];
  const allKeywords = pages.flatMap((p) => p.keywords);
  const keywordMap = new Map<string, number>();
  for (const kw of allKeywords) {
    keywordMap.set(kw.term, (keywordMap.get(kw.term) ?? 0) + kw.tfidf);
  }
  const topKeywords = [...keywordMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([term]) => term);

  const metaTitles = pages
    .filter((p) => p.metaTitle)
    .map((p) => p.metaTitle)
    .slice(0, 20);

  return {
    pageCount: pages.length,
    totalWordCount,
    avgReadability,
    schemaTypes: JSON.stringify(allSchemaTypes),
    topKeywords: JSON.stringify(topKeywords),
    metaTitles: JSON.stringify(metaTitles),
  };
}

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createCompetitorMonitorTool(repo?: CompetitorRepository): ToolDefinition {
  const repository = repo ?? new CompetitorRepository();

  return {
    name: "competitive-monitor",
    description:
      "Monitor competitor websites for SEO and content changes. " +
      "Actions: 'add' a competitor URL, 'remove' one, 'snapshot' to crawl and capture metrics, " +
      "'report' to compare latest snapshots and show changes, 'list' all monitored competitors.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove", "snapshot", "report", "list"], description: "Action to perform" },
        url: { type: "string", description: "Competitor URL" },
        name: { type: "string", description: "Friendly name (add only)" },
        maxPages: { type: "number", description: "Max pages to crawl (snapshot only, default: 20)" },
      },
      required: ["action"],
    },
    zodSchema: competitorMonitorSchema,
    category: "search",
    riskLevel: "medium",
    handler: async (args) => {
      const parsed = competitorMonitorSchema.parse(args);

      switch (parsed.action) {
        case "add": {
          if (isBlockedUrl(parsed.url)) {
            return { text: `SSRF blocked: "${parsed.url}" targets an internal network`, isError: true };
          }
          repository.addCompetitor(parsed.url, parsed.name);
          return { text: `Added competitor: ${parsed.url}${parsed.name ? ` (${parsed.name})` : ""}` };
        }

        case "remove": {
          const removed = repository.removeCompetitor(parsed.url);
          return { text: removed ? `Removed competitor: ${parsed.url}` : `Competitor not found: ${parsed.url}` };
        }

        case "list": {
          const competitors = repository.listCompetitors();
          if (competitors.length === 0) {
            return { text: "No competitors being monitored. Use action='add' to add one." };
          }
          return {
            text: `Monitored competitors (${competitors.length}):\n\n` +
              JSON.stringify(competitors, null, 2),
          };
        }

        case "snapshot": {
          const client = getFirecrawlClient();
          if (!client.getConfig().enabled) {
            return { text: "Firecrawl is not enabled. Set firecrawl.enabled=true.", isError: true };
          }

          const competitors = parsed.url
            ? [{ url: parsed.url }]
            : repository.listCompetitors();

          if (competitors.length === 0) {
            return { text: "No competitors to snapshot. Add some first.", isError: true };
          }

          const results: string[] = [];
          for (const comp of competitors) {
            try {
              if (isBlockedUrl(comp.url)) continue;
              const crawlResult = await client.crawl(comp.url, {
                limit: parsed.maxPages,
                maxDepth: 2,
                scrapeOptions: { formats: ["html"] },
              });

              const extractedPages: ExtractedContent[] = [];
              for (const page of crawlResult.pages) {
                if (!page.html) continue;
                extractedPages.push(extractContent(page.html, page.url));
              }

              const metrics = aggregatePages(extractedPages);
              repository.saveSnapshot(comp.url, metrics);
              results.push(`✅ ${comp.url}: ${metrics.pageCount} pages, ${metrics.totalWordCount} words`);
            } catch (err) {
              results.push(`❌ ${comp.url}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          return { text: `Snapshot complete:\n${results.join("\n")}` };
        }

        case "report": {
          const competitors = parsed.url
            ? [{ url: parsed.url }]
            : repository.listCompetitors();

          if (competitors.length === 0) {
            return { text: "No competitors to report on.", isError: true };
          }

          const reports: string[] = [];
          for (const comp of competitors) {
            const snapshots = repository.getLatestSnapshots(comp.url, 2);
            if (snapshots.length === 0) {
              reports.push(`⚠️ ${comp.url}: No snapshots yet. Run 'snapshot' first.`);
              continue;
            }
            if (snapshots.length === 1) {
              reports.push(`📊 ${comp.url}: Only 1 snapshot (baseline). Run 'snapshot' again later for comparison.\n  Pages: ${snapshots[0].pageCount}, Words: ${snapshots[0].totalWordCount}`);
              continue;
            }

            const [current, previous] = snapshots;
            const changes = computeDiff(current, previous);

            if (changes.length === 0) {
              reports.push(`📊 ${comp.url}: No significant changes detected.`);
            } else {
              const changeLines = changes.map((c) =>
                `  - ${c.field}: ${c.previous} → ${c.current} (${c.direction})`,
              );
              reports.push(`📊 ${comp.url}:\n${changeLines.join("\n")}`);
            }
          }

          return { text: `Competitive Intelligence Report:\n\n${reports.join("\n\n")}` };
        }

        default:
          return { text: `Unknown action`, isError: true };
      }
    },
  };
}
