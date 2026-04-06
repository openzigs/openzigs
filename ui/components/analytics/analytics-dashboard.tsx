"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import {
  BarChart3,
  TrendingUp,
  Eye,
  ThumbsUp,
  Clock,
  RefreshCw,
} from "lucide-react";

type Period = "7d" | "30d" | "90d" | "all";

interface PlatformSummary {
  platform: string;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  avgEngagementRate: number;
  contentCount: number;
}

interface AnalyticsSummaryResponse {
  totalViews: number;
  totalEngagements: number;
  overallEngagementRate: number;
  topContent: { contentId: string; title: string; views: number } | null;
  platformBreakdown: PlatformSummary[];
  dateRange: { start: string; end: string };
}

interface BestTimeSlot {
  dayOfWeek: number;
  hour: number;
  avgEngagementRate: number;
  postCount: number;
}

const PLATFORM_COLORS: Record<string, string> = {
  youtube: "#FF0000",
  tiktok: "#000000",
  instagram: "#E1306C",
  twitter: "#1DA1F2",
  linkedin: "#0A66C2",
  pinterest: "#E60023",
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Cross-platform video performance analytics dashboard.
 * #828 — Video Performance Analytics Dashboard
 */
export function AnalyticsDashboard() {
  const [period, setPeriod] = useState<Period>("30d");

  const {
    data: summary,
    isLoading: loadingSummary,
    refetch,
  } = useQuery({
    queryKey: ["video-analytics-summary", period],
    queryFn: () =>
      fetchJson<AnalyticsSummaryResponse>(
        `/api/admin/video-analytics/summary?period=${period}`,
      ),
    refetchInterval: 60_000,
  });

  const { data: bestTimes, isLoading: loadingTimes } = useQuery({
    queryKey: ["video-analytics-best-times"],
    queryFn: () =>
      fetchJson<{ slots: BestTimeSlot[] }>(
        `/api/admin/video-analytics/best-times`,
      ),
  });

  const isLoading = loadingSummary || loadingTimes;

  return (
    <div className="space-y-6" data-testid="analytics-dashboard">
      {/* Period selector + refresh */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Video Performance Analytics</h2>
        <div className="flex items-center gap-2">
          {(["7d", "30d", "90d", "all"] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 rounded text-xs font-medium ${
                period === p
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              {p === "all" ? "All Time" : p.toUpperCase()}
            </button>
          ))}
          <button
            onClick={() => refetch()}
            className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400"
            title="Refresh"
          >
            <RefreshCw
              className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`}
            />
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          icon={<Eye className="w-5 h-5 text-blue-400" />}
          label="Total Views"
          value={summary?.totalViews ?? 0}
          loading={isLoading}
        />
        <KPICard
          icon={<ThumbsUp className="w-5 h-5 text-green-400" />}
          label="Total Engagements"
          value={summary?.totalEngagements ?? 0}
          loading={isLoading}
        />
        <KPICard
          icon={<TrendingUp className="w-5 h-5 text-amber-400" />}
          label="Engagement Rate"
          value={`${(summary?.overallEngagementRate ?? 0).toFixed(1)}%`}
          loading={isLoading}
        />
        <KPICard
          icon={<BarChart3 className="w-5 h-5 text-purple-400" />}
          label="Top Content"
          value={summary?.topContent?.title ?? "—"}
          subtitle={
            summary?.topContent
              ? `${summary.topContent.views.toLocaleString()} views`
              : undefined
          }
          loading={isLoading}
        />
      </div>

      {/* Platform Breakdown */}
      <SectionCard
        title={<span className="inline-flex items-center gap-2"><BarChart3 className="w-4 h-4" /> Platform Breakdown</span>}
      >
        {!summary?.platformBreakdown?.length ? (
          <p className="text-sm text-zinc-400">
            No analytics data yet. Publish content to see metrics.
          </p>
        ) : (
          <div className="space-y-3">
            {summary.platformBreakdown.map((ps) => (
              <div key={ps.platform} className="flex items-center gap-3">
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor: PLATFORM_COLORS[ps.platform] ?? "#6b7280",
                  }}
                />
                <span className="text-sm font-medium capitalize w-24">
                  {ps.platform}
                </span>
                <div className="flex-1 bg-zinc-800 rounded-full h-2 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${summary.totalViews > 0 ? (ps.totalViews / summary.totalViews) * 100 : 0}%`,
                      backgroundColor:
                        PLATFORM_COLORS[ps.platform] ?? "#6b7280",
                    }}
                  />
                </div>
                <span className="text-xs text-zinc-400 min-w-[5rem] text-right">
                  {ps.totalViews.toLocaleString()} views
                </span>
                <span className="text-xs text-zinc-500 min-w-[3rem] text-right">
                  {ps.avgEngagementRate.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Best Times Heatmap */}
      <SectionCard
        title={<span className="inline-flex items-center gap-2"><Clock className="w-4 h-4" /> Best Posting Times</span>}
      >
        {!bestTimes?.slots?.length ? (
          <p className="text-sm text-zinc-400">
            Not enough data to compute best posting times.
          </p>
        ) : (
          <div
            className="grid grid-cols-8 gap-1 text-[10px]"
            data-testid="best-times-grid"
          >
            <div />
            {DAY_NAMES.map((d) => (
              <div key={d} className="text-center text-zinc-500 font-medium">
                {d}
              </div>
            ))}
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className="contents">
                <div className="text-right text-zinc-500 pr-1">
                  {hour.toString().padStart(2, "0")}
                </div>
                {Array.from({ length: 7 }, (_, day) => {
                  const slot = bestTimes.slots.find(
                    (s) => s.dayOfWeek === day && s.hour === hour,
                  );
                  const intensity = slot
                    ? Math.min(slot.avgEngagementRate / 10, 1)
                    : 0;
                  return (
                    <div
                      key={day}
                      className="w-full aspect-square rounded-sm"
                      style={{
                        backgroundColor: `rgba(34, 197, 94, ${intensity})`,
                      }}
                      title={
                        slot
                          ? `${DAY_NAMES[day]} ${hour}:00 — ${slot.avgEngagementRate.toFixed(1)}% (${slot.postCount} posts)`
                          : `${DAY_NAMES[day]} ${hour}:00 — no data`
                      }
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ── KPI Card ──────────────────────────────────────────────────

function KPICard({
  icon,
  label,
  value,
  subtitle,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subtitle?: string;
  loading?: boolean;
}) {
  return (
    <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-xs text-zinc-400">{label}</span>
      </div>
      {loading ? (
        <div className="h-6 w-24 bg-zinc-700 rounded animate-pulse" />
      ) : (
        <>
          <div className="text-lg font-bold">
            {typeof value === "number" ? value.toLocaleString() : value}
          </div>
          {subtitle && <div className="text-xs text-zinc-500">{subtitle}</div>}
        </>
      )}
    </div>
  );
}
