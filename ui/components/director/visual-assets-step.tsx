/**
 * VisualAssetsStep — Director Mode Step 5
 *
 * Lets users upload images and short video clips that will be overlaid on the
 * final render.  After uploading, users can describe each asset ("company logo",
 * "product shot for the intro") and request AI-assisted placement.
 *
 * API surface:
 *   POST /api/admin/director/files/upload-asset?kind=image|video
 *   POST /api/admin/director/assets/placement  (LLM placement)
 */

"use client";

import { useRef, useState, useCallback } from "react";
import { Upload, X, Image, Film, Sparkles, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import type { VisualAsset } from "./types";
import { cn } from "@/lib/utils";

interface VisualAssetsStepProps {
  assets: VisualAsset[];
  onChange: (assets: VisualAsset[]) => void;
}

const MAX_ASSETS = 20;
const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm";

// ── Single asset card ────────────────────────────────────────────────────────

function AssetCard({
  asset,
  index: _index,
  onDescriptionChange,
  onRemove,
}: {
  asset: VisualAsset;
  index: number;
  onDescriptionChange: (desc: string) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isVideo = asset.type === "video";

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-start gap-3 p-3">
        {/* Thumbnail */}
        <div className="shrink-0 w-14 h-14 rounded-lg overflow-hidden border border-border bg-muted flex items-center justify-center">
          {asset.previewUrl && !isVideo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={asset.previewUrl} alt={asset.name} className="w-full h-full object-cover" />
          ) : (
            <div className="flex flex-col items-center gap-1">
              {isVideo ? (
                <Film className="h-5 w-5 text-muted-foreground/60" />
              ) : (
                <Image className="h-5 w-5 text-muted-foreground/60" />
              )}
              <span className="text-[10px] text-muted-foreground/60 uppercase">
                {asset.type}
              </span>
            </div>
          )}
        </div>

        {/* Name + description */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate" title={asset.name}>
            {asset.name}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {(asset.size / 1024 / 1024).toFixed(1)} MB ·{" "}
            <span className={`capitalize ${isVideo ? "text-primary/80" : "text-emerald-500/80"}`}>
              {asset.type}
            </span>
          </p>
          <input
            type="text"
            placeholder="Describe this asset (e.g. 'company logo for intro')"
            value={asset.description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* Controls */}
        <div className="shrink-0 flex flex-col items-end gap-1">
          <button
            onClick={onRemove}
            title="Remove asset"
            className="rounded-md p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/8 transition-all"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          {asset.placement && (
            <button
              onClick={() => setExpanded((v) => !v)}
              title="Show AI placement"
              className="rounded-md p-1 text-muted-foreground hover:text-foreground transition-all"
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* AI Placement detail */}
      {expanded && asset.placement && (
        <div className="border-t border-border/60 bg-muted/20 px-3 py-2 text-xs space-y-1">
          <p className="font-medium text-muted-foreground uppercase tracking-wider text-[10px]">
            AI Suggested Placement
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
            <span>Start</span>
            <span className="font-mono text-foreground">{asset.placement.startTimeSec}s</span>
            <span>End</span>
            <span className="font-mono text-foreground">{asset.placement.endTimeSec}s</span>
            <span>Position</span>
            <span className="font-mono text-foreground">{asset.placement.position}</span>
            <span>Scale</span>
            <span className="font-mono text-foreground">{asset.placement.scale * 100}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Step ────────────────────────────────────────────────────────────────

export function VisualAssetsStep({ assets, onChange }: VisualAssetsStepProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [placingAI, setPlacingAI] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const uploadAsset = useCallback(async (file: File): Promise<VisualAsset | null> => {
    const kind = file.type.startsWith("video/") ? "video" : "image";
    try {
      const result = await fetchJson<{ filePath: string; fileName: string; size: number; mimeType: string }>(
        `/api/admin/director/files/upload-asset?kind=${kind}`,
        {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name),
            "x-file-type": file.type || "application/octet-stream",
          },
          body: file,
        },
      );
      const previewUrl = kind === "image" ? URL.createObjectURL(file) : undefined;
      return {
        name: file.name,
        path: result.filePath,
        description: "",
        type: kind,
        size: result.size,
        previewUrl,
        placement: null,
      };
    } catch (err) {
      showToast(`Upload failed: ${String(err)}`, "error");
      return null;
    }
  }, []);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (assets.length + arr.length > MAX_ASSETS) {
        showToast(`Maximum ${MAX_ASSETS} visual assets allowed.`, "error");
        return;
      }
      setUploading(true);
      const uploaded: VisualAsset[] = [];
      for (const f of arr) {
        const asset = await uploadAsset(f);
        if (asset) uploaded.push(asset);
      }
      onChange([...assets, ...uploaded]);
      setUploading(false);
      if (uploaded.length) showToast(`${uploaded.length} asset${uploaded.length > 1 ? "s" : ""} uploaded.`, "success");
    },
    [assets, onChange, uploadAsset],
  );

  const removeAsset = useCallback(
    (index: number) => {
      const updated = [...assets];
      const removed = updated.splice(index, 1)[0];
      if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      onChange(updated);
    },
    [assets, onChange],
  );

  const updateDescription = useCallback(
    (index: number, description: string) => {
      const updated = [...assets];
      updated[index] = { ...updated[index], description };
      onChange(updated);
    },
    [assets, onChange],
  );

  const requestAIPlacement = async () => {
    const missingDesc = assets.some((a) => !a.description.trim());
    if (missingDesc) {
      showToast("Please add a description to all assets before requesting AI placement.", "error");
      return;
    }
    setPlacingAI(true);
    try {
      const result = await fetchJson<{
        placements: Array<{
          id: string;
          startTimeSec: number;
          endTimeSec: number;
          position: string;
          scale: number;
        }>;
      }>("/api/admin/director/assets/placement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: assets.map((a) => a.description).join(". "),
          assets: assets.map((a, i) => ({ id: String(i), path: a.path, description: a.description })),
          videoDurationSec: 60, // placeholder; refined when render is triggered
        }),
      });

      const updated = assets.map((a, i) => {
        const p = result.placements.find((pl) => pl.id === String(i));
        return p ? { ...a, placement: { startTimeSec: p.startTimeSec, endTimeSec: p.endTimeSec, position: p.position, scale: p.scale } } : a;
      });
      onChange(updated);
      showToast("AI placement generated — review each asset card.", "success");
    } catch (err) {
      showToast(String(err), "error");
    } finally {
      setPlacingAI(false);
    }
  };

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);
  const onDragLeave = useCallback(() => setIsDragging(false), []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Visual Assets</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Upload images or video clips to overlay on your video. Add a description for each, then use AI
          to suggest timestamps — or skip this step for a music-only video.
        </p>
      </div>

      {/* Upload zone */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => !uploading && fileInputRef.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 transition-all",
          isDragging
            ? "border-primary bg-primary/6"
            : "border-border hover:border-primary/40 hover:bg-primary/4",
          uploading && "pointer-events-none opacity-50",
          assets.length >= MAX_ASSETS && "pointer-events-none opacity-40",
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {uploading ? (
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        ) : (
          <Upload className="h-8 w-8 text-muted-foreground/60" />
        )}
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">
            {uploading ? "Uploading…" : assets.length >= MAX_ASSETS ? `Maximum ${MAX_ASSETS} assets reached` : "Upload images or video clips"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Drag & drop or click · JPEG, PNG, WebP, GIF, MP4, MOV, WebM
          </p>
        </div>
      </div>

      {/* Asset list */}
      {assets.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {assets.length} asset{assets.length !== 1 ? "s" : ""}
            </p>
            <button
              onClick={() => void requestAIPlacement()}
              disabled={placingAI || assets.some((a) => !a.description.trim())}
              className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-all hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                assets.some((a) => !a.description.trim())
                  ? "Add a description to every asset first"
                  : "Ask the AI to suggest where each asset should appear"
              }
            >
              {placingAI ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {placingAI ? "Placing…" : "AI Placement"}
            </button>
          </div>

          <div className="space-y-2">
            {assets.map((a, i) => (
              <AssetCard
                key={`${a.path}-${i}`}
                asset={a}
                index={i}
                onDescriptionChange={(desc) => updateDescription(i, desc)}
                onRemove={() => removeAsset(i)}
              />
            ))}
          </div>
        </div>
      )}

      {assets.length === 0 && (
        <div className="rounded-xl border border-dashed border-border/40 px-6 py-5 text-center">
          <div className="flex justify-center gap-3 mb-2">
            <Image className="h-5 w-5 text-muted-foreground/40" />
            <Film className="h-5 w-5 text-muted-foreground/40" />
          </div>
          <p className="text-sm text-muted-foreground">No visual assets yet.</p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            This step is optional — skip it for a clean music-only video.
          </p>
        </div>
      )}
    </div>
  );
}
