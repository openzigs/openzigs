/**
 * Pinterest Digest Service
 * Issue #423: Sends weekly Pinterest performance digests via Telegram.
 *
 * Follows the same pattern as MediaNotificationService: uses ChannelManager
 * to send via Telegram. Can be triggered by schedule-job cron or called directly.
 */

import { logger } from "../logging/logger.js";
import type { ChannelManager } from "../channels/channel-manager.js";

const PINTEREST_API_BASE = "https://api.pinterest.com/v5";

export type PinterestDigestOptions = {
  channelManager: ChannelManager;
  /** Fallback Telegram chat ID when none is specified in the call. */
  fallbackChatId?: string;
  /** For testing. */
  log?: Pick<typeof logger, "info" | "warn" | "error">;
};

export class PinterestDigestService {
  private channelManager: ChannelManager;
  private fallbackChatId: string | undefined;
  private log: Pick<typeof logger, "info" | "warn" | "error">;

  constructor({ channelManager, fallbackChatId, log: logOverride }: PinterestDigestOptions) {
    this.channelManager = channelManager;
    this.fallbackChatId = fallbackChatId;
    this.log = logOverride ?? logger;
  }

  /** Send a weekly Pinterest performance digest to a Telegram chat. */
  async sendDigest(chatId?: string): Promise<void> {
    const targetChatId = chatId ?? this.fallbackChatId;
    if (!targetChatId) {
      this.log.warn("[PinterestDigest] No chat ID available for digest.");
      return;
    }

    const token = process.env.PINTEREST_ACCESS_TOKEN;
    if (!token) {
      this.log.warn("[PinterestDigest] PINTEREST_ACCESS_TOKEN not configured — skipping digest.");
      return;
    }

    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 7 * 86_400_000).toISOString().split("T")[0];

    try {
      const url = new URL(`${PINTEREST_API_BASE}/user_account/analytics`);
      url.searchParams.set("start_date", startDate);
      url.searchParams.set("end_date", endDate);
      url.searchParams.set("metric_types", "IMPRESSION,PIN_CLICK,SAVE,ENGAGEMENT");

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });

      if (!res.ok) {
        this.log.error(`[PinterestDigest] Pinterest API error: ${res.status}`);
        return;
      }

      const analytics = (await res.json()) as Record<string, unknown>;
      const metrics = this.extractSummaryMetrics(analytics);

      const message = [
        "\u{1F4CA} *Pinterest Weekly Digest*",
        `\u{1F4C5} ${startDate} \u2192 ${endDate}`,
        "",
        `\u{1F441} Impressions: ${this.formatNumber(metrics.impression)}`,
        `\u{1F4CC} Pin Clicks: ${this.formatNumber(metrics.pinClick)}`,
        `\u{1F4BE} Saves: ${this.formatNumber(metrics.save)}`,
        `\u{1F4AC} Engagement: ${this.formatNumber(metrics.engagement)}`,
        "",
        "Use `/pinterest audit` in chat to run a full SEO analysis.",
      ].join("\n");

      await this.send(targetChatId, message);
      this.log.info(`[PinterestDigest] Sent weekly digest to chat ${targetChatId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`[PinterestDigest] Failed to send digest: ${message}`);
    }
  }

  private extractSummaryMetrics(
    analytics: Record<string, unknown>,
  ): { impression: number; pinClick: number; save: number; engagement: number } {
    const defaults = { impression: 0, pinClick: 0, save: 0, engagement: 0 };
    try {
      const all = analytics.all as Record<string, unknown> | undefined;
      if (!all?.summary_metrics) return defaults;
      const summary = all.summary_metrics as Record<string, number>;
      return {
        impression: summary.IMPRESSION ?? 0,
        pinClick: summary.PIN_CLICK ?? 0,
        save: summary.SAVE ?? 0,
        engagement: summary.ENGAGEMENT ?? 0,
      };
    } catch {
      return defaults;
    }
  }

  private formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  private async send(chatId: string, text: string): Promise<void> {
    const telegram = this.channelManager.getChannel("telegram");
    if (!telegram || !telegram.isConnected()) {
      this.log.warn("[PinterestDigest] Telegram not connected — skipping notification.");
      return;
    }
    try {
      await telegram.sendMessage(chatId, { text, markdown: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`[PinterestDigest] Failed to send Telegram message: ${message}`);
    }
  }
}
