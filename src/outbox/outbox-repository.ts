import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// ── Types ───────────────────────────────────────────────────

export type OutboxPlatform =
  | "twitter"
  | "pinterest"
  | "linkedin"
  | "youtube"
  | "reddit"
  | "instagram"
  | "facebook";

export type OutboxStatus =
  | "pending"
  | "processing"
  | "published"
  | "failed"
  | "canceled";

export type OutboxAssetType = "image" | "video" | "audio" | "document" | "text";

export interface OutboxAttachment {
  filePath: string;
  filename: string;
  assetType?: OutboxAssetType;
}

export interface OutboxItem {
  id: string;
  title: string | null;
  assetId: string | null;
  assetUrl: string | null;
  assetType: OutboxAssetType;
  contentBody: string | null;
  attachments: OutboxAttachment[];
  platform: OutboxPlatform;
  scheduledTime: Date;
  agentContext: string;
  platformMetadata: Record<string, unknown>;
  status: OutboxStatus;
  error: string | null;
  publishedUrl: string | null;
  retryCount: number;
  maxRetries: number;
  templateId: string | null;
  brandKitId: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface CreateOutboxInput {
  title?: string | null;
  assetId?: string | null;
  assetUrl?: string | null;
  assetType?: OutboxAssetType;
  contentBody?: string | null;
  attachments?: OutboxAttachment[];
  platform: OutboxPlatform;
  scheduledTime: Date;
  agentContext: string;
  platformMetadata?: Record<string, unknown>;
  maxRetries?: number;
  templateId?: string | null;
  brandKitId?: string | null;
}

export interface UpdateOutboxInput {
  title?: string | null;
  contentBody?: string | null;
  agentContext?: string;
  scheduledTime?: Date;
  assetUrl?: string | null;
  assetId?: string | null;
  assetType?: OutboxAssetType;
  attachments?: OutboxAttachment[];
  platformMetadata?: Record<string, unknown>;
  templateId?: string | null;
  brandKitId?: string | null;
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
  title: string | null;
  asset_id: string | null;
  asset_url: string | null;
  asset_type: string;
  content_body: string | null;
  attachments: string;
  platform: string;
  scheduled_time: string;
  agent_context: string;
  platform_metadata: string;
  status: string;
  error: string | null;
  published_url: string | null;
  retry_count: number;
  max_retries: number;
  template_id: string | null;
  brand_kit_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ── Converter ───────────────────────────────────────────────

const toItem = (row: StoredOutboxRow): OutboxItem => ({
  id: row.id,
  title: row.title,
  assetId: row.asset_id,
  assetUrl: row.asset_url,
  assetType: row.asset_type as OutboxAssetType,
  contentBody: row.content_body,
  attachments: JSON.parse(row.attachments || "[]") as OutboxAttachment[],
  platform: row.platform as OutboxPlatform,
  scheduledTime: new Date(row.scheduled_time),
  agentContext: row.agent_context,
  platformMetadata: JSON.parse(row.platform_metadata) as Record<
    string,
    unknown
  >,
  status: row.status as OutboxStatus,
  error: row.error,
  publishedUrl: row.published_url,
  retryCount: row.retry_count,
  maxRetries: row.max_retries,
  templateId: row.template_id ?? null,
  brandKitId: row.brand_kit_id ?? null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  startedAt: row.started_at ? new Date(row.started_at) : null,
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
});

// ── Valid platforms & statuses ───────────────────────────────

const VALID_PLATFORMS: Set<string> = new Set([
  "twitter",
  "pinterest",
  "linkedin",
  "youtube",
  "reddit",
  "instagram",
  "facebook",
]);
const VALID_STATUSES: Set<string> = new Set([
  "pending",
  "processing",
  "published",
  "failed",
  "canceled",
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
        title TEXT,
        asset_id TEXT,
        asset_url TEXT,
        asset_type TEXT NOT NULL DEFAULT 'image',
        content_body TEXT,
        attachments TEXT NOT NULL DEFAULT '[]',
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

    // ── v2 migration: add title, content_body, attachments columns ──
    const cols = this.db
      .prepare("PRAGMA table_info(outbox_queue)")
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("title")) {
      this.db.exec("ALTER TABLE outbox_queue ADD COLUMN title TEXT");
    }
    if (!colNames.has("content_body")) {
      this.db.exec("ALTER TABLE outbox_queue ADD COLUMN content_body TEXT");
    }
    if (!colNames.has("attachments")) {
      this.db.exec(
        "ALTER TABLE outbox_queue ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
      );
    }

    // ── v3 migration: add template_id, brand_kit_id columns (Issue #810) ──
    if (!colNames.has("template_id")) {
      this.db.exec("ALTER TABLE outbox_queue ADD COLUMN template_id TEXT");
    }
    if (!colNames.has("brand_kit_id")) {
      this.db.exec("ALTER TABLE outbox_queue ADD COLUMN brand_kit_id TEXT");
    }
  }

