"use client";

import { useEffect, useState, useCallback } from "react";
import { useCrawlProgress, type CrawlStats } from "@/hooks/useCrawlProgress";
import { fetchJson } from "@/lib/api";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  X,
} from "lucide-react";

/** Format milliseconds as `MM:SS` (or `H:MM:SS` over 1 hour). */
export function formatElapsed(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalSec = Math.floor(safeMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function useElapsed(startedAt: string, frozenMs?: number): number {
  const startTs = new Date(startedAt).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (frozenMs !== undefined) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [frozenMs]);
  return frozenMs ?? Math.max(0, now - startTs);
}

function StatusIcon({ status }: { status: CrawlStats["status"] }) {
  if (status === "completed")
    return (
      <CheckCircle2
        className="h-4 w-4 text-green-500 shrink-0"
        aria-label="Completed"
      />
    );
  if (status === "failed")
    return (
      <XCircle className="h-4 w-4 text-red-500 shrink-0" aria-label="Failed" />
    );
  if (status === "cancelled")
    return (
      <X
        className="h-4 w-4 text-muted-foreground shrink-0"
        aria-label="Cancelled"
      />
    );
  return (
    <Loader2
      className="h-4 w-4 animate-spin text-blue-500 shrink-0"
      aria-label="Running"
    />
  );
}

export interface CrawlItemProps {
  crawl: CrawlStats;
  onCancel?: (jobId: string) => Promise<void> | void;
  onComplete?: (jobId: string) => void;
}

export function CrawlItem({ crawl, onCancel, onComplete }: CrawlItemProps) {
  const isComplete = crawl.status !== "running";
  const frozenMs =
    isComplete && crawl.completedAt
      ? Math.max(
          0,
          new Date(crawl.completedAt).getTime() -
            new Date(crawl.startedAt).getTime(),
        )
      : undefined;
  const elapsedMs = useElapsed(crawl.startedAt, frozenMs);
  const pct =
    crawl.totalPages > 0
      ? Math.min(
          100,
          Math.round((crawl.pagesCompleted / crawl.totalPages) * 100),
        )
      : 0;
  const remaining = Math.max(0, crawl.totalPages - crawl.pagesCompleted);
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Notify parent on completion exactly once.
  useEffect(() => {
    if (isComplete) onComplete?.(crawl.jobId);
  }, [isComplete, crawl.jobId, onComplete]);

  const handleCancel = useCallback(async () => {
    if (!onCancel) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await onCancel(crawl.jobId);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setCancelling(false);
    }
  }, [crawl.jobId, onCancel]);

  return (
    <div
      className="rounded-lg border bg-card p-3"
      role="region"
      aria-label={`Crawl progress for ${crawl.siteUrl}`}
    >
      <div className="flex items-center gap-3">
        <StatusIcon status={crawl.status} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate" title={crawl.siteUrl}>
            {crawl.siteUrl}
          </p>
          <div
            className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Pages crawled"
          >
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                crawl.status === "failed"
                  ? "bg-red-500"
                  : crawl.status === "cancelled"
                    ? "bg-muted-foreground"
                    : "bg-blue-500"
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <div className="flex flex-col items-end text-xs text-muted-foreground whitespace-nowrap">
          <span aria-label="Pages crawled">
            {crawl.pagesCompleted}/{crawl.totalPages || "?"} pages
          </span>
          <span aria-label="Elapsed time" data-testid="crawl-elapsed">
            {formatElapsed(elapsedMs)}
          </span>
        </div>
        {!isComplete && onCancel && (
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="ml-2 rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
            aria-label="Cancel crawl"
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">Last:</span>{" "}
          <span className="truncate inline-block max-w-[300px] align-bottom">
            {crawl.lastUrl}
          </span>
        </span>
        {crawl.totalPages > 0 && !isComplete && (
          <span>
            <span className="font-medium text-foreground">{remaining}</span>{" "}
            remaining
          </span>
        )}
        {crawl.errorCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-red-500 hover:underline"
            aria-expanded={expanded}
            aria-controls={`crawl-errors-${crawl.jobId}`}
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <AlertTriangle className="h-3 w-3" />
            {crawl.errorCount} error{crawl.errorCount === 1 ? "" : "s"}
          </button>
        )}
      </div>

      {expanded && crawl.errors.length > 0 && (
        <ul
          id={`crawl-errors-${crawl.jobId}`}
          className="mt-2 max-h-32 overflow-y-auto space-y-1 rounded border border-red-500/20 bg-red-500/5 p-2 text-xs"
        >
          {crawl.errors.map((e, i) => (
            <li
              key={`${e.url}-${i}`}
              className="truncate"
              title={`${e.url} ${e.statusCode ?? ""} ${e.message ?? ""}`.trim()}
            >
              <span className="font-mono text-red-600">
                {e.statusCode ?? "ERR"}
              </span>{" "}
              <span className="text-muted-foreground">{e.url}</span>
            </li>
          ))}
        </ul>
      )}

      {cancelError && (
        <p className="mt-2 text-xs text-red-500" role="alert">
          {cancelError}
        </p>
      )}
    </div>
  );
}

export interface CrawlProgressPanelProps {
  /** Optional list of crawl stats. Defaults to the live useCrawlProgress hook. */
  crawls?: CrawlStats[];
  /** Override cancel handler. Defaults to POST /api/seo/audit/:jobId/cancel. */
  onCancel?: (jobId: string) => Promise<void> | void;
  /** Called once each time a crawl reaches a terminal state. */
  onComplete?: (jobId: string) => void;
}

async function defaultCancel(jobId: string): Promise<void> {
  await fetchJson(`/api/seo/audit/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
}

export function CrawlProgressPanel({
  crawls,
  onCancel = defaultCancel,
  onComplete,
}: CrawlProgressPanelProps = {}) {
  const live = useCrawlProgress();
  const list = crawls ?? live.activeCrawls;

  if (list.length === 0) return null;

  return (
    <div className="space-y-2" role="region" aria-label="Active crawls">
      <h3 className="text-sm font-semibold text-muted-foreground">
        Active Crawls
      </h3>
      {list.map((crawl) => (
        <CrawlItem
          key={crawl.jobId}
          crawl={crawl}
          onCancel={onCancel}
          onComplete={onComplete}
        />
      ))}
    </div>
  );
}
