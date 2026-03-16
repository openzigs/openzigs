import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type {
  Contact,
  SocialMessage,
  SocialPlatform,
  MessageDirection,
  MessageStatus,
  CommentRule,
  AutomationLogEntry,
  PostContext,
  FollowUpStep,
  FollowUpJob,
  ConversationAnalytics,
} from "./types.js";

export type ContactFilter = {
  platform?: SocialPlatform;
  search?: string;
  tag?: string;
  handoffActive?: boolean;
  page?: number;
  pageSize?: number;
};

export type PaginatedResult<T> = {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * SQLite-backed repository for the Social Brain CRM.
 *
 * Tables: contacts, social_messages, comment_automation_rules, comment_automation_log.
 */
export class SocialRepository {
  private db: Database.Database;
  private clock: () => Date;

  constructor(db: Database.Database, clock?: () => Date) {
    this.db = db;
    this.clock = clock ?? (() => new Date());
  }

  // ── Schema ──────────────────────────────────────────────────────────

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id                TEXT PRIMARY KEY,
        platform          TEXT NOT NULL,
        platform_user_id  TEXT NOT NULL,
        username          TEXT NOT NULL DEFAULT '',
        display_name      TEXT NOT NULL DEFAULT '',
        tags              TEXT NOT NULL DEFAULT '[]',
        notes             TEXT NOT NULL DEFAULT '',
        first_seen_at     TEXT NOT NULL,
        last_seen_at      TEXT NOT NULL,
        message_count     INTEGER NOT NULL DEFAULT 0,
        handoff_active    INTEGER NOT NULL DEFAULT 0,
        handoff_thread_id TEXT,
        handoff_channel   TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_platform_user
        ON contacts(platform, platform_user_id);
      CREATE INDEX IF NOT EXISTS idx_contacts_username ON contacts(username);
      CREATE INDEX IF NOT EXISTS idx_contacts_last_seen ON contacts(last_seen_at);

      CREATE TABLE IF NOT EXISTS social_messages (
        id                  TEXT PRIMARY KEY,
        contact_id          TEXT NOT NULL REFERENCES contacts(id),
        platform            TEXT NOT NULL,
        direction           TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        status              TEXT NOT NULL DEFAULT 'received'
          CHECK(status IN ('received', 'auto_replied', 'escalated', 'failed')),
        platform_message_id TEXT NOT NULL DEFAULT '',
        content             TEXT NOT NULL DEFAULT '',
        metadata            TEXT NOT NULL DEFAULT '{}',
        created_at          TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_social_messages_contact ON social_messages(contact_id);
      CREATE INDEX IF NOT EXISTS idx_social_messages_created ON social_messages(created_at);

      CREATE TABLE IF NOT EXISTS comment_automation_rules (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        platform              TEXT NOT NULL,
        enabled               INTEGER NOT NULL DEFAULT 1,
        post_ids              TEXT,
        keywords              TEXT NOT NULL DEFAULT '[]',
        regex                 TEXT,
        comment_reply_template TEXT,
        dm_template           TEXT NOT NULL DEFAULT '',
        dm_delay_seconds      INTEGER NOT NULL DEFAULT 0,
        max_triggers_per_user INTEGER NOT NULL DEFAULT 1,
        max_triggers_total    INTEGER,
        trigger_count         INTEGER NOT NULL DEFAULT 0,
        auto_tag              TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comment_automation_log (
        id              TEXT PRIMARY KEY,
        rule_id         TEXT NOT NULL REFERENCES comment_automation_rules(id),
        contact_id      TEXT REFERENCES contacts(id),
        platform        TEXT NOT NULL,
        post_id         TEXT,
        comment_id      TEXT NOT NULL,
        username        TEXT NOT NULL,
        matched_keyword TEXT,
        comment_replied INTEGER NOT NULL DEFAULT 0,
        dm_sent         INTEGER NOT NULL DEFAULT 0,
        dm_error        TEXT,
        created_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_automation_log_rule ON comment_automation_log(rule_id);

      CREATE TABLE IF NOT EXISTS post_context_cache (
        post_id          TEXT PRIMARY KEY,
        platform         TEXT NOT NULL,
        caption          TEXT NOT NULL DEFAULT '',
        permalink        TEXT NOT NULL DEFAULT '',
        media_type       TEXT NOT NULL DEFAULT '',
        media_url        TEXT NOT NULL DEFAULT '',
        author_username  TEXT NOT NULL DEFAULT '',
        published_at     TEXT NOT NULL DEFAULT '',
        cached_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS follow_up_steps (
        id              TEXT PRIMARY KEY,
        rule_id         TEXT NOT NULL REFERENCES comment_automation_rules(id) ON DELETE CASCADE,
        step_order      INTEGER NOT NULL DEFAULT 0,
        delay_seconds   INTEGER NOT NULL DEFAULT 3600,
        message_template TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_follow_up_steps_rule ON follow_up_steps(rule_id);

      CREATE TABLE IF NOT EXISTS follow_up_jobs (
        id                TEXT PRIMARY KEY,
        contact_id        TEXT NOT NULL REFERENCES contacts(id),
        rule_id           TEXT NOT NULL,
        step_id           TEXT NOT NULL,
        platform          TEXT NOT NULL,
        platform_user_id  TEXT NOT NULL,
        message           TEXT NOT NULL DEFAULT '',
        scheduled_at      TEXT NOT NULL,
        sent_at           TEXT,
        error             TEXT,
        created_at        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_follow_up_jobs_scheduled ON follow_up_jobs(scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_follow_up_jobs_contact ON follow_up_jobs(contact_id);
    `);

    // Runtime migration: add model column to comment_automation_rules
    try {
      this.db.exec(`ALTER TABLE comment_automation_rules ADD COLUMN model TEXT DEFAULT NULL`);
    } catch {
      // Column already exists
    }

    // Runtime migration: add lead fields to contacts
    try {
      this.db.exec(`ALTER TABLE contacts ADD COLUMN email TEXT DEFAULT NULL`);
    } catch { /* Column already exists */ }
    try {
      this.db.exec(`ALTER TABLE contacts ADD COLUMN phone TEXT DEFAULT NULL`);
    } catch { /* Column already exists */ }
    try {
      this.db.exec(`ALTER TABLE contacts ADD COLUMN lead_captured_at TEXT DEFAULT NULL`);
    } catch { /* Column already exists */ }

    // Runtime migration: add ai_reply flag to comment_automation_rules
    try {
      this.db.exec(`ALTER TABLE comment_automation_rules ADD COLUMN use_ai_reply INTEGER DEFAULT 0`);
    } catch { /* Column already exists */ }
    try {
      this.db.exec(`ALTER TABLE comment_automation_rules ADD COLUMN ai_reply_context TEXT DEFAULT NULL`);
    } catch { /* Column already exists */ }
  }

  // ── Contacts CRUD ───────────────────────────────────────────────────

  upsertContact(opts: {
    platform: SocialPlatform;
    platformUserId: string;
    username: string;
    displayName?: string;
  }): Contact {
    const now = this.clock().toISOString();
    const existing = this.db
      .prepare("SELECT * FROM contacts WHERE platform = ? AND platform_user_id = ?")
      .get(opts.platform, opts.platformUserId) as Contact | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE contacts SET username = ?, display_name = ?, last_seen_at = ?,
           message_count = message_count + 1, updated_at = ? WHERE id = ?`
        )
        .run(opts.username, opts.displayName ?? existing.display_name, now, now, existing.id);
      return this.getContact(existing.id)!;
    }

    const id = nanoid(16);
    this.db
      .prepare(
        `INSERT INTO contacts (id, platform, platform_user_id, username, display_name,
         tags, notes, first_seen_at, last_seen_at, message_count, handoff_active,
         created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '[]', '', ?, ?, 1, 0, ?, ?)`
      )
      .run(id, opts.platform, opts.platformUserId, opts.username, opts.displayName ?? "", now, now, now, now);
    return this.getContact(id)!;
  }

  getContact(id: string): Contact | undefined {
    return this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Contact | undefined;
  }

  getContactByPlatformUser(platform: SocialPlatform, platformUserId: string): Contact | undefined {
    return this.db
      .prepare("SELECT * FROM contacts WHERE platform = ? AND platform_user_id = ?")
      .get(platform, platformUserId) as Contact | undefined;
  }

  listContacts(filter: ContactFilter = {}): PaginatedResult<Contact> {
    const { platform, search, tag, handoffActive, page = 1, pageSize = 25 } = filter;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (platform) {
      conditions.push("platform = ?");
      params.push(platform);
    }
    if (search) {
      conditions.push("(username LIKE ? OR display_name LIKE ? OR notes LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (tag) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)");
      params.push(tag);
    }
    if (handoffActive !== undefined) {
      conditions.push("handoff_active = ?");
      params.push(handoffActive ? 1 : 0);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = (
      this.db.prepare(`SELECT COUNT(*) as count FROM contacts ${where}`).get(...params) as { count: number }
    ).count;

    const offset = (page - 1) * pageSize;
    const data = this.db
      .prepare(`SELECT * FROM contacts ${where} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset) as Contact[];

    return { data, total, page, pageSize };
  }

  updateContact(id: string, updates: Partial<Pick<Contact, "tags" | "notes" | "handoff_active" | "handoff_thread_id" | "handoff_channel">>): Contact | undefined {
    const contact = this.getContact(id);
    if (!contact) return undefined;

    const now = this.clock().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];

    if (updates.tags !== undefined) {
      try { JSON.parse(updates.tags as string); } catch { throw new Error("Invalid JSON in tags"); }
      sets.push("tags = ?"); params.push(updates.tags);
    }
    if (updates.notes !== undefined) { sets.push("notes = ?"); params.push(updates.notes); }
    if (updates.handoff_active !== undefined) { sets.push("handoff_active = ?"); params.push(updates.handoff_active); }
    if (updates.handoff_thread_id !== undefined) { sets.push("handoff_thread_id = ?"); params.push(updates.handoff_thread_id); }
    if (updates.handoff_channel !== undefined) { sets.push("handoff_channel = ?"); params.push(updates.handoff_channel); }

    params.push(id);
    this.db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getContact(id);
  }

  addTag(id: string, tag: string): Contact | undefined {
    const contact = this.getContact(id);
    if (!contact) return undefined;
    const tags: string[] = JSON.parse(contact.tags);
    if (!tags.includes(tag)) {
      tags.push(tag);
      return this.updateContact(id, { tags: JSON.stringify(tags) });
    }
    return contact;
  }

  removeTag(id: string, tag: string): Contact | undefined {
    const contact = this.getContact(id);
    if (!contact) return undefined;
    const tags: string[] = JSON.parse(contact.tags);
    const filtered = tags.filter((t) => t !== tag);
    return this.updateContact(id, { tags: JSON.stringify(filtered) });
  }

  // ── Social Messages ────────────────────────────────────────────────

  insertMessage(opts: {
    contactId: string;
    platform: SocialPlatform;
    direction: MessageDirection;
    status?: MessageStatus;
    platformMessageId?: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): SocialMessage {
    const id = nanoid(16);
    const now = this.clock().toISOString();
    this.db
      .prepare(
        `INSERT INTO social_messages (id, contact_id, platform, direction, status, platform_message_id, content, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        opts.contactId,
        opts.platform,
        opts.direction,
        opts.status ?? "received",
        opts.platformMessageId ?? "",
        opts.content,
        JSON.stringify(opts.metadata ?? {}),
        now
      );
    return this.db.prepare("SELECT * FROM social_messages WHERE id = ?").get(id) as SocialMessage;
  }

  getMessages(contactId: string, limit = 50, offset = 0): SocialMessage[] {
    return this.db
      .prepare("SELECT * FROM social_messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(contactId, limit, offset) as SocialMessage[];
  }

  getRecentActivity(limit = 50, offset = 0): SocialMessage[] {
    return this.db
      .prepare("SELECT * FROM social_messages ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as SocialMessage[];
  }

  // ── Comment Automation Rules ────────────────────────────────────────

  createRule(rule: Omit<CommentRule, "id" | "trigger_count" | "created_at" | "updated_at">): CommentRule {
    const id = nanoid(16);
    const now = this.clock().toISOString();
    this.db
      .prepare(
        `INSERT INTO comment_automation_rules
         (id, name, platform, enabled, post_ids, keywords, regex, comment_reply_template,
          dm_template, dm_delay_seconds, max_triggers_per_user, max_triggers_total, trigger_count, auto_tag, model, use_ai_reply, ai_reply_context, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, rule.name, rule.platform, rule.enabled, rule.post_ids, rule.keywords,
        rule.regex, rule.comment_reply_template, rule.dm_template, rule.dm_delay_seconds,
        rule.max_triggers_per_user, rule.max_triggers_total, rule.auto_tag, rule.model ?? null,
        rule.use_ai_reply ?? 0, rule.ai_reply_context ?? null, now, now
      );
    return this.db.prepare("SELECT * FROM comment_automation_rules WHERE id = ?").get(id) as CommentRule;
  }

  getRule(id: string): CommentRule | undefined {
    return this.db.prepare("SELECT * FROM comment_automation_rules WHERE id = ?").get(id) as CommentRule | undefined;
  }

  listRules(platform?: SocialPlatform): CommentRule[] {
    if (platform) {
      return this.db
        .prepare("SELECT * FROM comment_automation_rules WHERE platform = ? ORDER BY created_at ASC")
        .all(platform) as CommentRule[];
    }
    return this.db
      .prepare("SELECT * FROM comment_automation_rules ORDER BY created_at ASC")
      .all() as CommentRule[];
  }

  updateRule(id: string, updates: Partial<Omit<CommentRule, "id" | "created_at" | "updated_at">>): CommentRule | undefined {
    const rule = this.getRule(id);
    if (!rule) return undefined;
    const now = this.clock().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];

    const allowed = ["name", "platform", "enabled", "post_ids", "keywords", "regex", "comment_reply_template", "dm_template", "dm_delay_seconds", "max_triggers_per_user", "max_triggers_total", "auto_tag", "model", "use_ai_reply", "ai_reply_context"];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && allowed.includes(key)) {
        sets.push(`${key} = ?`);
        params.push(value);
      }
    }

    params.push(id);
    this.db.prepare(`UPDATE comment_automation_rules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getRule(id);
  }

  deleteRule(id: string): boolean {
    const result = this.db.prepare("DELETE FROM comment_automation_rules WHERE id = ?").run(id);
    return result.changes > 0;
  }

  incrementRuleTriggerCount(id: string): void {
    this.db.prepare("UPDATE comment_automation_rules SET trigger_count = trigger_count + 1, updated_at = ? WHERE id = ?")
      .run(this.clock().toISOString(), id);
  }

  // ── Automation Log ──────────────────────────────────────────────────

  insertAutomationLog(entry: Omit<AutomationLogEntry, "id" | "created_at">): AutomationLogEntry {
    const id = nanoid(16);
    const now = this.clock().toISOString();
    this.db
      .prepare(
        `INSERT INTO comment_automation_log
         (id, rule_id, contact_id, platform, post_id, comment_id, username, matched_keyword,
          comment_replied, dm_sent, dm_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, entry.rule_id, entry.contact_id, entry.platform, entry.post_id,
        entry.comment_id, entry.username, entry.matched_keyword,
        entry.comment_replied, entry.dm_sent, entry.dm_error, now
      );
    return this.db.prepare("SELECT * FROM comment_automation_log WHERE id = ?").get(id) as AutomationLogEntry;
  }

  getAutomationLog(opts: { ruleId?: string; limit?: number; offset?: number } = {}): AutomationLogEntry[] {
    const { ruleId, limit = 50, offset = 0 } = opts;
    if (ruleId) {
      return this.db
        .prepare("SELECT * FROM comment_automation_log WHERE rule_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
        .all(ruleId, limit, offset) as AutomationLogEntry[];
    }
    return this.db
      .prepare("SELECT * FROM comment_automation_log ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as AutomationLogEntry[];
  }

  getUserTriggerCount(ruleId: string, username: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM comment_automation_log WHERE rule_id = ? AND username = ?")
      .get(ruleId, username) as { count: number };
    return row.count;
  }

  // ── Post Context Cache ───────────────────────────────────────────────

  cachePostContext(ctx: PostContext): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO post_context_cache
         (post_id, platform, caption, permalink, media_type, media_url, author_username, published_at, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(ctx.postId, ctx.platform, ctx.caption, ctx.permalink, ctx.mediaType, ctx.mediaUrl, ctx.authorUsername, ctx.publishedAt, ctx.cachedAt);
  }

  getPostContext(postId: string): PostContext | null {
    const row = this.db
      .prepare("SELECT * FROM post_context_cache WHERE post_id = ?")
      .get(postId) as Record<string, string> | undefined;
    if (!row) return null;
    return {
      postId: row.post_id,
      platform: row.platform as SocialPlatform,
      caption: row.caption,
      permalink: row.permalink,
      mediaType: row.media_type,
      mediaUrl: row.media_url,
      authorUsername: row.author_username,
      publishedAt: row.published_at,
      cachedAt: row.cached_at,
    };
  }

  // ── Stats ───────────────────────────────────────────────────────────

  getStats(): {
    totalContacts: number;
    activeHandoffs: number;
    totalMessages: number;
    messagesLast24h: number;
    totalAutomationTriggers: number;
  } {
    const totalContacts = (this.db.prepare("SELECT COUNT(*) as c FROM contacts").get() as { c: number }).c;
    const activeHandoffs = (this.db.prepare("SELECT COUNT(*) as c FROM contacts WHERE handoff_active = 1").get() as { c: number }).c;
    const totalMessages = (this.db.prepare("SELECT COUNT(*) as c FROM social_messages").get() as { c: number }).c;

    const oneDayAgo = new Date(this.clock().getTime() - 24 * 60 * 60 * 1000).toISOString();
    const messagesLast24h = (
      this.db.prepare("SELECT COUNT(*) as c FROM social_messages WHERE created_at >= ?").get(oneDayAgo) as { c: number }
    ).c;

    const totalAutomationTriggers = (
      this.db.prepare("SELECT COALESCE(SUM(trigger_count), 0) as c FROM comment_automation_rules").get() as { c: number }
    ).c;

    return { totalContacts, activeHandoffs, totalMessages, messagesLast24h, totalAutomationTriggers };
  }

  // ── Follow-Up Sequences ─────────────────────────────────────────────

  createFollowUpStep(ruleId: string, step: { stepOrder: number; delaySeconds: number; messageTemplate: string }): FollowUpStep {
    const id = nanoid(16);
    const now = this.clock().toISOString();
    this.db.prepare(
      `INSERT INTO follow_up_steps (id, rule_id, step_order, delay_seconds, message_template, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, ruleId, step.stepOrder, step.delaySeconds, step.messageTemplate, now);
    return this.db.prepare("SELECT * FROM follow_up_steps WHERE id = ?").get(id) as FollowUpStep;
  }

  getFollowUpSteps(ruleId: string): FollowUpStep[] {
    return this.db.prepare("SELECT * FROM follow_up_steps WHERE rule_id = ? ORDER BY step_order ASC").all(ruleId) as FollowUpStep[];
  }

  deleteFollowUpStep(id: string): boolean {
    return this.db.prepare("DELETE FROM follow_up_steps WHERE id = ?").run(id).changes > 0;
  }

  scheduleFollowUp(opts: {
    contactId: string;
    ruleId: string;
    stepId: string;
    platform: SocialPlatform;
    platformUserId: string;
    message: string;
    scheduledAt: string;
  }): FollowUpJob {
    const id = nanoid(16);
    const now = this.clock().toISOString();
    this.db.prepare(
      `INSERT INTO follow_up_jobs (id, contact_id, rule_id, step_id, platform, platform_user_id, message, scheduled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, opts.contactId, opts.ruleId, opts.stepId, opts.platform, opts.platformUserId, opts.message, opts.scheduledAt, now);
    return this.db.prepare("SELECT * FROM follow_up_jobs WHERE id = ?").get(id) as FollowUpJob;
  }

  getPendingFollowUps(beforeTime: string): FollowUpJob[] {
    return this.db.prepare(
      "SELECT * FROM follow_up_jobs WHERE sent_at IS NULL AND error IS NULL AND scheduled_at <= ? ORDER BY scheduled_at ASC"
    ).all(beforeTime) as FollowUpJob[];
  }

  markFollowUpSent(id: string): void {
    const now = this.clock().toISOString();
    this.db.prepare("UPDATE follow_up_jobs SET sent_at = ? WHERE id = ?").run(now, id);
  }

  markFollowUpError(id: string, error: string): void {
    this.db.prepare("UPDATE follow_up_jobs SET error = ? WHERE id = ?").run(error, id);
  }

  // ── Lead Capture ────────────────────────────────────────────────────

  updateContactLead(id: string, lead: { email?: string; phone?: string }): Contact | undefined {
    const contact = this.getContact(id);
    if (!contact) return undefined;
    const now = this.clock().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];

    if (lead.email !== undefined) { sets.push("email = ?"); params.push(lead.email); }
    if (lead.phone !== undefined) { sets.push("phone = ?"); params.push(lead.phone); }
    if (lead.email || lead.phone) { sets.push("lead_captured_at = ?"); params.push(now); }

    params.push(id);
    this.db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getContact(id);
  }

  getLeads(opts: { platform?: SocialPlatform; limit?: number; offset?: number } = {}): Contact[] {
    const { platform, limit = 50, offset = 0 } = opts;
    if (platform) {
      return this.db.prepare(
        "SELECT * FROM contacts WHERE (email IS NOT NULL OR phone IS NOT NULL) AND platform = ? ORDER BY lead_captured_at DESC LIMIT ? OFFSET ?"
      ).all(platform, limit, offset) as Contact[];
    }
    return this.db.prepare(
      "SELECT * FROM contacts WHERE (email IS NOT NULL OR phone IS NOT NULL) ORDER BY lead_captured_at DESC LIMIT ? OFFSET ?"
    ).all(limit, offset) as Contact[];
  }

  // ── Conversation Analytics ──────────────────────────────────────────

  getAnalytics(since?: string): ConversationAnalytics[] {
    const sinceClause = since ? "AND sm.created_at >= ?" : "";
    const params: unknown[] = since ? [since] : [];

    const rows = this.db.prepare(`
      SELECT
        c.platform,
        COUNT(DISTINCT c.id) as total_conversations,
        SUM(CASE WHEN sm.direction = 'inbound' THEN 1 ELSE 0 END) as total_messages_in,
        SUM(CASE WHEN sm.direction = 'outbound' THEN 1 ELSE 0 END) as total_messages_out,
        SUM(CASE WHEN sm.status = 'auto_replied' THEN 1 ELSE 0 END) as auto_replies,
        SUM(CASE WHEN sm.status = 'escalated' THEN 1 ELSE 0 END) as escalations,
        COUNT(sm.id) as total_msg
      FROM contacts c
      LEFT JOIN social_messages sm ON sm.contact_id = c.id ${sinceClause}
      GROUP BY c.platform
    `).all(...params) as Array<Record<string, number | string>>;

    const leadCounts = this.db.prepare(`
      SELECT platform, COUNT(*) as leads
      FROM contacts
      WHERE email IS NOT NULL OR phone IS NOT NULL
      GROUP BY platform
    `).all() as Array<{ platform: string; leads: number }>;
    const leadMap = new Map(leadCounts.map((r) => [r.platform, r.leads]));

    return rows.map((r) => ({
      platform: r.platform as SocialPlatform,
      total_conversations: Number(r.total_conversations),
      total_messages_in: Number(r.total_messages_in),
      total_messages_out: Number(r.total_messages_out),
      avg_response_time_ms: 0, // TODO: compute from paired inbound→outbound timestamps
      auto_reply_rate: Number(r.total_msg) > 0 ? Number(r.auto_replies) / Number(r.total_msg) : 0,
      escalation_rate: Number(r.total_msg) > 0 ? Number(r.escalations) / Number(r.total_msg) : 0,
      leads_captured: leadMap.get(r.platform as string) ?? 0,
    }));
  }

  // ── CSV Export ──────────────────────────────────────────────────────

  exportContactsCsv(): string {
    const contacts = this.db.prepare("SELECT * FROM contacts ORDER BY last_seen_at DESC").all() as Contact[];
    const headers = ["id", "platform", "username", "display_name", "tags", "notes", "first_seen_at", "last_seen_at", "message_count", "handoff_active"];
    const rows = contacts.map((c) => {
      const tags = JSON.parse(c.tags).join("; ");
      return [c.id, c.platform, c.username, c.display_name, tags, c.notes, c.first_seen_at, c.last_seen_at, String(c.message_count), String(c.handoff_active)]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",");
    });
    return [headers.join(","), ...rows].join("\n");
  }
}
