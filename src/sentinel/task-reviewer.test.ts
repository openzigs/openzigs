import { describe, expect, it, vi } from "vitest";
import { TaskReviewer } from "./task-reviewer.js";
import type { SentinelConfig } from "./sentinel-state.js";
import type { AgentTask } from "../tasks/types.js";

const NOW = new Date("2026-06-15T12:00:00Z");
const clock = () => NOW;

const defaultConfig: SentinelConfig = {
  enabled: true,
  model: "gpt-4o-mini",
  checkIntervalMinutes: 15,
  jitterMinutes: 15,
  digestHour: 9,
  auditHour: 2,
  consecutiveFailureThreshold: 3,
  queueDepthThreshold: 10,
};

const makeTask = (overrides: Partial<AgentTask>): AgentTask => ({
  id: overrides.id ?? "task-1",
  goal: overrides.goal ?? "Test task",
  status: overrides.status ?? "completed",
  trigger: overrides.trigger ?? "web",
  depth: overrides.depth ?? 0,
  model: overrides.model ?? "gpt-4o-mini",
  result: overrides.result ?? null,
  error: overrides.error ?? null,
  spawnedBy: overrides.spawnedBy ?? null,
  sessionId: overrides.sessionId ?? "session-1",
  createdAt: overrides.createdAt ?? new Date("2026-06-15T11:00:00Z"),
  startedAt: overrides.startedAt ?? new Date("2026-06-15T11:00:00Z"),
  completedAt: overrides.completedAt ?? new Date("2026-06-15T11:01:00Z"),
  parentTaskId: overrides.parentTaskId ?? null,
  pipeline: overrides.pipeline ?? null,
  ...(overrides as Record<string, unknown>),
} as AgentTask);

const createMockRepo = (tasks: AgentTask[] = [], queuedCount = 0, runningTasks: AgentTask[] = []) => ({
  listSince: vi.fn().mockReturnValue(tasks),
  countQueued: vi.fn().mockReturnValue(queuedCount),
  countRunning: vi.fn().mockReturnValue(runningTasks.length),
  list: vi.fn().mockReturnValue(runningTasks),
  insert: vi.fn(),
  update: vi.fn(),
  getById: vi.fn(),
  deleteOlderThan: vi.fn(),
});

