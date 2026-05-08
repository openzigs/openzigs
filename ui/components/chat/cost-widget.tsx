"use client";

/**
 * Per-session cost widget (Issue #1059 / Epic #1053).
 *
 * Shows the running cloud-equivalent spend, the actual spend, and the
 * "saved by going local" total for the active chat session.
 */

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/api";

interface SessionCostAggregate {
  sessionId: string;
  callCount: number;
  totalActualCost: number;
  totalWouldHaveCost: number;
  savedByLocal: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface CostResponse {
  aggregate: SessionCostAggregate;
}

const fmtUsd = (n: number) =>
  n >= 1 ? `$${n.toFixed(2)}` : `${(n * 100).toFixed(2)}¢`;

export function CostWidget({
  sessionId,
  refreshIntervalMs = 5000,
}: {
  sessionId: string;
  refreshIntervalMs?: number;
}) {
  const [agg, setAgg] = useState<SessionCostAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetchJson<CostResponse>(
          `/api/admin/sessions/${encodeURIComponent(sessionId)}/cost`,
        );
        if (!cancelled) {
          setAgg(r.aggregate);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };
    void tick();
    const id = setInterval(() => void tick(), refreshIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, refreshIntervalMs]);

  if (error) {
    return (
      <div
        role="status"
        className="text-xs text-red-400"
        title={error}
      >
        cost: error
      </div>
    );
  }
  if (!agg || agg.callCount === 0) {
    return (
      <div role="status" className="text-xs text-zinc-500">
        cost: $0.00
      </div>
    );
  }

  return (
    <div role="status" className="flex items-center gap-2 text-xs text-zinc-400">
      <span>
        spent <span className="text-zinc-200">{fmtUsd(agg.totalActualCost)}</span>
      </span>
      <span aria-hidden>·</span>
      <span>
        cloud-equiv <span className="text-zinc-200">{fmtUsd(agg.totalWouldHaveCost)}</span>
      </span>
      {agg.savedByLocal > 0 && (
        <>
          <span aria-hidden>·</span>
          <span className="text-emerald-400">
            saved {fmtUsd(agg.savedByLocal)} by going local
          </span>
        </>
      )}
    </div>
  );
}
