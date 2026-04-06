"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { fetchJson, buildMediaUrl } from "@/lib/api";
import { ScreenRecorder } from "./screen-recorder";
import { VideoTrimmer } from "./video-trimmer";
import {
  Film,
  RefreshCw,
  Upload,
  X,
  Play,
  LayoutGrid,
  List as ListIcon,
} from "lucide-react";
import { showToast } from "@/components/toast";

interface GalleryAsset {
  id: string;
  filename: string;
  type: string;
  file_path: string;
  duration_seconds: number | null;
  tags: string[] | null;
}

export function CaptureAndTrimPanel() {
  const [selectedAsset, setSelectedAsset] = useState<GalleryAsset | null>(null);
  const [recentVideos, setRecentVideos] = useState<GalleryAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [libraryView, setLibraryView] = useState<"grid" | "list">("grid");
  const [pendingAsset, setPendingAsset] = useState<GalleryAsset | null>(null);
  const [hasUnsavedWork, setHasUnsavedWork] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-load videos on mount
  useEffect(() => {
    loadRecentVideos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const handleRecordingComplete = useCallback(
    async (assetId: string, _filename: string) => {
      try {
        const asset = await fetchJson<GalleryAsset>(
          `/api/queue/assets/${assetId}`,
        );
        selectVideo(asset);
        await loadRecentVideos();
      } catch {
        await loadRecentVideos();
      }
    },
    [loadRecentVideos],
  );

  // ── Video Selection with Unsaved Work Check ──
  const selectVideo = useCallback(
    (asset: GalleryAsset) => {
      if (selectedAsset && selectedAsset.id !== asset.id && hasUnsavedWork) {
        setPendingAsset(asset);
        return;
      }
      setSelectedAsset(asset);
      setHasUnsavedWork(false);
    },
    [selectedAsset, hasUnsavedWork],
  );

  const confirmSwitchVideo = useCallback(() => {
    if (pendingAsset) {
      setSelectedAsset(pendingAsset);
      setHasUnsavedWork(false);
      setPendingAsset(null);
    }
  }, [pendingAsset]);

  const cancelSwitchVideo = useCallback(() => {
    setPendingAsset(null);
  }, []);

  const handleTrimComplete = useCallback(
    async (_newAssetId: string) => {
      await loadRecentVideos();
    },
    [loadRecentVideos],
  );

  // ── Drag-and-Drop Upload ──
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

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
        selectVideo(asset);
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
    [loadRecentVideos],
  );

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
      e.target.value = ""; // reset for re-selecting same file
    },
    [uploadVideoFile],
  );

  const fmtDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = String(Math.round(secs % 60)).padStart(2, "0");
    return `${m}:${s}`;
  };

  return (
    <div
      className="h-full overflow-y-auto pb-8"
      data-testid="capture-and-trim-panel"
    >
      {/* Two-column layout: left = recorder + browser, right = trimmer */}
      <div className="flex gap-6 min-h-0">
        {/* Left Column: Recorder + Video Browser */}
        <div className="w-1/2 space-y-4 min-w-0">
          {/* Screen Recorder */}
          <ScreenRecorder onRecordingComplete={handleRecordingComplete} />

          {/* Video Browser */}
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
                {/* View toggle */}
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

            {/* Drag-and-Drop Upload Zone */}
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed p-4 cursor-pointer transition ${
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
                {uploading
                  ? "Uploading…"
                  : "Drop video here or click to upload"}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                onChange={handleFileSelect}
                className="hidden"
              />
            </div>

            {/* Video Grid / List */}
            {recentVideos.length > 0 && libraryView === "grid" && (
              <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                {recentVideos.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => selectVideo(v)}
                    className={`group relative text-left rounded overflow-hidden transition ${
                      selectedAsset?.id === v.id
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
              <div className="max-h-64 overflow-y-auto space-y-1">
                {recentVideos.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => selectVideo(v)}
                    className={`w-full flex items-center gap-3 rounded px-2 py-1.5 text-left transition ${
                      selectedAsset?.id === v.id
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
                      <p className="text-xs text-zinc-300 truncate">
                        {v.filename}
                      </p>
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
                No videos yet. Record your screen above or drag a video file
                here.
              </p>
            )}
          </div>
        </div>

        {/* Right Column: Video Trimmer */}
        <div className="w-1/2 min-w-0">
          {/* Unsaved work confirmation dialog */}
          {pendingAsset && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
              <div className="rounded-lg border border-zinc-600 bg-zinc-900 p-5 max-w-sm shadow-xl space-y-3">
                <h4 className="text-sm font-semibold text-zinc-200">
                  Switch Video?
                </h4>
                <p className="text-xs text-zinc-400">
                  You have unsaved cuts or edits on the current video. Switching
                  will discard them.
                </p>
                <p className="text-xs text-zinc-500 truncate">
                  Loading:{" "}
                  <span className="text-zinc-300">{pendingAsset.filename}</span>
                </p>
                <div className="flex gap-2 justify-end pt-1">
                  <button
                    onClick={cancelSwitchVideo}
                    className="rounded bg-zinc-700 hover:bg-zinc-600 px-3 py-1.5 text-xs text-zinc-300 transition"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmSwitchVideo}
                    className="rounded bg-red-600 hover:bg-red-700 px-3 py-1.5 text-xs text-white transition"
                  >
                    Discard &amp; Switch
                  </button>
                </div>
              </div>
            </div>
          )}

          {selectedAsset ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-zinc-400 truncate flex-1">
                  Editing:{" "}
                  <span className="text-zinc-200">
                    {selectedAsset.filename}
                  </span>
                </p>
                <button
                  onClick={() => {
                    setSelectedAsset(null);
                    setHasUnsavedWork(false);
                  }}
                  className="text-zinc-500 hover:text-zinc-300 transition"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <VideoTrimmer
                assetId={selectedAsset.id}
                videoUrl={`/api/queue/assets/${selectedAsset.id}/file`}
                duration={selectedAsset.duration_seconds ?? 60}
                onTrimComplete={handleTrimComplete}
                onDirtyChange={setHasUnsavedWork}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full rounded-lg border border-zinc-700 bg-zinc-900/50">
              <div className="text-center px-8 py-16">
                <Film className="h-10 w-10 text-zinc-700 mx-auto mb-3" />
                <p className="text-sm text-zinc-500">
                  Select a video to start editing
                </p>
                <p className="text-xs text-zinc-600 mt-1">
                  Record your screen, upload a file, or pick from your library
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
