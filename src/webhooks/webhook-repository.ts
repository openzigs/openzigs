import Database from "better-sqlite3";
import type { WebhookConfig } from "./webhook-manager.js";

/**
 * SQLite-backed repository for webhook configurations.
 *
 * Follows the same pattern as `SocialRepository` — constructor accepts a
 * `Database.Database` instance and an optional `clock` for deterministic time
 * in tests. Call `migrate()` once at startup to ensure the schema exists.
 */
export class WebhookRepository {
  private db: Database.Database;
  private clock: () => Date;

  constructor(db: Database.Database, clock?: () => Date) {
    this.db = db;
    this.clock = clock ?? (() => new Date());
  }

  // ── Schema ──────────────────────────────────────────────────────────

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        action            TEXT NOT NULL CHECK(action IN ('prompt', 'goal')),
        action_payload    TEXT NOT NULL DEFAULT '{}',
        secret            TEXT NOT NULL,
        api_key_hash      TEXT NOT NULL,
        api_key_salt      TEXT NOT NULL,
        enabled           INTEGER NOT NULL DEFAULT 1,
        allowed_ips       TEXT NOT NULL DEFAULT '[]',
        rate_limit        INTEGER NOT NULL DEFAULT 60,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        last_triggered_at TEXT,
        trigger_count     INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks(enabled);
    `);
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  insert(config: WebhookConfig): void {
    this.db
      .prepare(
        `INSERT INTO webhooks (id, name, action, action_payload, secret, api_key_hash,
         api_key_salt, enabled, allowed_ips, rate_limit, created_at, updated_at,
         last_triggered_at, trigger_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        config.id,
        config.name,
        config.action,
        JSON.stringify(config.actionPayload),
        config.secret,
        config.apiKeyHash,
        config.apiKeySalt,
        config.enabled ? 1 : 0,
        JSON.stringify(config.allowedIps),
        config.rateLimit,
        config.createdAt,
        config.updatedAt,
        config.lastTriggeredAt,
        config.triggerCount,
      );
  }

  getById(id: string): WebhookConfig | undefined {
    const row = this.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as WebhookRow | undefined;
    return row ? this.rowToConfig(row) : undefined;
  }

  list(): WebhookConfig[] {
    const rows = this.db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all() as WebhookRow[];
    return rows.map((r) => this.rowToConfig(r));
  }

  update(id: string, updates: Partial<Pick<WebhookConfig, "name" | "enabled" | "allowedIps" | "rateLimit" | "apiKeyHash" | "apiKeySalt" | "lastTriggeredAt" | "triggerCount">>): WebhookConfig | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;

    const now = this.clock().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];

    if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }
    if (updates.allowedIps !== undefined) { sets.push("allowed_ips = ?"); params.push(JSON.stringify(updates.allowedIps)); }
    if (updates.rateLimit !== undefined) { sets.push("rate_limit = ?"); params.push(updates.rateLimit); }
    if (updates.apiKeyHash !== undefined) { sets.push("api_key_hash = ?"); params.push(updates.apiKeyHash); }
    if (updates.apiKeySalt !== undefined) { sets.push("api_key_salt = ?"); params.push(updates.apiKeySalt); }
    if (updates.lastTriggeredAt !== undefined) { sets.push("last_triggered_at = ?"); params.push(updates.lastTriggeredAt); }
    if (updates.triggerCount !== undefined) { sets.push("trigger_count = ?"); params.push(updates.triggerCount); }

    params.push(id);
    this.db.prepare(`UPDATE webhooks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getById(id);
  }

  deleteById(id: string): boolean {
    const result = this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private rowToConfig(row: WebhookRow): WebhookConfig {
    return {
      id: row.id,
      name: row.name,
      action: row.action as "prompt" | "goal",
      actionPayload: JSON.parse(row.action_payload),
      secret: row.secret,
      apiKeyHash: row.api_key_hash,
      apiKeySalt: row.api_key_salt,
      enabled: row.enabled === 1,
      allowedIps: JSON.parse(row.allowed_ips),
      rateLimit: row.rate_limit,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastTriggeredAt: row.last_triggered_at,
      triggerCount: row.trigger_count,
    };
  }
}

/** Raw SQLite row shape — columns use snake_case. */
type WebhookRow = {
  id: string;
  name: string;
  action: string;
  action_payload: string;
  secret: string;
  api_key_hash: string;
  api_key_salt: string;
  enabled: number;
  allowed_ips: string;
  rate_limit: number;
  created_at: string;
  updated_at: string;
  last_triggered_at: string | null;
  trigger_count: number;
};
