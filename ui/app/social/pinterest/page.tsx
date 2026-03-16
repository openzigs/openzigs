"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  ArrowLeft,
  TrendingUp,
  Search,
  BarChart3,
  FileText,
  ExternalLink,
  Lightbulb,
  Target,
  Eye,
  MousePointerClick,
  Bookmark,
  Trash2,
  Pause,
  Play,
  Archive,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-react";
import { CreatePinModal } from "@/components/create-pin-modal";

// ── Types ──

type ReportListItem = {
  filename: string;
  type: string;
  generated: string;
  size: number;
  hasJson: boolean;
};

type PinterestStatus = {
  connected: boolean;
  reportCount: number;
};

type TrackedPin = {
  pin_id: string;
  title: string | null;
  topic: string | null;
  board_id: string | null;
  link: string | null;
  initial_score: number | null;
  created_at: string;
  last_checked: string | null;
  status: "active" | "paused" | "archived";
};

type PinSnapshot = {
  id: number;
  pin_id: string;
  checked_at: string;
  impressions: number;
  pin_clicks: number;
  saves: number;
  outbound_clicks: number;
  reactions: number;
  comments: number;
};

type ContentIdea = {
  id: number;
  topic: string;
  suggested_title: string;
  suggested_description: string;
  target_keywords: string;
  difficulty: string;
  estimated_volume: string;
  source_data: string;
  created_at: string;
  status: "new" | "created" | "dismissed";
  pin_id: string | null;
};

type PinSummary = {
  pin: TrackedPin;
  latest: PinSnapshot | null;
  first: PinSnapshot | null;
  totalSnapshots: number;
  daysSinceCreated: number;
};

// ── Hooks ──

function usePinterestStatus() {
  return useQuery<PinterestStatus>({
    queryKey: ["pinterest-status"],
    queryFn: () => fetchJson("/api/pinterest/status"),
  });
}

function usePinterestReports() {
  return useQuery<{ reports: ReportListItem[] }>({
    queryKey: ["pinterest-reports"],
    queryFn: () => fetchJson("/api/pinterest/reports"),
  });
}

function usePinterestReport(filename: string | null) {
  return useQuery({
    queryKey: ["pinterest-report", filename],
    queryFn: () => fetchJson<{ format: string; data?: Record<string, unknown>; content?: string }>(`/api/pinterest/reports/${filename}`),
    enabled: !!filename,
  });
}

function useTrackedPins() {
  return useQuery<{ pins: TrackedPin[] }>({
    queryKey: ["pinterest-tracked-pins"],
    queryFn: () => fetchJson("/api/pinterest/tracker/pins"),
  });
}

function usePinSnapshots(pinId: string | null) {
  return useQuery<{ snapshots: PinSnapshot[] }>({
    queryKey: ["pinterest-snapshots", pinId],
    queryFn: () => fetchJson(`/api/pinterest/tracker/pins/${pinId}/snapshots`),
    enabled: !!pinId,
  });
}

function usePinSummary(pinId: string | null) {
  return useQuery<PinSummary>({
    queryKey: ["pinterest-pin-summary", pinId],
    queryFn: () => fetchJson(`/api/pinterest/tracker/pins/${pinId}`),
    enabled: !!pinId,
  });
}

function useContentIdeas() {
  return useQuery<{ ideas: ContentIdea[] }>({
    queryKey: ["pinterest-content-ideas"],
    queryFn: () => fetchJson("/api/pinterest/tracker/ideas"),
  });
}

// ── Helpers ──

const TYPE_LABELS: Record<string, string> = {
  trends: "Trends",
  "keyword-metrics": "Keyword Metrics",
  analytics: "Analytics",
  "seo-analysis": "SEO Analysis",
  "content-ideas": "Content Ideas",
  "related-keywords": "Related Keywords",
  "search-pins": "Search Pins",
  "pin-insights": "Pin Insights",
};

