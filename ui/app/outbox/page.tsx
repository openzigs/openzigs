"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Send,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  RotateCcw,
  Trash2,
  ExternalLink,
  Filter,
  Ban,
  AlertTriangle,
  Image as ImageIcon,
  Video,
  Music,
  FileText,
  Type,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────

type OutboxStatus = "pending" | "processing" | "published" | "failed" | "canceled";
type OutboxPlatform = "twitter" | "pinterest" | "linkedin" | "facebook" | "youtube" | "reddit" | "instagram";
type OutboxAssetType = "image" | "video" | "audio" | "document" | "text";

interface OutboxItem {
  id: string;
  assetId: string | null;
  assetUrl: string | null;
  assetType: OutboxAssetType;
  platform: OutboxPlatform;
  scheduledTime: string;
  agentContext: string;
  platformMetadata: Record<string, unknown>;
  status: OutboxStatus;
  error: string | null;
  publishedUrl: string | null;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface OutboxStats {
  pending: number;
  processing: number;
  published: number;
  failed: number;
  canceled: number;
  total: number;
}

// ── Constants ───────────────────────────────────────────────

const STATUS_CONFIG: Record<OutboxStatus, { label: string; color: string; icon: React.ElementType }> = {
  pending: { label: "Pending", color: "bg-amber-500/15 text-amber-400 border-amber-500/30", icon: Clock },
  processing: { label: "Processing", color: "bg-blue-500/15 text-blue-400 border-blue-500/30", icon: Loader2 },
  published: { label: "Published", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", icon: CheckCircle2 },
  failed: { label: "Failed", color: "bg-red-500/15 text-red-400 border-red-500/30", icon: XCircle },
  canceled: { label: "Canceled", color: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30", icon: Ban },
};

const PLATFORM_LABELS: Record<OutboxPlatform, string> = {
  twitter: "𝕏 / Twitter",
  pinterest: "Pinterest",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  youtube: "YouTube",
  reddit: "Reddit",
  instagram: "Instagram",
};

const ASSET_TYPE_ICONS: Record<OutboxAssetType, React.ElementType> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  document: FileText,
  text: Type,
};

const ALL_STATUSES: OutboxStatus[] = ["pending", "processing", "published", "failed", "canceled"];
const ALL_PLATFORMS: OutboxPlatform[] = ["twitter", "pinterest", "linkedin", "facebook", "youtube", "reddit", "instagram"];

// ── Helpers ─────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatScheduledTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── Page ────────────────────────────────────────────────────

export default function OutboxPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<OutboxStatus | "all">("all");
  const [platformFilter, setPlatformFilter] = useState<OutboxPlatform | "all">("all");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [expandedError, setExpandedError] = useState<string | null>(null);

  // ── Queries ───────────────────────────────────────────────

  const { data: statsData } = useQuery<OutboxStats>({
    queryKey: ["outbox-stats"],
    queryFn: () => fetchJson("/api/admin/outbox/stats"),
    refetchInterval: 10_000,
  });

  const { data: listData, isLoading } = useQuery<{ items: OutboxItem[]; total: number }>({
    queryKey: ["outbox-items", statusFilter, platformFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (platformFilter !== "all") params.set("platform", platformFilter);
      params.set("limit", "100");
      return fetchJson(`/api/admin/outbox?${params.toString()}`);
    },
    refetchInterval: 10_000,
  });

  // ── Mutations ─────────────────────────────────────────────

  const retryMutation = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/admin/outbox/${id}/retry`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outbox-items"] });
      queryClient.invalidateQueries({ queryKey: ["outbox-stats"] });
      showToast("Item queued for retry", "success");
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/admin/outbox/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outbox-items"] });
      queryClient.invalidateQueries({ queryKey: ["outbox-stats"] });
      showToast("Item canceled", "success");
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/admin/outbox/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outbox-items"] });
      queryClient.invalidateQueries({ queryKey: ["outbox-stats"] });
      showToast("Item deleted", "success");
      setConfirmDelete(null);
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const items = listData?.items ?? [];
  const stats = statsData ?? { pending: 0, processing: 0, published: 0, failed: 0, canceled: 0, total: 0 };

  return (
    <main className="px-6 py-10 lg:px-12">
      <ToastContainer />

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground">Publishing Outbox</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Queue content for autonomous publishing across platforms
        </p>
      </div>

      {/* ── Stats Cards ─────────────────────────────────────── */}
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {ALL_STATUSES.map((s) => {
          const cfg = STATUS_CONFIG[s];
          const Icon = cfg.icon;
          const count = stats[s];
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(statusFilter === s ? "all" : s)}
              className={`rounded-xl border p-4 text-left transition-colors ${
                statusFilter === s ? cfg.color + " ring-1 ring-current" : "border-border bg-card hover:bg-muted/40"
              }`}
            >
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Icon className={`h-3.5 w-3.5 ${s === "processing" ? "animate-spin" : ""}`} />
                {cfg.label}
              </div>
              <div className="mt-1 text-2xl font-bold text-card-foreground">{count}</div>
            </button>
          );
        })}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Total</div>
          <div className="mt-1 text-2xl font-bold text-card-foreground">{stats.total}</div>
        </div>
      </div>

      {/* ── Filters ─────────────────────────────────────────── */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value as OutboxPlatform | "all")}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-card-foreground"
        >
          <option value="all">All Platforms</option>
          {ALL_PLATFORMS.map((p) => (
            <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>
          ))}
        </select>
      </div>

      {/* ── Queue List ──────────────────────────────────────── */}
      <SectionCard title="Queue" className="overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            <Send className="mx-auto mb-3 h-8 w-8 opacity-40" />
            <p>No items in the outbox</p>
            <p className="mt-1 text-xs">Use the Gallery to queue content for publishing</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {items.map((item) => {
              const statusCfg = STATUS_CONFIG[item.status];
              const StatusIcon = statusCfg.icon;
              const AssetIcon = ASSET_TYPE_ICONS[item.assetType] ?? FileText;
              const isPending = item.status === "pending";
              const isFailed = item.status === "failed";

              return (
                <div key={item.id} className="flex items-start gap-4 py-4 first:pt-0 last:pb-0">
                  {/* Asset type icon */}
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                    <AssetIcon className="h-5 w-5 text-muted-foreground" />
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${statusCfg.color}`}>
                        <StatusIcon className={`h-3 w-3 ${item.status === "processing" ? "animate-spin" : ""}`} />
                        {statusCfg.label}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        {PLATFORM_LABELS[item.platform] ?? item.platform}
                      </span>
                      {item.retryCount > 0 && (
                        <span className="text-xs text-muted-foreground">
                          retry #{item.retryCount}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-card-foreground">{item.agentContext}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span title={new Date(item.scheduledTime).toLocaleString()}>
                        <Clock className="mr-0.5 inline h-3 w-3" />
                        {formatScheduledTime(item.scheduledTime)}
                      </span>
                      {item.publishedUrl && (
                        <a
                          href={item.publishedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-emerald-400 hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" />
                          View post
                        </a>
                      )}
                      <span>{relativeTime(item.updatedAt)}</span>
                    </div>

                    {/* Error display */}
                    {isFailed && item.error && (
                      <button
                        type="button"
                        onClick={() => setExpandedError(expandedError === item.id ? null : item.id)}
                        className="mt-2 flex items-center gap-1 text-xs text-red-400 hover:text-red-300"
                      >
                        <AlertTriangle className="h-3 w-3" />
                        {expandedError === item.id ? "Hide error" : "Show error"}
                      </button>
                    )}
                    {expandedError === item.id && item.error && (
                      <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-red-950/30 p-2 text-xs text-red-300">
                        {item.error}
                      </pre>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex shrink-0 items-center gap-1">
                    {isFailed && (
                      <button
                        type="button"
                        title="Retry"
                        onClick={() => retryMutation.mutate(item.id)}
                        disabled={retryMutation.isPending}
                        className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-amber-400"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    )}
                    {(isPending || isFailed) && (
                      <button
                        type="button"
                        title="Cancel"
                        onClick={() => cancelMutation.mutate(item.id)}
                        disabled={cancelMutation.isPending}
                        className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-orange-400"
                      >
                        <Ban className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      title="Delete"
                      onClick={() => setConfirmDelete(item.id)}
                      className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      {/* ── Delete confirmation ─────────────────────────────── */}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete outbox item"
          message="This will permanently remove the item from the publishing queue."
          confirmLabel="Delete"
          onConfirm={() => deleteMutation.mutate(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </main>
  );
}
