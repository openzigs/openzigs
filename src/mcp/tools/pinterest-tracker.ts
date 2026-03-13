/**
 * Pinterest Pin Tracker — SQLite-backed pin performance tracking over time.
 *
 * Stores tracked pins and periodic metric snapshots to enable
 * long-term performance monitoring (the "Pinterest long game").
 */

import type Database from "better-sqlite3";

// ── Types ───────────────────────────────────────────────────────────────────

export interface TrackedPin {
  pin_id: string;
  title: string | null;
  topic: string | null;
  board_id: string | null;
  link: string | null;
  initial_score: number | null;
  created_at: string;
  last_checked: string | null;
  status: "active" | "paused" | "archived";
}

export interface PinSnapshot {
  id: number;
  pin_id: string;
  checked_at: string;
  impressions: number;
  pin_clicks: number;
  saves: number;
  outbound_clicks: number;
  reactions: number;
  comments: number;
}

export interface ContentIdea {
  id: number;
  topic: string;
  suggested_title: string;
  suggested_description: string;
  target_keywords: string;
  difficulty: string;
  estimated_volume: string;
  source_data: string;
  created_at: string;
  status: "new" | "created" | "dismissed";
  pin_id: string | null;
}

// ── Repository ──────────────────────────────────────────────────────────────

