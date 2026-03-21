/**
 * Follow-Up Sequence Scheduler — processes timed follow-up DMs
 * after initial comment-automation triggers (like ManyChat's follow-up flows).
 */

import { EventEmitter } from "node:events";
import { logger } from "../../logging/logger.js";
import { SocialRepository } from "./social-repository.js";
import type { DmSender } from "./comment-rule-engine.js";
import type { SocialPlatform } from "./types.js";

export type FollowUpSchedulerOptions = {
  repository: SocialRepository;
  sendDm?: DmSender;
  /** How often to check for pending follow-ups (ms). Default: 30_000. */
  checkIntervalMs?: number;
  clock?: () => Date;
};

/**
 * Periodically checks for pending follow-up jobs and sends them.
 *
 * Emits:
 * - "sent" — { job: FollowUpJob }
 * - "error" — { job: FollowUpJob, error: string }
 */
export class FollowUpScheduler extends EventEmitter {
  private repository: SocialRepository;
  private sendDm?: DmSender;
  private checkIntervalMs: number;
  private clock: () => Date;
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: FollowUpSchedulerOptions) {
    super();
    this.repository = opts.repository;
    this.sendDm = opts.sendDm;
    this.checkIntervalMs = opts.checkIntervalMs ?? 30_000;
    this.clock = opts.clock ?? (() => new Date());
  }

  setSendDm(fn: DmSender): void {
    this.sendDm = fn;
  }

  /** Start the scheduler loop. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.processPending(), this.checkIntervalMs);
    // Process immediately on start
    void this.processPending();
    logger.info(`[FollowUpScheduler] Started (interval: ${this.checkIntervalMs}ms)`);
  }

  /** Stop the scheduler loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Schedule follow-up steps for a contact after a rule trigger.
   * Called by CommentRuleEngine after a successful match.
   */
  scheduleForRule(ruleId: string, contact: { id: string; platform: SocialPlatform; platformUserId: string }, vars: Record<string, string>): void {
    const steps = this.repository.getFollowUpSteps(ruleId);
    if (steps.length === 0) return;

    const now = this.clock();
    for (const step of steps) {
      const scheduledAt = new Date(now.getTime() + step.delay_seconds * 1000).toISOString();
      const message = step.message_template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? `{{${key}}}`);

      this.repository.scheduleFollowUp({
        contactId: contact.id,
        ruleId,
        stepId: step.id,
        platform: contact.platform,
        platformUserId: contact.platformUserId,
        message,
        scheduledAt,
      });
    }

    logger.info(`[FollowUpScheduler] Scheduled ${steps.length} follow-ups for contact ${contact.id} (rule ${ruleId})`);
  }

  /** Process all pending follow-up jobs that are due. */
  async processPending(): Promise<number> {
    if (!this.sendDm) return 0;

    const now = this.clock().toISOString();
    const pending = this.repository.getPendingFollowUps(now);
    let sent = 0;

    for (const job of pending) {
      try {
        await this.sendDm(job.platform as SocialPlatform, job.platform_user_id, job.message);
        this.repository.markFollowUpSent(job.id);

        // Log the outbound DM in social_messages
        this.repository.insertMessage({
          contactId: job.contact_id,
          platform: job.platform as SocialPlatform,
          direction: "outbound",
          status: "auto_replied",
          content: job.message,
          metadata: { source: "follow-up", ruleId: job.rule_id, stepId: job.step_id },
        });

        sent++;
        this.emit("sent", { job });
        logger.info(`[FollowUpScheduler] Sent follow-up ${job.id} to ${job.platform_user_id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.repository.markFollowUpError(job.id, msg);
        this.emit("error", { job, error: msg });
        logger.error(`[FollowUpScheduler] Failed to send follow-up ${job.id}: ${msg}`);
      }
    }

    return sent;
  }
}
