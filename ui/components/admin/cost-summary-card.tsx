"use client";

/**
 * Admin cost-summary card (Bug #1064-#6b / Epic #1053).
 *
 * Surfaces cross-session totals from `GET /api/admin/sessions/cost-summary`
 * so the admin dashboard always has a "what did the local LLM save us" view,
 * even when no chat is currently open. Polls every 30s — same cadence as the
 * neighbouring local-llm panel after PN-A.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { Loader2 } from "lucide-react";

interface CostSummary {
  callCount: number;
  sessionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalActualCost: number;
  totalWouldHaveCost: number;
  savedByLocal: number;
  lastCallAt: string | null;
  pricingSource: string;
  pricingVersion: string;
  pricingFetchedAt: string;
}

function fmtUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function CostSummaryCard() {
  const query = useQuery({
    queryKey: ["admin", "cost-summary"],
    queryFn: () =>
      fetchJson<{ summary: CostSummary }>(
        "/api/admin/sessions/cost-summary",
      ).then((r) => r.summary),
    refetchInterval: 30_000,
  });

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading cost summary…
      </div>
    );
  }
  if (query.error) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-200">
        Failed to load cost summary:{" "}
        {query.error instanceof Error ? query.error.message : String(query.error)}
      </div>
    );
  }

  const s = query.data;
  if (!s || s.callCount === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        No cost data yet. Once you start chatting (cloud or local), totals will
        appear here.
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-border bg-card text-card-foreground p-4"
      data-testid="cost-summary-card"
    >
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">Sessions</p>
          <p className="text-xl font-semibold">{s.sessionCount.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">API calls</p>
          <p className="text-xl font-semibold">{s.callCount.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Actual cost</p>
          <p className="text-xl font-semibold">{fmtUsd(s.totalActualCost)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Saved by local</p>
          <p className="text-xl font-semibold text-emerald-600 dark:text-emerald-400">
            {fmtUsd(s.savedByLocal)}
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Tokens: {s.totalInputTokens.toLocaleString()} in /{" "}
        {s.totalOutputTokens.toLocaleString()} out
        {s.totalCachedTokens > 0
          ? ` (${s.totalCachedTokens.toLocaleString()} cached)`
          : ""}
        .{" "}
        Pricing: {s.pricingSource} v{s.pricingVersion}.
      </p>
    </div>
  );
}
