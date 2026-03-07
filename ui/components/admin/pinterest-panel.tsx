"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { TrendingUp, Eye, MousePointerClick, Bookmark, Activity, ExternalLink, Copy } from "lucide-react";
import { showToast } from "@/components/toast";

type PinterestStatus = {
  connected: boolean;
  message?: string;
  profile?: {
    username?: string;
    account_type?: string;
    profile_image?: string;
    website_url?: string;
  };
};

type TrendKeyword = {
  keyword: string;
  pct_growth_wow: number;
  pct_growth_mom: number;
  pct_growth_yoy?: number;
};

type PinterestStats = {
  start_date: string;
  end_date: string;
  data: Record<string, unknown>;
};

function formatGrowth(value: number | undefined): string {
  if (value === undefined || value === null) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value}%`;
}

function growthColor(value: number | undefined): string {
  if (value === undefined || value === null) return "text-muted-foreground";
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-red-400";
  return "text-muted-foreground";
}

export function PinterestPanel() {
  const statusQuery = useQuery({
    queryKey: ["pinterest-status"],
    queryFn: () => fetchJson<PinterestStatus>("/api/admin/pinterest/status"),
    refetchInterval: 60_000,
  });

  const trendsQuery = useQuery({
    queryKey: ["pinterest-trends"],
    queryFn: () => fetchJson<{ trends?: TrendKeyword[] }>("/api/admin/pinterest/trends?region=US&limit=10"),
    enabled: statusQuery.data?.connected === true,
    refetchInterval: 300_000,
  });

  const statsQuery = useQuery({
    queryKey: ["pinterest-stats"],
    queryFn: () => fetchJson<PinterestStats>("/api/admin/pinterest/stats?days=7"),
    enabled: statusQuery.data?.connected === true,
    refetchInterval: 300_000,
  });

  const status = statusQuery.data;
  const trends = trendsQuery.data?.trends ?? [];
  const stats = statsQuery.data;

  const copyKeyword = (keyword: string) => {
    navigator.clipboard.writeText(keyword).then(() => {
      showToast(`Copied "${keyword}" to clipboard`, "info");
    }).catch(() => {
      showToast("Failed to copy", "error");
    });
  };

  return (
    <div className="space-y-6">
      {/* Connection Status */}
      <div className="rounded-xl border border-border bg-card/60 p-4">
        <h3 className="text-sm font-semibold text-card-foreground mb-2">Pinterest Account</h3>
        {statusQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Checking connection…</p>
        ) : status?.connected ? (
          <div className="flex items-center gap-3">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400" />
            <span className="text-sm text-card-foreground">
              Connected{status.profile?.username ? ` as @${status.profile.username}` : ""}
            </span>
            {status.profile?.website_url && (
              <a
                href={status.profile.website_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
              >
                <ExternalLink className="h-3 w-3" />
                Website
              </a>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />
            <span className="text-sm text-muted-foreground">
              {status?.message ?? "Not connected"}.{" "}
              Set <code className="rounded bg-muted px-1 py-0.5 text-xs">PINTEREST_ACCESS_TOKEN</code> to connect.
            </span>
          </div>
        )}
      </div>

      {/* Quick Stats */}
      {status?.connected && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            icon={<Eye className="h-4 w-4 text-blue-400" />}
            label="Impressions"
            value={extractMetric(stats?.data, "IMPRESSION")}
            loading={statsQuery.isLoading}
          />
          <StatCard
            icon={<MousePointerClick className="h-4 w-4 text-purple-400" />}
            label="Pin Clicks"
            value={extractMetric(stats?.data, "PIN_CLICK")}
            loading={statsQuery.isLoading}
          />
          <StatCard
            icon={<Bookmark className="h-4 w-4 text-rose-400" />}
            label="Saves"
            value={extractMetric(stats?.data, "SAVE")}
            loading={statsQuery.isLoading}
          />
          <StatCard
            icon={<Activity className="h-4 w-4 text-emerald-400" />}
            label="Engagement"
            value={extractMetric(stats?.data, "ENGAGEMENT")}
            loading={statsQuery.isLoading}
          />
        </div>
      )}

      {/* Trending Keywords */}
      {status?.connected && (
        <div className="rounded-xl border border-border bg-card/60 p-4">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-card-foreground">Trending Keywords (US)</h3>
          </div>
          {trendsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading trends…</p>
          ) : trends.length === 0 ? (
            <p className="text-sm text-muted-foreground">No trend data available.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2 pr-4">Keyword</th>
                    <th className="pb-2 pr-4 text-right">WoW</th>
                    <th className="pb-2 pr-4 text-right">MoM</th>
                    <th className="pb-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {trends.map((t) => (
                    <tr key={t.keyword} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-4 font-medium text-card-foreground">{t.keyword}</td>
                      <td className={`py-2 pr-4 text-right ${growthColor(t.pct_growth_wow)}`}>
                        {formatGrowth(t.pct_growth_wow)}
                      </td>
                      <td className={`py-2 pr-4 text-right ${growthColor(t.pct_growth_mom)}`}>
                        {formatGrowth(t.pct_growth_mom)}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          onClick={() => copyKeyword(t.keyword)}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary/30 hover:text-primary transition"
                          title="Copy keyword to clipboard"
                        >
                          <Copy className="h-3 w-3" />
                          Copy
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  loading: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className="text-lg font-semibold text-card-foreground">
        {loading ? "…" : value}
      </p>
    </div>
  );
}

/** Extract a summarized metric value from Pinterest analytics response. */
function extractMetric(
  data: Record<string, unknown> | undefined,
  metricKey: string,
): string {
  if (!data) return "—";
  try {
    // Pinterest analytics returns { all: { daily_metrics: [...], summary_metrics: { ... } } }
    const all = data.all as Record<string, unknown> | undefined;
    if (all?.summary_metrics) {
      const summary = all.summary_metrics as Record<string, number>;
      const val = summary[metricKey];
      if (typeof val === "number") return formatNumber(val);
    }
    // Fallback: try direct key access
    if (typeof data[metricKey] === "number") return formatNumber(data[metricKey] as number);
    return "—";
  } catch {
    return "—";
  }
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
