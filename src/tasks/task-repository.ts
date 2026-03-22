import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AgentTask, CreateTaskInput, PipelineDefinition, StoredTask, TaskStatus, TaskTreeNode, TaskTreeStats, RootTaskSummary } from "./types.js";
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
  reasoningEffort: (row.reasoning_effort as AgentTask["reasoningEffort"]) ?? null,
  allowedTools: row.allowed_tools ? (JSON.parse(row.allowed_tools) as string[]) : null,
  autoApproveTools: row.auto_approve_tools ? (JSON.parse(row.auto_approve_tools) as string[]) : null,
  pipeline: row.pipeline ? (JSON.parse(row.pipeline) as PipelineDefinition) : null,
  tokenUsage: row.token_usage_json ? (JSON.parse(row.token_usage_json) as AgentTask["tokenUsage"]) : null,
  notifyOnComplete: row.notify_on_complete === 1,
  depth: row.depth,
  createdAt: new Date(row.created_at),
  startedAt: row.started_at ? new Date(row.started_at) : null,
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
  spawnedBy: row.spawned_by,
  skillName: row.skill_name ?? null,
  skillBody: row.skill_body ?? null,
  disabledSkills: row.disabled_skills ? (JSON.parse(row.disabled_skills) as string[]) : null,
  agentName: row.agent_name ?? null,
  enableInSessionSubagents: row.enable_in_session_subagents === 1,
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
        reasoning_effort TEXT,
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

    // Add 'allowed_tools' column if missing (safe for existing DBs)
    const columns = this.db.pragma("table_info(agent_tasks)") as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "allowed_tools")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN allowed_tools TEXT DEFAULT NULL");
    }

    // Add 'auto_approve_tools' column if missing — tools that bypass approval gating
    if (!columns.some((c) => c.name === "auto_approve_tools")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN auto_approve_tools TEXT DEFAULT NULL");
    }

    // Add 'reasoning_effort' column if missing
    if (!columns.some((c) => c.name === "reasoning_effort")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN reasoning_effort TEXT DEFAULT NULL");
    }

    // Add 'pipeline' column — JSON pipeline definition for multi-stage tasks
    if (!columns.some((c) => c.name === "pipeline")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN pipeline TEXT DEFAULT NULL");
    }

    // Add 'token_usage_json' column — JSON token usage data per task
    if (!columns.some((c) => c.name === "token_usage_json")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN token_usage_json TEXT DEFAULT NULL");
    }

    // Add 'skill_name' and 'skill_body' columns — skill injection for background tasks
    if (!columns.some((c) => c.name === "skill_name")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN skill_name TEXT DEFAULT NULL");
    }
    if (!columns.some((c) => c.name === "skill_body")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN skill_body TEXT DEFAULT NULL");
    }

    // Add 'disabled_skills' column — JSON array of disabled skill names for focused execution
    if (!columns.some((c) => c.name === "disabled_skills")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN disabled_skills TEXT DEFAULT NULL");
    }

    // Add 'agent_name' column — custom agent persona for task execution
    if (!columns.some((c) => c.name === "agent_name")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN agent_name TEXT DEFAULT NULL");
    }

    // Add 'enable_in_session_subagents' column — opt-in for SDK-native subagent delegation
    if (!columns.some((c) => c.name === "enable_in_session_subagents")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN enable_in_session_subagents INTEGER NOT NULL DEFAULT 0");
    }

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
           session_id, channel_type, chat_id, model, reasoning_effort, allowed_tools, auto_approve_tools,
           pipeline, notify_on_complete, depth, created_at, spawned_by, skill_name, skill_body, disabled_skills, agent_name, enable_in_session_subagents)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        input.reasoningEffort ?? null,
        input.allowedTools ? JSON.stringify(input.allowedTools) : null,
        input.autoApproveTools ? JSON.stringify(input.autoApproveTools) : null,
        input.pipeline ? JSON.stringify(input.pipeline) : null,
        input.notifyOnComplete ? 1 : 0,
        depth,
        now,
        input.spawnedBy ?? null,
        input.skillName ?? null,
        input.skillBody ?? null,
        input.disabledSkills ? JSON.stringify(input.disabledSkills) : null,
        input.agentName ?? null,
        input.enableInSessionSubagents ? 1 : 0
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
    if (options?.limit) {
      params.push(options.limit);
    }
    const limit = options?.limit ? "LIMIT ?" : "";
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

  /** Persist token usage data on a task (typically called on completion). */
  updateTokenUsage(taskId: string, usage: { inputTokens: number; outputTokens: number; totalTokens: number; turns: number }): void {
    this.db.prepare(
      "UPDATE agent_tasks SET token_usage_json = ? WHERE id = ?"
    ).run(JSON.stringify(usage), taskId);
  }

  /** List tasks created since a given ISO timestamp, newest first. */
  listSince(since: string, options?: { status?: TaskStatus; limit?: number }): AgentTask[] {
    const clauses: string[] = ["created_at >= ?"];
    const params: unknown[] = [since];

    if (options?.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }

    const where = `WHERE ${clauses.join(" AND ")}`;
    if (options?.limit) {
      params.push(options.limit);
    }
    const limit = options?.limit ? "LIMIT ?" : "";
    const sql = `SELECT * FROM agent_tasks ${where} ORDER BY created_at DESC ${limit}`;
    const rows = this.db.prepare(sql).all(...params) as StoredTask[];
    return rows.map(toTask);
  }

  /** Find tasks triggered by a specific job name (stored in context JSON). */
  findByJobName(jobName: string, limit = 10): AgentTask[] {
    const sql = `SELECT * FROM agent_tasks WHERE json_valid(context) AND json_extract(context, '$.jobName') = ? ORDER BY created_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(jobName, limit) as StoredTask[];
    return rows.map(toTask);
  }

  /**
   * Fetch the full task tree rooted at `taskId` using a recursive CTE.
   * Returns a flat list of `AgentTask` ordered by depth then created_at.
   */
  getTaskTreeFlat(taskId: string, maxDepth = 10): AgentTask[] {
    const sql = `
      WITH RECURSIVE task_tree AS (
        SELECT *, 0 as tree_depth FROM agent_tasks WHERE id = ?
        UNION ALL
        SELECT t.*, tt.tree_depth + 1
        FROM agent_tasks t
        JOIN task_tree tt ON t.parent_task_id = tt.id
        WHERE tt.tree_depth < ?
      )
      SELECT * FROM task_tree ORDER BY tree_depth, created_at
    `;
    const rows = this.db.prepare(sql).all(taskId, maxDepth) as (StoredTask & { tree_depth: number })[];
    return rows.map(toTask);
  }

  /**
   * Build a nested `TaskTreeNode` tree from a flat list of tasks rooted at `taskId`.
   */
  getTaskTree(taskId: string, maxDepth = 10): { root: TaskTreeNode; stats: TaskTreeStats } | null {
    const flatTasks = this.getTaskTreeFlat(taskId, maxDepth);
    if (flatTasks.length === 0) return null;

    const toNode = (task: AgentTask): TaskTreeNode => {
      const durationMs =
        task.startedAt && task.completedAt
          ? task.completedAt.getTime() - task.startedAt.getTime()
          : null;
      return {
        id: task.id,
        parentTaskId: task.parentTaskId,
        status: task.status,
        goal: task.goal,
        depth: task.depth,
        tokenUsage: task.tokenUsage,
        createdAt: task.createdAt.toISOString(),
        startedAt: task.startedAt?.toISOString() ?? null,
        completedAt: task.completedAt?.toISOString() ?? null,
        durationMs,
        agentName: task.agentName,
        children: [],
      };
    };

    const nodeMap = new Map<string, TaskTreeNode>();
    for (const task of flatTasks) {
      nodeMap.set(task.id, toNode(task));
    }

    // Build tree links
    for (const task of flatTasks) {
      if (task.parentTaskId && nodeMap.has(task.parentTaskId)) {
        nodeMap.get(task.parentTaskId)!.children.push(nodeMap.get(task.id)!);
      }
    }

    // Compute aggregate stats
    const stats: TaskTreeStats = {
      totalTasks: flatTasks.length,
      completed: 0,
      failed: 0,
      running: 0,
      queued: 0,
      cancelled: 0,
      totalTokens: 0,
    };
    for (const task of flatTasks) {
      if (task.status === "completed") stats.completed++;
      else if (task.status === "failed") stats.failed++;
      else if (task.status === "running") stats.running++;
      else if (task.status === "queued") stats.queued++;
      else if (task.status === "cancelled") stats.cancelled++;
      if (task.tokenUsage) stats.totalTokens += task.tokenUsage.totalTokens;
    }

    return { root: nodeMap.get(taskId)!, stats };
  }

  /** List all root tasks (no parent) with immediate child count. */
  getRootTasks(options?: { limit?: number; offset?: number }): RootTaskSummary[] {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const sql = `
      SELECT t.*,
        (SELECT COUNT(*) FROM agent_tasks c WHERE c.parent_task_id = t.id) as child_count
      FROM agent_tasks t
      WHERE t.parent_task_id IS NULL
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.prepare(sql).all(limit, offset) as (StoredTask & { child_count: number })[];
    return rows.map((row) => ({
      id: row.id,
      status: row.status as AgentTask["status"],
      goal: row.goal,
      model: row.model,
      trigger: row.trigger as AgentTask["trigger"],
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      childCount: row.child_count,
      tokenUsage: row.token_usage_json
        ? (JSON.parse(row.token_usage_json) as AgentTask["tokenUsage"])
        : null,
    }));
  }
}
