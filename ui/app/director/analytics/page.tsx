"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import {
  BarChart3,
  Eye,
  Users,
  Video,
  Loader2,
  RefreshCw,
  ArrowUpDown,
  Search,
  AlertCircle,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ── Types ────────────────────────────────────────────

interface ChannelStats {
  channelId: string;
  title: string;
  description: string;
  subscriberCount: number;
  viewCount: number;
  videoCount: number;
  thumbnailUrl: string;
  _cached?: boolean;
  _cachedAt?: string;
}

interface VideoMetric {
  videoId: string;
  title: string;
  publishedAt: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  duration: string;
  thumbnailUrl: string;
  likeRatio: number;
}

interface VideosResponse {
  videos: VideoMetric[];
  _cached?: boolean;
  _cachedAt?: string;
}

type SortField = "viewCount" | "likeCount" | "commentCount" | "publishedAt";

// ── Helpers ──────────────────────────────────────────

function formatCount(n: number | string | undefined | null): string {
  const num = Number(n ?? 0);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ── Stat Card ────────────────────────────────────────

function StatCard({ icon: Icon, label, value }: { icon: typeof Eye; label: string; value: string }) {
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

// ── Page ─────────────────────────────────────────────

export default function AnalyticsPage() {
  const [sortField, setSortField] = useState<SortField>("viewCount");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [searchQuery, setSearchQuery] = useState("");

  const channelQuery = useQuery({
    queryKey: ["yt-analytics-channel"],
    queryFn: () => fetchJson<ChannelStats>("/api/admin/director/youtube/analytics/channel"),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const videosQuery = useQuery({
    queryKey: ["yt-analytics-videos"],
    queryFn: () =>
      fetchJson<VideosResponse>("/api/admin/director/youtube/analytics/videos?limit=50&sort=views&order=desc"),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const cachedAt = channelQuery.data?._cachedAt ?? videosQuery.data?._cachedAt;
  const isFromCache = !!(channelQuery.data?._cached || videosQuery.data?._cached);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  const refetchAll = () => {
    channelQuery.refetch();
    videosQuery.refetch();
  };

  // Filter & sort videos
  const videos = (videosQuery.data?.videos ?? [])
    .filter((v) => v.title.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      const aVal = sortField === "publishedAt" ? new Date(a.publishedAt).getTime() : a[sortField];
      const bVal = sortField === "publishedAt" ? new Date(b.publishedAt).getTime() : b[sortField];
      return sortOrder === "asc" ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });

  // Bar chart: top 10 by views
  const topVideos = [...(videosQuery.data?.videos ?? [])]
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, 10)
    .map((v) => ({
      name: v.title.length > 25 ? v.title.slice(0, 25) + "…" : v.title,
      views: v.viewCount,
    }));

  const isLoading = channelQuery.isLoading || videosQuery.isLoading;
  const hasNoData = channelQuery.isError && videosQuery.isError && !channelQuery.data && !videosQuery.data;

  if (hasNoData) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <AlertCircle className="h-8 w-8" />
        <p className="text-sm">YouTube analytics unavailable</p>
        <p className="text-xs">Make sure YouTube OAuth is configured and the YouTube MCP server is running.</p>
        <button
          onClick={refetchAll}
          className="mt-2 flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-foreground">
            <BarChart3 className="h-5 w-5" />
            YouTube Analytics
          </h1>
          {isFromCache && cachedAt && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-500">
              <AlertCircle className="h-3 w-3" />
              Showing cached data from {new Date(cachedAt).toLocaleString()} — live API unavailable
            </p>
          )}
        </div>
        <button
          onClick={refetchAll}
          disabled={isLoading}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Channel Overview */}
      {channelQuery.isLoading ? (
        <div className="flex h-20 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : channelQuery.data ? (
        <div>
          <div className="mb-3 flex items-center gap-3">
            {channelQuery.data.thumbnailUrl && (
              <img src={channelQuery.data.thumbnailUrl} alt="" className="h-10 w-10 rounded-full" />
            )}
            <div>
              <h2 className="text-sm font-semibold">{channelQuery.data.title}</h2>
              {channelQuery.data.description && (
                <p className="text-xs text-muted-foreground line-clamp-1">{channelQuery.data.description}</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <StatCard icon={Users} label="Subscribers" value={formatCount(channelQuery.data.subscriberCount)} />
            <StatCard icon={Eye} label="Total Views" value={formatCount(channelQuery.data.viewCount)} />
            <StatCard icon={Video} label="Videos" value={formatCount(channelQuery.data.videoCount)} />
          </div>
        </div>
      ) : null}

      {/* Top Videos Bar Chart */}
      {topVideos.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold">Top Videos by Views</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={topVideos} layout="vertical" margin={{ left: 120 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis type="number" tickFormatter={formatCount} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => formatCount(Number(v ?? 0))} />
              <Bar dataKey="views" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Video Metrics Table */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="text-sm font-semibold">Video Metrics</h3>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search videos…"
              className="rounded-md border border-border bg-background py-1.5 pl-8 pr-3 text-xs"
            />
          </div>
        </div>

        {videosQuery.isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Video</th>
                  <th className="px-4 py-2">
                    <button onClick={() => handleSort("viewCount")} className="flex items-center gap-1 font-medium hover:text-foreground">
                      Views <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="px-4 py-2">
                    <button onClick={() => handleSort("likeCount")} className="flex items-center gap-1 font-medium hover:text-foreground">
                      Likes <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="px-4 py-2">
                    <button onClick={() => handleSort("commentCount")} className="flex items-center gap-1 font-medium hover:text-foreground">
                      Comments <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="px-4 py-2">Like %</th>
                  <th className="px-4 py-2">
                    <button onClick={() => handleSort("publishedAt")} className="flex items-center gap-1 font-medium hover:text-foreground">
                      Published <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {videos.map((v) => (
                  <tr key={v.videoId} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        {v.thumbnailUrl && (
                          <img src={v.thumbnailUrl} alt="" className="h-8 w-14 rounded object-cover" />
                        )}
                        <span className="max-w-[200px] truncate font-medium text-foreground">{v.title}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2">{formatCount(v.viewCount)}</td>
                    <td className="px-4 py-2">{formatCount(v.likeCount)}</td>
                    <td className="px-4 py-2">{formatCount(v.commentCount)}</td>
                    <td className="px-4 py-2">{v.likeRatio.toFixed(1)}%</td>
                    <td className="px-4 py-2 text-muted-foreground">{formatDate(v.publishedAt)}</td>
                  </tr>
                ))}
                {videos.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      {searchQuery ? "No videos match your search" : "No videos found"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
