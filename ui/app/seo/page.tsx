"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useSeoHistory } from "@/hooks/useSeoHistory";
import { CrawlProgressPanel } from "@/components/seo/crawl-progress-panel";
import { SiteHealthScore } from "@/components/seo/site-health-score";
import { AuditTrends } from "@/components/seo/audit-trends";
import { ExportDialog } from "@/components/seo/export-dialog";
import { Search, BarChart3, History, Download } from "lucide-react";

export default function SeoPage() {
  const { data: history } = useSeoHistory();
  const latest = history?.[0] ?? null;
  const [selectedId, setSelectedId] = useState<number | null>(null);

  return (
    <main className="px-6 py-10 lg:px-12 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">SEO Suite</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Monitor site health, track audit history, and export reports.
        </p>
      </div>

      <CrawlProgressPanel />

      <Tabs defaultValue="overview" className="mt-4">
        <TabsList>
          <TabsTrigger value="overview" className="gap-1.5">
            <Search className="h-3.5 w-3.5" /> Overview
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <History className="h-3.5 w-3.5" /> History
          </TabsTrigger>
          <TabsTrigger value="export" className="gap-1.5">
            <Download className="h-3.5 w-3.5" /> Export
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-xl border bg-card p-6">
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <BarChart3 className="h-4 w-4" /> Health Score
              </h3>
              <SiteHealthScore snapshot={latest} />
            </div>

            <div className="rounded-xl border bg-card p-6">
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <History className="h-4 w-4" /> Recent Trends
              </h3>
              <AuditTrends siteUrl={latest?.siteUrl} />
            </div>
          </div>

          {latest && (
            <div className="mt-6 rounded-xl border bg-card p-6">
              <h3 className="text-sm font-semibold mb-3">
                Latest Audit Details
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Stat label="Pages Audited" value={latest.pagesAudited} />
                <Stat label="Total Issues" value={latest.totalIssues} />
                <Stat
                  label="Critical"
                  value={latest.critical}
                  color="text-red-500"
                />
                <Stat
                  label="High"
                  value={latest.high}
                  color="text-orange-500"
                />
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-6">
          <AuditTrends />
        </TabsContent>

        <TabsContent value="export" className="mt-6">
          <div className="rounded-xl border bg-card p-6 space-y-4">
            {history && history.length > 0 ? (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Select Audit</label>
                  <select
                    value={selectedId ?? ""}
                    onChange={(e) =>
                      setSelectedId(
                        e.target.value ? Number(e.target.value) : null,
                      )
                    }
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">Choose an audit…</option>
                    {history.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.siteUrl} — Score {s.healthScore} —{" "}
                        {new Date(s.createdAt).toLocaleDateString()}
                      </option>
                    ))}
                  </select>
                </div>
                <ExportDialog snapshotId={selectedId} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No audits available to export. Run an SEO site audit first.
              </p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </main>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold ${color ?? ""}`}>{value}</p>
    </div>
  );
}
