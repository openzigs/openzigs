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
  it("generates a digest record from task review data", async () => {
    const generator = new DigestGenerator();
    const report: DigestReport = {
      taskReview: makeTaskReview(),
      promptAudit: null,
      tokenBurn: null,
    };

    const record = await generator.generate(report);

    expect(record.timestamp).toBeTruthy();
    expect(record.taskSummary.completed).toBe(8);
    expect(record.taskSummary.failed).toBe(1);
    expect(record.taskSummary.cancelled).toBe(1);
    expect(record.taskSummary.successRate).toBeCloseTo(0.889, 2);
    expect(record.alertCount).toBe(0);
    expect(record.tokenBurn).toBeNull();
    expect(record.promptAudit).toBeNull();
  });

  it("includes prompt audit data when available", async () => {
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

    const record = await generator.generate(report);

    expect(record.promptAudit).not.toBeNull();
    expect(record.promptAudit!.sampledCount).toBe(5);
    expect(record.promptAudit!.avgScore).toBeCloseTo(7.5);
  });

  it("includes token burn data when available", async () => {
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

    const record = await generator.generate(report);

    expect(record.tokenBurn).not.toBeNull();
    expect(record.tokenBurn!.total).toBe(50000);
    expect(record.tokenBurn!.topConsumer?.goal).toBe("Research task");
  });

  it("formatDigest produces human-readable text", async () => {
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

    const record = await generator.generate(report);
    const text = generator.formatDigest(record);

    expect(text).toContain("Daily Digest");
    expect(text).toContain("Completed: 10");
    expect(text).toContain("Failed: 2");
    expect(text).toContain("83.3%");
    expect(text).toContain("25,000 tokens");
    expect(text).toContain("Sampled 3 prompts");
    expect(text).toContain("8.0/10");
  });

  it("formatDigest handles record with no optional data gracefully", async () => {
    const generator = new DigestGenerator();
    const report: DigestReport = {
      taskReview: makeTaskReview({ completed: 5, failed: 0, cancelled: 0, successRate: 1 }),
      promptAudit: null,
      tokenBurn: null,
    };

    const record = await generator.generate(report);
    const text = generator.formatDigest(record);

    expect(text).toContain("Daily Digest");
    expect(text).toContain("100.0%");
    // Should NOT contain token burn or prompt sections
    expect(text).not.toContain("Token Burn");
    expect(text).not.toContain("Prompt Improvements");
  });

  // ── #195: Prompt Recommendations & Status Markdown ─────────────────

  describe("prompt recommendations (#195)", () => {
    it("extracts per-prompt recommendations from audit data", async () => {
      const generator = new DigestGenerator();
      const report: DigestReport = {
        taskReview: makeTaskReview(),
        promptAudit: {
          sampledCount: 2,
          averageScore: 6.5,
          audits: [
            {
              originalPrompt: "Write a function that adds two numbers",
              sessionId: "sess-001",
              score: 4,
              tokenEstimate: 50,
              suggestions: "Be more specific about types and error handling",
              rewrite: "Write a TypeScript function that adds two numbers with input validation",
            },
            {
              originalPrompt: "Refactor the authentication module",
              sessionId: "sess-002",
              score: 9,
              tokenEstimate: 40,
              suggestions: "Good prompt overall",
              rewrite: null,
            },
          ],
        },
        tokenBurn: null,
      };

      const record = await generator.generate(report);

      expect(record.promptRecommendations).not.toBeNull();
      expect(record.promptRecommendations).toHaveLength(2);

      const first = record.promptRecommendations![0]!;
      expect(first.sessionId).toBe("sess-001");
      expect(first.score).toBe(4);
      expect(first.suggestions).toContain("specific about types");
      expect(first.rewrite).toBeTruthy();

      const second = record.promptRecommendations![1]!;
      expect(second.score).toBe(9);
      expect(second.rewrite).toBeNull();
    });

    it("returns null promptRecommendations when no audit data", async () => {
      const generator = new DigestGenerator();
      const report: DigestReport = {
        taskReview: makeTaskReview(),
        promptAudit: null,
        tokenBurn: null,
      };

      const record = await generator.generate(report);
      expect(record.promptRecommendations).toBeNull();
    });

    it("formatDigest includes prompt recommendations section", async () => {
      const generator = new DigestGenerator();
      const report: DigestReport = {
        taskReview: makeTaskReview(),
        promptAudit: {
          sampledCount: 1,
          averageScore: 4,
          audits: [
            {
              originalPrompt: "Do the thing",
              sessionId: "sess-x",
              score: 4,
              tokenEstimate: 30,
              suggestions: "Provide more context",
              rewrite: "Please implement X with Y constraints",
            },
          ],
        },
        tokenBurn: null,
      };

      const record = await generator.generate(report);
      const text = generator.formatDigest(record);

      expect(text).toContain("Prompt Recommendations");
      expect(text).toContain("🔴");
      expect(text).toContain("4/10");
      expect(text).toContain("Provide more context");
      expect(text).toContain("Suggested rewrite");
    });

    it("generateStatusMarkdown produces valid markdown", async () => {
      const generator = new DigestGenerator();
      const report: DigestReport = {
        taskReview: makeTaskReview({ completed: 10, failed: 1, cancelled: 0, successRate: 0.909 }),
        promptAudit: {
          sampledCount: 2,
          averageScore: 7.0,
          audits: [
            {
              originalPrompt: "Test prompt",
              sessionId: "s1",
              score: 7,
              tokenEstimate: 25,
              suggestions: "Looks good",
              rewrite: null,
            },
          ],
        },
        tokenBurn: { total: 5000, avgPerTask: 500, topConsumer: null },
      };

      const record = await generator.generate(report);
      const md = generator.generateStatusMarkdown(record);

      expect(md).toContain("# Sentinel Status Report");
      expect(md).toContain("## Task Summary");
      expect(md).toContain("| Completed | 10 |");
      expect(md).toContain("## Token Burn");
      expect(md).toContain("## Prompt Audit");
      expect(md).toContain("## Prompt Recommendations");
      expect(md).toContain("Auto-generated by Sentinel");
    });
  });
});
