"use client";

export const dynamic = "force-dynamic";

import { useState, useCallback, useEffect } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useSeoHistory } from "@/hooks/useSeoHistory";
import { useQueryClient } from "@tanstack/react-query";
import { CrawlProgressPanel } from "@/components/seo/crawl-progress-panel";
import { SiteHealthScore } from "@/components/seo/site-health-score";
import { AuditTrends } from "@/components/seo/audit-trends";
import { ExportDialog } from "@/components/seo/export-dialog";
import { LinkGraph } from "@/components/seo/link-graph";
import { fetchJson } from "@/lib/api";
import {
  Search,
  BarChart3,
  History,
  Download,
  AlertTriangle,
  Link2,
  FileText,
  Gauge,
  Play,
  Loader2,
  AlertCircle,
} from "lucide-react";

interface AuditIssue {
  severity: string;
  category: string;
  message: string;
}

interface AuditPage {
  url: string;
  issues: AuditIssue[];
  metrics?: Record<string, number>;
}

interface BrokenLink {
  sourceUrl: string;
  targetUrl: string;
  anchorText: string;
  statusCode: number;
}

interface RedirectChain {
  chain?: string[];
}

interface LinkAnalysis {
  totalLinks: number;
  brokenLinks?: BrokenLink[];
  orphanPages?: (string | Record<string, unknown>)[];
  redirectChains?: RedirectChain[];
  links?: { source: string; target: string }[];
  nodes?: { id: string; issues?: number }[];
}

interface DuplicateGroup {
  urls?: string[];
}

interface ThinContentPage {
  url?: string;
  wordCount?: number;
}

interface ContentAnalysis {
  duplicateGroups?: DuplicateGroup[];
  thinContentPages?: (string | ThinContentPage)[];
}

interface CwvMetric {
  name: string;
  value: number;
  unit: string;
  rating: string;
}

interface CwvEntry {
  url: string;
  performanceScore: number;
  metrics?: CwvMetric[];
}

interface SeoData {
  pages?: AuditPage[];
  linkAnalysis?: LinkAnalysis;
  contentAnalysis?: ContentAnalysis;
  coreWebVitals?: CwvEntry[];
}

