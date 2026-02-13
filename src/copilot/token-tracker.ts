/**
 * Token usage tracking for CopilotWrapperService.
 *
 * Accumulates per-session token counts from the SDK's `assistant.usage` events
 * and exposes them for real-time emission (Socket.IO) and persistence (SQLite).
 *
 * @module
 */

// ── Types ────────────────────────────────────────────────────────────

/** Finalized token usage snapshot for a session/task. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
}

/** Internal accumulator for token counts. */
interface TokenUsageAccumulator {
  input: number;
  output: number;
  turns: number;
}

/** Real-time token usage event emitted per SDK usage callback. */
export interface TokenUsageEvent {
  sessionId: string;
  delta: { inputTokens: number; outputTokens: number };
  cumulative: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/** Context compaction lifecycle event. */
export interface CompactionEvent {
  sessionId: string;
  status: "started" | "completed";
}

// ── Model Context Windows ────────────────────────────────────────────

/** Known context window sizes (in tokens) for supported models. */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1-nano": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-5": 1_000_000,
  "gpt-5-mini": 1_000_000,
  "claude-sonnet-4": 200_000,
  "claude-sonnet-3.5": 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
  "gemini-2.5-pro": 1_000_000,
};

// ── TokenTracker ─────────────────────────────────────────────────────

/**
 * Tracks per-session token usage. Thread-safe via single-threaded Node.js
 * event loop — no locking required.
 */
export class TokenTracker {
  private sessionUsage = new Map<string, TokenUsageAccumulator>();

  /**
   * Record a token usage delta for a session.
   *
   * @returns The cumulative usage after applying the delta.
   */
  record(sessionId: string, inputTokens: number, outputTokens: number): TokenUsageEvent {
    const acc = this.sessionUsage.get(sessionId) ?? { input: 0, output: 0, turns: 0 };
    acc.input += inputTokens;
    acc.output += outputTokens;
    acc.turns++;
    this.sessionUsage.set(sessionId, acc);

    return {
      sessionId,
      delta: { inputTokens, outputTokens },
      cumulative: {
        inputTokens: acc.input,
        outputTokens: acc.output,
        totalTokens: acc.input + acc.output,
      },
    };
  }

  /** Retrieve the current accumulated usage for a session (non-destructive). */
  getUsage(sessionId: string): TokenUsage | null {
    const acc = this.sessionUsage.get(sessionId);
    if (!acc) return null;
    return {
      inputTokens: acc.input,
      outputTokens: acc.output,
      totalTokens: acc.input + acc.output,
      turns: acc.turns,
    };
  }

  /**
   * Retrieve and remove the accumulated usage for a session.
   * Used when a task completes to persist the final token counts.
   */
  clearUsage(sessionId: string): TokenUsage | null {
    const usage = this.getUsage(sessionId);
    this.sessionUsage.delete(sessionId);
    return usage;
  }

  /** Check whether we have any usage data for a session. */
  hasUsage(sessionId: string): boolean {
    return this.sessionUsage.has(sessionId);
  }

  /** Get the context window size for a model (returns undefined if unknown). */
  getContextWindow(modelId: string): number | undefined {
    return MODEL_CONTEXT_WINDOWS[modelId];
  }
}
