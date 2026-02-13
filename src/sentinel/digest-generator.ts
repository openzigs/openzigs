import type { TaskReviewResult } from "./task-reviewer.js";
import type { PromptAuditResult } from "./prompt-auditor.js";
import {
  appendDigestRecord,
  writeStatusMarkdown,
  type DigestRecord,
  type PromptRecommendation,
  type SentinelConfig,
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

/** Score threshold below which a rewrite is shown. */
const REWRITE_SCORE_THRESHOLD = 7;

/**
 * Formats task review + prompt audit results into a daily digest
 * and persists to the digest history JSONL file.
 */
export class DigestGenerator {
  private config: Partial<SentinelConfig>;

  constructor(config?: Partial<SentinelConfig>) {
    this.config = config ?? {};
  }

  updateConfig(config: Partial<SentinelConfig>): void {
    this.config = config;
  }

  /** Generate a digest record from aggregated results. */
  async generate(report: DigestReport): Promise<DigestRecord> {
    const { taskReview, promptAudit, tokenBurn } = report;
    const now = new Date().toISOString();

    // Extract per-prompt recommendations from audit data (#195)
    const promptRecommendations: PromptRecommendation[] | null = promptAudit?.audits
      ? promptAudit.audits.map((a) => ({
          prompt: a.originalPrompt.slice(0, 200),
          sessionId: a.sessionId,
          score: a.score,
          suggestions: a.suggestions,
          rewrite: a.rewrite,
        }))
      : null;

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
      promptRecommendations,
      alertCount: taskReview.alerts.length,
    };

    // Persist to JSONL with retention pruning
    const retentionDays = this.config.digestRetentionDays ?? 30;
    await appendDigestRecord(record, retentionDays);

    // Write status.md if enabled (#195)
    if (this.config.persistMarkdownDigest !== false) {
      const markdown = this.generateStatusMarkdown(record);
      await writeStatusMarkdown(markdown, this.config.markdownDigestPath);
    }

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

    // Per-prompt recommendations (#195)
    if (record.promptRecommendations && record.promptRecommendations.length > 0) {
      lines.push("", "━━ Prompt Recommendations ━━━━━");
      for (const rec of record.promptRecommendations) {
        const scoreEmoji = rec.score >= 8 ? "🟢" : rec.score >= 5 ? "🟡" : "🔴";
        lines.push(`  ${scoreEmoji} Score: ${rec.score}/10 — "${rec.prompt.slice(0, 80)}…"`);
        lines.push(`     💡 ${rec.suggestions}`);
        if (rec.rewrite && rec.score < REWRITE_SCORE_THRESHOLD) {
          lines.push(`     ✏️ Suggested rewrite: "${rec.rewrite.slice(0, 200)}"`);
        }
      }
    }

    lines.push(
      "",
      "━━ Alerts ━━━━━━━━━━━━━━━━━━━━━━",
      `⚠️ ${record.alertCount} alert(s) in this period`,
    );

    return lines.join("\n");
  }

  /** Generate a human-readable Markdown status file from a digest record. */
  generateStatusMarkdown(record: DigestRecord): string {
    const tz = this.config.timezone ?? "UTC";
    const date = new Date(record.timestamp).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz,
    });

    const lines: string[] = [
      "# Sentinel Status Report",
      "",
      `> Generated: ${date}`,
      `> Period: ${new Date(record.period.from).toLocaleString(undefined, { timeZone: tz })} → ${new Date(record.period.to).toLocaleString(undefined, { timeZone: tz })}`,
      "",
      "## Task Summary",
      "",
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Completed | ${record.taskSummary.completed} |`,
      `| Failed | ${record.taskSummary.failed} |`,
      `| Cancelled | ${record.taskSummary.cancelled} |`,
      `| Success Rate | ${(record.taskSummary.successRate * 100).toFixed(1)}% |`,
      `| Alerts | ${record.alertCount} |`,
    ];

    if (record.tokenBurn) {
      lines.push(
        "",
        "## Token Burn",
        "",
        `- **Total**: ~${record.tokenBurn.total.toLocaleString()} tokens`,
        `- **Avg per task**: ~${record.tokenBurn.avgPerTask.toLocaleString()} tokens`,
      );
      if (record.tokenBurn.topConsumer) {
        lines.push(`- **Top consumer**: "${record.tokenBurn.topConsumer.goal}" (${record.tokenBurn.topConsumer.tokens.toLocaleString()} tokens)`);
      }
    }

    if (record.promptAudit) {
      lines.push(
        "",
        "## Prompt Audit",
        "",
        `- **Sampled**: ${record.promptAudit.sampledCount} prompts`,
        `- **Average Score**: ${record.promptAudit.avgScore.toFixed(1)}/10`,
      );
    }

    if (record.promptRecommendations && record.promptRecommendations.length > 0) {
      lines.push(
        "",
        "## Prompt Recommendations",
        "",
      );
      for (const rec of record.promptRecommendations) {
        const emoji = rec.score >= 8 ? "🟢" : rec.score >= 5 ? "🟡" : "🔴";
        lines.push(`### ${emoji} Score: ${rec.score}/10`);
        lines.push("");
        lines.push(`**Prompt**: "${rec.prompt}"`);
        lines.push("");
        lines.push(`**Suggestions**: ${rec.suggestions}`);
        if (rec.rewrite && rec.score < REWRITE_SCORE_THRESHOLD) {
          lines.push("");
          lines.push("**Suggested Rewrite**:");
          lines.push("");
          lines.push("```");
          lines.push(rec.rewrite);
          lines.push("```");
        }
        lines.push("");
      }
    }

    lines.push(
      "",
      "---",
      `*Auto-generated by Sentinel — OpenZigs Autonomous Monitor*`,
    );

    return lines.join("\n");
  }
}
