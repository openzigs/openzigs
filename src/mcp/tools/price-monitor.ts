/**
 * Price Monitor Tool
 *
 * Tracks pricing pages with historical snapshots in SQLite.
 * Scrapes via Firecrawl, returns content for LLM extraction,
 * and detects changes between snapshots.
 */

import * as z from "zod";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "../tool-registry.js";
import { getFirecrawlClient, isBlockedUrl, type ScrapeAction } from "../../browser/firecrawl-client.js";

// ── Zod Schema ───────────────────────────────────────────────────────────

const snapshotSchema = z.object({
  action: z.literal("snapshot"),
  url: z.string().url().describe("URL to monitor"),
  label: z.string().optional().describe("Friendly name for this price target"),
  scrollToLoad: z.boolean().optional().default(false).describe("Scroll page to load dynamic content"),
});

const compareSchema = z.object({
  action: z.literal("compare"),
  url: z.string().url().describe("URL to compare snapshots for"),
  previousCount: z.number().int().min(2).max(20).optional().default(2).describe("Number of snapshots to compare"),
});

const historySchema = z.object({
  action: z.literal("history"),
  url: z.string().url().describe("URL to show history for"),
  previousCount: z.number().int().min(1).max(50).optional().default(5).describe("Number of snapshots to return"),
});

const listSchema = z.object({
  action: z.literal("list"),
});

const priceMonitorSchema = z.discriminatedUnion("action", [
  snapshotSchema,
  compareSchema,
  historySchema,
  listSchema,
]);

export type PriceMonitorInput = z.infer<typeof priceMonitorSchema>;

// ── Types ────────────────────────────────────────────────────────────────

export interface PriceSnapshot {
  id: number;
  url: string;
  label: string | null;
  capturedAt: string;
  rawMarkdown: string;
  extractedJson: string | null;
  priceHash: string;
}

// ── Repository ───────────────────────────────────────────────────────────

export class PriceSnapshotRepository {
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
      CREATE TABLE IF NOT EXISTS price_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        label TEXT,
        captured_at TEXT NOT NULL DEFAULT (datetime('now')),
        raw_markdown TEXT NOT NULL,
        extracted_json TEXT,
        price_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_price_snapshots_url ON price_snapshots(url);
    `);
  }

  saveSnapshot(url: string, markdown: string, label?: string): PriceSnapshot {
    const hash = crypto.createHash("sha256").update(markdown).digest("hex").slice(0, 16);
    const stmt = this.db.prepare(`
      INSERT INTO price_snapshots (url, label, raw_markdown, price_hash)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(url, label ?? null, markdown, hash);

