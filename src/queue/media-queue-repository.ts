/**
 * Media Queue — SQLite Repository
 * Issue #326: Persistence layer for the `media_jobs` and `media_assets` tables.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  CreateMediaJobInput,
  MediaJob,
  MediaJobStatus,
  MediaJobType,
  StoredMediaJob,
  TargetNode,
} from "./types.js";
import { defaultModelForJobType, targetNodeForJobType } from "./types.js";

// ── Row → Domain ──────────────────────────────────────────────

const toJob = (row: StoredMediaJob): MediaJob => ({
  id: row.id,
  type: row.type as MediaJobType,
  requiredModel: row.required_model,
  targetNode: row.target_node as TargetNode,
  payload: JSON.parse(row.payload),
  status: row.status as MediaJobStatus,
  resultUrl: row.result_url,
  resultMetadata: row.result_metadata ? JSON.parse(row.result_metadata) : null,
  projectId: row.project_id,
  galleryAssetId: row.gallery_asset_id,
  priority: row.priority,
  retries: row.retries,
  maxRetries: row.max_retries,
  error: row.error,
  createdAt: new Date(row.created_at),
  dispatchedAt: row.dispatched_at ? new Date(row.dispatched_at) : null,
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
});

// ── Repository ────────────────────────────────────────────────

export class MediaQueueRepository {
  private db: Database.Database;
  private clock: () => Date;

  constructor(db: Database.Database, clock?: () => Date) {
    this.db = db;
    this.clock = clock ?? (() => new Date());
  }

  // ── Schema ────────────────────────────────────────────────

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('txt2img','img2img','txt2video','img2video','tts')),
        required_model TEXT NOT NULL,
        target_node TEXT NOT NULL CHECK(target_node IN ('mac-mini','m2-pro')),
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','dispatched','processing','complete','failed')),
        result_url TEXT,
        result_metadata TEXT,
        project_id TEXT,
        gallery_asset_id TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        error TEXT,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_media_jobs_target ON media_jobs(target_node, status);
      CREATE INDEX IF NOT EXISTS idx_media_jobs_project ON media_jobs(project_id);
    `);

    // ── media_assets table ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_assets (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('image','video','audio')),
        filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size_bytes INTEGER,
        width INTEGER,
        height INTEGER,
        duration_seconds REAL,
        prompt TEXT,
        model TEXT,
        generation_params TEXT,
        source TEXT NOT NULL CHECK(source IN ('generated','uploaded','director')),
        job_id TEXT,
        project_id TEXT,
        tags TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_media_assets_type ON media_assets(type);
      CREATE INDEX IF NOT EXISTS idx_media_assets_source ON media_assets(source);
      CREATE INDEX IF NOT EXISTS idx_media_assets_project ON media_assets(project_id);
    `);
  }

  // ── Media Jobs CRUD ───────────────────────────────────────

  createJob(input: CreateMediaJobInput): MediaJob {
    const id = randomUUID();
    const now = this.clock().toISOString();
    const model = input.model ?? input.payload.model ?? defaultModelForJobType(input.type);
    const targetNode = targetNodeForJobType(input.type);

    const stmt = this.db.prepare(`
      INSERT INTO media_jobs (id, type, required_model, target_node, payload, status, project_id, priority, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);

    stmt.run(
      id,
      input.type,
      model,
      targetNode,
      JSON.stringify(input.payload),
      input.projectId ?? null,
      input.priority ?? 0,
      now,
    );

    return this.getJob(id)!;
  }

  getJob(id: string): MediaJob | null {
    const row = this.db.prepare("SELECT * FROM media_jobs WHERE id = ?").get(id) as StoredMediaJob | undefined;
    return row ? toJob(row) : null;
  }

  /** Get pending jobs for a target node, ordered by priority DESC, created_at ASC. */
  getPendingJobs(targetNode?: TargetNode, limit = 10): MediaJob[] {
    let sql = "SELECT * FROM media_jobs WHERE status = 'pending'";
    const params: unknown[] = [];

    if (targetNode) {
      sql += " AND target_node = ?";
      params.push(targetNode);
    }

    sql += " ORDER BY priority DESC, created_at ASC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as StoredMediaJob[];
    return rows.map(toJob);
  }

  /** Get pending jobs that match a specific model on a target node (VRAM-aware batching). */
  getPendingJobsForModel(targetNode: TargetNode, model: string, limit = 5): MediaJob[] {
    const rows = this.db.prepare(
      `SELECT * FROM media_jobs
       WHERE status = 'pending' AND target_node = ? AND required_model = ?
       ORDER BY priority DESC, created_at ASC LIMIT ?`,
    ).all(targetNode, model, limit) as StoredMediaJob[];
    return rows.map(toJob);
  }

  markDispatched(id: string): void {
    const now = this.clock().toISOString();
    this.db.prepare(
      "UPDATE media_jobs SET status = 'dispatched', dispatched_at = ? WHERE id = ?",
    ).run(now, id);
  }

  markProcessing(id: string): void {
    this.db.prepare("UPDATE media_jobs SET status = 'processing' WHERE id = ?").run(id);
  }

  markComplete(id: string, resultUrl: string, metadata?: Record<string, unknown>, galleryAssetId?: string): void {
    const now = this.clock().toISOString();
    this.db.prepare(
      `UPDATE media_jobs SET status = 'complete', result_url = ?, result_metadata = ?,
       gallery_asset_id = ?, completed_at = ? WHERE id = ?`,
    ).run(resultUrl, metadata ? JSON.stringify(metadata) : null, galleryAssetId ?? null, now, id);
  }

  markFailed(id: string, error: string): void {
    const now = this.clock().toISOString();
    const job = this.getJob(id);
    if (!job) return;

    if (job.retries < job.maxRetries) {
      // Retry: bump retries and reset to pending
      this.db.prepare(
        "UPDATE media_jobs SET status = 'pending', retries = retries + 1, error = ? WHERE id = ?",
      ).run(error, id);
    } else {
      this.db.prepare(
        "UPDATE media_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
      ).run(error, now, id);
    }
  }

  cancelJob(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE media_jobs SET status = 'failed', error = 'Cancelled by user' WHERE id = ? AND status = 'pending'",
    ).run(id);
    return result.changes > 0;
  }

  /** List jobs with optional filters. */
  listJobs(opts: { status?: MediaJobStatus; type?: MediaJobType; projectId?: string; limit?: number; offset?: number }): MediaJob[] {
    let sql = "SELECT * FROM media_jobs WHERE 1=1";
    const params: unknown[] = [];

    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts.type) { sql += " AND type = ?"; params.push(opts.type); }
    if (opts.projectId) { sql += " AND project_id = ?"; params.push(opts.projectId); }

    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(opts.limit ?? 50, opts.offset ?? 0);

    return (this.db.prepare(sql).all(...params) as StoredMediaJob[]).map(toJob);
  }

  /** Count jobs by status (for dashboard). */
  countByStatus(): Record<MediaJobStatus, number> {
    const rows = this.db.prepare(
      "SELECT status, COUNT(*) as count FROM media_jobs GROUP BY status",
    ).all() as Array<{ status: string; count: number }>;

    const counts: Record<string, number> = { pending: 0, dispatched: 0, processing: 0, complete: 0, failed: 0 };
    for (const r of rows) counts[r.status] = r.count;
    return counts as Record<MediaJobStatus, number>;
  }

  /** Check if all jobs for a project are complete. */
  isProjectComplete(projectId: string): { complete: boolean; total: number; done: number } {
    const total = (this.db.prepare(
      "SELECT COUNT(*) as c FROM media_jobs WHERE project_id = ?",
    ).get(projectId) as { c: number }).c;

    const done = (this.db.prepare(
      "SELECT COUNT(*) as c FROM media_jobs WHERE project_id = ? AND status IN ('complete', 'failed')",
    ).get(projectId) as { c: number }).c;

    return { complete: total > 0 && done >= total, total, done };
  }

  // ── Media Assets CRUD ─────────────────────────────────────

  createAsset(input: {
    type: "image" | "video" | "audio";
    filename: string;
    filePath: string;
    mimeType: string;
    fileSizeBytes?: number;
    width?: number;
    height?: number;
    durationSeconds?: number;
    prompt?: string;
    model?: string;
    generationParams?: Record<string, unknown>;
    source: "generated" | "uploaded" | "director";
    jobId?: string;
    projectId?: string;
    tags?: string[];
  }): string {
    const id = randomUUID();
    const now = this.clock().toISOString();

    this.db.prepare(`
      INSERT INTO media_assets (id, type, filename, file_path, mime_type, file_size_bytes,
        width, height, duration_seconds, prompt, model, generation_params,
        source, job_id, project_id, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.type, input.filename, input.filePath, input.mimeType,
      input.fileSizeBytes ?? null, input.width ?? null, input.height ?? null,
      input.durationSeconds ?? null, input.prompt ?? null, input.model ?? null,
      input.generationParams ? JSON.stringify(input.generationParams) : null,
      input.source, input.jobId ?? null, input.projectId ?? null,
      input.tags ? JSON.stringify(input.tags) : null, now, now,
    );

    return id;
  }

  getAsset(id: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM media_assets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (typeof row.generation_params === "string") row.generation_params = JSON.parse(row.generation_params as string);
    if (typeof row.tags === "string") row.tags = JSON.parse(row.tags as string);
    return row;
  }

  listAssets(opts: { type?: string; source?: string; projectId?: string; limit?: number; offset?: number } = {}): Array<Record<string, unknown>> {
    let sql = "SELECT * FROM media_assets WHERE 1=1";
    const params: unknown[] = [];

    if (opts.type) { sql += " AND type = ?"; params.push(opts.type); }
    if (opts.source) { sql += " AND source = ?"; params.push(opts.source); }
    if (opts.projectId) { sql += " AND project_id = ?"; params.push(opts.projectId); }

    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(opts.limit ?? 50, opts.offset ?? 0);

    return (this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map((row) => {
      if (typeof row.generation_params === "string") row.generation_params = JSON.parse(row.generation_params as string);
      if (typeof row.tags === "string") row.tags = JSON.parse(row.tags as string);
      return row;
    });
  }

  deleteAsset(id: string): boolean {
    return this.db.prepare("DELETE FROM media_assets WHERE id = ?").run(id).changes > 0;
  }

  updateAssetTags(id: string, tags: string[]): void {
    const now = this.clock().toISOString();
    this.db.prepare("UPDATE media_assets SET tags = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(tags), now, id);
  }
}
