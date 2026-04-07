"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer } from "@/components/toast";
import {
  BarChart3,
  Eye,
  ThumbsUp,
  Share2,
  MessageSquare,
  TrendingUp,
  Loader2,
} from "lucide-react";

interface PlatformSummary {
  platform: string;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  avgEngagementRate: number;
  contentCount: number;
}

interface VideoMetrics {
  contentId: string;
  platform: string;
  title: string;
  publishedUrl: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  engagementRate: number;
  watchTimeMinutes: number;
  ctr: number;
  publishedAt: string;
  fetchedAt: string;
}

interface AnalyticsSummary {
  totalViews: number;
  totalEngagements: number;
  overallEngagementRate: number;
  topContent: VideoMetrics | null;
  platformBreakdown: PlatformSummary[];
  dateRange: { start: string; end: string };
}

type Period = "7d" | "30d" | "90d";

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function KpiCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Eye;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="mt-1 text-2xl font-bold text-foreground">{value}</p>
    </div>
  );
}

export default function CrossPlatformAnalyticsPage() {
  const [period, setPeriod] = useState<Period>("7d");

  const summaryQuery = useQuery({
    queryKey: ["video-analytics-summary", period],
    queryFn: () =>
      fetchJson<AnalyticsSummary>(
        `/api/admin/video-analytics/summary?period=${period}`,
      ),
    staleTime: 60_000,
  });

  const summary = summaryQuery.data;

  const totalLikes =
    summary?.platformBreakdown.reduce((s, p) => s + p.totalLikes, 0) ?? 0;
  const totalShares =
    summary?.platformBreakdown.reduce((s, p) => s + p.totalShares, 0) ?? 0;
  const totalComments =
    summary?.platformBreakdown.reduce((s, p) => s + p.totalComments, 0) ?? 0;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <ToastContainer />

      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-lg font-bold text-foreground">
          <BarChart3 className="h-5 w-5" />
          Cross-Platform Analytics
        </h1>
        <div className="flex rounded-lg border border-border bg-muted p-0.5">
          {(["7d", "30d", "90d"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                period === p
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {p === "7d" ? "7 Days" : p === "30d" ? "30 Days" : "90 Days"}
            </button>
          ))}
        </div>
      </div>

      {summaryQuery.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <KpiCard
              icon={Eye}
              label="Views"
              value={formatCount(summary?.totalViews ?? 0)}
            />
            <KpiCard
              icon={ThumbsUp}
              label="Likes"
              value={formatCount(totalLikes)}
            />
            <KpiCard
              icon={Share2}
              label="Shares"
              value={formatCount(totalShares)}
            />
            <KpiCard
              icon={MessageSquare}
              label="Comments"
              value={formatCount(totalComments)}
            />
            <KpiCard
              icon={TrendingUp}
              label="Engagement Rate"
              value={`${(summary?.overallEngagementRate ?? 0).toFixed(1)}%`}
            />
          </div>

          {summary?.platformBreakdown && summary.platformBreakdown.length > 0 && (
            <SectionCard
              title={
                <span>
                  Platform Breakdown{" "}
                  <span className="text-sm font-normal text-muted-foreground">
                    — performance by platform
                  </span>
                </span>
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Platform</th>
                      <th className="px-4 py-2 font-medium">Content</th>
                      <th className="px-4 py-2 font-medium">Views</th>
                      <th className="px-4 py-2 font-medium">Likes</th>
                      <th className="px-4 py-2 font-medium">Comments</th>
                      <th className="px-4 py-2 font-medium">Shares</th>
                      <th className="px-4 py-2 font-medium">Engagement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.platformBreakdown.map((p) => (
                      <tr
                        key={p.platform}
                        className="border-b border-border last:border-0 hover:bg-muted/30"
                      >
                        <td className="px-4 py-2 font-medium capitalize text-foreground">
                          {p.platform}
                        </td>
                        <td className="px-4 py-2">{p.contentCount}</td>
                        <td className="px-4 py-2">
                          {formatCount(p.totalViews)}
                        </td>
                        <td className="px-4 py-2">
                          {formatCount(p.totalLikes)}
                        </td>
                        <td className="px-4 py-2">
                          {formatCount(p.totalComments)}
                        </td>
                        <td className="px-4 py-2">
                          {formatCount(p.totalShares)}
                        </td>
                        <td className="px-4 py-2">
                          {p.avgEngagementRate.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          {summary?.topContent && (
            <SectionCard
              title={
                <span>
                  Top Content{" "}
                  <span className="text-sm font-normal text-muted-foreground">
                    — highest performing video
                  </span>
                </span>
              }
            >
              <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/20 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {summary.topContent.title}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs capitalize text-muted-foreground">
                      {summary.topContent.platform}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                    <span>{formatCount(summary.topContent.views)} views</span>
                    <span>{formatCount(summary.topContent.likes)} likes</span>
                    <span>
                      {formatCount(summary.topContent.comments)} comments
                    </span>
                    <span>{formatCount(summary.topContent.shares)} shares</span>
                    <span>
                      {summary.topContent.engagementRate.toFixed(1)}% engagement
                    </span>
                  </div>
                </div>
              </div>
            </SectionCard>
          )}
        </>
      )}
    </main>
  );
}
