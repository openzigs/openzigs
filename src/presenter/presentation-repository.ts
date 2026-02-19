/**
 * Presenter Mode — Presentation Repository
 * Issue #276 (SI-1): SQLite CRUD for presentations + quiz_cache.
 * Follows the TaskRepository pattern.
 */

import type Database from "better-sqlite3";
import { nanoid } from "nanoid";

// ── Types ─────────────────────────────────────────────────────

export interface PresentationRow {
  id: string;
  title: string;
  video_path: string;
  thumbnail_path: string | null;
  duration_seconds: number;
  fps: number;
  script_json: string;
  chapters: string;
  voice_id: string | null;
  quiz_enabled: number;
  quiz_config: string | null;
  director_manifest_path: string | null;
  mode: string;
  created_at: string;
}

export interface PresentationSummary {
  id: string;
  title: string;
  thumbnail_path: string | null;
  duration_seconds: number;
  mode: string;
  quiz_enabled: boolean;
  created_at: string;
}

export interface Chapter {
  title: string;
  startSeconds: number;
  endSeconds: number;
}

export interface QuizConfig {
  timestamps: number[];
  difficulty: "easy" | "medium" | "hard";
}

export interface QuizCacheRow {
  id: string;
  presentation_id: string;
  chapter_index: number;
  timestamp_seconds: number;
  question: string;
  options: string;
  correct_index: number;
  explanation: string;
  generated_at: string;
}

export interface CreatePresentationInput {
  title: string;
  video_path: string;
  thumbnail_path?: string | null;
  duration_seconds: number;
  fps?: number;
  script_json: string;
  chapters: string;
  voice_id?: string | null;
  quiz_enabled?: boolean;
  quiz_config?: QuizConfig | null;
  director_manifest_path?: string | null;
  mode: string;
}

export interface InsertQuizInput {
  presentation_id: string;
  chapter_index: number;
  timestamp_seconds: number;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
}

// ── Repository ────────────────────────────────────────────────

export class PresentationRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Idempotent table creation. Safe to call on every boot. */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS presentations (
        id                    TEXT PRIMARY KEY,
        title                 TEXT NOT NULL,
        video_path            TEXT NOT NULL,
        thumbnail_path        TEXT,
        duration_seconds      REAL NOT NULL,
        fps                   INTEGER NOT NULL DEFAULT 30,
        script_json           TEXT NOT NULL,
        chapters              TEXT NOT NULL DEFAULT '[]',
        voice_id              TEXT,
        quiz_enabled          INTEGER NOT NULL DEFAULT 0,
        quiz_config           TEXT,
        director_manifest_path TEXT,
        mode                  TEXT NOT NULL DEFAULT 'presentation',
        created_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS quiz_cache (
        id                TEXT PRIMARY KEY,
        presentation_id   TEXT NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
        chapter_index     INTEGER NOT NULL,
        timestamp_seconds REAL NOT NULL,
        question          TEXT NOT NULL,
        options           TEXT NOT NULL,
        correct_index     INTEGER NOT NULL,
        explanation       TEXT NOT NULL DEFAULT '',
        generated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_quiz_cache_presentation
        ON quiz_cache(presentation_id);
    `);
  }

  insert(input: CreatePresentationInput): PresentationRow {
    const id = nanoid(12);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO presentations
          (id, title, video_path, thumbnail_path, duration_seconds, fps,
           script_json, chapters, voice_id, quiz_enabled, quiz_config,
           director_manifest_path, mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title,
        input.video_path,
        input.thumbnail_path ?? null,
        input.duration_seconds,
        input.fps ?? 30,
        input.script_json,
        input.chapters,
        input.voice_id ?? null,
        input.quiz_enabled ? 1 : 0,
        input.quiz_config ? JSON.stringify(input.quiz_config) : null,
        input.director_manifest_path ?? null,
        input.mode,
        now,
      );

    return this.findById(id)!;
  }

  findById(id: string): PresentationRow | undefined {
    return this.db
      .prepare("SELECT * FROM presentations WHERE id = ?")
      .get(id) as PresentationRow | undefined;
  }

  listAll(): PresentationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, thumbnail_path, duration_seconds, mode, quiz_enabled, created_at
         FROM presentations ORDER BY created_at DESC`
      )
      .all() as PresentationRow[];

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      thumbnail_path: r.thumbnail_path,
      duration_seconds: r.duration_seconds,
      mode: r.mode,
      quiz_enabled: r.quiz_enabled === 1,
      created_at: r.created_at,
    }));
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM presentations WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  update(
    id: string,
    fields: { title?: string; quiz_enabled?: boolean; quiz_config?: QuizConfig | null },
  ): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (fields.title !== undefined) {
      sets.push("title = ?");
      params.push(fields.title);
    }
    if (fields.quiz_enabled !== undefined) {
      sets.push("quiz_enabled = ?");
      params.push(fields.quiz_enabled ? 1 : 0);
    }
    if (fields.quiz_config !== undefined) {
      sets.push("quiz_config = ?");
      params.push(fields.quiz_config ? JSON.stringify(fields.quiz_config) : null);
    }

    if (sets.length === 0) return false;

    params.push(id);
    const result = this.db
      .prepare(`UPDATE presentations SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    return result.changes > 0;
  }

  // ── Quiz Cache ────────────────────────────────────────────────

  insertQuiz(input: InsertQuizInput): QuizCacheRow {
    const id = nanoid(12);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO quiz_cache
          (id, presentation_id, chapter_index, timestamp_seconds,
           question, options, correct_index, explanation, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.presentation_id,
        input.chapter_index,
        input.timestamp_seconds,
        input.question,
        JSON.stringify(input.options),
        input.correct_index,
        input.explanation,
        now,
      );

    return this.db
      .prepare("SELECT * FROM quiz_cache WHERE id = ?")
      .get(id) as QuizCacheRow;
  }

  getQuizzes(presentationId: string): QuizCacheRow[] {
    return this.db
      .prepare(
        "SELECT * FROM quiz_cache WHERE presentation_id = ? ORDER BY timestamp_seconds ASC"
      )
      .all(presentationId) as QuizCacheRow[];
  }

  deleteQuizzes(presentationId: string): number {
    const result = this.db
      .prepare("DELETE FROM quiz_cache WHERE presentation_id = ?")
      .run(presentationId);
    return result.changes;
  }
}
