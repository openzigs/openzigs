"use client";

import type { AuditSnapshot } from "@/hooks/useSeoHistory";

function ratingColor(rating: string): string {
  switch (rating) {
    case "excellent":
      return "text-green-500";
    case "good":
      return "text-emerald-500";
    case "fair":
      return "text-yellow-500";
    case "poor":
      return "text-red-500";
    default:
      return "text-muted-foreground";
  }
}

function ringColor(score: number): string {
  if (score >= 90) return "stroke-green-500";
  if (score >= 70) return "stroke-emerald-500";
  if (score >= 50) return "stroke-yellow-500";
  return "stroke-red-500";
}

export function SiteHealthScore({
  snapshot,
}: {
  snapshot: AuditSnapshot | null;
}) {
  if (!snapshot) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        No audit data yet
      </div>
    );
  }

  const circumference = 2 * Math.PI * 40;
  const offset = circumference - (snapshot.healthScore / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative h-28 w-28">
        <svg className="h-28 w-28 -rotate-90" viewBox="0 0 100 100">
          <circle
            cx="50"
            cy="50"
            r="40"
            fill="none"
            className="stroke-muted"
            strokeWidth="8"
          />
          <circle
            cx="50"
            cy="50"
            r="40"
            fill="none"
            className={ringColor(snapshot.healthScore)}
            strokeWidth="8"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-2xl font-bold">{snapshot.healthScore}</span>
        </div>
      </div>
      <span
        className={`text-sm font-semibold capitalize ${ratingColor(snapshot.rating)}`}
      >
        {snapshot.rating}
      </span>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>Pages: {snapshot.pagesAudited}</span>
        <span>Issues: {snapshot.totalIssues}</span>
        <span>Critical: {snapshot.critical}</span>
        <span>High: {snapshot.high}</span>
        <span>Medium: {snapshot.medium}</span>
        <span>Low: {snapshot.low}</span>
      </div>
    </div>
  );
}
