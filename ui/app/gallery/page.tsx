"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import {
  Image as ImageIcon,
  Video,
  Music,
  Trash2,
  Tag,
  Download,
  Filter,
  Plus,
  Loader2,
  Eye,
  X,
  Cpu,
  Power,
  ArrowRightLeft,
  LayoutGrid,
  List,
  Skull,
  ChevronDown,
  ChevronRight,
  Clock,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────

interface GalleryAsset {
  id: string;
  type: "image" | "video" | "audio";
  filename: string;
  file_path: string;
  mime_type: string;
  file_size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  prompt: string | null;
  model: string | null;
  generation_params: Record<string, unknown> | null;
  source: "generated" | "uploaded" | "director";
  job_id: string | null;
  project_id: string | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
}

interface QueueStats {
  pending: number;
  dispatched: number;
  processing: number;
  complete: number;
  failed: number;
}

interface NodeStatusInfo {
  node: "mac-mini" | "m2-pro";
  reachable: boolean;
  is_busy: boolean;
  loaded_model: string | null;
  url: string;
}

interface MediaJob {
  id: string;
  type: string;
  status: "pending" | "dispatched" | "processing" | "complete" | "failed";
  targetNode: string;
  requiredModel: string;
  payload: { prompt?: string; [key: string]: unknown };
  error: string | null;
  createdAt: string;
  dispatchedAt: string | null;
}

// ── Helpers ─────────────────────────────────────────────────

