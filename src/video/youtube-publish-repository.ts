/**
 * YouTube Publish Repository — SQLite persistence for YouTube publish history.
 * Issue #517: Tracks all YouTube publishes with status, video metadata, and error info.
 */

import type Database from "better-sqlite3";

export interface YouTubePublishRow {
  id: string;
  draft_id: string;
  video_id: string | null;
  video_url: string | null;
  title: string;
  privacy_status: string;
  published_at: string | null;
  status: string; // uploading | published | failed | scheduled
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class YouTubePublishRepository {
  constructor(private readonly db: Database.Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS youtube_publishes (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        video_id TEXT,
        video_url TEXT,
        title TEXT NOT NULL,
        privacy_status TEXT NOT NULL DEFAULT 'private',
        published_at TEXT,
        status TEXT NOT NULL DEFAULT 'uploading',
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (draft_id) REFERENCES director_drafts(id) ON DELETE CASCADE
      );
    `);
  }

  insert(row: YouTubePublishRow): void {
    this.db.prepare(
      `INSERT INTO youtube_publishes (id, draft_id, video_id, video_url, title, privacy_status, published_at, status, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.draft_id,
      row.video_id,
      row.video_url,
      row.title,
      row.privacy_status,
      row.published_at,
      row.status,
      row.error_message,
      row.created_at,
      row.updated_at,
    );
  }

  updateStatus(id: string, status: string, updates: Partial<Pick<YouTubePublishRow, "video_id" | "video_url" | "published_at" | "error_message">> = {}): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE youtube_publishes
       SET status = ?, video_id = COALESCE(?, video_id), video_url = COALESCE(?, video_url),
           published_at = COALESCE(?, published_at), error_message = COALESCE(?, error_message),
           updated_at = ?
       WHERE id = ?`,
    ).run(
      status,
      updates.video_id ?? null,
      updates.video_url ?? null,
      updates.published_at ?? null,
      updates.error_message ?? null,
      now,
      id,
    );
  }

  getById(id: string): YouTubePublishRow | undefined {
    return this.db.prepare(
      `SELECT * FROM youtube_publishes WHERE id = ?`,
    ).get(id) as YouTubePublishRow | undefined;
  }

  getByDraftId(draftId: string): YouTubePublishRow[] {
    return this.db.prepare(
      `SELECT * FROM youtube_publishes WHERE draft_id = ? ORDER BY created_at DESC`,
    ).all(draftId) as YouTubePublishRow[];
  }

  getLatestByDraftId(draftId: string): YouTubePublishRow | undefined {
    return this.db.prepare(
      `SELECT * FROM youtube_publishes WHERE draft_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(draftId) as YouTubePublishRow | undefined;
  }

  listAll(limit = 100): YouTubePublishRow[] {
    return this.db.prepare(
      `SELECT * FROM youtube_publishes ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as YouTubePublishRow[];
  }

  deleteById(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM youtube_publishes WHERE id = ?`).run(id);
    return result.changes > 0;
  }
}