describe("TaskReviewer", () => {
  it("returns a clean review when no tasks exist", () => {
    const repo = createMockRepo();
    const reviewer = new TaskReviewer({ taskRepo: repo as never, config: defaultConfig, clock });

    const result = reviewer.review(new Date("2026-06-15T11:00:00Z").toISOString());

    expect(result.totalTasks).toBe(0);
    expect(result.successRate).toBe(1);
    expect(result.alerts).toHaveLength(0);
    expect(result.consecutiveFailures).toBe(0);
  });

  it("calculates correct success rate with mixed outcomes", () => {
    const tasks = [
      makeTask({ id: "t1", status: "completed" }),
      makeTask({ id: "t2", status: "completed" }),
      makeTask({ id: "t3", status: "failed", error: "boom" }),
      makeTask({ id: "t4", status: "cancelled" }),
    ];
    const repo = createMockRepo(tasks);
    const reviewer = new TaskReviewer({ taskRepo: repo as never, config: defaultConfig, clock });

    const result = reviewer.review(new Date("2026-06-15T11:00:00Z").toISOString());

    expect(result.totalTasks).toBe(4);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.cancelled).toBe(1);
    // successRate = 2 / (2+1) = 0.666...
    expect(result.successRate).toBeCloseTo(0.667, 2);
  });

  it("counts consecutive failures from newest tasks", () => {
    // Newest first: failed, failed, failed, completed
    const tasks = [
      makeTask({ id: "t4", status: "failed", error: "fail" }),
      makeTask({ id: "t3", status: "failed", error: "fail" }),
      makeTask({ id: "t2", status: "failed", error: "fail" }),
      makeTask({ id: "t1", status: "completed" }),
    ];
    const repo = createMockRepo(tasks);
    const reviewer = new TaskReviewer({ taskRepo: repo as never, config: defaultConfig, clock });

    const result = reviewer.review(new Date("2026-06-15T11:00:00Z").toISOString());

    expect(result.consecutiveFailures).toBe(3);
  });

  it("generates consecutive-failures alert when threshold met", () => {
    const tasks = [
      makeTask({ id: "t3", status: "failed", error: "Connection timeout" }),
      makeTask({ id: "t2", status: "failed", error: "Connection timeout" }),
      makeTask({ id: "t1", status: "failed", error: "Connection timeout" }),
    ];
    const repo = createMockRepo(tasks);
    const reviewer = new TaskReviewer({ taskRepo: repo as never, config: defaultConfig, clock });

    const result = reviewer.review(new Date("2026-06-15T11:00:00Z").toISOString());

    const alert = result.alerts.find((a) => a.type === "consecutive-failures");
    expect(alert).toBeDefined();
    expect(alert!.priority).toBe("critical");
    expect(alert!.message).toContain("3 consecutive");
  });

  it("generates queue-depth alert when threshold exceeded", () => {
    const tasks = [makeTask({ id: "t1", status: "completed" })];
    const repo = createMockRepo(tasks, 15); // 15 queued > threshold of 10
    const reviewer = new TaskReviewer({ taskRepo: repo as never, config: defaultConfig, clock });

    const result = reviewer.review(new Date("2026-06-15T11:00:00Z").toISOString());

    const alert = result.alerts.find((a) => a.type === "queue-depth");
    expect(alert).toBeDefined();
    expect(alert!.priority).toBe("warning");
  });

  it("generates success-rate-drop alert when rate drops below 50%", () => {
    const tasks = [
      makeTask({ id: "t1", status: "completed" }),
      makeTask({ id: "t2", status: "failed", error: "err" }),
      makeTask({ id: "t3", status: "failed", error: "err" }),
      makeTask({ id: "t4", status: "failed", error: "err" }),
    ];
    const repo = createMockRepo(tasks);
    const reviewer = new TaskReviewer({ taskRepo: repo as never, config: defaultConfig, clock });

    const result = reviewer.review(new Date("2026-06-15T11:00:00Z").toISOString());

    const alert = result.alerts.find((a) => a.type === "success-rate-drop");
    expect(alert).toBeDefined();
    expect(alert!.priority).toBe("critical");
  });

  it("detects orphaned tasks running >30 minutes", () => {
    const orphanedTask = makeTask({
      id: "orphan-1",
      status: "running",
      goal: "Stuck task",
      startedAt: new Date("2026-06-15T11:00:00Z"), // 60 minutes ago
      completedAt: undefined,
    });

    const repo = createMockRepo([], 0, [orphanedTask]);
    const reviewer = new TaskReviewer({ taskRepo: repo as never, config: defaultConfig, clock });

    const result = reviewer.review(new Date("2026-06-15T11:00:00Z").toISOString());

    expect(result.orphanedTasks).toHaveLength(1);
    expect(result.orphanedTasks[0].id).toBe("orphan-1");

    const alert = result.alerts.find((a) => a.type === "orphaned-task");
    expect(alert).toBeDefined();
    expect(alert!.priority).toBe("warning");
  });

  it("detects slow tasks (>5 minutes)", () => {
    const slowTask = makeTask({
      id: "slow-1",
      status: "completed",
      goal: "Slow task",
      startedAt: new Date("2026-06-15T11:00:00Z"),
      completedAt: new Date("2026-06-15T11:10:00Z"), // 10 minutes
    });

    const repo = createMockRepo([slowTask]);
    const reviewer = new TaskReviewer({ taskRepo: repo as never, config: defaultConfig, clock });

    const result = reviewer.review(new Date("2026-06-15T11:00:00Z").toISOString());

    expect(result.slowTasks).toHaveLength(1);
    expect(result.slowTasks[0].id).toBe("slow-1");
  });

  it("groups repeated errors by message", () => {
    const tasks = [
      makeTask({ id: "t1", status: "failed", error: "Connection refused" }),
      makeTask({ id: "t2", status: "failed", error: "Connection refused" }),
      makeTask({ id: "t3", status: "failed", error: "Connection refused" }),
      makeTask({ id: "t4", status: "failed", error: "OOM killed" }),
    ];
    const repo = createMockRepo(tasks);
    const reviewer = new TaskReviewer({ taskRepo: repo as never, config: defaultConfig, clock });

    const result = reviewer.review(new Date("2026-06-15T11:00:00Z").toISOString());

    // "Connection refused" appears 3x (>= 2), "OOM killed" appears 1x (filtered out)
    expect(result.repeatedErrors).toHaveLength(1);
    expect(result.repeatedErrors[0].message).toBe("Connection refused");
    expect(result.repeatedErrors[0].count).toBe(3);
  });

  it("updateConfig applies new thresholds", () => {
    const tasks = [
      makeTask({ id: "t1", status: "failed", error: "err" }),
      makeTask({ id: "t2", status: "failed", error: "err" }),
    ];
    const repo = createMockRepo(tasks);
    const reviewer = new TaskReviewer({ taskRepo: repo as never, config: defaultConfig, clock });

    // With default threshold of 3, 2 failures shouldn't trigger alert
    let result = reviewer.review(new Date("2026-06-15T11:00:00Z").toISOString());
    expect(result.alerts.filter((a) => a.type === "consecutive-failures")).toHaveLength(0);

    // Lower threshold to 2
    reviewer.updateConfig({ ...defaultConfig, consecutiveFailureThreshold: 2 });
    result = reviewer.review(new Date("2026-06-15T11:00:00Z").toISOString());
    expect(result.alerts.filter((a) => a.type === "consecutive-failures")).toHaveLength(1);
  });
});
