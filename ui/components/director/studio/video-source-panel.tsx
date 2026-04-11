"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { fetchJson, buildMediaUrl } from "@/lib/api";
import { ScreenRecorder } from "./screen-recorder";
import {
  Film,
  RefreshCw,
  Upload,
  Play,
  LayoutGrid,
  List as ListIcon,
  Youtube,
  Loader2,
  X,
} from "lucide-react";
import { showToast } from "@/components/toast";

export interface GalleryAsset {
  id: string;
  filename: string;
  type: string;
  file_path: string;
  duration_seconds: number | null;
  tags: string[] | null;
}

interface VideoSourcePanelProps {
  selectedAssetId?: string;
  onSelectAsset: (asset: GalleryAsset) => void;
  compact?: boolean;
}

function fmtDuration(secs: number) {
  const m = Math.floor(secs / 60);
  const s = String(Math.round(secs % 60)).padStart(2, "0");
  return `${m}:${s}`;
}

export function VideoSourcePanel({
  selectedAssetId,
  onSelectAsset,
  compact,
}: VideoSourcePanelProps) {
  const [recentVideos, setRecentVideos] = useState<GalleryAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [libraryView, setLibraryView] = useState<"grid" | "list">(
    compact ? "list" : "grid",
  );
  const [ytUrl, setYtUrl] = useState("");
  const [ytImporting, setYtImporting] = useState(false);
  const [showYtInput, setShowYtInput] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadRecentVideos = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchJson<{ count: number; assets: GalleryAsset[] }>(
        "/api/queue/assets?type=video&limit=20",
      );
      setRecentVideos(data.assets ?? []);
    } catch {
      showToast("Failed to load gallery videos", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecentVideos();
  }, [loadRecentVideos]);

  const handleRecordingComplete = useCallback(
    async (assetId: string, _filename: string) => {
      try {
        const asset = await fetchJson<GalleryAsset>(
          `/api/queue/assets/${assetId}`,
        );
        onSelectAsset(asset);
        await loadRecentVideos();
      } catch {
        await loadRecentVideos();
      }
    },
    [loadRecentVideos, onSelectAsset],
  );

  const uploadVideoFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("video/")) {
        showToast("Only video files are accepted", "error");
        return;
      }
      setUploading(true);
      try {
        const token = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? ""}/api/studio/upload-recording`,
          {
            method: "POST",
            headers: {
              "Content-Type": file.type,
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: file,
          },
        );
        if (!response.ok) {
          const data = await response
            .json()
            .catch(() => ({ error: "Upload failed" }));
          throw new Error(
            (data as { error?: string }).error ??
              `Upload failed: ${response.status}`,
          );
        }
        const result = (await response.json()) as {
          assetId: string;
          filename: string;
        };
        showToast(`Uploaded: ${result.filename}`, "success");
        const asset = await fetchJson<GalleryAsset>(
          `/api/queue/assets/${result.assetId}`,
        );
        onSelectAsset(asset);
        await loadRecentVideos();
      } catch (err) {
        showToast(
          `Upload failed: ${err instanceof Error ? err.message : "Unknown error"}`,
          "error",
        );
      } finally {
        setUploading(false);
      }
    },
    [loadRecentVideos, onSelectAsset],
  );

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const file = e.dataTransfer.files?.[0];
      if (file) uploadVideoFile(file);
    },
    [uploadVideoFile],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) uploadVideoFile(file);
      e.target.value = "";
    },
    [uploadVideoFile],
  );

  const handleYouTubeImport = useCallback(async () => {
    const url = ytUrl.trim();
    if (!url) return;
    try {
      new URL(url);
    } catch {
      showToast("Please enter a valid URL", "error");
      return;
    }
    setYtImporting(true);
    try {
      const res = await fetchJson<{ assetId: string; asset: GalleryAsset }>(
        "/api/studio/import-youtube",
        { method: "POST", body: JSON.stringify({ url }) },
      );
      showToast(
        `Downloaded: ${res.asset?.filename ?? "video"}`,
        "success",
      );
      setYtUrl("");
      setShowYtInput(false);
      if (res.asset) {
        onSelectAsset(res.asset);
      }
      await loadRecentVideos();
    } catch (err) {
      showToast(
        `Import failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      setYtImporting(false);
    }
  }, [ytUrl, loadRecentVideos, onSelectAsset]);

  const maxH = compact ? "max-h-40" : "max-h-64";

  return (
    <div className="space-y-4" data-testid="video-source-panel">
      <ScreenRecorder onRecordingComplete={handleRecordingComplete} />

      {/* YouTube import */}
      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Youtube className="h-4 w-4 text-red-500" />
            <span className="text-sm font-semibold text-zinc-200">Import from YouTube</span>
          </div>
          <button
            onClick={() => setShowYtInput((v) => !v)}
            className="text-xs text-zinc-400 hover:text-zinc-200 transition"
          >
            {showYtInput ? <X className="h-3.5 w-3.5" /> : "Add URL"}
          </button>
        </div>

        {showYtInput && (
          <div className="flex gap-2">
            <input
              type="url"
              value={ytUrl}
              onChange={(e) => setYtUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleYouTubeImport()}
              placeholder="https://youtube.com/watch?v=..."
              className="flex-1 min-w-0 rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              disabled={ytImporting}
            />
            <button
              onClick={handleYouTubeImport}
              disabled={ytImporting || !ytUrl.trim()}
              className="flex items-center gap-1.5 rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 transition"
            >
              {ytImporting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Youtube className="h-3 w-3" />
              )}
              {ytImporting ? "Downloading…" : "Import"}
            </button>
          </div>
        )}

        {ytImporting && (
          <p className="text-xs text-zinc-400">
            Downloading video… this may take a minute for long videos.
          </p>
        )}
      </div>

      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Film className="h-5 w-5 text-zinc-400" />
            <h3 className="text-sm font-semibold text-zinc-200">
              Video Library
            </h3>
            <span className="text-[10px] text-zinc-600">
              ({recentVideos.length})
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded bg-zinc-800 overflow-hidden">
              <button
                onClick={() => setLibraryView("grid")}
                className={`p-1.5 transition ${libraryView === "grid" ? "bg-zinc-600 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}
                title="Grid view"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setLibraryView("list")}
                className={`p-1.5 transition ${libraryView === "list" ? "bg-zinc-600 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}
                title="List view"
              >
                <ListIcon className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              onClick={loadRecentVideos}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>
        </div>

        <div
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed p-3 cursor-pointer transition ${
            dragActive
              ? "border-blue-500 bg-blue-600/10"
              : "border-zinc-700 bg-zinc-800/50 hover:border-zinc-500"
          }`}
        >
          {uploading ? (
            <div className="h-5 w-5 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <Upload className="h-5 w-5 text-zinc-500" />
          )}
          <p className="text-xs text-zinc-500">
            {uploading ? "Uploading…" : "Drop video here or click to upload"}
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>

        {recentVideos.length > 0 && libraryView === "grid" && (
          <div className={`grid grid-cols-2 gap-2 ${maxH} overflow-y-auto`}>
            {recentVideos.map((v) => (
              <button
                key={v.id}
                onClick={() => onSelectAsset(v)}
                className={`group relative text-left rounded overflow-hidden transition ${
                  selectedAssetId === v.id
                    ? "ring-2 ring-blue-500"
                    : "ring-1 ring-zinc-700 hover:ring-zinc-500"
                }`}
              >
                <div className="relative aspect-video bg-zinc-800">
                  <video
                    src={buildMediaUrl(`/api/queue/assets/${v.id}/file`)}
                    className="w-full h-full object-cover"
                    preload="metadata"
                    muted
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition">
                    <Play className="h-6 w-6 text-white/80" />
                  </div>
                  {v.duration_seconds != null && (
                    <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-white font-mono">
                      {fmtDuration(v.duration_seconds)}
                    </span>
                  )}
                  {v.tags?.includes("screen-recording") && (
                    <span className="absolute top-1 left-1 rounded bg-red-600/80 px-1 py-0.5 text-[9px] text-white">
                      REC
                    </span>
                  )}
                </div>
                <div className="px-2 py-1.5 bg-zinc-900">
                  <p className="text-[11px] text-zinc-300 truncate">
                    {v.filename}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        {recentVideos.length > 0 && libraryView === "list" && (
          <div className={`${maxH} overflow-y-auto space-y-1`}>
            {recentVideos.map((v) => (
              <button
                key={v.id}
                onClick={() => onSelectAsset(v)}
                className={`w-full flex items-center gap-3 rounded px-2 py-1.5 text-left transition ${
                  selectedAssetId === v.id
                    ? "bg-blue-600/20 ring-1 ring-blue-500"
                    : "bg-zinc-800 hover:bg-zinc-750 ring-1 ring-zinc-700 hover:ring-zinc-500"
                }`}
              >
                <div className="relative w-16 h-9 rounded overflow-hidden shrink-0 bg-zinc-700">
                  <video
                    src={buildMediaUrl(`/api/queue/assets/${v.id}/file`)}
                    className="w-full h-full object-cover"
                    preload="metadata"
                    muted
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-zinc-300 truncate">{v.filename}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {v.duration_seconds != null && (
                      <span className="text-[10px] text-zinc-500 font-mono">
                        {fmtDuration(v.duration_seconds)}
                      </span>
                    )}
                    {v.tags?.includes("screen-recording") && (
                      <span className="rounded bg-red-600/60 px-1 py-0.5 text-[8px] text-white">
                        REC
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {recentVideos.length === 0 && !loading && (
          <p className="text-xs text-zinc-600 text-center py-4">
            No videos yet. Record your screen above or drag a video file here.
          </p>
        )}
      </div>
    </div>
  );
}
