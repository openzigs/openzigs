"use client";

import { useState, useCallback } from "react";
import { VideoSourcePanel, type GalleryAsset } from "./video-source-panel";
import { VideoTrimmer } from "./video-trimmer";
import { Film, X } from "lucide-react";

export function CaptureAndTrimPanel() {
  const [selectedAsset, setSelectedAsset] = useState<GalleryAsset | null>(null);
  const [pendingAsset, setPendingAsset] = useState<GalleryAsset | null>(null);
  const [hasUnsavedWork, setHasUnsavedWork] = useState(false);

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

  return (
    <div
      className="h-full overflow-y-auto pb-8"
      data-testid="capture-and-trim-panel"
    >
      <div className="flex gap-6 min-h-0">
        <div className="w-1/2 space-y-4 min-w-0">
          <VideoSourcePanel
            selectedAssetId={selectedAsset?.id}
            onSelectAsset={selectVideo}
          />
        </div>

        <div className="w-1/2 min-w-0">
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