export default function SeoPage() {
  const { data: history } = useSeoHistory();
  const queryClient = useQueryClient();
  const latest = history?.[0] ?? null;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [auditUrl, setAuditUrl] = useState("");
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [firecrawlHealth, setFirecrawlHealth] = useState<{
    available: boolean;
    message: string;
    checking: boolean;
  }>({ available: false, message: "", checking: true });

  // Check Firecrawl health on mount
  useEffect(() => {
    const checkHealth = async () => {
      try {
        const result = await fetchJson<{ available: boolean; message: string }>(
          "/api/seo/health",
        );
        setFirecrawlHealth({
          available: result.available,
          message: result.message,
          checking: false,
        });
      } catch {
        setFirecrawlHealth({
          available: false,
          message: "Failed to check Firecrawl status",
          checking: false,
        });
      }
    };
    checkHealth();
  }, []);

  const handleRunAudit = useCallback(async () => {
    const trimmed = auditUrl.trim();
    if (!trimmed) return;
    setAuditRunning(true);
    setAuditError(null);
    try {
      await fetchJson<{ status: string; url: string }>("/api/seo/audit", {
        method: "POST",
        body: JSON.stringify({ url: trimmed }),
      });
      // After accepted, clear input — user should see progress via CrawlProgressPanel
      setAuditUrl("");
      // Refresh history after a short delay to allow audit start
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["seo-history"] });
      }, 3000);
    } catch (err) {
      setAuditError(
        err instanceof Error ? err.message : "Failed to start audit",
      );
    } finally {
      setAuditRunning(false);
    }
  }, [auditUrl, queryClient]);

  const latestData = latest ? safeParseDataJson(latest.dataJson) : null;

  return (
    <main className="px-6 py-10 lg:px-12 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">SEO Suite</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Monitor site health, track audit history, and export reports.
        </p>
      </div>

      {/* Run Audit CTA */}
      <div className="rounded-xl border bg-card p-4 mb-4">
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <Play className="h-4 w-4" /> Run Audit
        </h3>

        {/* Firecrawl health warning */}
        {!firecrawlHealth.checking && !firecrawlHealth.available && (
          <div className="flex items-start gap-2 rounded-md bg-yellow-500/10 border border-yellow-500/30 p-3 mb-3">
            <AlertCircle className="h-4 w-4 text-yellow-600 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-yellow-700 dark:text-yellow-500">
                Firecrawl sidecar not available
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {firecrawlHealth.message}
              </p>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={auditUrl}
            onChange={(e) => setAuditUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && firecrawlHealth.available)
                handleRunAudit();
            }}
            placeholder="Enter site URL, e.g. sawsonskates.com"
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            disabled={auditRunning || !firecrawlHealth.available}
          />
          <button
            onClick={handleRunAudit}
            disabled={
              auditRunning ||
              !auditUrl.trim() ||
              !firecrawlHealth.available ||
              firecrawlHealth.checking
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {auditRunning || firecrawlHealth.checking ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Run Audit
          </button>
        </div>
        {auditError && (
          <p className="text-xs text-red-500 mt-2">{auditError}</p>
        )}
      </div>

      <CrawlProgressPanel />

      <Tabs defaultValue="overview" className="mt-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview" className="gap-1.5">
            <Search className="h-3.5 w-3.5" /> Overview
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" /> Audit
          </TabsTrigger>
          <TabsTrigger value="links" className="gap-1.5">
            <Link2 className="h-3.5 w-3.5" /> Links
          </TabsTrigger>
          <TabsTrigger value="content" className="gap-1.5">
            <FileText className="h-3.5 w-3.5" /> Content
          </TabsTrigger>
          <TabsTrigger value="performance" className="gap-1.5">
            <Gauge className="h-3.5 w-3.5" /> Performance
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <History className="h-3.5 w-3.5" /> History
          </TabsTrigger>
          <TabsTrigger value="export" className="gap-1.5">
            <Download className="h-3.5 w-3.5" /> Export
          </TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────── */}
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

        {/* ── Audit (results detail) ───────────────────────────── */}
        <TabsContent value="audit" className="mt-6">
          {latestData?.pages && latestData.pages.length > 0 ? (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">
                Audit Results — {latest?.siteUrl}
              </h3>
              {(["error", "warning", "info"] as const).map((severity) => {
                const pagesWithIssues = latestData.pages!.filter((p) =>
                  p.issues.some((i) => i.severity === severity),
                );
                if (pagesWithIssues.length === 0) return null;
                return (
                  <div key={severity} className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide flex items-center gap-1.5">
                      <SeverityDot severity={severity} />
                      {severity === "error"
                        ? "Errors"
                        : severity === "warning"
                          ? "Warnings"
                          : "Info"}{" "}
                      (
                      {pagesWithIssues.reduce(
                        (acc, p) =>
                          acc +
                          p.issues.filter((i) => i.severity === severity)
                            .length,
                        0,
                      )}
                      )
                    </h4>
                    {pagesWithIssues.map((page) => (
                      <div
                        key={page.url}
                        className="rounded-lg border bg-card p-3"
                      >
                        <p className="text-sm font-medium truncate">
                          {page.url}
                        </p>
                        <ul className="mt-1 space-y-0.5">
                          {page.issues
                            .filter((i) => i.severity === severity)
                            .map((issue, idx) => (
                              <li
                                key={idx}
                                className="text-xs text-muted-foreground"
                              >
                                [{issue.category}] {issue.message}
                              </li>
                            ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState message="No audit results yet. Run an audit to see detailed findings." />
          )}
        </TabsContent>

        {/* ── Links ────────────────────────────────────────────── */}
        <TabsContent value="links" className="mt-6">
          {latestData?.linkAnalysis ? (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-3">
                <StatCard
                  label="Total Links"
                  value={latestData.linkAnalysis.totalLinks}
                />
                <StatCard
                  label="Broken Links"
                  value={latestData.linkAnalysis.brokenLinks?.length ?? 0}
                  color="text-red-500"
                />
                <StatCard
                  label="Orphan Pages"
                  value={latestData.linkAnalysis.orphanPages?.length ?? 0}
                  color="text-orange-500"
                />
              </div>

              {latestData.linkAnalysis.brokenLinks &&
                latestData.linkAnalysis.brokenLinks.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">Broken Links</h4>
                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">
                              Source
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                              Target
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                              Text
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                              Status
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {latestData.linkAnalysis.brokenLinks.map(
                            (link, idx) => (
                              <tr key={idx} className="border-t">
                                <td className="px-3 py-2 truncate max-w-[200px]">
                                  {link.sourceUrl}
                                </td>
                                <td className="px-3 py-2 truncate max-w-[200px]">
                                  {link.targetUrl}
                                </td>
                                <td className="px-3 py-2 truncate max-w-[120px]">
                                  {link.anchorText}
                                </td>
                                <td className="px-3 py-2 text-red-500 font-medium">
                                  {link.statusCode}
                                </td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

              {latestData.linkAnalysis.redirectChains &&
                latestData.linkAnalysis.redirectChains.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">
                      Redirect Chains
                    </h4>
                    <div className="space-y-1">
                      {latestData.linkAnalysis.redirectChains.map(
                        (chain, idx) => (
                          <div
                            key={idx}
                            className="text-xs bg-card border rounded-lg px-3 py-2"
                          >
                            {chain.chain?.join(" → ") ?? JSON.stringify(chain)}
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                )}

              {latestData.linkAnalysis.orphanPages &&
                latestData.linkAnalysis.orphanPages.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">Orphan Pages</h4>
                    <ul className="space-y-1">
                      {latestData.linkAnalysis.orphanPages.map((url, idx) => (
                        <li
                          key={idx}
                          className="text-xs bg-card border rounded-lg px-3 py-2 truncate"
                        >
                          {typeof url === "string" ? url : JSON.stringify(url)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

              <div>
                <h4 className="text-sm font-semibold mb-2">Link Graph</h4>
                <LinkGraph linkAnalysis={latestData.linkAnalysis} />
              </div>
            </div>
          ) : (
            <EmptyState message="No link analysis data. Run an audit to analyze your site's link structure." />
          )}
        </TabsContent>

        {/* ── Content ──────────────────────────────────────────── */}
        <TabsContent value="content" className="mt-6">
          {latestData?.contentAnalysis ? (
            <div className="space-y-6">
              {latestData.contentAnalysis.duplicateGroups &&
              latestData.contentAnalysis.duplicateGroups.length > 0 ? (
                <div>
                  <h4 className="text-sm font-semibold mb-2">
                    Duplicate Content Groups
                  </h4>
                  <div className="space-y-2">
                    {latestData.contentAnalysis.duplicateGroups.map(
                      (group, idx) => (
                        <div
                          key={idx}
                          className="rounded-lg border bg-card p-3"
                        >
                          <p className="text-xs font-medium text-orange-500 mb-1">
                            Group {idx + 1} — {group.urls?.length ?? 0} pages
                          </p>
                          <ul className="space-y-0.5">
                            {(group.urls ?? []).map(
                              (url: string, i: number) => (
                                <li
                                  key={i}
                                  className="text-xs text-muted-foreground truncate"
                                >
                                  {url}
                                </li>
                              ),
                            )}
                          </ul>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No duplicate content detected.
                </p>
              )}

              {latestData.contentAnalysis.thinContentPages &&
              latestData.contentAnalysis.thinContentPages.length > 0 ? (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Thin Content</h4>
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">
                            URL
                          </th>
                          <th className="px-3 py-2 text-left font-medium">
                            Word Count
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {latestData.contentAnalysis.thinContentPages.map(
                          (page, idx) => (
                            <tr key={idx} className="border-t">
                              <td className="px-3 py-2 truncate max-w-[300px]">
                                {typeof page === "string"
                                  ? page
                                  : (page.url ?? JSON.stringify(page))}
                              </td>
                              <td className="px-3 py-2 text-orange-500">
                                {typeof page === "object" && page.wordCount
                                  ? page.wordCount
                                  : "—"}
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No thin content pages detected.
                </p>
              )}
            </div>
          ) : (
            <EmptyState message="No content analysis data. Run an audit to check for duplicate and thin content." />
          )}
        </TabsContent>

        {/* ── Performance (CWV) ────────────────────────────────── */}
        <TabsContent value="performance" className="mt-6">
          {latestData?.coreWebVitals && latestData.coreWebVitals.length > 0 ? (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">Core Web Vitals</h3>
              {latestData.coreWebVitals.map((cwv, idx) => (
                <div key={idx} className="rounded-lg border bg-card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-medium truncate flex-1">
                      {cwv.url}
                    </p>
                    <span className="text-lg font-bold ml-3">
                      {cwv.performanceScore}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {(cwv.metrics ?? []).map((m) => (
                      <div key={m.name} className="text-xs">
                        <span className="font-medium">{m.name}</span>
                        <span className="ml-1 text-muted-foreground">
                          {m.value}
                          {m.unit}
                        </span>
                        <CwvRatingBadge rating={m.rating} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState message="No Core Web Vitals data. Run an audit with performance analysis enabled." />
          )}
        </TabsContent>

        {/* ── History ──────────────────────────────────────────── */}
        <TabsContent value="history" className="mt-6">
          <AuditTrends />
        </TabsContent>

        {/* ── Export ───────────────────────────────────────────── */}
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
              <ExportDialog snapshotId={null} />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </main>
  );
}

// ── Helper Components ────────────────────────────────────────────────────

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

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color ?? ""}`}>{value}</p>
    </div>
  );
}

function SeverityDot({ severity }: { severity: string }) {
  const color =
    severity === "error"
      ? "bg-red-500"
      : severity === "warning"
        ? "bg-yellow-500"
        : "bg-blue-400";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

function CwvRatingBadge({ rating }: { rating: string }) {
  const colors: Record<string, string> = {
    good: "text-green-600 bg-green-50",
    "needs-improvement": "text-yellow-600 bg-yellow-50",
    poor: "text-red-600 bg-red-50",
  };
  return (
    <span
      className={`ml-1.5 inline-block rounded px-1 py-0.5 text-[10px] font-medium ${colors[rating] ?? "text-muted-foreground bg-muted"}`}
    >
      {rating}
    </span>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-40 text-center">
      <AlertTriangle className="h-8 w-8 text-muted-foreground/40 mb-2" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function safeParseDataJson(json: string | undefined): SeoData | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
