import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AgentTask, CreateTaskInput, StoredTask, TaskStatus } from "./types.js";
import { TASK_LIMITS } from "./types.js";

/** Convert a SQLite row into a domain `AgentTask`. */
export const toTask = (row: StoredTask): AgentTask => ({
  id: row.id,
  parentTaskId: row.parent_task_id,
  trigger: row.trigger as AgentTask["trigger"],
  status: row.status as AgentTask["status"],
  goal: row.goal,
  context: row.context,
  result: row.result,
  error: row.error,
  sessionId: row.session_id,
  channelType: row.channel_type as AgentTask["channelType"],
  chatId: row.chat_id,
  model: row.model,
  notifyOnComplete: row.notify_on_complete === 1,
  depth: row.depth,
  createdAt: new Date(row.created_at),
  startedAt: row.started_at ? new Date(row.started_at) : null,
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
  spawnedBy: row.spawned_by,
});

/**
 * Data-access layer for the `agent_tasks` table.
 *
 * All methods are **synchronous** (better-sqlite3 API) except where explicitly
 * noted. Keep business logic in `TaskEngine`; this class is a thin persistence
 * wrapper.
 */
export class TaskRepository {
  private db: Database.Database;
  private clock: () => Date;

  constructor(db: Database.Database, clock?: () => Date) {
    this.db = db;
    this.clock = clock ?? (() => new Date());
  }

  // ── Schema ──────────────────────────────────────────────────────────

