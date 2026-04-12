"use client";

import { useCrawlProgress, type CrawlStats } from "@/hooks/useCrawlProgress";
import { Loader2, CheckCircle2 } from "lucide-react";

function CrawlItem({ crawl }: { crawl: CrawlStats }) {
  const pct =
    crawl.totalPages > 0
      ? Math.round((crawl.pagesCompleted / crawl.totalPages) * 100)
      : 0;
  const isComplete = crawl.status === "completed";

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      {isComplete ? (
        <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
      ) : (
        <Loader2 className="h-4 w-4 animate-spin text-blue-500 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{crawl.siteUrl}</p>
        <div className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {crawl.pagesCompleted}/{crawl.totalPages || "?"} pages
      </span>
    </div>
  );
}

export function CrawlProgressPanel() {
  const { activeCrawls, hasCrawls } = useCrawlProgress();

  if (!hasCrawls) return null;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-muted-foreground">
        Active Crawls
      </h3>
      {activeCrawls.map((crawl) => (
        <CrawlItem key={crawl.jobId} crawl={crawl} />
      ))}
    </div>
  );
}
