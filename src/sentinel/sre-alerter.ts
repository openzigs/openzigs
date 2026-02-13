import { logger } from "../logging/logger.js";
import type { SentinelAlert } from "./task-reviewer.js";

export type { SentinelAlert } from "./task-reviewer.js";

/** Minimal interface for channel-based message delivery. */
export interface AlertChannel {
  type: string;
  sendMessage(chatId: string, content: { text: string }): Promise<void>;
}

/** Channel manager interface for multi-channel alert routing. */
export interface AlertChannelManager {
  getChannel(type: string): AlertChannel | undefined;
  listChannels(): AlertChannel[];
}

export interface SREAlerterDeps {
  io?: { emit: (event: string, data: unknown) => void };
  channelManager?: AlertChannelManager;
  notifyChannels?: string[];
  criticalCooldownMinutes?: number;
  warningCooldownMinutes?: number;
  clock?: () => Date;
}

/**
 * Dispatches SRE alerts via Socket.IO and configured messaging channels.
 * Manages deduplication via configurable cooldown windows.
 *
 * - "admin" channel: Socket.IO (web dashboard)
 * - Other channels (e.g. "telegram", "discord"): via ChannelManager
 * - Only critical alerts route to external channels to avoid notification fatigue
 */
export class SREAlerter {
  private io?: { emit: (event: string, data: unknown) => void };
  private channelManager?: AlertChannelManager;
  private notifyChannels: string[];
  private clock: () => Date;
  private cooldowns = new Map<string, number>();

  private criticalCooldownMs: number;
  private warningCooldownMs: number;

  constructor(deps: SREAlerterDeps) {
    this.io = deps.io;
    this.channelManager = deps.channelManager;
    this.notifyChannels = deps.notifyChannels ?? ["admin"];
    this.clock = deps.clock ?? (() => new Date());
    this.criticalCooldownMs = (deps.criticalCooldownMinutes ?? 5) * 60_000;
    this.warningCooldownMs = (deps.warningCooldownMinutes ?? 30) * 60_000;
  }

  /** Fire alerts, respecting deduplication cooldowns. */
  async fireAlerts(alerts: SentinelAlert[]): Promise<number> {
    let fired = 0;

    for (const alert of alerts) {
      if (this.isInCooldown(alert.type)) {
        logger.debug(`Sentinel alert "${alert.type}" suppressed (cooldown active)`);
        continue;
      }

      // Emit via Socket.IO (admin dashboard) when "admin" is in notifyChannels
      if (this.notifyChannels.includes("admin") && this.io) {
        this.io.emit("sentinel:alert", alert);
      }

      // Route critical alerts to external channels (#196)
      if (alert.priority === "critical" && this.channelManager) {
        const externalChannels = this.notifyChannels.filter((ch) => ch !== "admin");
        for (const channelType of externalChannels) {
          try {
            const channel = this.channelManager.getChannel(channelType);
            if (channel) {
              const message = this.formatAlertMessage(alert);
              await channel.sendMessage("broadcast", { text: message });
            } else {
              logger.warn(`Sentinel: configured notify channel "${channelType}" is not registered — skipping`);
            }
          } catch (err) {
            logger.warn(`Sentinel: failed to send alert to "${channelType}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // Set cooldown
      const cooldownMs = alert.priority === "critical"
        ? this.criticalCooldownMs
        : this.warningCooldownMs;
      this.setCooldown(alert.type, cooldownMs);

      logger.warn(`Sentinel SRE alert [${alert.priority}]: ${alert.message}`);
      fired++;
    }

    return fired;
  }

  /** Format an alert into a human-readable text message for external channels. */
  private formatAlertMessage(alert: SentinelAlert): string {
    const emoji = alert.priority === "critical" ? "🚨" : "⚠️";
    return `${emoji} Sentinel Alert [${alert.priority.toUpperCase()}]\n\nType: ${alert.type}\n${alert.message}\n\nTimestamp: ${alert.timestamp}`;
  }

  /** Check if an alert type is currently in cooldown. */
  private isInCooldown(alertType: string): boolean {
    const expiresAt = this.cooldowns.get(alertType);
    if (!expiresAt) return false;
    return this.clock().getTime() < expiresAt;
  }

  /** Set a cooldown for an alert type. */
  private setCooldown(alertType: string, durationMs: number): void {
    this.cooldowns.set(alertType, this.clock().getTime() + durationMs);
  }

  /** Inject or replace Socket.IO instance. */
  setIO(io: { emit: (event: string, data: unknown) => void }): void {
    this.io = io;
  }

  /** Update notify channels at runtime. */
  setNotifyChannels(channels: string[]): void {
    this.notifyChannels = channels;
  }

  /** Update cooldown durations from config. */
  updateCooldowns(criticalMinutes: number, warningMinutes: number): void {
    this.criticalCooldownMs = criticalMinutes * 60_000;
    this.warningCooldownMs = warningMinutes * 60_000;
  }

  /** Clear all cooldowns (useful for testing). */
  clearCooldowns(): void {
    this.cooldowns.clear();
  }
}
