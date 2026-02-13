import { EventEmitter } from "node:events";
import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { logger } from "../logging/logger.js";
import type { TaskRepository } from "../tasks/task-repository.js";
import type { CopilotWrapperService } from "../copilot/copilot-wrapper.js";
import type { SessionManager } from "../sessions/session-manager.js";
import {
  readState,
  writeState,
  defaultState,
  readDigestHistory,
  type SentinelState,
  type SentinelConfig,
  type DigestRecord,
} from "./sentinel-state.js";
import { TaskReviewer, type TaskReviewResult } from "./task-reviewer.js";
import { PromptAuditor, type PromptAuditResult } from "./prompt-auditor.js";
import { DigestGenerator } from "./digest-generator.js";
import { SREAlerter } from "./sre-alerter.js";

export interface SentinelStatus {
  enabled: boolean;
  lastTaskCheckAt: string | null;
  lastDigestAt: string | null;
  lastPromptAuditAt: string | null;
  consecutiveFailures: number;
  totalTasksReviewed: number;
  alertsSent: number;
  modelOverride: string | null;
  nextCheckEstimate: string | null;
  config: SentinelConfig;
}

export interface SentinelDependencies {
  taskRepo: TaskRepository;
  copilot: CopilotWrapperService;
  sessionManager: SessionManager;
  config: SentinelConfig;
  clock?: () => Date;
  io?: { emit: (event: string, data: unknown) => void };
}

/**
 * Autonomous system monitor daemon.
 *
 * Runs periodic checks on task health, prompt quality, and system status.
 * Emits Socket.IO events for the admin UI and dispatches alerts via
 * configured notification channels.
 */
export class SentinelService extends EventEmitter {
  private taskRepo: TaskRepository;
  private copilot: CopilotWrapperService;
  private sessionManager: SessionManager;
  private config: SentinelConfig;
  private clock: () => Date;
  private io?: { emit: (event: string, data: unknown) => void };

  private state: SentinelState;
  private checkTask: ScheduledTask | null = null;
  private digestTask: ScheduledTask | null = null;
  private auditTask: ScheduledTask | null = null;
  private running = false;
  private lastCheckScheduledAt: Date | null = null;

  // Sub-components
  private taskReviewer: TaskReviewer;
  private promptAuditor: PromptAuditor;
  private digestGenerator: DigestGenerator;
  private alerter: SREAlerter;

  // Pending results for digest aggregation
  private pendingAuditResult: PromptAuditResult | null = null;

  // Concurrency lock to prevent overlapping check/audit/digest runs
  private isChecking = false;
  private isAuditing = false;
  private isDigesting = false;

  constructor(deps: SentinelDependencies) {
    super();
    this.taskRepo = deps.taskRepo;
    this.copilot = deps.copilot;
    this.sessionManager = deps.sessionManager;
    this.config = { ...deps.config };
    this.clock = deps.clock ?? (() => new Date());
    this.io = deps.io;

    this.state = defaultState(this.clock);

    this.taskReviewer = new TaskReviewer({
      taskRepo: this.taskRepo,
      config: this.config,
      clock: this.clock,
    });

    this.promptAuditor = new PromptAuditor({
      copilot: this.copilot,
      sessionManager: this.sessionManager,
      model: this.config.model,
    });

    this.digestGenerator = new DigestGenerator();

    this.alerter = new SREAlerter({
      io: this.io,
      clock: this.clock,
    });
  }

