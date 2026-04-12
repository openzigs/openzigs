"use client";

import {
  useSeoHistory,
  useSeoComparison,
  type AuditSnapshot,
} from "@/hooks/useSeoHistory";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  Clock,
} from "lucide-react";

function DeltaBadge({ delta }: { delta: number }) {
  if (delta > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600">
        <TrendingUp className="h-3 w-3" /> +{delta}
      </span>
    );
  }
  if (delta < 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
        <TrendingDown className="h-3 w-3" /> {delta}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <Minus className="h-3 w-3" /> 0
    </span>
  );
}

function SnapshotRow({ snapshot }: { snapshot: AuditSnapshot }) {
  const date = new Date(snapshot.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="flex items-center gap-4 rounded-lg border bg-card p-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{snapshot.siteUrl}</p>
        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
          <Clock className="h-3 w-3" /> {date}
        </p>
      </div>
      <div className="text-right">
        <span className="text-lg font-bold">{snapshot.healthScore}</span>
        <span className="text-xs text-muted-foreground ml-1">/ 100</span>
      </div>
      <div className="text-right text-xs text-muted-foreground">
        <div>{snapshot.pagesAudited} pages</div>
        <div>{snapshot.totalIssues} issues</div>
      </div>
    </div>
  );
}

export function AuditTrends({ siteUrl }: { siteUrl?: string }) {
  const { data: history, isLoading } = useSeoHistory(siteUrl);
  const { data: comparison } = useSeoComparison(siteUrl ?? null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        Loading history…
      </div>
    );
  }

  if (!history || history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 gap-2 text-muted-foreground">
        <Clock className="h-6 w-6" />
        <p className="text-sm">No audit history yet</p>
        <p className="text-xs">
          Run an SEO site audit to start tracking trends
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {comparison && (
        <div className="rounded-lg border bg-card p-4 space-y-2">
          <h4 className="text-sm font-semibold">Latest vs Previous</h4>
          <div className="flex items-center gap-6">
            <div>
              <span className="text-xs text-muted-foreground">
                Score Change
              </span>
              <div className="mt-0.5">
                <DeltaBadge delta={comparison.scoreDelta} />
              </div>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">New Issues</span>
              <p className="text-sm font-medium">{comparison.newIssues}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Resolved</span>
              <p className="text-sm font-medium">{comparison.resolvedIssues}</p>
            </div>
          </div>
          {comparison.regressions.length > 0 && (
            <div className="mt-2 space-y-1">
              <span className="text-xs font-medium text-red-600 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Regressions
              </span>
              {comparison.regressions.map((r, i) => (
                <p key={i} className="text-xs text-muted-foreground pl-4">
                  {r}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-muted-foreground">
          Audit History
        </h4>
        {history.map((s) => (
          <SnapshotRow key={s.id} snapshot={s} />
        ))}
      </div>
    </div>
  );
}
