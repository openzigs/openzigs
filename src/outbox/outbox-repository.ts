import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// ── Types ───────────────────────────────────────────────────

export type OutboxPlatform =
  | "twitter"
  | "pinterest"
  | "linkedin"
  | "facebook"
  | "youtube"
  | "reddit"
  | "instagram";

export type OutboxStatus =
  | "pending"
  | "processing"
  | "published"
  | "failed"
  | "canceled";

export type OutboxAssetType =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "text";

export interface OutboxItem {
  id: string;
  assetId: string | null;
  assetUrl: string | null;
  assetType: OutboxAssetType;
  platform: OutboxPlatform;
  scheduledTime: Date;
  agentContext: string;
  platformMetadata: Record<string, unknown>;
  status: OutboxStatus;
  error: string | null;
  publishedUrl: string | null;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface CreateOutboxInput {
  assetId?: string | null;
  assetUrl?: string | null;
  assetType?: OutboxAssetType;
  platform: OutboxPlatform;
  scheduledTime: Date;
  agentContext: string;
  platformMetadata?: Record<string, unknown>;
  maxRetries?: number;
}

export interface OutboxListFilters {
  status?: OutboxStatus;
  platform?: OutboxPlatform;
  limit?: number;
  offset?: number;
}

export interface OutboxStats {
  pending: number;
  processing: number;
  published: number;
  failed: number;
  canceled: number;
  total: number;
}

// ── Row type ────────────────────────────────────────────────

interface StoredOutboxRow {
  id: string;
  asset_id: string | null;
  asset_url: string | null;
  asset_type: string;
  platform: string;
  scheduled_time: string;
  agent_context: string;
  platform_metadata: string;
  status: string;
  error: string | null;
  published_url: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ── Converter ───────────────────────────────────────────────

const toItem = (row: StoredOutboxRow): OutboxItem => ({
  id: row.id,
  assetId: row.asset_id,
  assetUrl: row.asset_url,
  assetType: row.asset_type as OutboxAssetType,
  platform: row.platform as OutboxPlatform,
  scheduledTime: new Date(row.scheduled_time),
  agentContext: row.agent_context,
  platformMetadata: JSON.parse(row.platform_metadata) as Record<string, unknown>,
  status: row.status as OutboxStatus,
  error: row.error,
  publishedUrl: row.published_url,
  retryCount: row.retry_count,
  maxRetries: row.max_retries,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  startedAt: row.started_at ? new Date(row.started_at) : null,
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
});

// ── Valid platforms & statuses ───────────────────────────────

const VALID_PLATFORMS: Set<string> = new Set([
  "twitter", "pinterest", "linkedin", "facebook", "youtube", "reddit", "instagram",
]);
const VALID_STATUSES: Set<string> = new Set([
  "pending", "processing", "published", "failed", "canceled",
]);

// ── Repository ──────────────────────────────────────────────

export class OutboxRepository {
  private db: Database.Database;
  private clock: () => Date;

