import { EventEmitter } from "node:events";
import type { TaskEngine } from "./task-engine.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { AgentTask } from "./types.js";
import { logger } from "../logging/logger.js";

export type TaskWorkerOptions = {
  engine: TaskEngine;
  copilot: CopilotWrapper;
  /** Maximum concurrent background tasks. Default 2. */
  maxConcurrent?: number;
  /** Poll interval in milliseconds. Default 2000. */
  pollIntervalMs?: number;
  /** For testing: inject a logger. */
  log?: Pick<typeof logger, "info" | "warn" | "error">;
};

/**
 * Background consumer that polls the TaskEngine queue and executes tasks
 * via `CopilotWrapper.chat()`.
 *
 * The worker runs a `setInterval` loop that dequeues tasks up to
 * `maxConcurrent` and processes them asynchronously.
 */
export class TaskWorker extends EventEmitter {
  private engine: TaskEngine;
  private copilot: CopilotWrapper;
  private maxConcurrent: number;
  private pollIntervalMs: number;
  private log: Pick<typeof logger, "info" | "warn" | "error">;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = 0;
  private stopped = false;

  constructor({
    engine,
    copilot,
    maxConcurrent = 2,
    pollIntervalMs = 2_000,
    log: logOverride,
  }: TaskWorkerOptions) {
    super();
    this.engine = engine;
    this.copilot = copilot;
    this.maxConcurrent = maxConcurrent;
    this.pollIntervalMs = pollIntervalMs;
    this.log = logOverride ?? logger;
  }

  /** Start the polling loop. Idempotent. */
  start(): void {
    if (this.timer) {
      return;
    }
    this.stopped = false;
    this.log.info(`TaskWorker started (maxConcurrent=${this.maxConcurrent}, pollInterval=${this.pollIntervalMs}ms)`);
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);

    // Run immediately on start
    void this.poll();
  }

  /** Stop the polling loop and wait for in-flight tasks to drain. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for in-flight tasks to finish (up to 30s)
    const deadline = Date.now() + 30_000;
    while (this.running > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    this.log.info("TaskWorker stopped");
  }

  /** Number of currently executing tasks. */
  get activeCount(): number {
    return this.running;
  }

  /** Single poll iteration: dequeue up to available capacity. */
  private async poll(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const available = this.maxConcurrent - this.running;
    if (available <= 0) {
      return;
    }

    for (let i = 0; i < available; i++) {
      const task = this.engine.dequeue();
      if (!task) {
        break; // Queue is empty
      }
      this.running++;
      void this.executeTask(task).finally(() => {
        this.running--;
      });
    }
  }

  /** Execute a single task via CopilotWrapper. */
  private async executeTask(task: AgentTask): Promise<void> {
    this.log.info(`TaskWorker executing task ${task.id}: "${task.goal.slice(0, 80)}"`);
    this.emit("task:executing", task);

    try {
      const prompt = this.buildPrompt(task);
      let result = "";

      for await (const chunk of this.copilot.chat(prompt, {
        model: task.model ?? undefined,
        onToolCall: (toolName, args) => {
          if (toolName === "spawn-agent") {
            // Inject parent task ID, session, and channel info for recursive chaining.
            const a = args as Record<string, unknown>;
            a.parentTaskId = task.id;
            a.sessionId = task.sessionId;
            a.channelType = task.channelType;
            a.chatId = task.chatId;
          }
        },
      })) {
        result += chunk;
      }

      const completed = this.engine.complete(task.id, result);
      this.log.info(`TaskWorker completed task ${task.id}`);
      this.emit("task:done", completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.engine.fail(task.id, message);
      this.log.error(`TaskWorker failed task ${task.id}: ${message}`);
      this.emit("task:error", failed);
    }
  }

  /** Build a prompt string for the background task. */
  private buildPrompt(task: AgentTask): string {
    const lines: string[] = [];

    lines.push("You are an autonomous agent executing a background task.");
    lines.push(`Task Goal: ${task.goal}`);

    if (task.context) {
      lines.push("");
      lines.push("Additional Context:");
      lines.push(task.context);
    }

    lines.push("");
    lines.push("Complete this task thoroughly and return your results. Be concise but comprehensive.");

    return lines.join("\n");
  }
}