const TYPE_COLORS: Record<string, string> = {
  trends: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  "keyword-metrics": "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  analytics: "bg-green-500/10 text-green-600 dark:text-green-400",
  "seo-analysis": "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  "content-ideas": "bg-pink-500/10 text-pink-600 dark:text-pink-400",
  "related-keywords": "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  "search-pins": "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  "pin-insights": "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

const CHART_COLORS = ["#8b5cf6", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#ec4899"];

type TabId = "tracker" | "ideas" | "reports";

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

// ── Main Page ──

export default function PinterestAnalyticsPage() {
  const { data: status } = usePinterestStatus();
  const [activeTab, setActiveTab] = useState<TabId>("tracker");

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: "tracker", label: "Pin Tracker", icon: <Target className="h-4 w-4" /> },
    { id: "ideas", label: "Content Ideas", icon: <Lightbulb className="h-4 w-4" /> },
    { id: "reports", label: "Reports", icon: <FileText className="h-4 w-4" /> },
  ];

  return (
    <main className="mx-auto max-w-6xl px-6 pb-12 pt-4">
      {/* Header */}
      <div className="mb-6 flex items-center gap-4">
        <Link
          href="/social"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition"
        >
          <ArrowLeft className="h-4 w-4" />
          Social Brain
        </Link>
      </div>

      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Pinterest Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Track pin performance, discover content ideas, and analyze SEO reports.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              status?.connected
                ? "bg-green-500/10 text-green-600 dark:text-green-400"
                : "bg-red-500/10 text-red-600 dark:text-red-400"
            }`}
          >
            {status?.connected ? "Pinterest Connected" : "Not Connected"}
          </span>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="mb-6 flex gap-1 rounded-xl bg-muted/50 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
              activeTab === tab.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "tracker" && <PinTrackerTab />}
      {activeTab === "ideas" && <ContentIdeasTab />}
      {activeTab === "reports" && <ReportsTab />}

      <ToastContainer />
    </main>
  );
}

// ── Pin Tracker Tab ──

function PinTrackerTab() {
  const { data, isLoading } = useTrackedPins();
  const [selectedPin, setSelectedPin] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const syncPinsMutation = useMutation({
    mutationFn: () => fetchJson<{ ok: boolean; imported: number }>("/api/pinterest/sync-pins", { method: "POST" }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["pinterest-tracked-pins"] });
      showToast(`Synced ${data.imported} pins from Pinterest`, "success");
    },
    onError: (err: Error) => showToast(`Sync failed: ${err.message}`, "error"),
  });

  const syncMetricsMutation = useMutation({
    mutationFn: () => fetchJson<{ ok: boolean; synced: number; errors: number }>("/api/pinterest/sync-metrics", { method: "POST" }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["pinterest-tracked-pins"] });
      showToast(`Metrics synced for ${data.synced} pins${data.errors ? ` (${data.errors} errors)` : ""}`, "success");
    },
    onError: (err: Error) => showToast(`Metrics sync failed: ${err.message}`, "error"),
  });

  const seedMutation = useMutation({
    mutationFn: () => fetchJson("/api/pinterest/tracker/seed", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pinterest-tracked-pins"] });
      showToast("Demo data seeded — these are synthetic pins, not real Pinterest data", "success");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (pinId: string) => fetchJson(`/api/pinterest/tracker/pins/${pinId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pinterest-tracked-pins"] });
      setSelectedPin(null);
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ pinId, status }: { pinId: string; status: string }) =>
      fetchJson(`/api/pinterest/tracker/pins/${pinId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pinterest-tracked-pins"] }),
  });

  const pins = data?.pins ?? [];
  const isSyncing = syncPinsMutation.isPending || syncMetricsMutation.isPending;

  if (selectedPin) {
    return <PinDetail pinId={selectedPin} onBack={() => setSelectedPin(null)} />;
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading tracked pins...</p>;

  if (pins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Target className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <h2 className="text-lg font-semibold">No Pins Being Tracked</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Sync your real Pinterest pins to start tracking their performance over time.
        </p>
        <div className="flex items-center gap-3 mt-4">
          <button
            onClick={() => syncPinsMutation.mutate()}
            disabled={isSyncing}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${syncPinsMutation.isPending ? "animate-spin" : ""}`} />
            {syncPinsMutation.isPending ? "Syncing..." : "Sync from Pinterest"}
          </button>
          <button
            onClick={() => seedMutation.mutate()}
            disabled={seedMutation.isPending}
            className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {seedMutation.isPending ? "Seeding..." : "Seed Demo Data"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary row + sync actions */}
      <div className="flex items-end justify-between">
        <div className="grid flex-1 grid-cols-4 gap-4">
          <MetricCard label="Tracked Pins" value={pins.length} icon={<Target className="h-4 w-4 text-primary" />} />
          <MetricCard label="Active" value={pins.filter((p) => p.status === "active").length} icon={<Play className="h-4 w-4 text-green-500" />} />
          <MetricCard label="Paused" value={pins.filter((p) => p.status === "paused").length} icon={<Pause className="h-4 w-4 text-yellow-500" />} />
          <MetricCard label="Archived" value={pins.filter((p) => p.status === "archived").length} icon={<Archive className="h-4 w-4 text-muted-foreground" />} />
        </div>
      </div>

      {/* Sync buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => syncPinsMutation.mutate()}
          disabled={isSyncing}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${syncPinsMutation.isPending ? "animate-spin" : ""}`} />
          {syncPinsMutation.isPending ? "Syncing Pins..." : "Sync Pins"}
        </button>
        <button
          onClick={() => syncMetricsMutation.mutate()}
          disabled={isSyncing}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition disabled:opacity-50"
        >
          <TrendingUp className={`h-3.5 w-3.5 ${syncMetricsMutation.isPending ? "animate-spin" : ""}`} />
          {syncMetricsMutation.isPending ? "Syncing Metrics..." : "Sync Metrics"}
        </button>
      </div>

      {/* Pin list */}
      <div className="space-y-2">
        {pins.map((pin) => (
          <div
            key={pin.pin_id}
            className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition hover:border-primary/30 hover:shadow-sm"
          >
            <button
              onClick={() => setSelectedPin(pin.pin_id)}
              className="flex flex-1 items-center gap-4 text-left"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Target className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{pin.title ?? pin.pin_id}</p>
                <div className="mt-0.5 flex items-center gap-2">
                  {pin.topic && (
                    <span className="rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] font-semibold text-purple-600 dark:text-purple-400">
                      {pin.topic}
                    </span>
                  )}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    pin.status === "active" ? "bg-green-500/10 text-green-600 dark:text-green-400"
                      : pin.status === "paused" ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                        : "bg-muted text-muted-foreground"
                  }`}>
                    {pin.status}
                  </span>
                  {pin.initial_score != null && (
                    <span className="text-[10px] text-muted-foreground">Score: {pin.initial_score}/100</span>
                  )}
                  {pin.last_checked && (
                    <span className="text-[10px] text-muted-foreground">Last checked: {formatDate(pin.last_checked)}</span>
                  )}
                </div>
              </div>
            </button>
            <div className="flex items-center gap-1">
              {pin.status === "active" ? (
                <button
                  onClick={() => statusMutation.mutate({ pinId: pin.pin_id, status: "paused" })}
                  className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-yellow-600 transition"
                  title="Pause tracking"
                >
                  <Pause className="h-4 w-4" />
                </button>
              ) : (
                <button
                  onClick={() => statusMutation.mutate({ pinId: pin.pin_id, status: "active" })}
                  className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-green-600 transition"
                  title="Resume tracking"
                >
                  <Play className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={() => deleteMutation.mutate(pin.pin_id)}
                className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-red-500 transition"
                title="Remove pin"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}

// ── Pin Detail ──

function PinDetail({ pinId, onBack }: { pinId: string; onBack: () => void }) {
  const { data: summary } = usePinSummary(pinId);
  const { data: snapshotsData } = usePinSnapshots(pinId);

  const snapshots = snapshotsData?.snapshots ?? [];
  // Reverse to show oldest→newest for charts
  const chartData = [...snapshots].reverse().map((s) => ({
    date: s.checked_at.slice(5, 10),
    impressions: s.impressions,
    clicks: s.pin_clicks,
    saves: s.saves,
    outbound: s.outbound_clicks,
  }));

  const latest = summary?.latest;
  const first = summary?.first;

  const delta = (current: number, initial: number) => {
    const diff = current - initial;
    if (diff === 0) return "—";
    return diff > 0 ? `+${diff.toLocaleString()}` : diff.toLocaleString();
  };

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition">
        <ArrowLeft className="h-4 w-4" /> Back to tracker
      </button>

      {summary && (
        <>
          <div>
            <h2 className="text-lg font-bold">{summary.pin.title ?? summary.pin.pin_id}</h2>
            <div className="mt-1 flex items-center gap-2">
              {summary.pin.topic && (
                <span className="rounded-full bg-purple-500/10 px-2 py-0.5 text-xs font-semibold text-purple-600 dark:text-purple-400">
                  {summary.pin.topic}
                </span>
              )}
              <span className="text-xs text-muted-foreground">{summary.totalSnapshots} snapshots over {summary.daysSinceCreated} days</span>
            </div>
          </div>

          {/* Metric summary cards */}
          <div className="grid grid-cols-4 gap-4">
            <MetricCardDelta
              label="Impressions"
              current={latest?.impressions ?? 0}
              delta={latest && first ? delta(latest.impressions, first.impressions) : "—"}
              icon={<Eye className="h-4 w-4 text-purple-500" />}
            />
            <MetricCardDelta
              label="Pin Clicks"
              current={latest?.pin_clicks ?? 0}
              delta={latest && first ? delta(latest.pin_clicks, first.pin_clicks) : "—"}
              icon={<MousePointerClick className="h-4 w-4 text-blue-500" />}
            />
            <MetricCardDelta
              label="Saves"
              current={latest?.saves ?? 0}
              delta={latest && first ? delta(latest.saves, first.saves) : "—"}
              icon={<Bookmark className="h-4 w-4 text-green-500" />}
            />
            <MetricCardDelta
              label="Outbound Clicks"
              current={latest?.outbound_clicks ?? 0}
              delta={latest && first ? delta(latest.outbound_clicks, first.outbound_clicks) : "—"}
              icon={<ExternalLink className="h-4 w-4 text-amber-500" />}
            />
          </div>
        </>
      )}

      {/* Performance chart */}
      {chartData.length > 1 && (
        <SectionCard title="Performance Over Time" defaultOpen>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" className="text-xs" tick={{ fontSize: 10 }} />
                <YAxis className="text-xs" />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }}
                />
                <Line type="monotone" dataKey="impressions" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Impressions" />
                <Line type="monotone" dataKey="clicks" stroke="#3b82f6" strokeWidth={2} dot={false} name="Pin Clicks" />
                <Line type="monotone" dataKey="saves" stroke="#10b981" strokeWidth={2} dot={false} name="Saves" />
                <Line type="monotone" dataKey="outbound" stroke="#f59e0b" strokeWidth={2} dot={false} name="Outbound Clicks" />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#8b5cf6]" /> Impressions</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#3b82f6]" /> Clicks</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#10b981]" /> Saves</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#f59e0b]" /> Outbound</span>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ── Content Ideas Tab ──

function ContentIdeasTab() {
  const { data, isLoading } = useContentIdeas();
  const queryClient = useQueryClient();
  const [createPinOpen, setCreatePinOpen] = useState(false);
  const [selectedIdea, setSelectedIdea] = useState<ContentIdea | null>(null);
  const [ideaTopic, setIdeaTopic] = useState("");

  const dismissMutation = useMutation({
    mutationFn: (id: number) =>
      fetchJson(`/api/pinterest/tracker/ideas/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "dismissed" }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pinterest-content-ideas"] }),
  });

  const markCreatedMutation = useMutation({
    mutationFn: ({ id, pin_id }: { id: number; pin_id?: string }) =>
      fetchJson(`/api/pinterest/tracker/ideas/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "created", pin_id }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pinterest-content-ideas"] }),
  });

  const generateIdeasMutation = useMutation({
    mutationFn: (body: { topic?: string; count?: number }) =>
      fetchJson<{ ok: boolean; added: number }>("/api/pinterest/generate-ideas", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["pinterest-content-ideas"] });
      showToast(`Generated ${data.added} new content ideas`, "success");
      setIdeaTopic("");
    },
    onError: (err: Error) => showToast(`Failed to generate ideas: ${err.message}`, "error"),
  });

  const handleCreatePin = (idea: ContentIdea) => {
    setSelectedIdea(idea);
    setCreatePinOpen(true);
  };

  const handleCreatePinStandalone = () => {
    setSelectedIdea(null);
    setCreatePinOpen(true);
  };

  const handlePinCreated = (pinId: string, ideaId?: number) => {
    if (ideaId) {
      markCreatedMutation.mutate({ id: ideaId, pin_id: pinId });
    }
  };

  const ideas = data?.ideas ?? [];
  const newIdeas = ideas.filter((i) => i.status === "new");
  const createdIdeas = ideas.filter((i) => i.status === "created");
  const dismissedIdeas = ideas.filter((i) => i.status === "dismissed");

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading content ideas...</p>;

  if (ideas.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Lightbulb className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <h2 className="text-lg font-semibold">No Content Ideas Yet</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Generate AI-powered content ideas for your Pinterest pins, or create a pin directly.
        </p>
        <div className="flex flex-col items-center gap-3 mt-4">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={ideaTopic}
              onChange={(e) => setIdeaTopic(e.target.value)}
              placeholder="Topic or niche (optional)..."
              className="w-56 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none transition"
            />
            <button
              onClick={() => generateIdeasMutation.mutate({ topic: ideaTopic || undefined, count: 5 })}
              disabled={generateIdeasMutation.isPending}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition disabled:opacity-50"
            >
              <Lightbulb className={`h-4 w-4 ${generateIdeasMutation.isPending ? "animate-pulse" : ""}`} />
              {generateIdeasMutation.isPending ? "Generating..." : "Generate Ideas"}
            </button>
          </div>
          <button
            onClick={handleCreatePinStandalone}
            className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted transition"
          >
            <Upload className="h-4 w-4" /> Create Pin
          </button>
        </div>
        <CreatePinModal
          open={createPinOpen}
          onOpenChange={setCreatePinOpen}
          idea={selectedIdea}
          onPinCreated={handlePinCreated}
        />
      </div>
    );
  }

  const difficultyColor = (d: string) => {
    if (d === "low") return "bg-green-500/10 text-green-600 dark:text-green-400";
    if (d === "medium") return "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400";
    return "bg-red-500/10 text-red-600 dark:text-red-400";
  };

  const renderIdea = (idea: ContentIdea) => {
    let keywords: string[] = [];
    try { keywords = JSON.parse(idea.target_keywords) as string[]; } catch { /* ignore */ }

    return (
      <div
        key={idea.id}
        className="rounded-xl border border-border bg-card p-4 transition hover:border-primary/30"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">{idea.suggested_title}</p>
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{idea.suggested_description}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${difficultyColor(idea.difficulty)}`}>
                {idea.difficulty}
              </span>
              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
                {idea.estimated_volume}
              </span>
              <span className="rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] font-semibold text-purple-600 dark:text-purple-400">
                {idea.topic}
              </span>
            </div>
            {keywords.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {keywords.map((kw, i) => (
                  <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {kw}
                  </span>
                ))}
              </div>
            )}
          </div>
          {idea.status === "new" && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleCreatePin(idea)}
                className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-green-600 transition"
                title="Create pin from this idea"
              >
                <Upload className="h-4 w-4" />
              </button>
              <button
                onClick={() => dismissMutation.mutate(idea.id)}
                className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-red-500 transition"
                title="Dismiss"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Summary + action buttons */}
      <div className="flex items-center justify-between">
        <div className="grid flex-1 grid-cols-3 gap-4">
          <MetricCard label="New Ideas" value={newIdeas.length} icon={<Lightbulb className="h-4 w-4 text-yellow-500" />} />
          <MetricCard label="Created" value={createdIdeas.length} icon={<Plus className="h-4 w-4 text-green-500" />} />
          <MetricCard label="Dismissed" value={dismissedIdeas.length} icon={<Trash2 className="h-4 w-4 text-muted-foreground" />} />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={ideaTopic}
          onChange={(e) => setIdeaTopic(e.target.value)}
          placeholder="Topic or niche (optional)..."
          className="w-48 rounded-lg border border-border bg-background px-3 py-1.5 text-xs focus:border-primary focus:outline-none transition"
        />
        <button
          onClick={() => generateIdeasMutation.mutate({ topic: ideaTopic || undefined, count: 5 })}
          disabled={generateIdeasMutation.isPending}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition disabled:opacity-50"
        >
          <Lightbulb className={`h-3.5 w-3.5 ${generateIdeasMutation.isPending ? "animate-pulse" : ""}`} />
          {generateIdeasMutation.isPending ? "Generating..." : "Generate Ideas"}
        </button>
        <button
          onClick={handleCreatePinStandalone}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition"
        >
          <Upload className="h-3.5 w-3.5" /> Create Pin
        </button>
      </div>

      {newIdeas.length > 0 && (
        <SectionCard title={`New Ideas (${newIdeas.length})`} defaultOpen>
          <div className="space-y-3">{newIdeas.map(renderIdea)}</div>
        </SectionCard>
      )}

      {createdIdeas.length > 0 && (
        <SectionCard title={`Created (${createdIdeas.length})`} defaultOpen={false}>
          <div className="space-y-3">{createdIdeas.map(renderIdea)}</div>
        </SectionCard>
      )}

      {dismissedIdeas.length > 0 && (
        <SectionCard title={`Dismissed (${dismissedIdeas.length})`} defaultOpen={false}>
          <div className="space-y-3">{dismissedIdeas.map(renderIdea)}</div>
        </SectionCard>
      )}

      <CreatePinModal
        open={createPinOpen}
        onOpenChange={setCreatePinOpen}
        idea={selectedIdea}
        onPinCreated={handlePinCreated}
      />
    </div>
  );
}

