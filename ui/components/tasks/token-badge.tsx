"use client";

import { cn, formatTokens } from "@/lib/utils";
import type { TokenUsage } from "@/lib/types";

export type TokenBadgeProps = {
  /** Token usage data for the task. null = no data recorded. */
  usage: TokenUsage | null;
  /** Show compact variant (badge only, no tooltip wrapper). */
  compact?: boolean;
};

const fmt = formatTokens;

/** Pick a colour based on total token count. */
const badgeColor = (total: number): { bg: string; text: string } => {
  if (total < 10_000)
    return { bg: "bg-green-500/15", text: "text-green-600 dark:text-green-400" };
  if (total < 50_000)
    return { bg: "bg-yellow-500/15", text: "text-yellow-600 dark:text-yellow-400" };
  if (total < 200_000)
    return { bg: "bg-orange-500/15", text: "text-orange-600 dark:text-orange-400" };
  return { bg: "bg-red-500/15", text: "text-red-600 dark:text-red-400" };
};

/**
 * A small badge that shows token usage for a completed task.
 *
 * Colour ranges:
 *  - Green  (<10K):   cheap / lightweight
 *  - Yellow (10K–50K): moderate
 *  - Orange (50K–200K): heavy
 *  - Red    (>200K):  very expensive
 *
 * The tooltip (via native `title`) shows input/output breakdown.
 */
export const TokenBadge = ({ usage, compact = false }: TokenBadgeProps) => {
  if (!usage) return null;

  const color = badgeColor(usage.totalTokens);
  const tooltip = `Input: ${fmt(usage.inputTokens)} · Output: ${fmt(usage.outputTokens)} · Turns: ${usage.turns}`;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide",
        color.bg,
        color.text,
        compact && "px-1.5"
      )}
      title={tooltip}
    >
      <svg
        className="h-2.5 w-2.5"
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <text x="8" y="11" textAnchor="middle" fontSize="8" fontWeight="bold">T</text>
      </svg>
      {fmt(usage.totalTokens)}
    </span>
  );
};