export class PinterestTrackerRepository {
  constructor(private db: Database.Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pinterest_tracked_pins (
        pin_id TEXT PRIMARY KEY,
        title TEXT,
        topic TEXT,
        board_id TEXT,
        link TEXT,
        initial_score INTEGER,
        created_at TEXT NOT NULL,
        last_checked TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'archived'))
      );

      CREATE TABLE IF NOT EXISTS pinterest_pin_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pin_id TEXT NOT NULL REFERENCES pinterest_tracked_pins(pin_id) ON DELETE CASCADE,
        checked_at TEXT NOT NULL,
        impressions INTEGER NOT NULL DEFAULT 0,
        pin_clicks INTEGER NOT NULL DEFAULT 0,
        saves INTEGER NOT NULL DEFAULT 0,
        outbound_clicks INTEGER NOT NULL DEFAULT 0,
        reactions INTEGER NOT NULL DEFAULT 0,
        comments INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_pin ON pinterest_pin_snapshots(pin_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_date ON pinterest_pin_snapshots(checked_at);

      CREATE TABLE IF NOT EXISTS pinterest_content_ideas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        suggested_title TEXT NOT NULL,
        suggested_description TEXT NOT NULL,
        target_keywords TEXT NOT NULL DEFAULT '[]',
        difficulty TEXT NOT NULL DEFAULT 'medium',
        estimated_volume TEXT NOT NULL DEFAULT 'unknown',
        source_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'created', 'dismissed')),
        pin_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_ideas_status ON pinterest_content_ideas(status);
      CREATE INDEX IF NOT EXISTS idx_ideas_topic ON pinterest_content_ideas(topic);
    `);
  }

  // ── Tracked Pins ────────────────────────────────────────────────────────

  trackPin(pin: Omit<TrackedPin, "last_checked">): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pinterest_tracked_pins
         (pin_id, title, topic, board_id, link, initial_score, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pin.pin_id,
        pin.title ?? null,
        pin.topic ?? null,
        pin.board_id ?? null,
        pin.link ?? null,
        pin.initial_score ?? null,
        pin.created_at,
        pin.status,
      );
  }

  getTrackedPin(pinId: string): TrackedPin | undefined {
    return this.db
      .prepare("SELECT * FROM pinterest_tracked_pins WHERE pin_id = ?")
      .get(pinId) as TrackedPin | undefined;
  }

  listTrackedPins(status?: string): TrackedPin[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM pinterest_tracked_pins WHERE status = ? ORDER BY created_at DESC")
        .all(status) as TrackedPin[];
    }
    return this.db
      .prepare("SELECT * FROM pinterest_tracked_pins ORDER BY created_at DESC")
      .all() as TrackedPin[];
  }

  updatePinStatus(pinId: string, status: "active" | "paused" | "archived"): boolean {
    const result = this.db
      .prepare("UPDATE pinterest_tracked_pins SET status = ? WHERE pin_id = ?")
      .run(status, pinId);
    return result.changes > 0;
  }

  updateLastChecked(pinId: string, checkedAt: string): void {
    this.db
      .prepare("UPDATE pinterest_tracked_pins SET last_checked = ? WHERE pin_id = ?")
      .run(checkedAt, pinId);
  }

  deleteTrackedPin(pinId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM pinterest_tracked_pins WHERE pin_id = ?")
      .run(pinId);
    return result.changes > 0;
  }

  // ── Snapshots ─────────────────────────────────────────────────────────

  addSnapshot(snapshot: Omit<PinSnapshot, "id">): number {
    const result = this.db
      .prepare(
        `INSERT INTO pinterest_pin_snapshots
         (pin_id, checked_at, impressions, pin_clicks, saves, outbound_clicks, reactions, comments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.pin_id,
        snapshot.checked_at,
        snapshot.impressions,
        snapshot.pin_clicks,
        snapshot.saves,
        snapshot.outbound_clicks,
        snapshot.reactions,
        snapshot.comments,
      );
    return result.lastInsertRowid as number;
  }

  getSnapshots(pinId: string, limit = 90): PinSnapshot[] {
    return this.db
      .prepare(
        "SELECT * FROM pinterest_pin_snapshots WHERE pin_id = ? ORDER BY checked_at DESC LIMIT ?",
      )
      .all(pinId, limit) as PinSnapshot[];
  }

  getLatestSnapshot(pinId: string): PinSnapshot | undefined {
    return this.db
      .prepare(
        "SELECT * FROM pinterest_pin_snapshots WHERE pin_id = ? ORDER BY checked_at DESC LIMIT 1",
      )
      .get(pinId) as PinSnapshot | undefined;
  }

  // ── Content Ideas ─────────────────────────────────────────────────────

  addContentIdea(idea: Omit<ContentIdea, "id">): number {
    const result = this.db
      .prepare(
        `INSERT INTO pinterest_content_ideas
         (topic, suggested_title, suggested_description, target_keywords, difficulty, estimated_volume, source_data, created_at, status, pin_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        idea.topic,
        idea.suggested_title,
        idea.suggested_description,
        idea.target_keywords,
        idea.difficulty,
        idea.estimated_volume,
        idea.source_data,
        idea.created_at,
        idea.status,
        idea.pin_id ?? null,
      );
    return result.lastInsertRowid as number;
  }

  listContentIdeas(status?: string): ContentIdea[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM pinterest_content_ideas WHERE status = ? ORDER BY created_at DESC")
        .all(status) as ContentIdea[];
    }
    return this.db
      .prepare("SELECT * FROM pinterest_content_ideas ORDER BY created_at DESC")
      .all() as ContentIdea[];
  }

  updateIdeaStatus(id: number, status: "new" | "created" | "dismissed", pinId?: string): boolean {
    if (pinId) {
      const result = this.db
        .prepare("UPDATE pinterest_content_ideas SET status = ?, pin_id = ? WHERE id = ?")
        .run(status, pinId, id);
      return result.changes > 0;
    }
    const result = this.db
      .prepare("UPDATE pinterest_content_ideas SET status = ? WHERE id = ?")
      .run(status, id);
    return result.changes > 0;
  }

  deleteContentIdea(id: number): boolean {
    const result = this.db
      .prepare("DELETE FROM pinterest_content_ideas WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  // ── Analytics helpers ─────────────────────────────────────────────────

  /** Get pin performance summary with latest vs first snapshot deltas */
  getPinPerformanceSummary(pinId: string): {
    pin: TrackedPin;
    latest: PinSnapshot | null;
    first: PinSnapshot | null;
    totalSnapshots: number;
    daysSinceCreated: number;
  } | null {
    const pin = this.getTrackedPin(pinId);
    if (!pin) return null;

    const latest = this.getLatestSnapshot(pinId) ?? null;
    const first = this.db
      .prepare(
        "SELECT * FROM pinterest_pin_snapshots WHERE pin_id = ? ORDER BY checked_at ASC LIMIT 1",
      )
      .get(pinId) as PinSnapshot | undefined ?? null;

    const count = this.db
      .prepare("SELECT COUNT(*) as cnt FROM pinterest_pin_snapshots WHERE pin_id = ?")
      .get(pinId) as { cnt: number };

    const daysSinceCreated = Math.floor(
      (Date.now() - new Date(pin.created_at).getTime()) / (1000 * 60 * 60 * 24),
    );

    return {
      pin,
      latest,
      first,
      totalSnapshots: count.cnt,
      daysSinceCreated,
    };
  }
}