  /** Idempotent table + index creation. Safe to call on every boot. */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        parent_task_id TEXT REFERENCES agent_tasks(id),
        trigger TEXT NOT NULL CHECK(trigger IN ('chat', 'cron', 'agent')),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        goal TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        result TEXT,
        error TEXT,
        session_id TEXT,
        channel_type TEXT,
        chat_id TEXT,
        model TEXT,
        notify_on_complete INTEGER NOT NULL DEFAULT 0,
        depth INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        spawned_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON agent_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON agent_tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON agent_tasks(session_id);
    `);

    // ── Backfill: link orphaned agent tasks to their parent ──
    // Before the parentTaskId propagation fix, spawn-agent/orchestrate-agents
    // never set parentTaskId. This backfill matches orphaned agent tasks to
    // the most recent CHAT task in the same session created within 60 seconds
    // before the agent task.
    //
    // NOTE: This only touches tasks with parent_task_id IS NULL, so it will
    // never overwrite legitimately-set parent links from the new code that
    // creates orchestration parent tasks (agent→agent hierarchies).
    this.db.exec(`
      UPDATE agent_tasks
      SET parent_task_id = (
        SELECT p.id
        FROM agent_tasks p
        WHERE p.trigger = 'chat'
          AND p.session_id = agent_tasks.session_id
          AND p.session_id IS NOT NULL
          AND p.id != agent_tasks.id
          AND p.created_at < agent_tasks.created_at
          AND julianday(agent_tasks.created_at) - julianday(p.created_at) < 60.0 / 86400.0
        ORDER BY p.created_at DESC
        LIMIT 1
      ),
      depth = 1
      WHERE trigger = 'agent'
        AND parent_task_id IS NULL
        AND session_id IS NOT NULL;
    `);
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  /** Insert a new task and return the hydrated domain object. */
  insert(input: CreateTaskInput): AgentTask {
    const id = randomUUID();
    const now = this.clock().toISOString();
    let depth = 0;

    if (input.parentTaskId) {
      const parent = this.getById(input.parentTaskId);
      if (!parent) {
        throw new Error(`Parent task not found: ${input.parentTaskId}`);
      }
      depth = parent.depth + 1;
      if (depth > TASK_LIMITS.maxDepth) {
        throw new Error(
          `Maximum task depth (${TASK_LIMITS.maxDepth}) exceeded`
        );
      }

      // Enforce max-children limit
      const childCount = this.countChildren(input.parentTaskId);
      if (childCount >= TASK_LIMITS.maxChildren) {
        throw new Error(
          `Parent task ${input.parentTaskId} already has ${TASK_LIMITS.maxChildren} children`
        );
      }
    }

    this.db
      .prepare(
        `INSERT INTO agent_tasks
          (id, parent_task_id, trigger, status, goal, context,
           session_id, channel_type, chat_id, model,
           notify_on_complete, depth, created_at, spawned_by)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.parentTaskId ?? null,
        input.trigger,
        input.goal,
        input.context ?? "",
        input.sessionId ?? null,
        input.channelType ?? null,
        input.chatId ?? null,
        input.model ?? null,
        input.notifyOnComplete ? 1 : 0,
        depth,
        now,
        input.spawnedBy ?? null
      );

    return this.getById(id)!;
  }

  getById(id: string): AgentTask | null {
    const row = this.db
      .prepare("SELECT * FROM agent_tasks WHERE id = ?")
      .get(id) as StoredTask | undefined;
    return row ? toTask(row) : null;
  }

  /** List tasks, newest first. Optional status filter. */
  list(options?: { status?: TaskStatus; limit?: number; parentTaskId?: string }): AgentTask[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options?.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options?.parentTaskId) {
      clauses.push("parent_task_id = ?");
      params.push(options.parentTaskId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = options?.limit ? `LIMIT ${options.limit}` : "";
    const sql = `SELECT * FROM agent_tasks ${where} ORDER BY created_at DESC ${limit}`;
    const rows = this.db.prepare(sql).all(...params) as StoredTask[];
    return rows.map(toTask);
  }

  /** Atomically claim the next queued task for execution. Returns null if queue is empty. */
  dequeue(): AgentTask | null {
    const now = this.clock().toISOString();
    const row = this.db
      .prepare(
        `UPDATE agent_tasks
         SET status = 'running', started_at = ?
         WHERE id = (
           SELECT id FROM agent_tasks
           WHERE status = 'queued'
           ORDER BY created_at ASC
           LIMIT 1
         )
         RETURNING *`
      )
      .get(now) as StoredTask | undefined;

    return row ? toTask(row) : null;
  }

  /** Mark a task as running. */
  markRunning(id: string): void {
    const now = this.clock().toISOString();
    this.db
      .prepare("UPDATE agent_tasks SET status = 'running', started_at = ? WHERE id = ?")
      .run(now, id);
  }

  /** Mark a task as completed with a result. */
  markCompleted(id: string, result: string): void {
    const now = this.clock().toISOString();
    this.db
      .prepare(
        "UPDATE agent_tasks SET status = 'completed', result = ?, completed_at = ? WHERE id = ?"
      )
      .run(result, now, id);
  }

  /** Mark a task as failed with an error message. */
  markFailed(id: string, error: string): void {
    const now = this.clock().toISOString();
    this.db
      .prepare(
        "UPDATE agent_tasks SET status = 'failed', error = ?, completed_at = ? WHERE id = ?"
      )
      .run(error, now, id);
  }

  /** Cancel a task (only if queued or running). Returns true if cancelled. */
  cancel(id: string): boolean {
    const now = this.clock().toISOString();
    const result = this.db
      .prepare(
        "UPDATE agent_tasks SET status = 'cancelled', completed_at = ? WHERE id = ? AND status IN ('queued', 'running')"
      )
      .run(now, id);
    return result.changes > 0;
  }

  /** Get children of a task. */
  getChildren(parentTaskId: string): AgentTask[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_tasks WHERE parent_task_id = ? ORDER BY created_at ASC")
      .all(parentTaskId) as StoredTask[];
    return rows.map(toTask);
  }

  /** Count children of a task. */
  countChildren(parentTaskId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM agent_tasks WHERE parent_task_id = ?")
      .get(parentTaskId) as { count: number };
    return row.count;
  }

  /** Count queued tasks. */
  countQueued(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'queued'")
      .get() as { count: number };
    return row.count;
  }

  /** Count running tasks. */
  countRunning(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'running'")
      .get() as { count: number };
    return row.count;
  }

  /** Count tasks created by a session in the last N milliseconds. */
  countRecentBySession(sessionId: string, windowMs: number): number {
    const cutoff = new Date(this.clock().getTime() - windowMs).toISOString();
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM agent_tasks WHERE session_id = ? AND created_at >= ?"
      )
      .get(sessionId, cutoff) as { count: number };
    return row.count;
  }
}
