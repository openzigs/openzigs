"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson, buildMediaUrl } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { MultiTrackView } from "@/components/music-studio/MultiTrackView";
import {
  ControlPanel,
  type Voice2VoiceParams,
} from "@/components/music-studio/ControlPanel";
import { PipelineStatus } from "@/components/music-studio/PipelineStatus";
import {
  EffectsRack,
  DEFAULT_EFFECTS,
  type EffectsState,
} from "@/components/music-studio/EffectsRack";
import { SpectrogramView } from "@/components/music-studio/SpectrogramView";
import { SmartRemixLab } from "@/components/music-studio/SmartRemixLab";
import { Music, Disc3, Wand2, Pencil, Check, X } from "lucide-react";
import { AskAiPanel, AskAiButton, PAGE_CONTEXTS } from "@/components/ask-ai";

// ── Types ───────────────────────────────────────────────────

type StudioTab = "voice2voice" | "remix";

interface GalleryAsset {
  id: string;
  type: "image" | "video" | "audio";
  filename: string;
  mime_type: string;
  prompt: string | null;
  duration_seconds: number | null;
}

interface MediaJob {
  id: string;
  type: string;
  status: string;
  resultUrl: string | null;
}

interface Track {
  id: string;
  label: string;
  url: string;
  color: string;
  progressColor: string;
  muted: boolean;
  volume: number;
}

// ── Page Component ──────────────────────────────────────────

