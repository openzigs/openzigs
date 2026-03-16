import cron from "node-cron";
import type { OutboxRepository, OutboxItem } from "./outbox-repository.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";
import { logger } from "../logging/logger.js";

export type OutboxPollerOptions = {
  outboxRepo: OutboxRepository;
  taskEngine: TaskEngine;
  mediaQueueRepo?: MediaQueueRepository;
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
  private readonly mediaQueueRepo?: MediaQueueRepository;
  private readonly cronExpression: string;
  private readonly batchSize: number;

  constructor(options: OutboxPollerOptions) {
    this.outboxRepo = options.outboxRepo;
    this.taskEngine = options.taskEngine;
    this.mediaQueueRepo = options.mediaQueueRepo;
    this.cronExpression = options.cronExpression ?? "*/2 * * * *";
    this.batchSize = options.batchSize ?? 5;
  }

  start(): void {
    if (this.task) return;
    this.task = cron.schedule(this.cronExpression, () => {
      this.poll();
    }, { noOverlap: true });
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
      // Resolve assetId to actual file path if available
      let resolvedAssetPath: string | null = null;
      if (item.assetId && this.mediaQueueRepo) {
        const asset = this.mediaQueueRepo.getAsset(item.assetId);
        if (asset?.file_path) resolvedAssetPath = String(asset.file_path);
      }

      const goal = [
        `Publish content to ${item.platform}.`,
        item.agentContext,
        item.contentBody ? `Pre-approved content (use exactly as-is):\n${item.contentBody}` : null,
        item.assetUrl ? `Asset URL: ${item.assetUrl}` : null,
        resolvedAssetPath ? `Image file path: ${resolvedAssetPath}` : (item.assetId ? `Asset ID: ${item.assetId}` : null),
        item.attachments && item.attachments.length > 0
          ? `Attachments (include these with the post):\n${item.attachments.map((a) => `- ${a.filename} (${a.filePath})`).join("\n")}`
          : null,
        `Outbox Item ID: ${item.id}`,
        `Platform metadata: ${JSON.stringify(item.platformMetadata)}`,
        item.platform === "pinterest"
          ? `IMPORTANT: You MUST call pinterest-list-boards FIRST to get the user's actual boards. IGNORE any board name mentioned anywhere in these instructions — they are AI-generated suggestions and likely wrong. Use ONLY a board_id returned by pinterest-list-boards. The user's board is retrieved from the API, not from the publishing instructions. Pick the most relevant board from the list, or use the first one if unsure.`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

      this.taskEngine.submit(
        {
          trigger: "cron",
          goal,
          context: `Outbox item ${item.id} for ${item.platform}`,
          skillName: "universal-publisher",
          autoApproveTools: ["update-outbox-status", "pinterest-list-boards", "fb_publish_post", "publish_media"],
          allowedTools: [
            "update-outbox-status",
            "social-post",
            "twitter-post-tweet",
            "linkedin-create-post",
            "reddit-submit-post",
            "youtube-upload-video",
            "pinterest-list-boards",
            "pinterest-create-pin",
            "fb_publish_post",
            "publish_media",
            "send-notification",
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
