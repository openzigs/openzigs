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

/** Simple SVG line chart for health score trend. */
function TrendChart({ history }: { history: AuditSnapshot[] }) {
  if (history.length < 2) return null;

  // Render oldest → newest (left to right)
  const data = [...history].reverse();
  const W = 500;
  const H = 120;
  const PAD = 24;
  const chartW = W - PAD * 2;
  const chartH = H - PAD * 2;

  const scores = data.map((s) => s.healthScore);
  const minScore = Math.max(0, Math.min(...scores) - 10);
  const maxScore = Math.min(100, Math.max(...scores) + 10);
  const range = maxScore - minScore || 1;

  const points = data.map((s, i) => {
    const x = PAD + (i / (data.length - 1)) * chartW;
    const y = PAD + chartH - ((s.healthScore - minScore) / range) * chartH;
    return { x, y, score: s.healthScore, date: s.createdAt };
  });

  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");

  const scoreColor = (score: number) =>
    score >= 80
      ? "text-green-500"
      : score >= 50
        ? "text-yellow-500"
        : "text-red-500";

  return (
    <div className="rounded-lg border bg-card p-3">
      <h4 className="text-xs font-semibold text-muted-foreground mb-2">
        Health Score Trend
      </h4>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = PAD + chartH - f * chartH;
          const label = Math.round(minScore + f * range);
          return (
            <g key={f}>
              <line
                x1={PAD}
                y1={y}
                x2={W - PAD}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.1}
              />
              <text
                x={PAD - 4}
                y={y + 3}
                textAnchor="end"
                className="fill-muted-foreground"
                fontSize="8"
              >
                {label}
              </text>
            </g>
          );
        })}

        {/* Line */}
        <polyline
          points={polyline}
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {/* Points */}
        {points.map((p, i) => (
          <g key={i}>
            <circle
              cx={p.x}
              cy={p.y}
              r="3.5"
              fill="hsl(var(--primary))"
              stroke="hsl(var(--background))"
              strokeWidth="1.5"
            />
            <title>
              {p.score}/100 — {new Date(p.date).toLocaleDateString()}
            </title>
          </g>
        ))}

        {/* Date labels */}
        {points
          .filter(
            (_, i) =>
              i === 0 ||
              i === points.length - 1 ||
              i === Math.floor(points.length / 2),
          )
          .map((p, i) => (
            <text
              key={i}
              x={p.x}
              y={H - 4}
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="7"
            >
              {new Date(p.date).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </text>
          ))}
      </svg>
      <div className="flex justify-between mt-1 text-[10px] text-muted-foreground px-1">
        <span>
          Latest:{" "}
          <span
            className={`font-medium ${scoreColor(scores[scores.length - 1])}`}
          >
            {scores[scores.length - 1]}
          </span>
        </span>
        <span>
          Avg:{" "}
          <span className="font-medium">
            {Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)}
          </span>
        </span>
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
      {/* Trend Chart */}
      <TrendChart history={history} />

      {/* Comparison */}
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
