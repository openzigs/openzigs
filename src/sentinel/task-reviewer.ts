import type { TaskRepository } from "../tasks/task-repository.js";
import type { AgentTask } from "../tasks/types.js";
import type { SentinelConfig } from "./sentinel-state.js";

export interface TaskReviewResult {
  period: { from: string; to: string };
  totalTasks: number;
  completed: number;
  failed: number;
  cancelled: number;
  successRate: number;
  consecutiveFailures: number;
  repeatedErrors: { message: string; count: number }[];
  slowTasks: { id: string; goal: string; durationMs: number }[];
  orphanedTasks: { id: string; goal: string; runningForMs: number }[];
  alerts: SentinelAlert[];
}

export interface SentinelAlert {
  type: "consecutive-failures" | "queue-depth" | "orphaned-task" | "sidecar-down" | "success-rate-drop" | "rag-db-unreachable" | "rag-ingestion-down" | "rag-queue-depth";
  priority: "critical" | "warning";
  message: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface TaskReviewerDeps {
  taskRepo: TaskRepository;
  config: SentinelConfig;
  clock?: () => Date;
}

const DEFAULT_SLOW_TASK_THRESHOLD_MS = 5 * 60_000; // 5 minutes
const DEFAULT_ORPHAN_THRESHOLD_MS = 30 * 60_000; // 30 minutes

/**
 * Examines recent task outcomes, calculates success rates,
 * identifies patterns, and generates alerts.
 */
export class TaskReviewer {
  private taskRepo: TaskRepository;
  private config: SentinelConfig;
  private clock: () => Date;

  constructor(deps: TaskReviewerDeps) {
    this.taskRepo = deps.taskRepo;
    this.config = { ...deps.config };
    this.clock = deps.clock ?? (() => new Date());
  }

  updateConfig(config: SentinelConfig): void {
    this.config = { ...config };
  }

  /** Review all tasks since the given ISO timestamp. Synchronous. */
  review(since: string): TaskReviewResult {
    const now = this.clock();
    const tasks = this.taskRepo.listSince(since);

    const completed = tasks.filter((t) => t.status === "completed");
    const failed = tasks.filter((t) => t.status === "failed");
    const cancelled = tasks.filter((t) => t.status === "cancelled");

    const totalResolved = completed.length + failed.length;
    const successRate = totalResolved > 0 ? completed.length / totalResolved : 1;

    // Consecutive failures: count from most recent task backwards
    const consecutiveFailures = this.countConsecutiveFailures(tasks);

    // Repeated error grouping
    const repeatedErrors = this.groupRepeatedErrors(failed);

    // Slow tasks (non-pipeline tasks that ran > 5 minutes)
    const slowTasks = this.findSlowTasks(completed);

    // Orphaned tasks (running > 30 minutes)
    const orphanedTasks = this.findOrphanedTasks(now);

    // Generate alerts
    const alerts: SentinelAlert[] = [];

    if (consecutiveFailures >= this.config.consecutiveFailureThreshold) {
      const lastError = failed.length > 0 ? (failed[0].error ?? "Unknown") : "Unknown";
      alerts.push({
        type: "consecutive-failures",
        priority: "critical",
        message: `${consecutiveFailures} consecutive task failures detected. Last error: ${lastError}`,
        data: { consecutiveFailures, lastError },
        timestamp: now.toISOString(),
      });
    }

    // Queue depth check
    const queuedCount = this.taskRepo.countQueued();
    if (queuedCount > this.config.queueDepthThreshold) {
      alerts.push({
        type: "queue-depth",
        priority: "warning",
        message: `Task queue depth at ${queuedCount}. Possible worker stall.`,
        data: { queueDepth: queuedCount },
        timestamp: now.toISOString(),
      });
    }

    // Orphaned task alerts
    for (const orphan of orphanedTasks) {
      alerts.push({
        type: "orphaned-task",
        priority: "warning",
        message: `Task ${orphan.id} has been running for ${Math.round(orphan.runningForMs / 60_000)} min. Goal: ${orphan.goal}`,
        data: { taskId: orphan.id, runningForMs: orphan.runningForMs },
        timestamp: now.toISOString(),
      });
    }

    // Success rate drop
    if (totalResolved >= 3 && successRate < 0.5) {
      alerts.push({
        type: "success-rate-drop",
        priority: "critical",
        message: `Success rate dropped to ${(successRate * 100).toFixed(1)}%. ${failed.length}/${totalResolved} tasks failed.`,
        data: { successRate, failed: failed.length, total: totalResolved },
        timestamp: now.toISOString(),
      });
    }

    return {
      period: { from: since, to: now.toISOString() },
      totalTasks: tasks.length,
      completed: completed.length,
      failed: failed.length,
      cancelled: cancelled.length,
      successRate,
      consecutiveFailures,
      repeatedErrors,
      slowTasks,
      orphanedTasks,
      alerts,
    };
  }

  /** Count consecutive failures from the most recent tasks. */
  private countConsecutiveFailures(tasks: AgentTask[]): number {
    // Tasks are sorted newest-first from listSince
    let count = 0;
    for (const task of tasks) {
      if (task.status === "failed") {
        count++;
      } else if (task.status === "completed") {
        break; // First success breaks the streak
      }
      // Skip queued/running/cancelled — they don't break the streak
    }
    return count;
  }

  /** Group failed tasks by error message. */
  private groupRepeatedErrors(failed: AgentTask[]): { message: string; count: number }[] {
    const errorMap = new Map<string, number>();
    for (const task of failed) {
      const msg = task.error ?? "Unknown error";
      // Normalize: take first 200 chars
      const normalized = msg.slice(0, 200);
      errorMap.set(normalized, (errorMap.get(normalized) ?? 0) + 1);
    }
    return Array.from(errorMap.entries())
      .filter(([, count]) => count >= 2)
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** Find completed tasks that took > 5 minutes (non-pipeline). */
  private findSlowTasks(completed: AgentTask[]): { id: string; goal: string; durationMs: number }[] {
    return completed
      .filter((t) => !t.pipeline && t.startedAt && t.completedAt)
      .map((t) => ({
        id: t.id,
        goal: t.goal,
        durationMs: t.completedAt!.getTime() - t.startedAt!.getTime(),
      }))
      .filter((t) => t.durationMs > this.getSlowTaskThresholdMs())
      .sort((a, b) => b.durationMs - a.durationMs);
  }

  /** Find tasks that have been running for > 30 minutes. */
  private findOrphanedTasks(now: Date): { id: string; goal: string; runningForMs: number }[] {
    const running = this.taskRepo.list({ status: "running" });
    return running
      .filter((t) => t.startedAt)
      .map((t) => ({
        id: t.id,
        goal: t.goal,
        runningForMs: now.getTime() - t.startedAt!.getTime(),
      }))
      .filter((t) => t.runningForMs > this.getOrphanThresholdMs());
  }

  private getSlowTaskThresholdMs(): number {
    const minutes = this.config.slowTaskThresholdMinutes;
    if (typeof minutes === "number" && minutes > 0) {
      return minutes * 60_000;
    }
    return DEFAULT_SLOW_TASK_THRESHOLD_MS;
  }

  private getOrphanThresholdMs(): number {
    const minutes = this.config.orphanTaskThresholdMinutes;
    if (typeof minutes === "number" && minutes > 0) {
      return minutes * 60_000;
    }
    return DEFAULT_ORPHAN_THRESHOLD_MS;
  }
}
