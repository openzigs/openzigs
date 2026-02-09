import type { ChannelManager } from "../channels/channel-manager.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { TaskEngine } from "./task-engine.js";
import type { AgentTask } from "./types.js";
import { logger } from "../logging/logger.js";

export type NotificationDispatcherOptions = {
  engine: TaskEngine;
  channelManager: ChannelManager;
  sessionManager: SessionManager;
  /** Socket.IO server instance for web push. */
  io?: { emit: (event: string, data: unknown) => void };
  /** For testing. */
  log?: Pick<typeof logger, "info" | "warn" | "error">;
};

/**
 * Listens for task completion/failure events on the TaskEngine and routes
 * notifications back to the originating channel.
 *
 * Supports:
 * - Web (Socket.IO emit)
 * - Telegram / Discord (via ChannelManager send)
 * - Session JSONL append (via SessionManager)
 */
export class NotificationDispatcher {
  private engine: TaskEngine;
  private channelManager: ChannelManager;
  private sessionManager: SessionManager;
  private io?: { emit: (event: string, data: unknown) => void };
  private log: Pick<typeof logger, "info" | "warn" | "error">;

  constructor({ engine, channelManager, sessionManager, io, log: logOverride }: NotificationDispatcherOptions) {
    this.engine = engine;
    this.channelManager = channelManager;
    this.sessionManager = sessionManager;
    this.io = io;
    this.log = logOverride ?? logger;

    this.engine.on("task:completed", (task: AgentTask) => {
      void this.notify(task).catch((err) => {
        this.log.error(`NotificationDispatcher error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    this.engine.on("task:failed", (task: AgentTask) => {
      void this.notify(task).catch((err) => {
        this.log.error(`NotificationDispatcher error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  /** Dispatch a notification for a completed or failed task. */
  private async notify(task: AgentTask): Promise<void> {
    if (!task.notifyOnComplete) {
      return;
    }

    const message = this.formatMessage(task);

    // 1. Always emit via Socket.IO for the web dashboard
    if (this.io) {
      this.io.emit("task:notification", {
        type: task.status,
        task: {
          ...task,
          createdAt: task.createdAt.toISOString(),
          startedAt: task.startedAt?.toISOString() ?? null,
          completedAt: task.completedAt?.toISOString() ?? null,
        },
      });
    }

    // 2. Send to originating channel if available  
    if (task.channelType && task.chatId) {
      const channel = this.channelManager.getChannel(task.channelType);
      if (channel) {
        try {
          await channel.sendMessage(task.chatId, { text: message });
          this.log.info(`Notification sent to ${task.channelType}:${task.chatId} for task ${task.id}`);
        } catch (err) {
          this.log.error(
            `Failed to send notification to ${task.channelType}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        this.log.warn(`Channel ${task.channelType} not registered — cannot notify for task ${task.id}`);
      }
    }

    // 3. Append to session log for history
    if (task.sessionId) {
      try {
        await this.sessionManager.appendEvent(task.sessionId, {
          timestamp: task.completedAt ?? new Date(),
          type: "tool_result",
          content: `[Background Task ${task.status}] ${task.goal}\n${task.result ?? task.error ?? ""}`,
        });
      } catch (err) {
        this.log.warn(
          `Failed to append task result to session ${task.sessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private formatMessage(task: AgentTask): string {
    if (task.status === "completed") {
      const preview = task.result && task.result.length > 500
        ? task.result.slice(0, 500) + "…"
        : task.result ?? "(no output)";
      return `✅ Background task completed: "${task.goal}"\n\n${preview}`;
    }

    return `❌ Background task failed: "${task.goal}"\n\nError: ${task.error ?? "Unknown error"}`;
  }
}
