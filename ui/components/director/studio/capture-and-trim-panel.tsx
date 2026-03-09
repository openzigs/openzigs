"use client";

import { useState, useCallback } from "react";
import { fetchJson } from "@/lib/api";
import { ScreenRecorder } from "./screen-recorder";
import { VideoTrimmer } from "./video-trimmer";
import { Film, RefreshCw } from "lucide-react";
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
      // Fetch the newly created asset to show in trimmer
      try {
        const asset = await fetchJson<GalleryAsset>(`/api/queue/assets/${assetId}`);
        setSelectedAsset(asset);
        await loadRecentVideos();
      } catch {
        // The asset was registered — reload gallery list
        await loadRecentVideos();
      }
    },
    [loadRecentVideos],
  );

  const handleTrimComplete = useCallback(
    async (_newAssetId: string) => {
      await loadRecentVideos();
    },
    [loadRecentVideos],
  );

  return (
    <div className="h-full overflow-y-auto space-y-6 pb-8" data-testid="capture-and-trim-panel">
      {/* Screen Recorder */}
      <ScreenRecorder onRecordingComplete={handleRecordingComplete} />

      {/* Video Selector + Trimmer */}
      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Film className="h-5 w-5 text-zinc-400" />
            <h3 className="text-sm font-semibold text-zinc-200">Select Video to Trim</h3>
          </div>
          <button
            onClick={loadRecentVideos}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {recentVideos.length === 0 ? "Load Videos" : "Refresh"}
          </button>
        </div>

        {recentVideos.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto">
            {recentVideos.map((v) => (
              <button
                key={v.id}
                onClick={() => setSelectedAsset(v)}
                className={`text-left rounded p-2 text-xs transition ${
                  selectedAsset?.id === v.id
                    ? "bg-blue-600/20 border border-blue-500"
                    : "bg-zinc-800 hover:bg-zinc-750 border border-zinc-700"
                }`}
              >
                <p className="text-zinc-200 truncate font-medium">{v.filename}</p>
                {v.duration_seconds != null && (
                  <p className="text-zinc-500 text-[10px] mt-0.5">
                    {Math.floor(v.duration_seconds / 60)}:{String(Math.round(v.duration_seconds % 60)).padStart(2, "0")}
                  </p>
                )}
                {v.tags && v.tags.some((t: string) => t === "screen-recording") && (
                  <span className="inline-block mt-1 rounded bg-red-600/20 text-red-400 px-1 py-0.5 text-[9px]">
                    Recording
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {recentVideos.length === 0 && !loading && (
          <p className="text-xs text-zinc-600 text-center py-4">
            No videos yet. Record your screen above or click &quot;Load Videos&quot; to browse gallery.
          </p>
        )}
      </div>

      {/* Video Trimmer */}
      {selectedAsset && (
        <VideoTrimmer
          assetId={selectedAsset.id}
          videoUrl={`/api/queue/assets/${selectedAsset.id}/file`}
          duration={selectedAsset.duration_seconds ?? 60}
          onTrimComplete={handleTrimComplete}
        />
      )}
    </div>
  );
}
