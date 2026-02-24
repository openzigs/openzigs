"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [previewAsset, setPreviewAsset] = useState<GalleryAsset | null>(null);
  const [showStudio, setShowStudio] = useState(false);

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
  });

  const statsQuery = useQuery({
    queryKey: ["queue-stats"],
    queryFn: () => fetchJson<QueueStats>("/api/queue/jobs/stats"),
    refetchInterval: 5000,
  });

  const assets = assetsQuery.data?.assets ?? [];
  const stats = statsQuery.data;

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
    window.open(fileUrl(asset.filename), "_blank");
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

      {/* Gallery Grid */}
      <SectionCard title={`Assets (${assets.length})`}>
        {assetsQuery.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : assets.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No assets yet. Use the Studio to create images and videos, or wait for queued jobs to complete.
          </p>
        ) : (
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
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-card">
      {/* Thumbnail */}
      <button onClick={onPreview} className="block w-full cursor-pointer">
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
      </button>

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
      </div>
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
};

const MODE_INFO: Record<StudioMode, { label: string; desc: string; icon: React.ReactNode }> = {
  txt2img: { label: "Text → Image", desc: "Generate an image from a text prompt", icon: <ImageIcon className="h-4 w-4" /> },
  img2img: { label: "Image → Image", desc: "Transform an existing image with a text prompt", icon: <ImageIcon className="h-4 w-4" /> },
  txt2video: { label: "Text → Video", desc: "4-second cinematic B-roll from text", icon: <Video className="h-4 w-4" /> },
  img2video: { label: "Image → Video", desc: "Animate an image into 4-second video", icon: <Video className="h-4 w-4" /> },
};

function GalleryStudio({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<StudioFormState>(DEFAULT_FORM);
  const [submitting, setSubmitting] = useState(false);

  const update = <K extends keyof StudioFormState>(key: K, value: StudioFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const isVideo = form.mode === "txt2video" || form.mode === "img2video";
  const needsImage = form.mode === "img2img" || form.mode === "img2video";

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

      await fetchJson("/api/queue/jobs", {
        method: "POST",
        body: JSON.stringify({ type: form.mode, payload }),
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
            : `Image: ${form.width}x${form.height}, ${form.steps} steps`}
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