  insert(input: CreateOutboxInput): OutboxItem {
    if (!VALID_PLATFORMS.has(input.platform)) {
      throw new Error(`Invalid platform: ${input.platform}`);
    }
    const now = this.clock().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO outbox_queue (id, title, asset_id, asset_url, asset_type, content_body, attachments, platform, scheduled_time, agent_context, platform_metadata, status, retry_count, max_retries, template_id, brand_kit_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.title ?? null,
        input.assetId ?? null,
        input.assetUrl ?? null,
        input.assetType ?? "text",
        input.contentBody ?? null,
        JSON.stringify(input.attachments ?? []),
        input.platform,
        input.scheduledTime.toISOString(),
        input.agentContext,
        JSON.stringify(input.platformMetadata ?? {}),
        input.maxRetries ?? 3,
        input.templateId ?? null,
        input.brandKitId ?? null,
        now,
        now,
      );
    return this.getById(id)!;
  }

  getById(id: string): OutboxItem | null {
    const row = this.db
      .prepare("SELECT * FROM outbox_queue WHERE id = ?")
      .get(id) as StoredOutboxRow | undefined;
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
    const rows = this.db
      .prepare(
        "SELECT status, COUNT(*) as count FROM outbox_queue GROUP BY status",
      )
      .all() as Array<{ status: string; count: number }>;

    const stats: OutboxStats = {
      pending: 0,
      processing: 0,
      published: 0,
      failed: 0,
      canceled: 0,
      total: 0,
    };
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
      const rows = this.db
        .prepare(
          `SELECT * FROM outbox_queue
         WHERE status = 'pending' AND scheduled_time <= ?
         ORDER BY scheduled_time ASC
         LIMIT ?`,
        )
        .all(now, batchSize) as StoredOutboxRow[];

      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE outbox_queue
           SET status = 'processing', started_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
          )
          .run(now, now, row.id);
      }

      // Return the rows after status update
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      return (
        this.db
          .prepare(`SELECT * FROM outbox_queue WHERE id IN (${placeholders})`)
          .all(...ids) as StoredOutboxRow[]
      ).map(toItem);
    });

    return claim.immediate();
  }

  markPublished(id: string, publishedUrl: string): OutboxItem | null {
    const now = this.clock().toISOString();
    const result = this.db
      .prepare(
        `UPDATE outbox_queue
       SET status = 'published', published_url = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'processing'`,
      )
      .run(publishedUrl, now, now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  markFailed(id: string, error: string): OutboxItem | null {
    const now = this.clock().toISOString();
    const result = this.db
      .prepare(
        `UPDATE outbox_queue
       SET status = 'failed', error = ?, completed_at = ?, updated_at = ?,
           retry_count = retry_count + 1
       WHERE id = ? AND status = 'processing'`,
      )
      .run(error, now, now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  retry(id: string): OutboxItem | null {
    const now = this.clock().toISOString();
    const result = this.db
      .prepare(
        `UPDATE outbox_queue
       SET status = 'pending', error = NULL, started_at = NULL, completed_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'failed'`,
      )
      .run(now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  cancel(id: string): OutboxItem | null {
    const now = this.clock().toISOString();
    const result = this.db
      .prepare(
        `UPDATE outbox_queue
       SET status = 'canceled', completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'failed')`,
      )
      .run(now, now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  /** Update status and started_at for an item (used by publish-now). */
  updateStatus(id: string, status: OutboxStatus, startedAt?: string): void {
    const now = this.clock().toISOString();
    this.db
      .prepare(
        `UPDATE outbox_queue SET status = ?, started_at = COALESCE(?, started_at), updated_at = ? WHERE id = ?`,
      )
      .run(status, startedAt ?? null, now, id);
  }

  /**
   * Update mutable fields of an outbox item. Only allowed for pending or canceled items.
   * Returns the updated item, or null if the item doesn't exist or is in a non-editable state.
   */
  update(id: string, input: UpdateOutboxInput): OutboxItem | null {
    const item = this.getById(id);
    if (!item) return null;
    if (item.status !== "pending" && item.status !== "canceled") return null;

    const now = this.clock().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];

    if (input.title !== undefined) {
      sets.push("title = ?");
      params.push(input.title);
    }
    if (input.contentBody !== undefined) {
      sets.push("content_body = ?");
      params.push(input.contentBody);
    }
    if (input.agentContext !== undefined) {
      sets.push("agent_context = ?");
      params.push(input.agentContext);
    }
    if (input.scheduledTime !== undefined) {
      sets.push("scheduled_time = ?");
      params.push(input.scheduledTime.toISOString());
    }
    if (input.assetUrl !== undefined) {
      sets.push("asset_url = ?");
      params.push(input.assetUrl);
    }
    if (input.assetId !== undefined) {
      sets.push("asset_id = ?");
      params.push(input.assetId);
    }
    if (input.assetType !== undefined) {
      sets.push("asset_type = ?");
      params.push(input.assetType);
    }
    if (input.attachments !== undefined) {
      sets.push("attachments = ?");
      params.push(JSON.stringify(input.attachments));
    }
    if (input.platformMetadata !== undefined) {
      sets.push("platform_metadata = ?");
      params.push(JSON.stringify(input.platformMetadata));
    }
    if (input.templateId !== undefined) {
      sets.push("template_id = ?");
      params.push(input.templateId);
    }
    if (input.brandKitId !== undefined) {
      sets.push("brand_kit_id = ?");
      params.push(input.brandKitId);
    }

    params.push(id);
    this.db
      .prepare(
        `UPDATE outbox_queue SET ${sets.join(", ")} WHERE id = ? AND status IN ('pending', 'canceled')`,
      )
      .run(...params);

    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM outbox_queue WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }
}
