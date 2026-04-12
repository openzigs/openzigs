/**
 * Scheduled Audits & Historical Trends (#848)
 *
 * SQLite table `seo_audit_snapshots` for audit history.
 * Stores health score, issue counts, page count per run.
 * Compare current vs previous audit. Detect regressions.
 */

import type Database from "better-sqlite3";
import type { HealthScoreResult } from "./health-score.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface AuditSnapshot {
  id: number;
  siteUrl: string;
  healthScore: number;
  rating: string;
  pagesAudited: number;
  totalIssues: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  dataJson: string;
  createdAt: string;
}

export interface AuditComparison {
  current: AuditSnapshot;
  previous: AuditSnapshot | null;
  scoreDelta: number;
  newIssues: number;
  resolvedIssues: number;
  regressions: string[];
}

// ── Repository ───────────────────────────────────────────────────────────

export class AuditHistoryRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seo_audit_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_url TEXT NOT NULL,
        health_score INTEGER NOT NULL DEFAULT 0,
        rating TEXT NOT NULL DEFAULT 'poor',
        pages_audited INTEGER NOT NULL DEFAULT 0,
        total_issues INTEGER NOT NULL DEFAULT 0,
        critical INTEGER NOT NULL DEFAULT 0,
        high INTEGER NOT NULL DEFAULT 0,
        medium INTEGER NOT NULL DEFAULT 0,
        low INTEGER NOT NULL DEFAULT 0,
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Index for efficient site + time queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_seo_snapshots_site_url
        ON seo_audit_snapshots(site_url, created_at DESC);
    `);
  }

  /** Save a new audit snapshot */
  saveSnapshot(
    siteUrl: string,
    healthScore: HealthScoreResult,
    pagesAudited: number,
    dataJson: string,
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO seo_audit_snapshots
        (site_url, health_score, rating, pages_audited, total_issues, critical, high, medium, low, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      siteUrl,
      healthScore.score,
      healthScore.rating,
      pagesAudited,
      healthScore.totalIssues,
      healthScore.critical,
      healthScore.high,
      healthScore.medium,
      healthScore.low,
      dataJson,
    );
    return Number(info.lastInsertRowid);
  }

  /** Get a single snapshot by ID */
  getSnapshot(id: number): AuditSnapshot | undefined {
    const row = this.db
      .prepare("SELECT * FROM seo_audit_snapshots WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /** List snapshots for a site, newest first */
  listSnapshots(siteUrl: string, limit = 12): AuditSnapshot[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM seo_audit_snapshots WHERE site_url = ? ORDER BY id DESC LIMIT ?",
      )
      .all(siteUrl, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  /** List all snapshots, newest first */
  listAll(limit = 50): AuditSnapshot[] {
    const rows = this.db
      .prepare("SELECT * FROM seo_audit_snapshots ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Compare the latest two audits for a site */
  compareLatest(siteUrl: string): AuditComparison | null {
    const snapshots = this.listSnapshots(siteUrl, 2);
    if (snapshots.length === 0) return null;

    const current = snapshots[0];
    const previous = snapshots.length > 1 ? snapshots[1] : null;

    const scoreDelta = previous
      ? current.healthScore - previous.healthScore
      : 0;
    const newIssues = previous
      ? Math.max(0, current.totalIssues - previous.totalIssues)
      : current.totalIssues;
    const resolvedIssues = previous
      ? Math.max(0, previous.totalIssues - current.totalIssues)
      : 0;

    const regressions: string[] = [];
    if (previous) {
      if (current.critical > previous.critical)
        regressions.push(
          `Critical issues increased: ${previous.critical} → ${current.critical}`,
        );
      if (current.high > previous.high)
        regressions.push(
          `High issues increased: ${previous.high} → ${current.high}`,
        );
      if (current.healthScore < previous.healthScore - 5)
        regressions.push(
          `Health score dropped by ${previous.healthScore - current.healthScore} points`,
        );
    }

    return {
      current,
      previous,
      scoreDelta,
      newIssues,
      resolvedIssues,
      regressions,
    };
  }

  private mapRow(row: Record<string, unknown>): AuditSnapshot {
    return {
      id: row.id as number,
      siteUrl: row.site_url as string,
      healthScore: row.health_score as number,
      rating: row.rating as string,
      pagesAudited: row.pages_audited as number,
      totalIssues: row.total_issues as number,
      critical: row.critical as number,
      high: row.high as number,
      medium: row.medium as number,
      low: row.low as number,
      dataJson: row.data_json as string,
      createdAt: row.created_at as string,
    };
  }
}
