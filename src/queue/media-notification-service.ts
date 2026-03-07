/**
 * Media Notification Service
 * Issue #414: Sends opt-in Telegram notifications when async media jobs complete or fail.
 *
 * Listens to QueueMaster and RenderOrchestrator events and routes notifications
 * to TelegramChannel via ChannelManager. Gracefully degrades when Telegram is
 * not configured or the chat ID is unknown.
 */

import { logger } from "../logging/logger.js";
import type { ChannelManager } from "../channels/channel-manager.js";
import type { QueueMaster } from "./queue-master.js";
import type { MediaJob } from "./types.js";
import type { RenderOrchestrator } from "../video/render-orchestrator.js";
import type { RenderResult } from "../video/render-types.js";

export type MediaNotificationServiceOptions = {
  queueMaster: QueueMaster;
  renderOrchestrator: RenderOrchestrator;
  channelManager: ChannelManager;
  /** Fallback Telegram chat ID when a job has notifyViaTelegram=true but no telegramChatId. */
  fallbackChatId?: string;
  /** For testing. */
  log?: Pick<typeof logger, "info" | "warn" | "error">;
};

/**
 * Wires up event listeners on QueueMaster and RenderOrchestrator.
 * Constructed once at server startup — no teardown required for the app lifetime.
 */
export class MediaNotificationService {
  private channelManager: ChannelManager;
  private fallbackChatId: string | undefined;
  private log: Pick<typeof logger, "info" | "warn" | "error">;

  constructor({
    queueMaster,
    renderOrchestrator,
    channelManager,
    fallbackChatId,
    log: logOverride,
  }: MediaNotificationServiceOptions) {
    this.channelManager = channelManager;
    this.fallbackChatId = fallbackChatId;
    this.log = logOverride ?? logger;

    // ── QueueMaster events ──────────────────────────────────
    queueMaster.on("job:complete", (job: MediaJob) => {
      void this.notifyJob(job, "complete").catch((err) => {
        this.log.error(`[MediaNotificationService] error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    queueMaster.on("job:failed", (job: MediaJob, error: string) => {
      void this.notifyJob(job, "failed", error).catch((err) => {
        this.log.error(`[MediaNotificationService] error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    // ── RenderOrchestrator events ───────────────────────────
    renderOrchestrator.on("render:complete", (result: RenderResult) => {
      const renderJob = renderOrchestrator.getJob(result.jobId);
      if (!renderJob?.notifyViaTelegram) return;

      const chatId = renderJob.telegramChatId ?? this.fallbackChatId;
      if (!chatId) {
        this.log.warn(`[MediaNotificationService] render:complete — notifyViaTelegram=true but no chatId for job ${result.jobId}`);
        return;
      }

      const title = renderJob.manifest.projectTitle ?? result.jobId;
      const secs = result.durationSec ? ` (${Math.round(result.durationSec)}s)` : "";
      const text = `🎬 Render complete: *${title}*${secs}\nOutput: \`${result.outputPath ?? "unknown"}\``;
      void this.send(chatId, text, result.jobId, "render").catch(() => {/* logged in send() */});
    });

    renderOrchestrator.on("render:failed", (data: { jobId: string; error: string }) => {
      const renderJob = renderOrchestrator.getJob(data.jobId);
      if (!renderJob?.notifyViaTelegram) return;

      const chatId = renderJob.telegramChatId ?? this.fallbackChatId;
      if (!chatId) return;

      const title = renderJob.manifest.projectTitle ?? data.jobId;
      const text = `❌ Render failed: *${title}*\nError: ${data.error}`;
      void this.send(chatId, text, data.jobId, "render").catch(() => {/* logged in send() */});
    });
  }

  private async notifyJob(job: MediaJob, outcome: "complete" | "failed", error?: string): Promise<void> {
    if (!job.notifyViaTelegram) return;

    const chatId = job.telegramChatId ?? this.fallbackChatId;
    if (!chatId) {
      this.log.warn(`[MediaNotificationService] job:${outcome} — notifyViaTelegram=true but no chatId for job ${job.id}`);
      return;
    }

    const label = job.payload.prompt
      ? `"${job.payload.prompt.slice(0, 60)}${job.payload.prompt.length > 60 ? "…" : ""}"`
      : job.type;

    let text: string;
    if (outcome === "complete") {
      text = `✅ Media job complete: *${label}*\nType: \`${job.type}\``;
      if (job.resultUrl) text += `\nResult: ${job.resultUrl}`;
    } else {
      text = `❌ Media job failed: *${label}*\nType: \`${job.type}\`\nError: ${error ?? "unknown"}`;
    }

    await this.send(chatId, text, job.id, "queue");
  }

  private async send(chatId: string, text: string, jobId: string, source: string): Promise<void> {
    const telegram = this.channelManager.getChannel("telegram");
    if (!telegram) {
      this.log.warn(`[MediaNotificationService] Telegram channel not registered — cannot notify for ${source} job ${jobId}`);
      return;
    }
    if (!telegram.isConnected()) {
      this.log.warn(`[MediaNotificationService] Telegram not connected — skipping notification for ${source} job ${jobId}`);
      return;
    }
    try {
      await telegram.sendMessage(chatId, { text, markdown: true });
      this.log.info(`[MediaNotificationService] Telegram notification sent to ${chatId} for ${source} job ${jobId}`);
    } catch (err) {
      this.log.error(
        `[MediaNotificationService] Failed to send Telegram notification for ${source} job ${jobId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