export default function MusicStudioPage() {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [effects, setEffects] = useState<EffectsState>({ ...DEFAULT_EFFECTS });
  const [spectrogramUrl, setSpectrogramUrl] = useState<string | null>(null);
  const [tab, setTab] = useState<StudioTab>("voice2voice");
  const [askAiOpen, setAskAiOpen] = useState(false);
  const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const { socket } = useSocket();
  const queryClient = useQueryClient();
  const activeJobRef = useRef(activeJobId);
  activeJobRef.current = activeJobId;

  // Background notification: listen for V2V job completion even when user
  // has navigated away from the pipeline status area or the page lost focus.
  useEffect(() => {
    if (!socket) return;

    const onGlobalComplete = (data: {
      jobId: string;
      type?: string;
      resultUrl?: string;
    }) => {
      if (data.type !== "voice2voice") return;
      // Only notify if this is NOT already being handled by PipelineStatus
      if (activeJobRef.current === data.jobId) return;
      showToast(
        `Voice2Voice job complete! Result ready in Audio Assets.`,
        "success",
      );
      // Refresh the asset list so the new result appears
      void queryClient.invalidateQueries({
        queryKey: ["gallery-audio-assets"],
      });
    };

    socket.on("queue:job:complete", onGlobalComplete);
    return () => {
      socket.off("queue:job:complete", onGlobalComplete);
    };
  }, [socket, queryClient]);

  // Fetch audio assets from the gallery
  const { data: assetsData } = useQuery({
    queryKey: ["gallery-audio-assets"],
    queryFn: () =>
      fetchJson<{ assets: GalleryAsset[]; total: number }>(
        "/api/queue/assets?type=audio&limit=100",
      ),
    refetchInterval: 10_000,
  });

  const audioAssets = (assetsData?.assets ?? []).map((a) => ({
    id: a.id,
    filename: a.filename,
    prompt: a.prompt ?? undefined,
  }));

  // Submit voice2voice job
  const submitJob = useMutation({
    mutationFn: async (params: Voice2VoiceParams) => {
      const res = await fetchJson<MediaJob>("/api/queue/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "voice2voice",
          payload: {
            prompt: `Voice conversion (Seed-VC)`,
            source_asset_id: params.source_asset_id,
            voice_reference_id: params.voice_reference_id,
            pitch_shift: params.pitch_shift,
            diffusion_steps: params.diffusion_steps,
            f0_condition: params.f0_condition,
            vocal_volume: params.vocal_volume,
            instrumental_volume: params.instrumental_volume,
            output_format: params.output_format,
          },
        }),
      });
      return res;
    },
    onSuccess: (job) => {
      setActiveJobId(job.id);
      showToast("Voice2Voice job submitted", "success");
    },
    onError: (err) => {
      showToast(
        `Failed to submit job: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    },
  });

  const handleSubmit = useCallback(
    (params: Voice2VoiceParams) => {
      submitJob.mutate(params);
    },
    [submitJob],
  );

  const handlePipelineComplete = useCallback(
    (result: { resultUrl?: string; galleryAssetId?: string }) => {
      showToast("Voice2Voice pipeline complete!", "success");
      setActiveJobId(null);

      if (result.resultUrl) {
        // Add the result as a track (use buildMediaUrl for auth token)
        const url = buildMediaUrl(result.resultUrl);
        setTracks((prev) => [
          ...prev,
          {
            id: `result-${Date.now()}`,
            label: "V2V Result",
            url,
            color: "#10b981",
            progressColor: "#34d399",
            muted: false,
            volume: 1,
          },
        ]);
      }
      if (result.galleryAssetId) {
        showToast(`Result saved as asset ${result.galleryAssetId}`, "info");
        // Refresh gallery so the new asset appears immediately
        void queryClient.invalidateQueries({
          queryKey: ["gallery-audio-assets"],
        });
      }
    },
    [queryClient],
  );

  const handlePipelineError = useCallback((error: string) => {
    showToast(`Pipeline failed: ${error}`, "error");
    setActiveJobId(null);
  }, []);

  // Rename an asset
  const renameAsset = useMutation({
    mutationFn: async ({ id, filename }: { id: string; filename: string }) => {
      await fetchJson(`/api/queue/assets/${id}/rename`, {
        method: "PATCH",
        body: JSON.stringify({ filename }),
      });
    },
    onSuccess: () => {
      showToast("Asset renamed", "success");
      setRenamingAssetId(null);
      void queryClient.invalidateQueries({
        queryKey: ["gallery-audio-assets"],
      });
    },
    onError: (err) => {
      showToast(
        `Rename failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    },
  });

  const handleRenameSubmit = useCallback(
    (assetId: string) => {
      if (renameValue.trim()) {
        renameAsset.mutate({ id: assetId, filename: renameValue.trim() });
      }
    },
    [renameValue, renameAsset],
  );

  // Load audio asset into waveform viewer
  const loadAssetAsTrack = useCallback(
    (assetId: string, filename: string) => {
      const url = buildMediaUrl(`/api/queue/assets/file/${filename}`);
      const exists = tracks.some((t) => t.url === url);
      if (exists) {
        showToast("Track already loaded", "info");
        return;
      }

      const colors = [
        { color: "#6366f1", progressColor: "#818cf8" },
        { color: "#f59e0b", progressColor: "#fbbf24" },
        { color: "#ec4899", progressColor: "#f472b6" },
        { color: "#8b5cf6", progressColor: "#a78bfa" },
      ];
      const colorIdx = tracks.length % colors.length;

      setTracks((prev) => [
        ...prev,
        {
          id: assetId,
          label: filename,
          url,
          ...colors[colorIdx],
          muted: false,
          volume: 1,
        },
      ]);

      // Show spectrogram for the first loaded track
      if (tracks.length === 0) {
        setSpectrogramUrl(url);
      }
    },
    [tracks],
  );

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <ToastContainer />

      {/* Header */}
      <div className="flex items-center gap-3">
        <Disc3 className="h-7 w-7 text-indigo-400" />
        <div>
          <h1 className="text-2xl font-bold text-white">Music Studio</h1>
          <p className="text-sm text-zinc-400">
            AI Voice2Voice pipeline &amp; Smart Remix Lab
          </p>
        </div>
        <div className="ml-auto">
          <AskAiButton onClick={() => setAskAiOpen(true)} />
        </div>
      </div>

      {/* Tab Switcher */}
      <div className="flex gap-1 rounded-lg border border-zinc-700 bg-zinc-900 p-1">
        <button
          onClick={() => setTab("voice2voice")}
          className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === "voice2voice"
              ? "bg-indigo-600 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Disc3 className="h-4 w-4" />
          Voice2Voice
        </button>
        <button
          onClick={() => setTab("remix")}
          className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === "remix"
              ? "bg-indigo-600 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Wand2 className="h-4 w-4" />
          AI Remix Lab
        </button>
      </div>

      {/* Remix Lab Tab */}
      {tab === "remix" && <SmartRemixLab audioAssets={audioAssets} />}

      {/* Voice2Voice Tab */}
      {tab === "voice2voice" && (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left Column: DAW + Pipeline Status */}
          <div className="space-y-6 lg:col-span-2">
            {/* DAW Waveform View */}
            <SectionCard title="Waveform View">
              {tracks.length > 0 ? (
                <MultiTrackView
                  tracks={tracks}
                  onTracksChange={setTracks}
                  playbackRate={effects.playbackRate}
                  showTimeline
                />
              ) : (
                <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-700 bg-zinc-950 py-16 text-center">
                  <Music className="mb-3 h-10 w-10 text-zinc-600" />
                  <p className="text-sm text-zinc-400">No tracks loaded</p>
                  <p className="mt-1 text-xs text-zinc-600">
                    Select an audio asset below or process a Voice2Voice job
                  </p>
                </div>
              )}
            </SectionCard>

            {/* Pipeline Progress */}
            {activeJobId && (
              <PipelineStatus
                jobId={activeJobId}
                onComplete={handlePipelineComplete}
                onError={handlePipelineError}
              />
            )}

            {/* Spectrogram */}
            {spectrogramUrl && (
              <SectionCard title="Spectrogram">
                <SpectrogramView url={spectrogramUrl} height={150} />
              </SectionCard>
            )}

            {/* Audio Asset Browser */}
            <SectionCard title="Audio Assets">
              {(assetsData?.assets ?? []).length > 0 ? (
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {(assetsData?.assets ?? []).map((asset) => (
                    <div
                      key={asset.id}
                      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-zinc-800"
                    >
                      {renamingAssetId === asset.id ? (
                        <div className="flex flex-1 items-center gap-2">
                          <input
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter")
                                handleRenameSubmit(asset.id);
                              if (e.key === "Escape") setRenamingAssetId(null);
                            }}
                            className="flex-1 rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-indigo-500"
                            autoFocus
                          />
                          <button
                            onClick={() => handleRenameSubmit(asset.id)}
                            className="text-emerald-400 hover:text-emerald-300"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setRenamingAssetId(null)}
                            className="text-zinc-400 hover:text-zinc-300"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() =>
                              loadAssetAsTrack(asset.id, asset.filename)
                            }
                            className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          >
                            <Music className="h-4 w-4 shrink-0 text-indigo-400" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-zinc-200">
                                {asset.filename}
                              </p>
                              {asset.prompt && (
                                <p className="truncate text-xs text-zinc-500">
                                  {asset.prompt}
                                </p>
                              )}
                            </div>
                          </button>
                          {asset.duration_seconds != null && (
                            <span className="shrink-0 font-mono text-xs text-zinc-500">
                              {Math.floor(asset.duration_seconds / 60)}:
                              {String(
                                Math.floor(asset.duration_seconds % 60),
                              ).padStart(2, "0")}
                            </span>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenamingAssetId(asset.id);
                              setRenameValue(asset.filename);
                            }}
                            className="shrink-0 text-zinc-500 hover:text-zinc-300"
                            title="Rename"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="py-8 text-center text-sm text-zinc-500">
                  No audio assets in gallery. Generate music first in the
                  Gallery or Director.
                </p>
              )}
            </SectionCard>
          </div>

          {/* Right Column: Control Panel + Effects */}
          <div className="space-y-6">
            <ControlPanel
              audioAssets={audioAssets}
              onSubmit={handleSubmit}
              isProcessing={!!activeJobId}
            />

            {/* Effects Rack */}
            <SectionCard title="Effects Rack">
              <EffectsRack effects={effects} onChange={setEffects} />
            </SectionCard>
          </div>
        </div>
      )}
      <AskAiPanel
        pageContext={PAGE_CONTEXTS["music-studio"]}
        open={askAiOpen}
        onClose={() => setAskAiOpen(false)}
      />
    </main>
  );
}
