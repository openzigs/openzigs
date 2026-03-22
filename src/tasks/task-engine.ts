import { EventEmitter } from "node:events";
import { TaskRepository } from "./task-repository.js";
import { TASK_LIMITS } from "./types.js";
import type { AgentTask, CreateTaskInput, TaskMode, TaskStatus } from "./types.js";

export type TaskEngineOptions = {
  repository: TaskRepository;
  clock?: () => Date;
  /** Default model for background tasks (cron/webhook/agent triggers). */
  backgroundTaskDefaultModel?: string | null;
};

export type SubmitOptions = {
  /** Whether to execute inline (streaming) or send to the background queue. */
  mode: TaskMode;
};

/**
 * Central coordinator for the task lifecycle.
 *
 * - Accepts task submissions from any trigger source (chat, cron, spawn_agent).
 * - Validates recursion limits and rate limits.
 * - Decides whether to run immediately (inline streaming) or enqueue for background.
 * - Emits lifecycle events for other components (TaskWorker, NotificationDispatcher, UI).
 */
export class TaskEngine extends EventEmitter {
  private repository: TaskRepository;
  private backgroundTaskDefaultModel: string | null;

  constructor({ repository, backgroundTaskDefaultModel }: TaskEngineOptions) {
    super();
    this.repository = repository;
    this.backgroundTaskDefaultModel = backgroundTaskDefaultModel ?? null;
  }

  /** Expose repository for direct queries (e.g., execution history). */
  getRepository(): TaskRepository {
    return this.repository;
  }

  /**
   * Submit a new task. Validates safety limits, inserts the task, and emits
   * the appropriate event based on mode.
   *
   * @returns The created AgentTask.
   */
  submit(input: CreateTaskInput, options: SubmitOptions): AgentTask {
    // Rate-limit: max N tasks per session per minute
    if (input.sessionId) {
      const recent = this.repository.countRecentBySession(input.sessionId, 60_000);
      if (recent >= TASK_LIMITS.maxRatePerMinute) {
        throw new Error(
          `Rate limit: max ${TASK_LIMITS.maxRatePerMinute} tasks per minute per session`
        );
      }
    }

    // Apply background default model for non-interactive triggers without explicit model
    const resolvedInput = { ...input };
    if (!resolvedInput.model && resolvedInput.trigger !== "chat" && this.backgroundTaskDefaultModel) {
      resolvedInput.model = this.backgroundTaskDefaultModel;
    }

    const task = this.repository.insert(resolvedInput);

    if (options.mode === "immediate") {
      this.repository.markRunning(task.id);
      const running = this.repository.getById(task.id)!;
      this.emit("task:running", running);
      return running;
    }

    // Background mode — leave as queued, TaskWorker will pick it up
    this.emit("task:queued", task);
    return task;
  }

  /** Mark a task as completed. Emits `task:completed`. */
  complete(taskId: string, result: string): AgentTask {
    this.repository.markCompleted(taskId, result);
    const task = this.repository.getById(taskId)!;
    this.emit("task:completed", task);
    return task;
  }

  /** Mark a task as failed. Emits `task:failed`. */
  fail(taskId: string, error: string): AgentTask {
    this.repository.markFailed(taskId, error);
    const task = this.repository.getById(taskId)!;
    this.emit("task:failed", task);
    return task;
  }

  /** Cancel a queued or running task. Emits `task:cancelled`. Returns the task or null. */
  cancel(taskId: string): AgentTask | null {
    const cancelled = this.repository.cancel(taskId);
    if (!cancelled) {
      return null;
    }
    const task = this.repository.getById(taskId)!;
    this.emit("task:cancelled", task);
    return task;
  }

  /** Get a single task by ID. */
  getTask(taskId: string): AgentTask | null {
    return this.repository.getById(taskId);
  }

  /** List tasks with optional filters. */
  listTasks(options?: { status?: TaskStatus; limit?: number; parentTaskId?: string }): AgentTask[] {
    return this.repository.list(options);
  }

  /** Get children of a task. */
  getChildren(taskId: string): AgentTask[] {
    return this.repository.getChildren(taskId);
  }

  /** Get or update the background task default model at runtime. */
  getBackgroundTaskDefaultModel(): string | undefined {
    return this.backgroundTaskDefaultModel ?? undefined;
  }

  setBackgroundTaskDefaultModel(model: string | undefined): void {
    this.backgroundTaskDefaultModel = model ?? null;
  }

  /**
   * Recursively collect a task and all its descendants into a flat list.
   * Used by the /tree endpoint to build the full DAG for visualisation.
   */
  getDescendants(taskId: string): AgentTask[] {
    const result: AgentTask[] = [];
    const queue = [taskId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const children = this.repository.getChildren(id);
      for (const child of children) {
        result.push(child);
        queue.push(child.id);
      }
    }

    return result;
  }

  /**
   * Walk up the parentTaskId chain to find the root of the task tree.
   * Used by the /tree endpoint to always display the full tree from root,
   * regardless of which node the user clicked.
   */
  getRoot(taskId: string): AgentTask {
    let current = this.repository.getById(taskId);
    if (!current) throw new Error(`Task ${taskId} not found`);

    const visited = new Set<string>();
    while (current.parentTaskId) {
      if (visited.has(current.id)) break; // cycle guard
      visited.add(current.id);
      const parent = this.repository.getById(current.parentTaskId);
      if (!parent) break;
      current = parent;
    }

    return current;
  }

  /** Dequeue the next background task. Used by TaskWorker. */
  dequeue(): AgentTask | null {
    const task = this.repository.dequeue();
    if (task) {
      this.emit("task:running", task);
    }
    return task;
  }

  /** Get queue stats for monitoring. */
  getStats(): { queued: number; running: number } {
    return {
      queued: this.repository.countQueued(),
      running: this.repository.countRunning(),
    };
  }
}
