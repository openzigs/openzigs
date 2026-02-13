"use client";

import { cn, formatTokens } from "@/lib/utils";
import type { TokenUsage } from "@/lib/types";

export type ContextFuelGaugeProps = {
  /** Cumulative token usage for the session. */
  usage: TokenUsage | null;
  /** Context window size in tokens for the selected model. */
  contextWindow: number | null;
  /** Fill ratio 0-1 (pre-computed). */
  fillRatio: number | null;
  /** Whether compaction is in progress. */
  compacting?: boolean;
};

/** Return Tailwind color classes based on fill level. */
const fillColor = (ratio: number): string => {
  if (ratio < 0.5) return "bg-moss";
  if (ratio < 0.75) return "bg-yellow-500";
  if (ratio < 0.9) return "bg-orange-500";
  return "bg-destructive";
};

// formatTokens imported from @/lib/utils

/**
 * A compact fuel-gauge bar showing context window fill level.
 * Sits in the chat header next to the model selector.
 *
 * Colour states:
 *  - Green  (<50%): plenty of headroom
 *  - Yellow (50–75%): moderate usage
 *  - Orange (75–90%): high usage
 *  - Red    (>90%): near capacity, compaction expected
 *
 * When `compacting` is true a pulsing indicator overlays the bar.
 */
export const ContextFuelGauge = ({
  usage,
  contextWindow,
  fillRatio,
  compacting = false,
}: ContextFuelGaugeProps) => {
  if (!usage || fillRatio === null) {
    // No usage data yet — show a minimal placeholder
    return (
      <div
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        title="Token usage will appear once conversation starts"
      >
        <span className="font-mono text-[10px]">0 tokens</span>
      </div>
    );
  }

  const pct = Math.round(fillRatio * 100);
  const barColor = fillColor(fillRatio);

  const title = contextWindow
    ? `${formatTokens(usage.inputTokens)} / ${formatTokens(contextWindow)} input tokens (${pct}%) · ${usage.turns} turn${usage.turns !== 1 ? "s" : ""}`
    : `${formatTokens(usage.totalTokens)} total tokens · ${usage.turns} turn${usage.turns !== 1 ? "s" : ""}`;

  return (
    <div className="flex items-center gap-2" title={title}>
      {/* Gauge bar */}
      <div className="relative h-2 w-20 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out",
            barColor,
            compacting && "animate-pulse"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Percentage label */}
      <span className={cn(
        "font-mono text-[10px] tabular-nums",
        fillRatio >= 0.9
          ? "text-destructive"
          : fillRatio >= 0.75
            ? "text-orange-500"
            : "text-muted-foreground"
      )}>
        {pct}%
      </span>

      {/* Compaction indicator */}
      {compacting && (
        <span className="text-[10px] text-amber-500 animate-pulse" title="Context compaction in progress">
          ⟳
        </span>
      )}
    </div>
  );
};
