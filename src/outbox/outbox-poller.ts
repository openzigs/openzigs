import cron from "node-cron";
import type { OutboxRepository, OutboxItem } from "./outbox-repository.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import { logger } from "../logging/logger.js";

export type OutboxPollerOptions = {
  outboxRepo: OutboxRepository;
  taskEngine: TaskEngine;
  /** Cron expression for polling interval (default: every 2 minutes) */
  cronExpression?: string;
  /** Max items to claim per poll cycle (default: 5) */
  batchSize?: number;
};

/**
 * Periodically claims pending outbox items whose scheduled_time has passed
 * and submits them as background tasks to the TaskEngine for the
 * Universal Publisher skill to execute.
 */
export class OutboxPoller {
  private task: cron.ScheduledTask | null = null;
  private readonly outboxRepo: OutboxRepository;
  private readonly taskEngine: TaskEngine;
  private readonly cronExpression: string;
  private readonly batchSize: number;

  constructor(options: OutboxPollerOptions) {
    this.outboxRepo = options.outboxRepo;
    this.taskEngine = options.taskEngine;
    this.cronExpression = options.cronExpression ?? "*/2 * * * *";
    this.batchSize = options.batchSize ?? 5;
  }

  start(): void {
    if (this.task) return;
    this.task = cron.schedule(this.cronExpression, () => {
      this.poll();
    });
    logger.info(`Outbox poller started (cron: ${this.cronExpression}, batch: ${this.batchSize})`);
  }

  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info("Outbox poller stopped");
    }
  }

  /** Run a single poll cycle. Exposed for testing. */
  poll(): void {
    try {
      const claimed = this.outboxRepo.claimPending(this.batchSize);
      if (claimed.length === 0) return;

      logger.info(`Outbox poller claimed ${claimed.length} item(s)`);

      for (const item of claimed) {
        this.submitTask(item);
      }
    } catch (err) {
      logger.error(`Outbox poller error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private submitTask(item: OutboxItem): void {
    try {
      const goal = [
        `Publish content to ${item.platform}.`,
        item.agentContext,
        item.assetUrl ? `Asset URL: ${item.assetUrl}` : null,
        item.assetId ? `Asset ID: ${item.assetId}` : null,
        `Outbox Item ID: ${item.id}`,
        `Platform metadata: ${JSON.stringify(item.platformMetadata)}`,
      ]
        .filter(Boolean)
        .join("\n");

      this.taskEngine.submit(
        {
          trigger: "cron",
          goal,
          context: `Outbox item ${item.id} for ${item.platform}`,
          skillName: "universal-publisher",
          autoApproveTools: ["update-outbox-status"],
          allowedTools: [
            "update-outbox-status",
            "web-search",
            "browser-navigate",
            "read-file",
            "shell-execute",
          ],
        },
        { mode: "background" },
      );

      logger.info(`Outbox task submitted for item ${item.id} → ${item.platform}`);
    } catch (err) {
      // If task submission fails, mark the item as failed
      logger.error(`Failed to submit outbox task for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      this.outboxRepo.markFailed(item.id, `Task submission failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