// ── Reports Tab ──

function ReportsTab() {
  const { data: reportsData, isLoading } = usePinterestReports();
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const reports = reportsData?.reports ?? [];
  const filtered = typeFilter === "all" ? reports : reports.filter((r) => r.type === typeFilter);
  const typeCounts = reports.reduce<Record<string, number>>((acc, r) => {
    acc[r.type] = (acc[r.type] ?? 0) + 1;
    return acc;
  }, {});

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading reports...</p>;

  if (reports.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <BarChart3 className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <h2 className="text-lg font-semibold">No Pinterest Reports Yet</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Use the Pinterest Marketer skill in Chat to generate trends, keyword metrics, analytics, and
          SEO analysis reports. They&apos;ll appear here automatically.
        </p>
        <Link
          href="/chat"
          className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition"
        >
          Go to Chat
        </Link>
      </div>
    );
  }

  if (selectedReport) {
    return <ReportDetail filename={selectedReport} onBack={() => setSelectedReport(null)} />;
  }

  return (
    <div className="space-y-4">
      {/* Type filter pills */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setTypeFilter("all")}
          className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
            typeFilter === "all" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          All ({reports.length})
        </button>
        {Object.entries(TYPE_LABELS).map(([key, label]) => {
          const count = typeCounts[key] ?? 0;
          if (count === 0) return null;
          return (
            <button
              key={key}
              onClick={() => setTypeFilter(key)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                typeFilter === key ? "bg-primary text-primary-foreground" : TYPE_COLORS[key] + " hover:opacity-80"
              }`}
            >
              {label} ({count})
            </button>
          );
        })}
      </div>

      <ReportList reports={filtered} onSelect={setSelectedReport} />
    </div>
  );
}

// ── Report List ──

function ReportList({ reports, onSelect }: { reports: ReportListItem[]; onSelect: (f: string) => void }) {
  const typeIcon = (type: string) => {
    switch (type) {
      case "trends": return <TrendingUp className="h-4 w-4" />;
      case "keyword-metrics": return <Search className="h-4 w-4" />;
      case "analytics": return <BarChart3 className="h-4 w-4" />;
      case "seo-analysis": return <FileText className="h-4 w-4" />;
      default: return <FileText className="h-4 w-4" />;
    }
  };

  return (
    <div className="space-y-2">
      {reports.map((r) => (
        <button
          key={r.filename}
          onClick={() => onSelect(r.filename)}
          className="flex w-full items-center gap-4 rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/30 hover:shadow-sm"
        >
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${TYPE_COLORS[r.type] ?? "bg-muted text-muted-foreground"}`}>
            {typeIcon(r.type)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{r.filename}</p>
            <div className="mt-0.5 flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${TYPE_COLORS[r.type] ?? "bg-muted text-muted-foreground"}`}>
                {TYPE_LABELS[r.type] ?? r.type}
              </span>
              <span className="text-[10px] text-muted-foreground">{formatDate(r.generated)}</span>
              {r.hasJson && (
                <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-semibold text-green-600 dark:text-green-400">
                  Charts
                </span>
              )}
            </div>
          </div>
          <ExternalLink className="h-4 w-4 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

// ── Report Detail ──

function ReportDetail({ filename, onBack }: { filename: string; onBack: () => void }) {
  const { data, isLoading } = usePinterestReport(filename);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading report...</p>;

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition">
        <ArrowLeft className="h-4 w-4" /> Back to reports
      </button>

      {data?.format === "json" && data.data ? (
        <JsonReportView data={data.data} />
      ) : data?.format === "markdown" && data.content ? (
        <MarkdownReportView content={data.content} />
      ) : (
        <p className="text-sm text-muted-foreground">Report data unavailable.</p>
      )}
    </div>
  );
}

// ── JSON Report Visualization ──

function JsonReportView({ data }: { data: Record<string, unknown> }) {
  const type = data.type as string;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${TYPE_COLORS[type] ?? "bg-muted text-muted-foreground"}`}>
          {TYPE_LABELS[type] ?? type}
        </span>
        {typeof data.generated === "string" && (
          <span className="text-xs text-muted-foreground">Generated {formatDate(data.generated)}</span>
        )}
        {typeof data.region === "string" && <span className="text-xs text-muted-foreground">Region: {data.region}</span>}
      </div>

      {type === "trends" && <TrendsChart data={data} />}
      {type === "keyword-metrics" && <KeywordMetricsChart data={data} />}
      {type === "analytics" && <AnalyticsChart data={data} />}
      {type === "seo-analysis" && <SeoScoreCard data={data} />}
    </div>
  );
}

// ── Trends Chart ──

function TrendsChart({ data }: { data: Record<string, unknown> }) {
  const rawData = data.data as Record<string, unknown> | undefined;
  const trends = (rawData?.trends ?? []) as Array<Record<string, unknown>>;

  if (trends.length === 0) return <p className="text-sm text-muted-foreground">No trend data available.</p>;

  const chartData = trends.slice(0, 20).map((t) => ({
    name: String(t.query ?? t.keyword ?? ""),
    mom: Number(t.pct_growth_mom ?? 0),
    wow: Number(t.pct_growth_wow ?? 0),
    yoy: Number(t.pct_growth_yoy ?? 0),
  }));

  const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v.toLocaleString()}%`;
  const pctColor = (v: number) => v > 0 ? "text-green-600 dark:text-green-400" : v < 0 ? "text-red-500" : "";

  return (
    <SectionCard title="Trending Keywords" defaultOpen>
      <div className="space-y-4">
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ left: 120, right: 20, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis type="number" unit="%" className="text-xs" />
              <YAxis type="category" dataKey="name" width={110} className="text-xs" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }}
                labelStyle={{ color: "hsl(var(--foreground))" }}
                formatter={(value) => [`${value}%`, "MoM Growth"]}
              />
              <Bar dataKey="mom" name="MoM Growth" radius={[0, 4, 4, 0]}>
                {chartData.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="py-2 text-left font-semibold text-muted-foreground">Keyword</th>
              <th className="py-2 text-right font-semibold text-muted-foreground">WoW</th>
              <th className="py-2 text-right font-semibold text-muted-foreground">MoM</th>
              <th className="py-2 text-right font-semibold text-muted-foreground">YoY</th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((row, i) => (
              <tr key={i} className="border-b border-border/50">
                <td className="py-1.5 font-medium">{row.name}</td>
                <td className={`py-1.5 text-right font-medium ${pctColor(row.wow)}`}>{fmtPct(row.wow)}</td>
                <td className={`py-1.5 text-right font-medium ${pctColor(row.mom)}`}>{fmtPct(row.mom)}</td>
                <td className={`py-1.5 text-right font-medium ${pctColor(row.yoy)}`}>{fmtPct(row.yoy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ── Keyword Metrics Chart ──

function parseSearchVolume(range: string): { midpoint: number; label: string } {
  if (!range || typeof range !== "string") return { midpoint: 0, label: "—" };
  const m = range.match(/([\d.]+)([KkMm]?)\s*[-–]\s*([\d.]+)([KkMm]?)/i);
  if (!m) {
    const single = parseFloat(range.replace(/[^\d.]/g, ""));
    return isNaN(single) ? { midpoint: 0, label: range } : { midpoint: single, label: range };
  }
  const mult = (u: string) => (u.toLowerCase() === "m" ? 1_000_000 : u.toLowerCase() === "k" ? 1_000 : 1);
  const lo = parseFloat(m[1]) * mult(m[2]);
  const hi = parseFloat(m[3]) * mult(m[4]);
  return { midpoint: (lo + hi) / 2, label: range };
}

function KeywordMetricsChart({ data }: { data: Record<string, unknown> }) {
  const rawData = data.data as Record<string, unknown> | undefined;
  const keywords = (rawData?.data ?? rawData?.keywords_metrics ?? rawData?.results ?? []) as Array<Record<string, unknown>>;

  if (keywords.length === 0) return <p className="text-sm text-muted-foreground">No keyword data available.</p>;

  const chartData = keywords.map((k) => {
    const metrics = k.metrics as Record<string, unknown> | undefined;
    const volRaw = String(metrics?.KEYWORD_QUERY_VOLUME ?? k.monthly_searches ?? k.search_volume ?? "0");
    const { midpoint, label } = parseSearchVolume(volRaw);
    return {
      name: String(k.keyword ?? k.query ?? ""),
      searches: midpoint,
      volumeLabel: label,
      competition: String(k.competition ?? k.overall_interest ?? "").toLowerCase(),
    };
  });

  const competitionColor = (c: string) => {
    if (c === "low" || c.includes("low")) return "text-green-600 dark:text-green-400";
    if (c === "medium" || c.includes("med")) return "text-yellow-600 dark:text-yellow-400";
    return "text-red-500";
  };

  return (
    <SectionCard title="Keyword Metrics" defaultOpen>
      <div className="space-y-4">
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ left: 10, right: 10, top: 5, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="name" angle={-30} textAnchor="end" interval={0} className="text-xs" tick={{ fontSize: 10 }} />
              <YAxis className="text-xs" />
              <Tooltip
                contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }}
              />
              <Bar dataKey="searches" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="py-2 text-left font-semibold text-muted-foreground">Keyword</th>
              <th className="py-2 text-right font-semibold text-muted-foreground">Monthly Searches</th>
              <th className="py-2 text-right font-semibold text-muted-foreground">Competition</th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((row, i) => (
              <tr key={i} className="border-b border-border/50">
                <td className="py-1.5 font-medium">{row.name}</td>
                <td className="py-1.5 text-right" title={`≈${row.searches.toLocaleString()}`}>{row.volumeLabel}</td>
                <td className={`py-1.5 text-right font-medium capitalize ${competitionColor(row.competition)}`}>{row.competition || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ── Analytics Chart ──

function AnalyticsChart({ data }: { data: Record<string, unknown> }) {
  const rawData = data.data as Record<string, unknown> | undefined;
  const allData = rawData?.all as Record<string, unknown> | undefined;
  const summaryMetrics = allData?.summary_metrics as Record<string, number> | undefined;
  const dailyRaw = (allData?.daily_metrics ?? rawData?.daily_metrics ?? []) as Array<Record<string, unknown>>;

  // Each entry has { date, data_status, metrics: { IMPRESSION, ... } }
  const activeDaily = dailyRaw.filter((d) => {
    const m = d.metrics as Record<string, number> | undefined;
    return m && Object.values(m).some((v) => typeof v === "number" && v > 0);
  });

  const topPins = (rawData?.top_pins ?? []) as Array<Record<string, unknown>>;

  const chartData = activeDaily.slice(0, 60).map((d) => {
    const m = (d.metrics ?? {}) as Record<string, number>;
    return {
      date: String(d.date ?? "").slice(5),
      impressions: Number(m.IMPRESSION ?? m.impressions ?? 0),
      clicks: Number(m.PIN_CLICK ?? m.pin_click ?? 0),
      saves: Number(m.SAVE ?? m.save ?? 0),
    };
  });

  // Use summary_metrics from API when available, otherwise sum chart data
  const totals = summaryMetrics
    ? {
        impressions: Number(summaryMetrics.IMPRESSION ?? 0),
        clicks: Number(summaryMetrics.PIN_CLICK ?? 0),
        saves: Number(summaryMetrics.SAVE ?? 0),
      }
    : chartData.reduce(
        (acc, d) => ({
          impressions: acc.impressions + d.impressions,
          clicks: acc.clicks + d.clicks,
          saves: acc.saves + d.saves,
        }),
        { impressions: 0, clicks: 0, saves: 0 }
      );

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <MetricCard label="Impressions" value={totals.impressions} />
        <MetricCard label="Pin Clicks" value={totals.clicks} />
        <MetricCard label="Saves" value={totals.saves} />
      </div>

      {chartData.length > 0 && (
        <SectionCard title="Daily Performance" defaultOpen>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" className="text-xs" tick={{ fontSize: 10 }} />
                <YAxis className="text-xs" />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }}
                />
                <Line type="monotone" dataKey="impressions" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="clicks" stroke="#3b82f6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="saves" stroke="#10b981" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#8b5cf6]" /> Impressions</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#3b82f6]" /> Clicks</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#10b981]" /> Saves</span>
          </div>
        </SectionCard>
      )}

      {topPins.length > 0 && (
        <SectionCard title="Top Pins" defaultOpen>
          <div className="space-y-2">
            {topPins.slice(0, 10).map((pin, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border border-border p-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{String(pin.pin_id ?? pin.id ?? `Pin ${i + 1}`)}</p>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  {pin.IMPRESSION != null && <span>{Number(pin.IMPRESSION).toLocaleString()} impressions</span>}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ── SEO Scorecard ──

function SeoScoreCard({ data }: { data: Record<string, unknown> }) {
  const results = (data.data ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="space-y-6">
      {results.map((pin, i) => {
        const score = Number(pin.pin_score ?? pin.score ?? 0);
        const scoreLabel = score >= 70 ? "Good" : score >= 40 ? "Needs Work" : "Poor";
        const scoreColor = score >= 70 ? "text-green-600 dark:text-green-400" : score >= 40 ? "text-yellow-600 dark:text-yellow-400" : "text-red-500";
        const barColor = score >= 70 ? "bg-green-500" : score >= 40 ? "bg-yellow-500" : "bg-red-500";

        // Derive breakdown from pin fields when explicit breakdown isn't available
        const breakdown = (pin.breakdown ?? {}) as Record<string, number>;
        const hasBreakdown = Object.keys(breakdown).length > 0;
        const breakdownData = hasBreakdown
          ? Object.entries(breakdown).map(([key, val]) => ({
              name: key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
              score: val,
              max: key === "annotations" ? 30 : key === "description" ? 25 : key === "title" ? 20 : key === "link" ? 10 : key === "alt_text" ? 10 : 5,
            }))
          : [];

        // Filter pin_metrics to only numeric values (exclude last_updated strings)
        const rawMetrics = pin.pin_metrics as Record<string, Record<string, unknown>> | undefined;
        const metrics = rawMetrics
          ? Object.fromEntries(
              Object.entries(rawMetrics).map(([period, values]) => [
                period,
                Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === "number")) as Record<string, number>,
              ])
            )
          : undefined;

        return (
          <SectionCard key={i} title={`Pin: ${pin.pin_id ?? `#${i + 1}`}`} defaultOpen>
            <div className="space-y-4">
              {/* Score header */}
              <div className="flex items-center gap-4">
                <div className="text-center">
                  <p className={`text-3xl font-bold ${scoreColor}`}>{score}</p>
                  <p className="text-xs text-muted-foreground">/100</p>
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-sm font-semibold ${scoreColor}`}>{scoreLabel}</span>
                    <span className="text-xs text-muted-foreground">
                      {pin.html_data_available ? "HTML Scraped" : pin.api_data_available ? "API Data" : "No Data"}
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-muted">
                    <div className={`h-2 rounded-full ${barColor} transition-all`} style={{ width: `${score}%` }} />
                  </div>
                </div>
              </div>

              {/* Score breakdown */}
              {hasBreakdown && breakdownData.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Score Breakdown</p>
                  {breakdownData.map((item) => (
                    <div key={item.name} className="flex items-center gap-3">
                      <span className="w-24 text-xs text-muted-foreground">{item.name}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-muted">
                        <div
                          className="h-1.5 rounded-full bg-primary transition-all"
                          style={{ width: `${(item.score / item.max) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs font-medium w-12 text-right">{item.score}/{item.max}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Performance metrics */}
              {metrics && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Performance</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {Object.entries(metrics).map(([period, values]) => (
                      <div key={period} className="rounded-lg border border-border p-3">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase">{period.replace(/_/g, " ")}</p>
                        {Object.entries(values).map(([metric, val]) => (
                          <div key={metric} className="mt-1 flex items-center justify-between">
                            <span className="text-[10px] text-muted-foreground capitalize">{metric.replace(/_/g, " ")}</span>
                            <span className="text-xs font-medium">{val.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recommendations */}
              {Array.isArray(pin.seo_recommendations ?? pin.recommendations) && ((pin.seo_recommendations ?? pin.recommendations) as string[]).length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Recommendations</p>
                  <ul className="space-y-1">
                    {((pin.seo_recommendations ?? pin.recommendations) as string[]).map((rec, j) => (
                      <li key={j} className="flex items-start gap-2 text-xs text-muted-foreground">
                        <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />
                        {rec}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </SectionCard>
        );
      })}
    </div>
  );
}

// ── Markdown Fallback ──

function MarkdownReportView({ content }: { content: string }) {
  return (
    <SectionCard title="Report" defaultOpen>
      <pre className="whitespace-pre-wrap text-xs text-muted-foreground font-mono leading-relaxed max-h-[600px] overflow-y-auto">
        {content}
      </pre>
    </SectionCard>
  );
}

// ── Metric Card ──

function MetricCard({ label, value, icon }: { label: string; value: number; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{label}</p>
        {icon}
      </div>
      <p className="text-2xl font-bold">{value.toLocaleString()}</p>
    </div>
  );
}

function MetricCardDelta({ label, current, delta, icon }: { label: string; current: number; delta: string; icon?: React.ReactNode }) {
  const isPositive = delta.startsWith("+");
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{label}</p>
        {icon}
      </div>
      <p className="text-2xl font-bold">{current.toLocaleString()}</p>
      {delta !== "—" && (
        <p className={`text-xs font-medium ${isPositive ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
          {delta} since first tracked
        </p>
      )}
    </div>
  );
}
