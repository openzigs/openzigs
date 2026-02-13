import { describe, expect, it } from "vitest";
import { DigestGenerator, type DigestReport } from "./digest-generator.js";
import type { TaskReviewResult } from "./task-reviewer.js";

const makeTaskReview = (overrides: Partial<TaskReviewResult> = {}): TaskReviewResult => ({
  period: overrides.period ?? { from: "2026-06-15T00:00:00Z", to: "2026-06-15T12:00:00Z" },
  totalTasks: overrides.totalTasks ?? 10,
  completed: overrides.completed ?? 8,
  failed: overrides.failed ?? 1,
  cancelled: overrides.cancelled ?? 1,
  successRate: overrides.successRate ?? 0.889,
  consecutiveFailures: overrides.consecutiveFailures ?? 0,
  repeatedErrors: overrides.repeatedErrors ?? [],
  slowTasks: overrides.slowTasks ?? [],
  orphanedTasks: overrides.orphanedTasks ?? [],
  alerts: overrides.alerts ?? [],
});

describe("DigestGenerator", () => {
  it("generates a digest record from task review data", () => {
    const generator = new DigestGenerator();
    const report: DigestReport = {
      taskReview: makeTaskReview(),
      promptAudit: null,
      tokenBurn: null,
    };

    const record = generator.generate(report);

    expect(record.timestamp).toBeTruthy();
    expect(record.taskSummary.completed).toBe(8);
    expect(record.taskSummary.failed).toBe(1);
    expect(record.taskSummary.cancelled).toBe(1);
    expect(record.taskSummary.successRate).toBeCloseTo(0.889, 2);
    expect(record.alertCount).toBe(0);
    expect(record.tokenBurn).toBeNull();
    expect(record.promptAudit).toBeNull();
  });

  it("includes prompt audit data when available", () => {
    const generator = new DigestGenerator();
    const report: DigestReport = {
      taskReview: makeTaskReview(),
      promptAudit: {
        sampledCount: 5,
        audits: [],
        averageScore: 7.5,
      },
      tokenBurn: null,
    };

    const record = generator.generate(report);

    expect(record.promptAudit).not.toBeNull();
    expect(record.promptAudit!.sampledCount).toBe(5);
    expect(record.promptAudit!.avgScore).toBeCloseTo(7.5);
  });

  it("includes token burn data when available", () => {
    const generator = new DigestGenerator();
    const report: DigestReport = {
      taskReview: makeTaskReview(),
      promptAudit: null,
      tokenBurn: {
        total: 50000,
        avgPerTask: 5000,
        topConsumer: { goal: "Research task", tokens: 15000 },
      },
    };

    const record = generator.generate(report);

    expect(record.tokenBurn).not.toBeNull();
    expect(record.tokenBurn!.total).toBe(50000);
    expect(record.tokenBurn!.topConsumer?.goal).toBe("Research task");
  });

  it("formatDigest produces human-readable text", () => {
    const generator = new DigestGenerator();
    const report: DigestReport = {
      taskReview: makeTaskReview({ completed: 10, failed: 2, cancelled: 0, successRate: 0.833 }),
      promptAudit: {
        sampledCount: 3,
        audits: [],
        averageScore: 8.0,
      },
      tokenBurn: {
        total: 25000,
        avgPerTask: 2500,
        topConsumer: null,
      },
    };

    const record = generator.generate(report);
    const text = generator.formatDigest(record);

    expect(text).toContain("Daily Digest");
    expect(text).toContain("Completed: 10");
    expect(text).toContain("Failed: 2");
    expect(text).toContain("83.3%");
    expect(text).toContain("25,000 tokens");
    expect(text).toContain("Sampled 3 prompts");
    expect(text).toContain("8.0/10");
  });

  it("formatDigest handles record with no optional data gracefully", () => {
    const generator = new DigestGenerator();
    const report: DigestReport = {
      taskReview: makeTaskReview({ completed: 5, failed: 0, cancelled: 0, successRate: 1 }),
      promptAudit: null,
      tokenBurn: null,
    };

    const record = generator.generate(report);
    const text = generator.formatDigest(record);

    expect(text).toContain("Daily Digest");
    expect(text).toContain("100.0%");
    // Should NOT contain token burn or prompt sections
    expect(text).not.toContain("Token Burn");
    expect(text).not.toContain("Prompt Improvements");
  });
});
