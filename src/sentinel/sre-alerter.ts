import { logger } from "../logging/logger.js";
import type { SentinelAlert } from "./task-reviewer.js";

export type { SentinelAlert } from "./task-reviewer.js";

export interface SREAlerterDeps {
  io?: { emit: (event: string, data: unknown) => void };
  clock?: () => Date;
}

/**
 * Dispatches SRE alerts via Socket.IO and manages deduplication
 * via cooldown windows.
 *
 * - Critical alerts: 5-minute cooldown
 * - Warning alerts: 30-minute cooldown
 */
export class SREAlerter {
  private io?: { emit: (event: string, data: unknown) => void };
  private clock: () => Date;
  private cooldowns = new Map<string, number>();

  private static readonly CRITICAL_COOLDOWN_MS = 5 * 60_000;
  private static readonly WARNING_COOLDOWN_MS = 30 * 60_000;

  constructor(deps: SREAlerterDeps) {
    this.io = deps.io;
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Fire alerts, respecting deduplication cooldowns. */
  async fireAlerts(alerts: SentinelAlert[]): Promise<number> {
    let fired = 0;

    for (const alert of alerts) {
      if (this.isInCooldown(alert.type)) {
        logger.debug(`Sentinel alert "${alert.type}" suppressed (cooldown active)`);
        continue;
      }

      // Emit via Socket.IO
      if (this.io) {
        this.io.emit("sentinel:alert", alert);
      }

      // Set cooldown
      const cooldownMs = alert.priority === "critical"
        ? SREAlerter.CRITICAL_COOLDOWN_MS
        : SREAlerter.WARNING_COOLDOWN_MS;
      this.setCooldown(alert.type, cooldownMs);

      logger.warn(`Sentinel SRE alert [${alert.priority}]: ${alert.message}`);
      fired++;
    }

    return fired;
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

  /** Clear all cooldowns (useful for testing). */
  clearCooldowns(): void {
    this.cooldowns.clear();
  }
}
