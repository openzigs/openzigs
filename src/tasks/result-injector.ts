import { EventEmitter } from "node:events";
import type { TaskEngine } from "./task-engine.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { AgentTask } from "./types.js";
import type { Server as SocketIOServer } from "socket.io";
import { logger } from "../logging/logger.js";

const MAX_RESULT_LENGTH = 4000;

export interface InjectedResultMessage {
  role: "system";
  content: string;
  metadata: {
    type: "subagent-result";
    taskId: string;
    parentTaskId: string | null;
    goal: string;
    status: "completed" | "failed";
    duration: number;
    tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number; turns: number } | null;
  };
}

export type ResultInjectorOptions = {
  taskEngine: TaskEngine;
  sessionManager: SessionManager;
  io?: SocketIOServer;
  log?: Pick<typeof logger, "info" | "warn" | "error">;
};

/**
 * Listens to TaskEngine `task:completed` and `task:failed` events.
 * When a background agent task finishes, injects the result as a
 * system message into the spawning session's conversation history.
 */
export class ResultInjector extends EventEmitter {
  private taskEngine: TaskEngine;
  private sessionManager: SessionManager;
  private io?: SocketIOServer;
  private log: Pick<typeof logger, "info" | "warn" | "error">;

  constructor(opts: ResultInjectorOptions) {
    super();
    this.taskEngine = opts.taskEngine;
    this.sessionManager = opts.sessionManager;
    this.io = opts.io;
    this.log = opts.log ?? logger;

    this.taskEngine.on("task:completed", (task: AgentTask) => {
      void this.handleCompletion(task);
    });
    this.taskEngine.on("task:failed", (task: AgentTask) => {
      void this.handleFailure(task);
    });
  }

  private async handleCompletion(task: AgentTask): Promise<void> {
    if (!this.shouldInject(task)) return;

    const duration = task.completedAt && task.startedAt
      ? task.completedAt.getTime() - task.startedAt.getTime()
      : 0;

    let resultText = task.result ?? "";
    if (resultText.length > MAX_RESULT_LENGTH) {
      resultText =
        resultText.slice(0, MAX_RESULT_LENGTH) +
        `\n\n[...truncated — full result available via GET /api/tasks/${task.id}]`;
    }

    const content = `[Sub-agent completed: ${task.goal}]\n\n${resultText}`;

    const message: InjectedResultMessage = {
      role: "system",
      content,
      metadata: {
        type: "subagent-result",
        taskId: task.id,
        parentTaskId: task.parentTaskId,
        goal: task.goal,
        status: "completed",
        duration,
        tokenUsage: task.tokenUsage,
      },
    };

    await this.inject(task.sessionId!, message);
  }

  private async handleFailure(task: AgentTask): Promise<void> {
    if (!this.shouldInject(task)) return;

    const duration = task.completedAt && task.startedAt
      ? task.completedAt.getTime() - task.startedAt.getTime()
      : 0;

    const content = `[Sub-agent failed: ${task.goal}]\n\nError: ${task.error ?? "Unknown error"}`;

    const message: InjectedResultMessage = {
      role: "system",
      content,
      metadata: {
        type: "subagent-result",
        taskId: task.id,
        parentTaskId: task.parentTaskId,
        goal: task.goal,
        status: "failed",
        duration,
        tokenUsage: task.tokenUsage,
      },
    };

    await this.inject(task.sessionId!, message);
  }

  /**
   * Only inject for agent-triggered tasks that have a valid sessionId.
   * Cron tasks and tasks without sessions do not inject.
   */
  private shouldInject(task: AgentTask): boolean {
    return task.trigger === "agent" && !!task.sessionId;
  }

  private async inject(sessionId: string, message: InjectedResultMessage): Promise<void> {
    try {
      await this.sessionManager.appendEvent(sessionId, {
        timestamp: new Date(),
        type: "assistant",
        content: message.content,
        metadata: message.metadata as unknown as Record<string, unknown>,
      });

      this.log.info(
        `ResultInjector: injected ${message.metadata.status} result for task ${message.metadata.taskId} into session ${sessionId}`
      );

      // Notify UI to refresh chat
      this.io?.emit("task:result-injected", {
        taskId: message.metadata.taskId,
        sessionId,
        status: message.metadata.status,
        goal: message.metadata.goal,
      });

      this.emit("injected", message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`ResultInjector: failed to inject result for task ${message.metadata.taskId}: ${msg}`, { error: err });
    }
  }
}