    return this.db.prepare(
      "SELECT id, url, label, captured_at as capturedAt, raw_markdown as rawMarkdown, extracted_json as extractedJson, price_hash as priceHash FROM price_snapshots WHERE id = ?",
    ).get(result.lastInsertRowid) as PriceSnapshot;
  }

  getLatestSnapshots(url: string, limit = 5): PriceSnapshot[] {
    return this.db.prepare(`
      SELECT id, url, label, captured_at as capturedAt, raw_markdown as rawMarkdown,
             extracted_json as extractedJson, price_hash as priceHash
      FROM price_snapshots WHERE url = ? ORDER BY id DESC LIMIT ?
    `).all(url, limit) as PriceSnapshot[];
  }

  listMonitoredUrls(): { url: string; label: string | null; snapshotCount: number; lastCapture: string }[] {
    return this.db.prepare(`
      SELECT url, MAX(label) as label, COUNT(*) as snapshotCount, MAX(captured_at) as lastCapture
      FROM price_snapshots GROUP BY url ORDER BY MAX(captured_at) DESC
    `).all() as { url: string; label: string | null; snapshotCount: number; lastCapture: string }[];
  }

  /** Expose the database for testing. */
  getDb(): Database.Database {
    return this.db;
  }
}

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createPriceMonitorTool(repo?: PriceSnapshotRepository): ToolDefinition {
  const repository = repo ?? new PriceSnapshotRepository();

  return {
    name: "price-monitor",
    description:
      "Monitor prices on web pages with historical snapshots. " +
      "Actions: 'snapshot' to capture current prices, 'compare' to diff recent snapshots, " +
      "'history' to view past snapshots, 'list' all monitored URLs. " +
      "Persists snapshots in SQLite for change detection.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["snapshot", "compare", "history", "list"], description: "Action to perform" },
        url: { type: "string", description: "URL to monitor (required for snapshot/compare/history)" },
        label: { type: "string", description: "Friendly name for this price target (snapshot only)" },
        scrollToLoad: { type: "boolean", description: "Scroll page to load dynamic content (snapshot only)" },
        previousCount: { type: "number", description: "Number of snapshots to return/compare (default: 5)" },
      },
      required: ["action"],
    },
    zodSchema: priceMonitorSchema,
    category: "data",
    riskLevel: "medium",
    handler: async (args) => {
      const parsed = priceMonitorSchema.parse(args);

      switch (parsed.action) {
        case "snapshot": {
          if (isBlockedUrl(parsed.url)) {
            return { text: `SSRF blocked: "${parsed.url}" targets an internal/private network address`, isError: true };
          }

          const client = getFirecrawlClient();
          if (!client.getConfig().enabled) {
            return { text: "Firecrawl is not enabled. Enable it in Admin → Settings.", isError: true };
          }

          try {
            const actions: ScrapeAction[] = [];
            if (parsed.scrollToLoad) {
              actions.push({ type: "scroll", direction: "down" });
              actions.push({ type: "wait", milliseconds: 2000 });
              actions.push({ type: "scroll", direction: "down" });
              actions.push({ type: "wait", milliseconds: 1000 });
            }

            const result = await client.scrape(parsed.url, {
              formats: ["markdown"],
              actions: actions.length > 0 ? actions : undefined,
            });

            const markdown = result.markdown ?? "(no content)";
            const snapshot = repository.saveSnapshot(parsed.url, markdown, parsed.label);

            // Check for changes from previous snapshot
            const previous = repository.getLatestSnapshots(parsed.url, 2);
            const hasChanged = previous.length >= 2 && previous[0].priceHash !== previous[1].priceHash;

            const lines: string[] = [
              "## Price Snapshot Captured\n",
              `**URL**: ${parsed.url}`,
              parsed.label ? `**Label**: ${parsed.label}` : "",
              `**Snapshot ID**: ${snapshot.id}`,
              `**Captured at**: ${snapshot.capturedAt}`,
              `**Content hash**: ${snapshot.priceHash}`,
              hasChanged ? "\n**⚠️ CHANGE DETECTED** — Content differs from previous snapshot.\n" : "\n**No change** from previous snapshot.\n",
              "### Page Content\n",
              markdown,
              "\n\nPlease extract pricing information from the content above and return as structured JSON with product names, prices, currencies, and any plan/tier details.",
            ].filter(Boolean);

            return { text: lines.join("\n") };
          } catch (err) {
            return { text: `Price snapshot failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        }

        case "compare": {
          const snapshots = repository.getLatestSnapshots(parsed.url, parsed.previousCount);
          if (snapshots.length < 2) {
            return { text: `Need at least 2 snapshots to compare. Found ${snapshots.length} for ${parsed.url}.` };
          }

          const lines: string[] = [
            "## Price Comparison\n",
            `**URL**: ${parsed.url}`,
            `**Snapshots compared**: ${snapshots.length}\n`,
          ];

          for (let i = 0; i < snapshots.length - 1; i++) {
            const newer = snapshots[i];
            const older = snapshots[i + 1];
            const changed = newer.priceHash !== older.priceHash;

            lines.push(`### ${newer.capturedAt} vs ${older.capturedAt}`);
            lines.push(`Hash: ${newer.priceHash} vs ${older.priceHash}`);
            lines.push(changed ? "**⚠️ Content changed**" : "No change");

            if (changed) {
              lines.push("\n**Newer content:**\n");
              lines.push(newer.rawMarkdown.slice(0, 5000));
              lines.push("\n**Older content:**\n");
              lines.push(older.rawMarkdown.slice(0, 5000));
            }
            lines.push("");
          }

          lines.push("\nPlease analyze the differences and highlight any price changes, new plans, or removed offerings.");
          return { text: lines.join("\n") };
        }

        case "history": {
          const snapshots = repository.getLatestSnapshots(parsed.url, parsed.previousCount);
          if (snapshots.length === 0) {
            return { text: `No snapshots found for ${parsed.url}. Use action='snapshot' to capture one.` };
          }

          const lines: string[] = [
            "## Price History\n",
            `**URL**: ${parsed.url}`,
            `**Snapshots**: ${snapshots.length}\n`,
            "| # | Date | Hash | Changed |",
            "|---|------|------|---------|",
          ];

          for (let i = 0; i < snapshots.length; i++) {
            const s = snapshots[i];
            const prev = snapshots[i + 1];
            const changed = prev ? (s.priceHash !== prev.priceHash ? "Yes" : "No") : "—";
            lines.push(`| ${s.id} | ${s.capturedAt} | ${s.priceHash} | ${changed} |`);
          }

          return { text: lines.join("\n") };
        }

        case "list": {
          const urls = repository.listMonitoredUrls();
          if (urls.length === 0) {
            return { text: "No URLs being monitored. Use action='snapshot' with a URL to start." };
          }

          const lines: string[] = [
            "## Monitored Price URLs\n",
            "| URL | Label | Snapshots | Last Capture |",
            "|-----|-------|-----------|--------------|",
          ];

          for (const u of urls) {
            lines.push(`| ${u.url} | ${u.label ?? "—"} | ${u.snapshotCount} | ${u.lastCapture} |`);
          }

          return { text: lines.join("\n") };
        }
      }
    },
  };
}
