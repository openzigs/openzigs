/**
 * Follower Welcome — auto-DM new followers with a configurable welcome message
 * per platform (like ManyChat's "Say hi to new followers" feature).
 */

import { EventEmitter } from "node:events";
import { logger } from "../../logging/logger.js";
import type { DmSender } from "./comment-rule-engine.js";
import type { SocialPlatform, SocialBrainConfig } from "./types.js";

export type FollowerWelcomeOptions = {
  sendDm?: DmSender;
  config?: SocialBrainConfig["followerWelcome"];
};

/**
 * Sends a welcome DM to new followers on any platform.
 *
 * Emits:
 * - "welcome_sent" — { platform, userId, username }
 * - "welcome_error" — { platform, userId, error }
 */
export class FollowerWelcomeService extends EventEmitter {
  private sendDm?: DmSender;
  private messages: Partial<Record<SocialPlatform, string>>;
  private delaySeconds: number;
  private enabled: boolean;
  /** Track already-welcomed users to prevent duplicate welcome DMs. */
  private welcomed = new Set<string>();

  constructor(opts: FollowerWelcomeOptions) {
    super();
    this.sendDm = opts.sendDm;
    this.messages = opts.config?.messages ?? {};
    this.delaySeconds = opts.config?.delaySeconds ?? 5;
    this.enabled = opts.config?.enabled ?? false;
  }

  setSendDm(fn: DmSender): void {
    this.sendDm = fn;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setMessage(platform: SocialPlatform, message: string): void {
    this.messages[platform] = message;
  }

  /**
   * Handle a new follower event. Sends the platform-specific welcome after the configured delay.
   */
  handleNewFollower(
    platform: SocialPlatform,
    userId: string,
    username: string,
  ): void {
    if (!this.enabled || !this.sendDm) return;

    const template = this.messages[platform];
    if (!template) return;

    const key = `${platform}:${userId}`;
    if (this.welcomed.has(key)) return;
    this.welcomed.add(key);

    const message = template.replace(/\{\{username\}\}/g, username);

    if (this.delaySeconds > 0) {
      setTimeout(
        () => void this.send(platform, userId, username, message),
        this.delaySeconds * 1000,
      );
    } else {
      void this.send(platform, userId, username, message);
    }
  }

  private async send(
    platform: SocialPlatform,
    userId: string,
    username: string,
    message: string,
  ): Promise<void> {
    try {
      await this.sendDm!(platform, userId, message);
      this.emit("welcome_sent", { platform, userId, username });
      logger.info(
        `[FollowerWelcome] Sent welcome to @${username} on ${platform}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("welcome_error", { platform, userId, error: msg });
      logger.error(
        `[FollowerWelcome] Failed to send welcome to @${username}: ${msg}`,
      );
    }
  }
}