  constructor(db: Database.Database, clock?: () => Date) {
    this.db = db;
    this.clock = clock ?? (() => new Date());
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox_queue (
        id TEXT PRIMARY KEY,
        asset_id TEXT,
        asset_url TEXT,
        asset_type TEXT NOT NULL DEFAULT 'image',
        platform TEXT NOT NULL,
        scheduled_time TEXT NOT NULL,
        agent_context TEXT NOT NULL DEFAULT '',
        platform_metadata TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        published_url TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_queue(status);
      CREATE INDEX IF NOT EXISTS idx_outbox_scheduled ON outbox_queue(scheduled_time);
      CREATE INDEX IF NOT EXISTS idx_outbox_platform ON outbox_queue(platform);
    `);
  }

  insert(input: CreateOutboxInput): OutboxItem {
    if (!VALID_PLATFORMS.has(input.platform)) {
      throw new Error(`Invalid platform: ${input.platform}`);
    }
    const now = this.clock().toISOString();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO outbox_queue (id, asset_id, asset_url, asset_type, platform, scheduled_time, agent_context, platform_metadata, status, retry_count, max_retries, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      id,
      input.assetId ?? null,
      input.assetUrl ?? null,
      input.assetType ?? "image",
      input.platform,
      input.scheduledTime.toISOString(),
      input.agentContext,
      JSON.stringify(input.platformMetadata ?? {}),
      input.maxRetries ?? 3,
      now,
      now,
    );
    return this.getById(id)!;
  }

  getById(id: string): OutboxItem | null {
    const row = this.db.prepare("SELECT * FROM outbox_queue WHERE id = ?").get(id) as StoredOutboxRow | undefined;
    return row ? toItem(row) : null;
  }

  list(filters: OutboxListFilters = {}): OutboxItem[] {
    let sql = "SELECT * FROM outbox_queue WHERE 1=1";
    const params: unknown[] = [];

    if (filters.status && VALID_STATUSES.has(filters.status)) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.platform && VALID_PLATFORMS.has(filters.platform)) {
      sql += " AND platform = ?";
      params.push(filters.platform);
    }

    sql += " ORDER BY scheduled_time DESC";

    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    sql += " LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as StoredOutboxRow[];
    return rows.map(toItem);
  }

  getStats(): OutboxStats {
    const rows = this.db.prepare(
      "SELECT status, COUNT(*) as count FROM outbox_queue GROUP BY status",
    ).all() as Array<{ status: string; count: number }>;

    const stats: OutboxStats = { pending: 0, processing: 0, published: 0, failed: 0, canceled: 0, total: 0 };
    for (const row of rows) {
      const key = row.status as keyof Omit<OutboxStats, "total">;
      if (key in stats) {
        stats[key] = row.count;
      }
      stats.total += row.count;
    }
    return stats;
  }

  /**
   * Atomically claim up to `batchSize` pending items whose scheduled_time has passed.
   * Uses an IMMEDIATE transaction to prevent double-processing.
   */
  claimPending(batchSize: number): OutboxItem[] {
    const now = this.clock().toISOString();
    const claim = this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT * FROM outbox_queue
         WHERE status = 'pending' AND scheduled_time <= ?
         ORDER BY scheduled_time ASC
         LIMIT ?`,
      ).all(now, batchSize) as StoredOutboxRow[];

      for (const row of rows) {
        this.db.prepare(
          `UPDATE outbox_queue
           SET status = 'processing', started_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        ).run(now, now, row.id);
      }

      // Return the rows after status update
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      return (
        this.db.prepare(`SELECT * FROM outbox_queue WHERE id IN (${placeholders})`).all(...ids) as StoredOutboxRow[]
      ).map(toItem);
    });

    return claim.immediate();
  }

  markPublished(id: string, publishedUrl: string): OutboxItem | null {
    const now = this.clock().toISOString();
    const result = this.db.prepare(
      `UPDATE outbox_queue
       SET status = 'published', published_url = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'processing'`,
    ).run(publishedUrl, now, now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  markFailed(id: string, error: string): OutboxItem | null {
    const now = this.clock().toISOString();
    const result = this.db.prepare(
      `UPDATE outbox_queue
       SET status = 'failed', error = ?, completed_at = ?, updated_at = ?,
           retry_count = retry_count + 1
       WHERE id = ? AND status = 'processing'`,
    ).run(error, now, now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  retry(id: string): OutboxItem | null {
    const now = this.clock().toISOString();
    const result = this.db.prepare(
      `UPDATE outbox_queue
       SET status = 'pending', error = NULL, started_at = NULL, completed_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'failed'`,
    ).run(now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  cancel(id: string): OutboxItem | null {
    const now = this.clock().toISOString();
    const result = this.db.prepare(
      `UPDATE outbox_queue
       SET status = 'canceled', completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'failed')`,
    ).run(now, now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM outbox_queue WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