function fileUrl(filename: string): string {
  const base = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "";
  return `${base}/api/queue/assets/file/${encodeURIComponent(filename)}`;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function typeIcon(type: string) {
  switch (type) {
    case "image": return <ImageIcon className="h-4 w-4" />;
    case "video": return <Video className="h-4 w-4" />;
    case "audio": return <Music className="h-4 w-4" />;
    default: return <ImageIcon className="h-4 w-4" />;
  }
}

function sourceBadge(source: string) {
  const map: Record<string, { label: string; classes: string }> = {
    generated: { label: "Generated", classes: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
    uploaded: { label: "Uploaded", classes: "bg-sky-500/10 text-sky-600 dark:text-sky-400" },
    director: { label: "Director", classes: "bg-purple-500/10 text-purple-600 dark:text-purple-400" },
  };
  const badge = map[source] ?? map.generated;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.classes}`}>
      {badge.label}
    </span>
  );
}

// ── Gallery Page ────────────────────────────────────────────

export default function GalleryPage() {
  const queryClient = useQueryClient();
  const { socket } = useSocket();
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [previewAsset, setPreviewAsset] = useState<GalleryAsset | null>(null);
  const [showStudio, setShowStudio] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  // ── Queries ─────────────────────────────────────────

  const assetsQuery = useQuery({
    queryKey: ["gallery-assets", typeFilter, sourceFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (sourceFilter) params.set("source", sourceFilter);
      params.set("limit", "100");
      return fetchJson<{ assets: GalleryAsset[]; total: number }>(`/api/queue/assets?${params.toString()}`);
    },
    refetchInterval: 5000,
  });

  const statsQuery = useQuery({
    queryKey: ["queue-stats"],
    queryFn: () => fetchJson<QueueStats>("/api/queue/jobs/stats"),
    refetchInterval: 5000,
  });

  const nodesQuery = useQuery({
    queryKey: ["queue-nodes"],
    queryFn: () => fetchJson<{ nodes: NodeStatusInfo[] }>("/api/queue/nodes"),
    refetchInterval: 5000,
  });

  // Real-time updates via Socket.IO
  useEffect(() => {
    if (!socket) return;
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ["gallery-assets"] });
      void queryClient.invalidateQueries({ queryKey: ["queue-stats"] });
      void queryClient.invalidateQueries({ queryKey: ["queue-nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["queue-active-jobs"] });
    };
    socket.on("queue:job:complete", invalidate);
    socket.on("queue:job:failed", invalidate);
    socket.on("queue:job:dispatched", invalidate);
    return () => {
      socket.off("queue:job:complete", invalidate);
      socket.off("queue:job:failed", invalidate);
      socket.off("queue:job:dispatched", invalidate);
    };
  }, [socket, queryClient]);

  const switchMutation = useMutation({
    mutationFn: (body: { targetNode: string; model?: string }) =>
      fetchJson("/api/queue/nodes/switch", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["queue-nodes"] });
      showToast("Model switch initiated", "success");
    },
    onError: (err) => showToast(`Switch failed: ${err.message}`, "error"),
  });

  const unloadMutation = useMutation({
    mutationFn: (node: string) =>
      fetchJson(`/api/queue/nodes/${node}/unload`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["queue-nodes"] });
      showToast("Model unloaded", "success");
    },
    onError: (err) => showToast(`Unload failed: ${err.message}`, "error"),
  });

  const activeJobsQuery = useQuery({
    queryKey: ["queue-active-jobs"],
    queryFn: async () => {
      const [pending, dispatched] = await Promise.all([
        fetchJson<{ jobs: MediaJob[] }>("/api/queue/jobs?status=pending&limit=50"),
        fetchJson<{ jobs: MediaJob[] }>("/api/queue/jobs?status=dispatched&limit=50"),
      ]);
      return [...pending.jobs, ...dispatched.jobs];
    },
    refetchInterval: 5000,
  });

  const cancelJobMutation = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/queue/jobs/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["queue-active-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["queue-stats"] });
      showToast("Job cancelled", "success");
    },
    onError: (err) => showToast(`Cancel failed: ${err.message}`, "error"),
  });

  const killJobMutation = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/queue/jobs/${id}/kill`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["queue-active-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["queue-stats"] });
      queryClient.invalidateQueries({ queryKey: ["queue-nodes"] });
      showToast("Job killed", "success");
    },
    onError: (err) => showToast(`Kill failed: ${err.message}`, "error"),
  });

  const assets = assetsQuery.data?.assets ?? [];
  const stats = statsQuery.data;
  const nodes = nodesQuery.data?.nodes ?? [];

  // ── Mutations ───────────────────────────────────────

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/queue/assets/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gallery-assets"] });
      showToast("Asset deleted", "success");
    },
    onError: (err) => showToast(`Delete failed: ${err.message}`, "error"),
  });

  const tagMutation = useMutation({
    mutationFn: ({ id, tags }: { id: string; tags: string[] }) =>
      fetchJson(`/api/queue/assets/${id}/tags`, { method: "PATCH", body: JSON.stringify({ tags }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gallery-assets"] });
      showToast("Tags updated", "success");
    },
    onError: (err) => showToast(`Failed: ${err.message}`, "error"),
  });

  const handleDelete = (asset: GalleryAsset) => {
    if (!confirm(`Delete "${asset.filename}"? This cannot be undone.`)) return;
    deleteMutation.mutate(asset.id);
  };

  const handleAddTag = (asset: GalleryAsset) => {
    const tag = prompt("Enter tag:");
    if (!tag?.trim()) return;
    const current = asset.tags ?? [];
    if (current.includes(tag.trim())) return;
    tagMutation.mutate({ id: asset.id, tags: [...current, tag.trim()] });
  };

  const handleDownload = (asset: GalleryAsset) => {
    const a = document.createElement("a");
    a.href = `${fileUrl(asset.filename)}?download=1`;
    a.download = asset.filename;
    a.click();
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-12">
      <header className="mb-8">
        <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">OpenZigs</p>
        <h1 className="mt-1 text-3xl font-semibold text-foreground">Asset Gallery</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse, manage, and create media assets — images, videos, and audio from the generation queue.
        </p>
      </header>

      {/* Queue Stats Bar */}
      {stats && (
        <div className="mb-6 flex gap-3">
          {(["pending", "dispatched", "processing", "complete", "failed"] as const).map((key) => (
            <div
              key={key}
              className="flex-1 rounded-xl border border-border bg-card px-4 py-3 text-center"
            >
              <p className="text-2xl font-bold text-foreground">{stats[key]}</p>
              <p className="text-[11px] font-medium capitalize text-muted-foreground">{key}</p>
            </div>
          ))}
        </div>
      )}

      {/* Active Jobs Panel */}
      {(activeJobsQuery.data?.length ?? 0) > 0 && (
        <QueueJobsPanel
          jobs={activeJobsQuery.data ?? []}
          onCancel={(id) => cancelJobMutation.mutate(id)}
          onKill={(id) => killJobMutation.mutate(id)}
          isCancelling={cancelJobMutation.isPending}
          isKilling={killJobMutation.isPending}
        />
      )}

      {/* Node Status — VRAM-aware model switching */}
      {nodes.length > 0 && (
        <div className="mb-6 rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">Worker Nodes</h3>
            <span className="text-[10px] text-muted-foreground">(shared M2 memory — only one model at a time)</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {nodes.map((node) => (
              <div
                key={node.node}
                className={`rounded-lg border px-4 py-3 ${
                  node.loaded_model
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : node.reachable
                    ? "border-border bg-card"
                    : "border-red-500/30 bg-red-500/5"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {node.node === "mac-mini" ? "Image Gen (FluxQ)" : "Video Gen (LTX-2)"}
                    </p>
                    <p className="text-[11px] text-muted-foreground">{node.url}</p>
                  </div>
                  <div className={`h-2.5 w-2.5 rounded-full ${
                    !node.reachable ? "bg-red-500" : node.is_busy ? "bg-amber-500" : node.loaded_model ? "bg-emerald-500" : "bg-yellow-500"
                  }`} />
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">
                    {!node.reachable ? (
                      <span className="text-red-500">Offline</span>
                    ) : node.is_busy ? (
                      <span className="flex items-center gap-1 text-amber-500">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {node.node === "mac-mini" ? "Generating..." : "Busy"}
                      </span>
                    ) : node.loaded_model ? (
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">{node.loaded_model}</span>
                    ) : (
                      <span>No model loaded</span>
                    )}
                  </div>
                  <div className="flex gap-1.5">
                    {node.reachable && node.loaded_model && (
                      <button
                        onClick={() => unloadMutation.mutate(node.node)}
                        disabled={unloadMutation.isPending || node.is_busy}
                        className="rounded-lg border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                        title="Unload model to free VRAM"
                      >
                        <Power className="inline h-3 w-3 mr-0.5" />
                        Unload
                      </button>
                    )}
                    {node.reachable && !node.loaded_model && (
                      <button
                        onClick={() => switchMutation.mutate({
                          targetNode: node.node,
                          model: node.node === "mac-mini" ? "flux-schnell" : undefined,
                        })}
                        disabled={switchMutation.isPending}
                        className="rounded-lg border border-primary/30 bg-primary/5 px-2 py-1 text-[10px] font-semibold text-primary hover:bg-primary/10 disabled:opacity-50"
                        title={`Switch to ${node.node === "mac-mini" ? "image" : "video"} generation`}
                      >
                        <ArrowRightLeft className="inline h-3 w-3 mr-0.5" />
                        Activate
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="mb-6 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
          >
            <option value="">All Types</option>
            <option value="image">Images</option>
            <option value="video">Videos</option>
            <option value="audio">Audio</option>
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
          >
            <option value="">All Sources</option>
            <option value="generated">Generated</option>
            <option value="uploaded">Uploaded</option>
            <option value="director">Director</option>
          </select>
        </div>
        <div className="flex-1" />
        {/* View toggle */}
        <div className="flex rounded-lg border border-border overflow-hidden">
          <button
            onClick={() => setViewMode("grid")}
            className={`px-3 py-2 ${viewMode === "grid" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"}`}
            title="Grid view"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={`px-3 py-2 border-l border-border ${viewMode === "list" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"}`}
            title="List view"
          >
            <List className="h-4 w-4" />
          </button>
        </div>
        <button
          onClick={() => setShowStudio(!showStudio)}
          className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground flex items-center gap-1.5"
        >
          <Plus className="h-4 w-4" />
          {showStudio ? "Close Studio" : "Create Asset"}
        </button>
      </div>

      {/* Gallery Studio (Create Asset) */}
      {showStudio && (
        <div className="mb-6">
          <GalleryStudio
            onClose={() => setShowStudio(false)}
            onCreated={() => {
              queryClient.invalidateQueries({ queryKey: ["gallery-assets"] });
              queryClient.invalidateQueries({ queryKey: ["queue-stats"] });
            }}
          />
        </div>
      )}

      {/* Gallery Grid / List */}
      <SectionCard title={`Assets (${assets.length})`}>
        {assetsQuery.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : assets.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No assets yet. Use the Studio to create images and videos, or wait for queued jobs to complete.
          </p>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {assets.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                onPreview={() => setPreviewAsset(asset)}
                onDelete={() => handleDelete(asset)}
                onTag={() => handleAddTag(asset)}
                onDownload={() => handleDownload(asset)}
              />
            ))}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {assets.map((asset) => (
              <AssetListRow
                key={asset.id}
                asset={asset}
                onPreview={() => setPreviewAsset(asset)}
                onDelete={() => handleDelete(asset)}
                onTag={() => handleAddTag(asset)}
                onDownload={() => handleDownload(asset)}
              />
            ))}
          </div>
        )}
      </SectionCard>

      {/* Preview Lightbox */}
      {previewAsset && (
        <PreviewLightbox asset={previewAsset} onClose={() => setPreviewAsset(null)} />
      )}

      <ToastContainer />
    </main>
  );
}

// ── Asset Card ──────────────────────────────────────────────

function AssetCard({
  asset,
  onPreview,
  onDelete,
  onTag,
  onDownload,
}: {
  asset: GalleryAsset;
  onPreview: () => void;
  onDelete: () => void;
  onTag: () => void;
  onDownload: () => void;
}) {
  const url = fileUrl(asset.filename);

  return (
    <div onClick={onPreview} className="group relative cursor-pointer overflow-hidden rounded-2xl border border-border bg-card">
      {/* Thumbnail */}
      <div className="block w-full">
        {asset.type === "image" ? (
          <img src={url} alt={asset.prompt ?? asset.filename} className="aspect-square w-full object-cover" loading="lazy" />
        ) : asset.type === "video" ? (
          <div className="relative aspect-square w-full bg-muted">
            <video src={url} className="h-full w-full object-cover" muted preload="metadata" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="rounded-full bg-black/50 p-3">
                <Video className="h-6 w-6 text-white" />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex aspect-square items-center justify-center bg-muted">
            <Music className="h-12 w-12 text-muted-foreground/50" />
          </div>
        )}
      </div>

      {/* Overlay actions */}
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
        <button onClick={onPreview} className="rounded-lg bg-black/60 p-1.5 text-white hover:bg-black/80" title="Preview">
          <Eye className="h-3.5 w-3.5" />
        </button>
        <button onClick={onDownload} className="rounded-lg bg-black/60 p-1.5 text-white hover:bg-black/80" title="Download">
          <Download className="h-3.5 w-3.5" />
        </button>
        <button onClick={onTag} className="rounded-lg bg-black/60 p-1.5 text-white hover:bg-black/80" title="Add Tag">
          <Tag className="h-3.5 w-3.5" />
        </button>
        <button onClick={onDelete} className="rounded-lg bg-red-600/80 p-1.5 text-white hover:bg-red-700" title="Delete">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Info */}
      <div className="p-3">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">{typeIcon(asset.type)}</span>
          {sourceBadge(asset.source)}
          {asset.model && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {asset.model}
            </span>
          )}
        </div>
        {asset.prompt && (
          <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{asset.prompt}</p>
        )}
        {asset.tags && asset.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {asset.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                {tag}
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{formatBytes(asset.file_size_bytes)}</span>
          {asset.duration_seconds && <span>{asset.duration_seconds.toFixed(1)}s</span>}
          <span>{new Date(asset.created_at).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
}

// ── Asset List Row ──────────────────────────────────────────

function AssetListRow({
  asset,
  onPreview,
  onDelete,
  onTag,
  onDownload,
}: {
  asset: GalleryAsset;
  onPreview: () => void;
  onDelete: () => void;
  onTag: () => void;
  onDownload: () => void;
}) {
  const url = fileUrl(asset.filename);

  return (
    <div className="flex items-center gap-4 py-3 px-1 hover:bg-muted/40 rounded-lg transition">
      {/* Thumbnail */}
      <button onClick={onPreview} className="flex-shrink-0 h-14 w-14 rounded-lg overflow-hidden border border-border bg-muted">
        {asset.type === "image" ? (
          <img src={url} alt={asset.prompt ?? asset.filename} className="h-full w-full object-cover" loading="lazy" />
        ) : asset.type === "video" ? (
          <div className="relative h-full w-full bg-muted flex items-center justify-center">
            <Video className="h-5 w-5 text-muted-foreground" />
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Music className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
      </button>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground truncate">{asset.filename}</span>
          {sourceBadge(asset.source)}
          {asset.model && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {asset.model}
            </span>
          )}
        </div>
        {asset.prompt && (
          <p className="mt-0.5 text-xs text-muted-foreground truncate">{asset.prompt}</p>
        )}
        <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
          {formatBytes(asset.file_size_bytes)}
          {asset.width && asset.height && <span>{asset.width}×{asset.height}</span>}
          {asset.duration_seconds && <span>{asset.duration_seconds.toFixed(1)}s</span>}
          <span>{new Date(asset.created_at).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex-shrink-0 flex items-center gap-1.5">
        <button onClick={onPreview} className="rounded-lg border border-border p-1.5 text-muted-foreground hover:bg-muted" title="Preview">
          <Eye className="h-3.5 w-3.5" />
        </button>
        <button onClick={onDownload} className="rounded-lg border border-border p-1.5 text-muted-foreground hover:bg-muted" title="Download">
          <Download className="h-3.5 w-3.5" />
        </button>
        <button onClick={onTag} className="rounded-lg border border-border p-1.5 text-muted-foreground hover:bg-muted" title="Add tag">
          <Tag className="h-3.5 w-3.5" />
        </button>
        <button onClick={onDelete} className="rounded-lg border border-red-500/30 p-1.5 text-red-500 hover:bg-red-500/10" title="Delete">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Preview Lightbox ────────────────────────────────────────

function PreviewLightbox({ asset, onClose }: { asset: GalleryAsset; onClose: () => void }) {
  const url = fileUrl(asset.filename);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative max-h-[90vh] max-w-[90vw] rounded-2xl bg-card p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute -right-3 -top-3 rounded-full bg-card p-2 shadow-lg border border-border hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>

        {asset.type === "image" ? (
          <img src={url} alt={asset.prompt ?? ""} className="max-h-[80vh] rounded-lg object-contain" />
        ) : asset.type === "video" ? (
          <video src={url} controls autoPlay className="max-h-[80vh] rounded-lg" />
        ) : (
          <div className="flex flex-col items-center gap-4 py-8 px-12">
            <Music className="h-16 w-16 text-muted-foreground" />
            <audio src={url} controls autoPlay />
          </div>
        )}

        <div className="mt-3 max-w-lg">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{asset.filename}</p>
              {asset.prompt && <p className="mt-1 text-xs text-muted-foreground">{asset.prompt}</p>}
              <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                {sourceBadge(asset.source)}
                <span>{formatBytes(asset.file_size_bytes)}</span>
                {asset.width && asset.height && <span>{asset.width}x{asset.height}</span>}
                {asset.duration_seconds && <span>{asset.duration_seconds.toFixed(1)}s</span>}
                {asset.model && <span>{asset.model}</span>}
              </div>
            </div>
            <a
              href={`${fileUrl(asset.filename)}?download=1`}
              download={asset.filename}
              className="flex-shrink-0 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
              onClick={(e) => e.stopPropagation()}
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Queue Jobs Panel ────────────────────────────────────────

function formatAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function QueueJobsPanel({
  jobs,
  onCancel,
  onKill,
  isCancelling,
  isKilling,
}: {
  jobs: MediaJob[];
  onCancel: (id: string) => void;
  onKill: (id: string) => void;
  isCancelling: boolean;
  isKilling: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const pending = jobs.filter((j) => j.status === "pending");
  const active = jobs.filter((j) => j.status === "dispatched" || j.status === "processing");

  return (
    <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5">
      <button
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <Clock className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-semibold text-foreground">
          Queue ({jobs.length} active)
        </span>
        {pending.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
            {pending.length} pending
          </span>
        )}
        {active.length > 0 && (
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
            {active.length} running
          </span>
        )}
        <div className="ml-auto text-muted-foreground">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4">
          {/* Dispatched / Processing */}
          {active.length > 0 && (
            <div className="mb-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                Running
              </p>
              <div className="space-y-2">
                {active.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center gap-3 rounded-lg border border-amber-500/20 bg-card px-3 py-2.5"
                  >
                    <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0 text-amber-500" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">{job.type}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {job.targetNode}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{job.requiredModel}</span>
                      </div>
                      {job.payload?.prompt && (
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {job.payload.prompt as string}
                        </p>
                      )}
                    </div>
                    <div className="flex-shrink-0 text-right">
                      <p className="text-[10px] text-muted-foreground">
                        {job.dispatchedAt ? formatAge(job.dispatchedAt) : formatAge(job.createdAt)}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        if (!confirm("Kill this job and unload the worker node?")) return;
                        onKill(job.id);
                      }}
                      disabled={isKilling}
                      className="flex-shrink-0 rounded-lg border border-red-500/30 p-1.5 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                      title="Kill job"
                    >
                      <Skull className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pending */}
          {pending.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Pending
              </p>
              <div className="space-y-2">
                {pending.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
                  >
                    <div className="h-3.5 w-3.5 flex-shrink-0 rounded-full border-2 border-muted-foreground/40" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">{job.type}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {job.targetNode}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{job.requiredModel}</span>
                      </div>
                      {job.payload?.prompt && (
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {job.payload.prompt as string}
                        </p>
                      )}
                    </div>
                    <div className="flex-shrink-0 text-right">
                      <p className="text-[10px] text-muted-foreground">{formatAge(job.createdAt)}</p>
                    </div>
                    <button
                      onClick={() => onCancel(job.id)}
                      disabled={isCancelling}
                      className="flex-shrink-0 rounded-lg border border-red-500/30 p-1.5 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                      title="Cancel job"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Gallery Studio (Sub-Issue #329) ─────────────────────────

type StudioMode = "txt2img" | "img2img" | "txt2video" | "img2video";

interface StudioFormState {
  mode: StudioMode;
  prompt: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  strength: number;
  num_frames: number;
  fps: number;
  seed: string;
  initImage: File | null;
  initImagePreview: string;
  imageProvider: "local" | "cloud" | "auto";
  imageModel: "flux-schnell" | "flux-dev" | "flux-kontext" | "sdxl-turbo";
}

const DEFAULT_FORM: StudioFormState = {
  mode: "txt2img",
  prompt: "",
  width: 1024,
  height: 1024,
  steps: 4,
  guidance: 3.5,
  strength: 0.75,
  num_frames: 97,
  fps: 24,
  seed: "",
  initImage: null,
  initImagePreview: "",
  imageProvider: "local",
  imageModel: "flux-schnell",
};

const MODE_INFO: Record<StudioMode, { label: string; desc: string; icon: React.ReactNode }> = {
  txt2img: { label: "Text → Image", desc: "Generate an image from a text prompt", icon: <ImageIcon className="h-4 w-4" /> },
  img2img: { label: "Image → Image", desc: "Transform an existing image with a text prompt", icon: <ImageIcon className="h-4 w-4" /> },
  txt2video: { label: "Text → Video", desc: "4-second cinematic B-roll from text", icon: <Video className="h-4 w-4" /> },
  img2video: { label: "Image → Video", desc: "Animate an image into 4-second video", icon: <Video className="h-4 w-4" /> },
};

function GalleryStudio({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const imageGenConfigQuery = useQuery({
    queryKey: ["admin-image-gen-config"],
    queryFn: () => fetchJson<{ mode: "local" | "network"; networkNodeUrl: string; hasToken: boolean }>("/api/admin/image-gen/config"),
  });

  const imageGenMode = imageGenConfigQuery.data?.mode ?? "local";
  // When admin switches mode, reset provider default and clear turbo if needed
  const [form, setForm] = useState<StudioFormState>(() => ({ ...DEFAULT_FORM, imageProvider: "local" }));
  const [submitting, setSubmitting] = useState(false);

  // If admin mode is network/cloud, SDXL Turbo is unavailable — auto-reset model
  const turboAvailable = imageGenMode === "local" && form.imageProvider === "local";
  if (form.imageModel === "sdxl-turbo" && !turboAvailable) {
    setForm((prev) => ({ ...prev, imageModel: "flux-schnell" }));
  }
  // img2img always uses flux-kontext
  if (form.mode === "img2img" && form.imageModel !== "flux-kontext") {
    setForm((prev) => ({ ...prev, imageModel: "flux-kontext", steps: 20, guidance: 2.5 }));
  }
  // switching away from img2img resets to flux-schnell defaults
  if (form.mode !== "img2img" && form.imageModel === "flux-kontext") {
    setForm((prev) => ({ ...prev, imageModel: "flux-schnell", steps: 4, guidance: 3.5 }));
  }

  const update = <K extends keyof StudioFormState>(key: K, value: StudioFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const isVideo = form.mode === "txt2video" || form.mode === "img2video";
  const needsImage = form.mode === "img2img" || form.mode === "img2video";

  const fluxQLabel = imageGenMode === "network" ? "FluxQ (Network — via Admin)" : "FluxQ (Local)";

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    update("initImage", file);
    const reader = new FileReader();
    reader.onload = () => update("initImagePreview", reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleSubmit = async () => {
    if (!form.prompt.trim()) {
      showToast("Prompt is required", "error");
      return;
    }
    if (needsImage && !form.initImage) {
      showToast("Source image is required for this mode", "error");
      return;
    }

    setSubmitting(true);
    try {
      // Cloud/auto image generation — direct route, bypasses queue
      if (!isVideo && (form.imageProvider === "cloud" || form.imageProvider === "auto")) {
        await fetchJson("/api/queue/image/generate", {
          method: "POST",
          body: JSON.stringify({
            prompt: form.prompt.trim(),
            provider: form.imageProvider,
            imageModel: form.imageModel,
            width: form.width,
            height: form.height,
            steps: form.steps,
            seed: form.seed ? parseInt(form.seed, 10) : undefined,
          }),
        });
        showToast("Image generated via cloud", "success");
        onCreated();
        setForm(DEFAULT_FORM);
        return;
      }

      let init_image: string | undefined;
      if (form.initImage) {
        const buf = await form.initImage.arrayBuffer();
        init_image = btoa(
          new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ""),
        );
      }

      const payload: Record<string, unknown> = {
        prompt: form.prompt.trim(),
        width: isVideo ? 768 : form.width,
        height: isVideo ? 512 : form.height,
      };

      if (!isVideo) {
        payload.steps = form.steps;
        payload.guidance_scale = form.guidance;
      }

      if (form.mode === "img2img") {
        payload.strength = form.strength;
        payload.init_image = init_image;
      }

      if (isVideo) {
        payload.num_frames = Math.min(form.num_frames, 97);
        payload.fps = form.fps;
      }

      if (form.mode === "img2video") {
        payload.init_image = init_image;
      }

      if (form.seed) {
        payload.seed = parseInt(form.seed, 10);
      }

      // For local image gen, pass the selected model
      const model = !isVideo ? form.imageModel : undefined;

      await fetchJson("/api/queue/jobs", {
        method: "POST",
        body: JSON.stringify({ type: form.mode, payload, model }),
      });

      showToast(`Job submitted: ${MODE_INFO[form.mode].label}`, "success");
      onCreated();
      setForm(DEFAULT_FORM);
    } catch (err) {
      showToast(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-primary/20 bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-foreground">Gallery Studio</h3>
        <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-muted">
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* Mode Selector */}
      <div className="mb-4 grid grid-cols-4 gap-2">
        {(Object.entries(MODE_INFO) as [StudioMode, typeof MODE_INFO["txt2img"]][]).map(([mode, info]) => (
          <button
            key={mode}
            onClick={() => update("mode", mode)}
            className={`rounded-xl border px-3 py-3 text-left transition ${
              form.mode === mode
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/50"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className={form.mode === mode ? "text-primary" : "text-muted-foreground"}>{info.icon}</span>
              <span className="text-xs font-semibold text-foreground">{info.label}</span>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">{info.desc}</p>
            {(mode === "txt2video" || mode === "img2video") && (
              <span className="mt-1 inline-block rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-600 dark:text-amber-400">
                4s cinematic B-roll
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Prompt */}
      <div className="mb-4">
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Prompt</label>
        <textarea
          value={form.prompt}
          onChange={(e) => update("prompt", e.target.value)}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
          rows={3}
          placeholder={isVideo ? "A cinematic aerial shot of a coastal city at golden hour..." : "A photorealistic portrait of a futuristic city skyline at dusk..."}
        />
      </div>

      {/* Image Upload (for img2img / img2video) */}
      {needsImage && (
        <div className="mb-4">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Source Image</label>
          <div className="flex items-center gap-4">
            <input type="file" accept="image/*" onChange={handleImageSelect} className="text-sm text-foreground" />
            {form.initImagePreview && (
              <img src={form.initImagePreview} alt="Preview" className="h-20 w-20 rounded-lg object-cover border border-border" />
            )}
          </div>
        </div>
      )}

      {/* Image provider + model controls */}
      {!isVideo && (
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
              Provider
              {imageGenConfigQuery.isLoading && <span className="text-[10px] text-muted-foreground/60">(loading...)</span>}
              {imageGenMode === "network" && form.imageProvider === "local" && (
                <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-sky-600 dark:text-sky-400">network node</span>
              )}
            </label>
            <select
              value={form.imageProvider}
              onChange={(e) => update("imageProvider", e.target.value as "local" | "cloud" | "auto")}
              className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
            >
              <option value="local">{fluxQLabel}</option>
              <option value="cloud">Cloud (Imagen 3)</option>
              <option value="auto">Auto (cloud → FluxQ)</option>
            </select>
          </div>
          {form.imageProvider === "local" && (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Model</label>
              <select
                value={form.imageModel}
                onChange={(e) => {
                  const m = e.target.value as StudioFormState["imageModel"];
                  const defaults = m === "flux-dev"
                    ? { steps: 25, guidance: 3.5 }
                    : m === "flux-schnell"
                    ? { steps: 4, guidance: 3.5 }
                    : {};
                  setForm((prev) => ({ ...prev, imageModel: m, ...defaults }));
                }}
                className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
                disabled={form.mode === "img2img"}
              >
                {form.mode === "img2img" ? (
                  <option value="flux-kontext">Flux Kontext</option>
                ) : (
                  <>
                    <option value="flux-schnell">Flux Schnell (fast, 4 steps)</option>
                    <option value="flux-dev">Flux Dev (quality, 25 steps)</option>
                    {turboAvailable && <option value="sdxl-turbo">SDXL Turbo (local only)</option>}
                  </>
                )}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Image-specific controls */}
      {!isVideo && (
        <div className="mb-4 grid grid-cols-4 gap-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Width</label>
            <input
              type="number"
              value={form.width}
              onChange={(e) => update("width", parseInt(e.target.value) || 1024)}
              className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Height</label>
            <input
              type="number"
              value={form.height}
              onChange={(e) => update("height", parseInt(e.target.value) || 1024)}
              className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Steps</label>
            <input
              type="number"
              value={form.steps}
              onChange={(e) => update("steps", parseInt(e.target.value) || 4)}
              min={1}
              max={50}
              className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Guidance</label>
            <input
              type="number"
              value={form.guidance}
              onChange={(e) => update("guidance", parseFloat(e.target.value) || 3.5)}
              min={0}
              max={20}
              step={0.5}
              className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
            />
          </div>
        </div>
      )}

      {/* Strength slider (img2img only) */}
      {form.mode === "img2img" && (
        <div className="mb-4">
          <label className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span>Strength</span>
            <span className="font-mono">{form.strength.toFixed(2)}</span>
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={form.strength}
            onChange={(e) => update("strength", parseFloat(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Subtle</span>
            <span>Complete transform</span>
          </div>
        </div>
      )}

      {/* Video-specific controls */}
      {isVideo && (
        <div className="mb-4 grid grid-cols-3 gap-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Frames (max 97)</label>
            <input
              type="number"
              value={form.num_frames}
              onChange={(e) => update("num_frames", Math.min(parseInt(e.target.value) || 97, 97))}
              min={1}
              max={97}
              className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">FPS</label>
            <input
              type="number"
              value={form.fps}
              onChange={(e) => update("fps", parseInt(e.target.value) || 24)}
              min={1}
              max={60}
              className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Duration</label>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {(form.num_frames / form.fps).toFixed(1)}s
            </p>
          </div>
        </div>
      )}

      {/* Seed */}
      <div className="mb-4">
        <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Seed (optional)</label>
        <input
          type="text"
          value={form.seed}
          onChange={(e) => update("seed", e.target.value)}
          className="w-full max-w-xs rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
          placeholder="Random"
        />
      </div>

      {/* Submit */}
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          {isVideo
            ? `Video: ${form.num_frames} frames at ${form.fps}fps = ${(form.num_frames / form.fps).toFixed(1)}s (768x512)`
            : form.imageProvider === "cloud"
            ? `Cloud (Imagen 3) · ${form.width}x${form.height}`
            : form.imageProvider === "auto"
            ? `Auto (cloud→local) · ${form.width}x${form.height}`
            : `${form.imageModel} · ${form.width}x${form.height}, ${form.steps} steps`}
        </p>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="rounded-xl bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50 flex items-center gap-2"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Submit to Queue
        </button>
      </div>
    </div>
  );
}
