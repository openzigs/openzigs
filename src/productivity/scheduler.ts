import type Database from "better-sqlite3";
import cron from "node-cron";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { PipelineStage } from "../tasks/types.js";
import type { ReasoningEffort } from "../copilot/copilot-wrapper.js";

export type ScheduledJob = {
  id: string;
  name: string;
  cronExpression: string;
  timezone: string;
  actionType: "prompt" | "shell" | "custom";
  actionPayload: Record<string, unknown>;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /** Optional list of tool names this job is allowed to use. null = all enabled tools. */
  allowedTools: string[] | null;
  /** Tools that bypass approval gating when this job runs. null = normal approval flow. */
  autoApproveTools: string[] | null;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateJobInput = {
  name: string;
  cronExpression: string;
  timezone?: string;
  actionType?: "prompt" | "shell" | "custom";
  actionPayload: Record<string, unknown>;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Optional list of tool names this job is allowed to use. */
  allowedTools?: string[];
  /** Tools that bypass approval gating for this job. */
  autoApproveTools?: string[];
  enabled?: boolean;
};

export type UpdateJobInput = {
  name?: string;
  cronExpression?: string;
  timezone?: string;
  actionPayload?: Record<string, unknown>;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  /** Set to an array to restrict tools, or null to clear restriction. */
  allowedTools?: string[] | null;
  /** Set to an array to auto-approve tools, or null to clear. */
  autoApproveTools?: string[] | null;
  enabled?: boolean;
};

type StoredJob = {
  id: string;
  name: string;
  cron_expression: string;
  timezone: string;
  action_type: string;
  action_payload: string;
  model: string | null;
  reasoning_effort: string | null;
  allowed_tools: string | null;
  auto_approve_tools: string | null;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
};

export type JobExecutionResult = {
  jobId: string;
  jobName: string;
  executedAt: Date;
  success: boolean;
  result?: string;
  error?: string;
};

export type SchedulerOptions = {
  db: Database.Database;
  auditLogDir?: string;
  clock?: () => Date;
  onExecute?: (job: ScheduledJob) => Promise<string>;
  /** When provided, scheduled prompt/shell jobs are submitted as background tasks. */
  taskEngine?: TaskEngine;
  /** Resolve a saved prompt name to its template text and optional pipeline stages. */
  promptResolver?: (promptName: string, variables?: Record<string, string>) => {
    text: string;
    preferredTools: string[] | null;
    stages: PipelineStage[] | null;
  } | null;
};

const toJob = (row: StoredJob): ScheduledJob => ({
  id: row.id,
  name: row.name,
  cronExpression: row.cron_expression,
  timezone: row.timezone,
  actionType: row.action_type as ScheduledJob["actionType"],
  actionPayload: JSON.parse(row.action_payload) as Record<string, unknown>,
  model: row.model ?? null,
  reasoningEffort: (row.reasoning_effort as ReasoningEffort | null) ?? null,
  allowedTools: row.allowed_tools ? (JSON.parse(row.allowed_tools) as string[]) : null,
  autoApproveTools: row.auto_approve_tools ? (JSON.parse(row.auto_approve_tools) as string[]) : null,
  enabled: row.enabled === 1,
  lastRunAt: row.last_run_at ? new Date(row.last_run_at) : null,
  nextRunAt: row.next_run_at ? new Date(row.next_run_at) : null,
  runCount: row.run_count,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const defaultAuditDir = () => path.join(os.homedir(), ".openzigs", "logs");

export class Scheduler extends EventEmitter {
  private db: Database.Database;
  private clock: () => Date;
  private auditLogDir: string;
  private tasks = new Map<string, cron.ScheduledTask>();
  private onExecute?: (job: ScheduledJob) => Promise<string>;
  private taskEngine?: TaskEngine;
  private promptResolver?: (promptName: string, variables?: Record<string, string>) => {
    text: string;
    preferredTools: string[] | null;
    stages: PipelineStage[] | null;
  } | null;

  constructor({ db, auditLogDir, clock, onExecute, taskEngine, promptResolver }: SchedulerOptions) {
    super();
    this.db = db;
    this.clock = clock ?? (() => new Date());
    this.auditLogDir = auditLogDir ?? defaultAuditDir();
    this.onExecute = onExecute;
    this.taskEngine = taskEngine;
    this.promptResolver = promptResolver;
    this.migrateSchema();
  }

  /** Set the TaskEngine (for deferred wiring when engine is created after scheduler). */
  setTaskEngine(engine: TaskEngine): void {
    this.taskEngine = engine;
  }

  /** Run lightweight schema migrations (add columns if missing). */
  private migrateSchema(): void {
    const columns = this.db.pragma("table_info(scheduled_jobs)") as Array<{ name: string }>;

    // Add 'model' column if it doesn't exist (safe for existing DBs)
    if (!columns.some((c) => c.name === "model")) {
      this.db.exec("ALTER TABLE scheduled_jobs ADD COLUMN model TEXT DEFAULT NULL");
    }

    // Add 'allowed_tools' column — JSON array of tool names or NULL (= all tools)
    if (!columns.some((c) => c.name === "allowed_tools")) {
      this.db.exec("ALTER TABLE scheduled_jobs ADD COLUMN allowed_tools TEXT DEFAULT NULL");
    }

    // Add 'reasoning_effort' column if it doesn't exist
    if (!columns.some((c) => c.name === "reasoning_effort")) {
      this.db.exec("ALTER TABLE scheduled_jobs ADD COLUMN reasoning_effort TEXT DEFAULT NULL");
    }

    // Add 'auto_approve_tools' column — tools that bypass approval gating
    if (!columns.some((c) => c.name === "auto_approve_tools")) {
      this.db.exec("ALTER TABLE scheduled_jobs ADD COLUMN auto_approve_tools TEXT DEFAULT NULL");
    }
  }

  /** Create a new scheduled job and optionally start it. */
  create(input: CreateJobInput): ScheduledJob {
    if (!cron.validate(input.cronExpression)) {
      throw new Error(`Invalid cron expression: ${input.cronExpression}`);
    }

    const now = this.clock().toISOString();
    const id = randomUUID();
    const enabled = input.enabled ?? true;

    this.db
      .prepare(
        `INSERT INTO scheduled_jobs
          (id, name, cron_expression, timezone, action_type, action_payload, model, reasoning_effort, allowed_tools, auto_approve_tools, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.cronExpression,
        input.timezone ?? "UTC",
        input.actionType ?? "prompt",
        JSON.stringify(input.actionPayload),
        input.model ?? null,
        input.reasoningEffort ?? null,
        input.allowedTools ? JSON.stringify(input.allowedTools) : null,
        input.autoApproveTools ? JSON.stringify(input.autoApproveTools) : null,
        enabled ? 1 : 0,
        now,
        now
      );

    const job = this.getById(id)!;
    if (enabled) {
      this.startTask(job);
    }
    return job;
  }

  getById(id: string): ScheduledJob | null {
    const row = this.db
      .prepare("SELECT * FROM scheduled_jobs WHERE id = ?")
      .get(id) as StoredJob | undefined;
    return row ? toJob(row) : null;
  }

  list(): ScheduledJob[] {
    const rows = this.db
      .prepare("SELECT * FROM scheduled_jobs ORDER BY created_at DESC")
      .all() as StoredJob[];
    return rows.map(toJob);
  }

  update(id: string, input: UpdateJobInput): ScheduledJob {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Job not found: ${id}`);
    }

    if (input.cronExpression && !cron.validate(input.cronExpression)) {
      throw new Error(`Invalid cron expression: ${input.cronExpression}`);
    }

    const now = this.clock().toISOString();
    const name = input.name ?? existing.name;
    const cronExpression = input.cronExpression ?? existing.cronExpression;
    const timezone = input.timezone ?? existing.timezone;
    const actionPayload = JSON.stringify(input.actionPayload ?? existing.actionPayload);
    const model = input.model !== undefined ? input.model : existing.model;
    const reasoningEffort = input.reasoningEffort !== undefined ? input.reasoningEffort : existing.reasoningEffort;
    const allowedTools = input.allowedTools !== undefined
      ? (input.allowedTools ? JSON.stringify(input.allowedTools) : null)
      : (existing.allowedTools ? JSON.stringify(existing.allowedTools) : null);
    const autoApproveTools = input.autoApproveTools !== undefined
      ? (input.autoApproveTools ? JSON.stringify(input.autoApproveTools) : null)
      : (existing.autoApproveTools ? JSON.stringify(existing.autoApproveTools) : null);
    const enabled = input.enabled ?? existing.enabled;

    this.db
      .prepare(
        `UPDATE scheduled_jobs
          SET name = ?, cron_expression = ?, timezone = ?, action_payload = ?, model = ?, reasoning_effort = ?, allowed_tools = ?, auto_approve_tools = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      )
        .run(name, cronExpression, timezone, actionPayload, model, reasoningEffort, allowedTools, autoApproveTools, enabled ? 1 : 0, now, id);

    // Restart the cron task if expression or timezone changed
    this.stopTask(id);
    const updated = this.getById(id)!;
    if (updated.enabled) {
      this.startTask(updated);
    }

    return updated;
  }

  delete(id: string): boolean {
    this.stopTask(id);
    const result = this.db
      .prepare("DELETE FROM scheduled_jobs WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  /** Enable or disable a job. */
  setEnabled(id: string, enabled: boolean): ScheduledJob {
    return this.update(id, { enabled });
  }

  /** Start all enabled jobs. Call once at server boot. */
  startAll(): void {
    const jobs = this.list().filter((j) => j.enabled);
    for (const job of jobs) {
      this.startTask(job);
    }
  }

  /** Stop all running tasks. Call on shutdown. */
  stopAll(): void {
    for (const [id, task] of this.tasks) {
      task.stop();
      this.tasks.delete(id);
    }
  }

  private startTask(job: ScheduledJob): void {
    if (this.tasks.has(job.id)) {
      return; // already running
    }

    const task = cron.schedule(
      job.cronExpression,
      async () => {
        await this.executeJob(job.id);
      },
      {
        timezone: job.timezone,
        noOverlap: true,
      }
    );

    this.tasks.set(job.id, task);
  }

  private stopTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
  }

  async executeJob(jobId: string): Promise<void> {
    const job = this.getById(jobId);
    if (!job || !job.enabled) {
      return;
    }

    const now = this.clock();

    // If TaskEngine is available, submit prompt jobs as background tasks
    if (this.taskEngine && job.actionType === "prompt") {
      try {
        const promptName = (job.actionPayload as Record<string, unknown>).promptName as string | undefined;
        const variables = ((job.actionPayload as Record<string, unknown>).variables ?? {}) as Record<string, string>;

        // Resolve the saved prompt template (with stages if configured)
        let resolvedPrompt: string | null = null;
        let pipelineStages: PipelineStage[] | null = null;

        if (promptName && this.promptResolver) {
          const resolved = this.promptResolver(promptName, variables);
          if (resolved) {
            resolvedPrompt = resolved.text;
            pipelineStages = resolved.stages;
          }
        }

        const goal = resolvedPrompt
          ? resolvedPrompt
          : (promptName
            ? `Execute scheduled prompt: "${promptName}" (job: ${job.name})`
            : `Execute scheduled job: "${job.name}"`);
        const context = `Scheduled job ID: ${job.id}\nAction: ${job.actionType}\nPrompt: ${promptName ?? "(none)"}\nPayload: ${JSON.stringify(job.actionPayload)}`;

        this.taskEngine.submit(
          {
            trigger: "cron",
            goal,
            context,
            model: job.model ?? undefined,
            reasoningEffort: job.reasoningEffort ?? undefined,
            allowedTools: job.allowedTools ?? undefined,
            autoApproveTools: job.autoApproveTools ?? undefined,
            pipeline: pipelineStages ? { stages: pipelineStages } : undefined,
            notifyOnComplete: true,
          },
          { mode: "background" }
        );

        // Update run metadata even when delegating to TaskEngine
        this.db
          .prepare(
            `UPDATE scheduled_jobs SET last_run_at = ?, run_count = run_count + 1, updated_at = ? WHERE id = ?`
          )
          .run(now.toISOString(), now.toISOString(), jobId);

        const result: JobExecutionResult = {
          jobId: job.id,
          jobName: job.name,
          executedAt: now,
          success: true,
          result: `Submitted as background task via TaskEngine`,
        };
        await this.appendAuditLog(result);
        this.emit("job:executed", result);
        return;
      } catch {
        // Fall through to legacy onExecute if TaskEngine submission fails
      }
    }

    let result: JobExecutionResult;

    try {
      const output = this.onExecute
        ? await this.onExecute(job)
        : `Job "${job.name}" executed (no handler)`;

      result = {
        jobId: job.id,
        jobName: job.name,
        executedAt: now,
        success: true,
        result: output,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        jobId: job.id,
        jobName: job.name,
        executedAt: now,
        success: false,
        error: message,
      };
    }

    // Update run metadata
    this.db
      .prepare(
        `UPDATE scheduled_jobs SET last_run_at = ?, run_count = run_count + 1, updated_at = ? WHERE id = ?`
      )
      .run(now.toISOString(), now.toISOString(), jobId);

    // Append to JSONL audit log
    await this.appendAuditLog(result);
    this.emit("job:executed", result);
  }

  private async appendAuditLog(result: JobExecutionResult): Promise<void> {
    try {
      await fs.mkdir(this.auditLogDir, { recursive: true });
      const date = result.executedAt.toISOString().slice(0, 10);
      const logFile = path.join(this.auditLogDir, `scheduler-${date}.jsonl`);
      const entry = {
        ...result,
        executedAt: result.executedAt.toISOString(),
      };
      await fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch {
      // Non-critical — swallow audit write failures
    }
  }
}