  /** Start all scheduled jobs. Loads state from disk. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.state = await readState(this.clock);
    this.state.enabled = true;

    // ── Periodic check (jittered) ──
    const intervalMin = this.config.checkIntervalMinutes;
    const cronExpr = `*/${intervalMin} * * * *`;
    this.checkTask = cron.schedule(cronExpr, () => {
      // Apply jitter: random delay between 0 and jitterMinutes
      const jitterMs = Math.floor(Math.random() * this.config.jitterMinutes * 60_000);
      setTimeout(() => {
        void this.runCheck().catch((err) => {
          logger.error(`Sentinel check failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, jitterMs);
    });

    this.lastCheckScheduledAt = this.clock();

    // ── Daily digest ──
    const digestCron = `0 ${this.config.digestHour} * * *`;
    this.digestTask = cron.schedule(digestCron, () => {
      void this.generateDigest().catch((err) => {
        logger.error(`Sentinel digest failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    // ── Daily prompt audit ──
    const auditCron = `0 ${this.config.auditHour} * * *`;
    this.auditTask = cron.schedule(auditCron, () => {
      void this.runPromptAudit().catch((err) => {
        logger.error(`Sentinel prompt audit failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    await writeState(this.state);
    logger.info(`Sentinel started — check every ${intervalMin}min (up to ${this.config.jitterMinutes}min jitter), digest at ${this.config.digestHour}:00, audit at ${this.config.auditHour}:00`);
  }

  /** Stop all scheduled jobs and flush state. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.checkTask?.stop();
    this.digestTask?.stop();
    this.auditTask?.stop();

    this.checkTask = null;
    this.digestTask = null;
    this.auditTask = null;

    this.state.enabled = false;
    await writeState(this.state);
    logger.info("Sentinel stopped");
  }

  /** Execute a single check cycle. Public for testing and "Run Now" API. */
  async runCheck(): Promise<TaskReviewResult> {
    if (this.isChecking) {
      logger.warn("Sentinel check is already in progress. Skipping.");
      throw new Error("Check already in progress");
    }
    this.isChecking = true;
    try {
      return await this._runCheckInner();
    } finally {
      this.isChecking = false;
    }
  }

  private async _runCheckInner(): Promise<TaskReviewResult> {
    const now = this.clock();
    logger.info("Sentinel: running task review check...");

    const result = this.taskReviewer.review(this.state.lastTaskCheckAt);

    // Update state
    this.state.lastTaskCheckAt = now.toISOString();
    this.state.totalTasksReviewed += result.totalTasks;
    this.state.consecutiveFailures = result.consecutiveFailures;

    // Fire immediate alerts
    if (result.alerts.length > 0) {
      await this.alerter.fireAlerts(result.alerts);
      this.state.alertsSent += result.alerts.length;
    }

    await writeState(this.state);
    this.lastCheckScheduledAt = now;

    // Emit Socket.IO event
    if (this.io) {
      this.io.emit("sentinel:check-complete", {
        timestamp: now.toISOString(),
        taskCount: result.totalTasks,
        alertCount: result.alerts.length,
        successRate: result.successRate,
      });
    }

    this.emit("check:complete", result);
    logger.info(`Sentinel check complete: ${result.totalTasks} tasks, ${result.alerts.length} alerts, ${(result.successRate * 100).toFixed(1)}% success`);

    return result;
  }

  /** Run the prompt auditor independently. */
  async runPromptAudit(): Promise<PromptAuditResult> {
    if (this.isAuditing) {
      logger.warn("Sentinel audit is already in progress. Skipping.");
      throw new Error("Audit already in progress");
    }
    this.isAuditing = true;
    try {
    logger.info("Sentinel: running prompt audit...");
    const result = await this.promptAuditor.audit();
    this.state.lastPromptAuditAt = this.clock().toISOString();
    this.pendingAuditResult = result;
    await writeState(this.state);
    logger.info(`Sentinel audit complete: ${result.sampledCount} prompts sampled, avg score ${result.averageScore.toFixed(1)}/10`);
    return result;
    } finally {
      this.isAuditing = false;
    }
  }

  /** Generate and deliver the daily digest. */
  async generateDigest(): Promise<DigestRecord> {
    if (this.isDigesting) {
      logger.warn("Sentinel digest is already in progress. Skipping.");
      throw new Error("Digest already in progress");
    }
    this.isDigesting = true;
    try {
    logger.info("Sentinel: generating daily digest...");

    // Run a check first to get fresh data
    const taskReview = await this.runCheck();

    const digest = this.digestGenerator.generate({
      taskReview,
      promptAudit: this.pendingAuditResult,
      tokenBurn: null, // Token burn from observability if available
    });

    this.state.lastDigestAt = this.clock().toISOString();
    this.pendingAuditResult = null; // Consumed by digest
    await writeState(this.state);

    // Emit Socket.IO event
    if (this.io) {
      this.io.emit("sentinel:digest", digest);
    }

    this.emit("digest:generated", digest);
    logger.info("Sentinel daily digest generated and delivered");

    return digest;
    } finally {
      this.isDigesting = false;
    }
  }

  /** Get current status for API/UI. */
  getStatus(): SentinelStatus {
    let nextCheckEstimate: string | null = null;

    if (this.running && this.lastCheckScheduledAt) {
      const nextMs = this.lastCheckScheduledAt.getTime() +
        this.config.checkIntervalMinutes * 60_000 +
        (this.config.jitterMinutes * 60_000) / 2; // Estimate midpoint of jitter window
      nextCheckEstimate = new Date(nextMs).toISOString();
    }

    return {
      enabled: this.running,
      lastTaskCheckAt: this.state.lastTaskCheckAt,
      lastDigestAt: this.state.lastDigestAt,
      lastPromptAuditAt: this.state.lastPromptAuditAt,
      consecutiveFailures: this.state.consecutiveFailures,
      totalTasksReviewed: this.state.totalTasksReviewed,
      alertsSent: this.state.alertsSent,
      modelOverride: this.state.modelOverride,
      nextCheckEstimate,
      config: { ...this.config },
    };
  }

  /** Update configuration. Restarts scheduling if interval/hour changes. */
  async updateConfig(update: Partial<SentinelConfig>): Promise<void> {
    const needsRestart = this.running && (
      update.checkIntervalMinutes !== undefined ||
      update.jitterMinutes !== undefined ||
      update.digestHour !== undefined ||
      update.auditHour !== undefined
    );

    Object.assign(this.config, update);

    if (update.model) {
      this.state.modelOverride = update.model;
      this.promptAuditor.setModel(update.model);
    }

    this.taskReviewer.updateConfig(this.config);

    if (needsRestart) {
      await this.stop();
      await this.start();
    } else {
      await writeState(this.state);
    }
  }

  /** Toggle enabled/disabled. */
  async toggle(enabled: boolean): Promise<void> {
    if (enabled && !this.running) {
      await this.start();
    } else if (!enabled && this.running) {
      await this.stop();
    }
  }

  /** Get digest history from disk. */
  async getDigestHistory(limit = 20): Promise<DigestRecord[]> {
    return readDigestHistory(limit);
  }

  /** Inject Socket.IO instance (available after HTTP server is listening). */
  setIO(io: { emit: (event: string, data: unknown) => void }): void {
    this.io = io;
    this.alerter.setIO(io);
  }

  /** Whether Sentinel is currently running. */
  get isRunning(): boolean {
    return this.running;
  }
}
