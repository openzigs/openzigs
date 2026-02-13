import type { TaskReviewResult } from "./task-reviewer.js";
import type { PromptAuditResult } from "./prompt-auditor.js";
import {
  appendDigestRecord,
  type DigestRecord,
} from "./sentinel-state.js";

export interface DigestReport {
  taskReview: TaskReviewResult;
  promptAudit: PromptAuditResult | null;
  tokenBurn: TokenBurnSummary | null;
}

export interface TokenBurnSummary {
  total: number;
  avgPerTask: number;
  topConsumer: { goal: string; tokens: number } | null;
}

/**
 * Formats task review + prompt audit results into a daily digest
 * and persists to the digest history JSONL file.
 */
export class DigestGenerator {
  /** Generate a digest record from aggregated results. */
  async generate(report: DigestReport): Promise<DigestRecord> {
    const { taskReview, promptAudit, tokenBurn } = report;
    const now = new Date().toISOString();

    const record: DigestRecord = {
      timestamp: now,
      period: taskReview.period,
      taskSummary: {
        completed: taskReview.completed,
        failed: taskReview.failed,
        cancelled: taskReview.cancelled,
        successRate: taskReview.successRate,
      },
      tokenBurn: tokenBurn
        ? {
            total: tokenBurn.total,
            avgPerTask: tokenBurn.avgPerTask,
            topConsumer: tokenBurn.topConsumer,
          }
        : null,
      promptAudit: promptAudit
        ? {
            sampledCount: promptAudit.sampledCount,
            avgScore: promptAudit.averageScore,
          }
        : null,
      alertCount: taskReview.alerts.length,
    };

    // Persist to JSONL
    await appendDigestRecord(record);

    return record;
  }

  /** Format a digest record into a human-readable message. */
  formatDigest(record: DigestRecord): string {
    const date = new Date(record.timestamp).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    const lines: string[] = [
      `📊 OpenZigs Daily Digest — ${date}`,
      "",
      "━━ Task Summary ━━━━━━━━━━━━━━━━",
      `✅ Completed: ${record.taskSummary.completed}  ❌ Failed: ${record.taskSummary.failed}  ⏭️ Cancelled: ${record.taskSummary.cancelled}`,
      `📈 Success Rate: ${(record.taskSummary.successRate * 100).toFixed(1)}%`,
    ];

    if (record.tokenBurn) {
      lines.push(
        "",
        "━━ Token Burn ━━━━━━━━━━━━━━━━━━",
        `💰 Total: ~${record.tokenBurn.total.toLocaleString()} tokens`,
        `📊 Avg per task: ~${record.tokenBurn.avgPerTask.toLocaleString()} tokens`,
      );
      if (record.tokenBurn.topConsumer) {
        lines.push(
          `🔥 Top consumer: "${record.tokenBurn.topConsumer.goal}" (${record.tokenBurn.topConsumer.tokens.toLocaleString()} tokens)`,
        );
      }
    }

    if (record.promptAudit) {
      lines.push(
        "",
        "━━ Prompt Improvements ━━━━━━━━━",
        `📝 Sampled ${record.promptAudit.sampledCount} prompts | Avg Score: ${record.promptAudit.avgScore.toFixed(1)}/10`,
      );
    }

    lines.push(
      "",
      "━━ Alerts ━━━━━━━━━━━━━━━━━━━━━━",
      `⚠️ ${record.alertCount} alert(s) in this period`,
    );

    return lines.join("\n");
  }
}
