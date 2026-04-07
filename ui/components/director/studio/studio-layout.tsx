"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { showToast } from "@/components/toast";
import { StudioToolbar } from "./studio-toolbar";
import { PlayerPreview } from "./player-preview";
import { SceneInspector } from "./scene-inspector";
import { CaptionStylePanel } from "./caption-style-panel";
import { TimelineTracks } from "./timeline-tracks";
import { TimelineRuler } from "./timeline-ruler";
import { TimelineToolbar } from "./timeline-toolbar";
import { AudioManager } from "./audio-manager";
import { ShortsProposalPanel } from "./shorts-proposal-panel";
import { ClipExtractorPanel } from "./clip-extractor-panel";
import { AudioCleanerPanel } from "./audio-cleaner-panel";
import { BRollPanel } from "./broll-panel";
import { NLEExportPanel } from "./nle-export-panel";
import { VideoSourcePanel, type GalleryAsset } from "./video-source-panel";
import { VideoTrimmer } from "./video-trimmer";
import { useUndoHistory } from "@/hooks/use-undo-history";
import {
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Film,
  MonitorUp,
  Clapperboard,
  Loader2 as Loader2Icon,
} from "lucide-react";
import type {
  DraftFull,
  InspectorState,
  TimelineTrack,
  TimelineTrackEntry,
  TimelineEntry,
  DirectorManifest,
} from "../types";

function buildTracks(manifest: DirectorManifest): TimelineTrack[] {
  const fps = manifest.composition?.fps || 30;
  const scenesEntries: TimelineTrackEntry[] = [];
  const voiceoverEntries: TimelineTrackEntry[] = [];
  const overlayEntries: TimelineTrackEntry[] = [];
  const audioEntries: TimelineTrackEntry[] = [];

  const timeline = manifest.timeline ?? [];
  let sceneCounter = 0;
  for (const [i, entry] of timeline.entries()) {
    const startFrame = entry.startAtFrame ?? 0;
    const dur = entry.duration ?? entry.durationInFrames ?? fps * 3;

    switch (entry.type) {
      case "image_scene":
      case "video_clip":
      case "title_card":
      case "intro_card":
      case "outro_card": {
        sceneCounter++;
        const sourceFile = entry.source
          ? String(entry.source).split("/").pop()
          : undefined;
        scenesEntries.push({
          timelineIndex: i,
          startFrame,
          durationFrames: dur,
          label:
            entry.title ??
            entry.scriptText?.slice(0, 30) ??
            sourceFile ??
            `Scene ${sceneCounter}`,
          color:
            entry.type === "intro_card"
              ? "bg-emerald-500/70"
              : entry.type === "outro_card"
                ? "bg-rose-500/70"
                : entry.type === "title_card"
                  ? "bg-amber-500/70"
                  : "bg-blue-500/70",
        });
        if (entry.voiceover) {
          voiceoverEntries.push({
            timelineIndex: i,
            startFrame,
            durationFrames: dur,
            label: `VO ${sceneCounter}`,
            color: "bg-purple-500/70",
          });
        }
        break;
      }
      case "overlay":
        overlayEntries.push({
          timelineIndex: i,
          startFrame,
          durationFrames: dur,
          label:
            ((entry as Record<string, unknown>).component as string) ??
            "Overlay",
          color: "bg-teal-500/70",
        });
        break;
      case "transition":
        break;
    }
  }

  const vo = manifest.audioLayer?.voiceover;
  if (vo && (vo.src || vo.source)) {
    const totalFrames = timeline.reduce((max, e) => {
      const end =
        (e.startAtFrame ?? 0) + (e.duration ?? e.durationInFrames ?? 0);
      return Math.max(max, end);
    }, 0);
    const voStart = vo.startAtFrame ?? 0;
    voiceoverEntries.push({
      timelineIndex: -1,
      startFrame: voStart,
      durationFrames: totalFrames - voStart,
      label: "Voiceover",
      color: "bg-purple-500/70",
    });
  }

  if (manifest.audioLayer?.music) {
    const totalFrames = timeline.reduce((max, e) => {
      const end =
        (e.startAtFrame ?? 0) + (e.duration ?? e.durationInFrames ?? 0);
      return Math.max(max, end);
    }, 0);
    audioEntries.push({
      timelineIndex: -1,
      startFrame: 0,
      durationFrames: totalFrames,
      label: "Music",
      color: "bg-orange-500/70",
    });
  }

  return [
    {
      id: "scenes",
      label: "Scenes",
      type: "scenes" as const,
      entries: scenesEntries,
    },
    {
      id: "voiceover",
      label: "Voiceover",
      type: "voiceover" as const,
      entries: voiceoverEntries,
    },
    {
      id: "overlay",
      label: "Overlays",
      type: "overlay" as const,
      entries: overlayEntries,
    },
    {
      id: "audio",
      label: "Audio",
      type: "audio" as const,
      entries: audioEntries,
    },
  ];
}

// ── Helpers shared by quick mode ────────────────────────────

interface DraftSummaryItem {
  id: string;
  title: string;
}

async function createDraftFromAsset(asset: GalleryAsset): Promise<string> {
  const fps = 30;
  const durationFrames = Math.round((asset.duration_seconds ?? 60) * fps);
  const manifest = {
    projectTitle: asset.filename.replace(/\.[^.]+$/, ""),
    templateId: "highlight-16-9",
    composition: { width: 1920, height: 1080, fps },
    audioLayer: { music: null, voiceover: null },
    timeline: [
      {
        type: "video_clip",
        source: asset.file_path,
        title: asset.filename,
        startAtFrame: 0,
        duration: durationFrames,
        durationInFrames: durationFrames,
      },
    ],
  };
  const draft = await fetchJson<{ id: string }>("/api/admin/director/drafts", {
    method: "POST",
    body: JSON.stringify({
      title: manifest.projectTitle,
      manifest,
      productionMode: "highlight",
    }),
  });
  return draft.id;
}

// ── Quick Mode (no draft) ────────────────────────────────────

function QuickModeStudio({ initialAssetId }: { initialAssetId?: string }) {
  const router = useRouter();
  const [selectedAsset, setSelectedAsset] = useState<GalleryAsset | null>(null);
  const [trimmedAsset, setTrimmedAsset] = useState<GalleryAsset | null>(null);
  const [pendingAsset, setPendingAsset] = useState<GalleryAsset | null>(null);
  const [hasUnsavedWork, setHasUnsavedWork] = useState(false);
  const [promoting, setPromoting] = useState(false);
  // Draft picker for "send to existing draft"
  const [drafts, setDrafts] = useState<DraftSummaryItem[]>([]);
  const [showDraftPicker, setShowDraftPicker] = useState(false);
  const [sendingToDraft, setSendingToDraft] = useState(false);

  useEffect(() => {
    if (initialAssetId && !selectedAsset) {
      fetchJson<GalleryAsset>(`/api/queue/assets/${initialAssetId}`)
        .then((a) => setSelectedAsset(a))
        .catch(() => {});
    }
  }, [initialAssetId, selectedAsset]);

  // Load drafts for the picker whenever it's opened
  useEffect(() => {
    if (!showDraftPicker) return;
    fetchJson<{ drafts: DraftSummaryItem[] }>("/api/admin/director/drafts")
      .then((d) => setDrafts(d.drafts ?? []))
      .catch(() => {});
  }, [showDraftPicker]);

  const selectVideo = useCallback(
    (asset: GalleryAsset) => {
      if (selectedAsset && selectedAsset.id !== asset.id && hasUnsavedWork) {
        setPendingAsset(asset);
        return;
      }
      setSelectedAsset(asset);
      setTrimmedAsset(null);
      setHasUnsavedWork(false);
    },
    [selectedAsset, hasUnsavedWork],
  );

  // Called when the trimmer exports a cut — the cut becomes a new gallery asset
  const handleTrimComplete = useCallback(async (newAssetId: string) => {
    try {
      const asset = await fetchJson<GalleryAsset>(
        `/api/queue/assets/${newAssetId}`,
      );
      setTrimmedAsset(asset);
      showToast(
        "Cut exported to gallery — you can now send it to a draft.",
        "success",
      );
    } catch {
      showToast("Cut exported to gallery.", "success");
    }
  }, []);

  // Create a brand-new draft from the current (or trimmed) asset and navigate there
  const promoteToDraft = useCallback(
    async (asset: GalleryAsset) => {
      setPromoting(true);
      try {
        const id = await createDraftFromAsset(asset);
        showToast("Draft created — opening full Studio", "success");
        router.replace(`/director/studio/${id}`);
      } catch (err) {
        showToast(
          `Failed to create draft: ${err instanceof Error ? err.message : "Unknown error"}`,
          "error",
        );
        setPromoting(false);
      }
    },
    [router],
  );

  // Append a clip to an existing draft's timeline
  const sendToExistingDraft = useCallback(
    async (draftId: string, asset: GalleryAsset) => {
      setSendingToDraft(true);
      try {
        // Fetch the full draft manifest
        const draft = await fetchJson<{
          id: string;
          title: string;
          manifest: Record<string, unknown> | null;
        }>(`/api/admin/director/drafts/${draftId}`);

        const fps = 30;
        const durationFrames = Math.round((asset.duration_seconds ?? 60) * fps);
        const existingTimeline =
          (draft.manifest as { timeline?: unknown[] } | null)?.timeline ?? [];
        const lastEnd = (
          existingTimeline as Array<Record<string, number>>
        ).reduce(
          (max, e) =>
            Math.max(
              max,
              (e.startAtFrame ?? 0) +
                (e.duration ?? e.durationInFrames ?? fps * 3),
            ),
          0,
        );

        const updatedManifest = {
          ...(draft.manifest ?? {}),
          timeline: [
            ...existingTimeline,
            {
              type: "video_clip",
              source: asset.file_path,
              title: asset.filename,
              startAtFrame: lastEnd,
              duration: durationFrames,
              durationInFrames: durationFrames,
            },
          ],
        };

        await fetchJson(`/api/admin/director/drafts/${draftId}`, {
          method: "PUT",
          body: JSON.stringify({
            manifest: updatedManifest,
            title: draft.title,
          }),
        });

        showToast(`Clip added to "${draft.title}" — opening Studio`, "success");
        router.replace(`/director/studio/${draftId}`);
      } catch (err) {
        showToast(
          `Failed to add clip: ${err instanceof Error ? err.message : "Unknown error"}`,
          "error",
        );
        setSendingToDraft(false);
      }
    },
    [router],
  );

  // The asset we want to send to a draft (trimmed clip takes priority over source)
  const assetForDraft = trimmedAsset ?? selectedAsset;

  return (
    <div className="flex h-full flex-col">
      {/* Quick-mode header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <Film className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">
            Studio — Quick Mode
          </h2>
          <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            Capture &amp; Trim
          </span>
        </div>
        <div className="flex items-center gap-2">
          {assetForDraft && (
            <>
              <button
                onClick={() => promoteToDraft(assetForDraft)}
                disabled={promoting || sendingToDraft}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                {promoting ? "Creating…" : "New Draft in Full Studio"}
              </button>
              <div className="relative">
                <button
                  onClick={() => setShowDraftPicker((v) => !v)}
                  disabled={promoting || sendingToDraft}
                  className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50 transition"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                  {sendingToDraft ? "Adding…" : "Add to Existing Draft"}
                </button>
                {showDraftPicker && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-background shadow-xl">
                    <div className="border-b border-border px-3 py-2">
                      <p className="text-xs font-medium text-foreground">
                        Choose a draft
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        Clip will be appended to the timeline
                      </p>
                    </div>
                    <div className="max-h-64 overflow-y-auto py-1">
                      {drafts.length === 0 ? (
                        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                          No drafts yet
                        </p>
                      ) : (
                        drafts.map((d) => (
                          <button
                            key={d.id}
                            onClick={() => {
                              setShowDraftPicker(false);
                              sendToExistingDraft(d.id, assetForDraft);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted transition"
                          >
                            <Film className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="flex-1 truncate text-foreground">
                              {d.title}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                    <div className="border-t border-border px-3 py-2">
                      <button
                        onClick={() => setShowDraftPicker(false)}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
          <a
            href="/director"
            className="text-xs text-muted-foreground hover:text-foreground transition"
          >
            ← Director
          </a>
        </div>
      </div>

      {/* Trim complete banner */}
      {trimmedAsset && (
        <div className="flex items-center gap-3 border-b border-border bg-green-500/10 px-4 py-2">
          <div className="h-2 w-2 rounded-full bg-green-500" />
          <span className="text-xs text-foreground">
            Cut exported:{" "}
            <span className="font-medium">{trimmedAsset.filename}</span>
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => promoteToDraft(trimmedAsset)}
              disabled={promoting}
              className="flex items-center gap-1 rounded bg-green-600 hover:bg-green-700 px-2.5 py-1 text-[11px] font-medium text-white transition disabled:opacity-50"
            >
              <FolderPlus className="h-3 w-3" />
              New Draft from Cut
            </button>
            <button
              onClick={() => {
                selectVideo(trimmedAsset);
                setTrimmedAsset(null);
              }}
              className="rounded border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground transition"
            >
              Edit Cut Further
            </button>
            <button
              onClick={() => setTrimmedAsset(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Left: Source panel */}
        <div className="w-1/2 overflow-y-auto border-r border-border p-4">
          <VideoSourcePanel
            selectedAssetId={selectedAsset?.id}
            onSelectAsset={selectVideo}
          />
        </div>

        {/* Right: Trimmer */}
        <div className="w-1/2 overflow-y-auto p-4">
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
                <div className="flex gap-2 justify-end pt-1">
                  <button
                    onClick={() => setPendingAsset(null)}
                    className="rounded bg-zinc-700 hover:bg-zinc-600 px-3 py-1.5 text-xs text-zinc-300 transition"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      setSelectedAsset(pendingAsset);
                      setHasUnsavedWork(false);
                      setPendingAsset(null);
                    }}
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

// ── Import Sidebar (collapsible, used in draft mode) ─────────

function ImportSidebarSection({
  draftId,
  manifest,
  onManifestUpdate,
}: {
  draftId: string;
  manifest: DirectorManifest;
  onManifestUpdate: (m: DirectorManifest) => void;
}) {
  const [open, setOpen] = useState(false);

  const handleImportAsset = useCallback(
    (asset: GalleryAsset) => {
      const fps = manifest.composition?.fps ?? 30;
      const durationFrames = Math.round((asset.duration_seconds ?? 60) * fps);
      const timeline = manifest.timeline ?? [];

      const lastEnd = timeline.reduce((max, e) => {
        const end =
          (e.startAtFrame ?? 0) + (e.duration ?? e.durationInFrames ?? fps * 3);
        return Math.max(max, end);
      }, 0);

      const newEntry: TimelineEntry = {
        type: "video_clip",
        source: asset.file_path,
        title: asset.filename,
        startAtFrame: lastEnd,
        duration: durationFrames,
        durationInFrames: durationFrames,
      };

      onManifestUpdate({
        ...manifest,
        timeline: [...timeline, newEntry],
      });
      showToast(`Added "${asset.filename}" to timeline`, "success");
    },
    [manifest, onManifestUpdate],
  );

  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition"
        data-testid={`import-sidebar-${draftId}`}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <MonitorUp className="h-3.5 w-3.5" />
        Import / Capture
      </button>
      {open && (
        <div className="border-t border-border p-3">
          <VideoSourcePanel onSelectAsset={handleImportAsset} compact />
        </div>
      )}
    </div>
  );
}

// ── Draft Mode (full studio) ─────────────────────────────────

export function StudioLayout({
  draftId,
  initialAssetId,
}: {
  draftId?: string;
  initialAssetId?: string;
}) {
  if (!draftId) {
    return <QuickModeStudio initialAssetId={initialAssetId} />;
  }

  return <DraftModeStudio draftId={draftId} />;
}

function DraftModeStudio({ draftId }: { draftId: string }) {
  const [draft, setDraft] = useState<DraftFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [inspector, setInspector] = useState<InspectorState>({
    sceneIndex: null,
    entry: null,
  });
  const [tracks, setTracks] = useState<TimelineTrack[]>([]);
  const [zoom, setZoom] = useState(1);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [renderStatus, setRenderStatus] = useState<{
    jobId: string;
    progress: number;
    status: string;
  } | null>(null);
  const playerRef = useRef<{
    seekTo: (frame: number) => void;
    play: () => void;
    pause: () => void;
  } | null>(null);
  const { socket } = useSocket();

  const loadDraft = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchJson<DraftFull>(
        `/api/admin/director/drafts/${draftId}`,
      );
      setDraft(data);
      if (data.manifest) {
        setTracks(buildTracks(data.manifest));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  useEffect(() => {
    loadDraft();
  }, [loadDraft]);

  useEffect(() => {
    if (!socket) return;

    const onProgress = (data: {
      jobId: string;
      progress: number;
      status: string;
    }) => {
      setRenderStatus(data);
    };

    const onComplete = (_data: {
      jobId: string;
      outputPath: string | null;
    }) => {
      setRenderStatus(null);
      showToast(`Render complete! Your video is ready.`, "success");
      loadDraft();
    };

    const onFailed = (data: { jobId: string; error: string }) => {
      setRenderStatus(null);
      showToast(`Render failed: ${data.error}`, "error");
    };

    socket.on("render:progress", onProgress);
    socket.on("render:complete", onComplete);
    socket.on("render:failed", onFailed);

    return () => {
      socket.off("render:progress", onProgress);
      socket.off("render:complete", onComplete);
      socket.off("render:failed", onFailed);
    };
  }, [socket, loadDraft]);

  const handleSave = useCallback(async () => {
    if (!draft?.manifest) return;
    await fetchJson(`/api/admin/director/drafts/${draftId}`, {
      method: "PUT",
      body: JSON.stringify({ manifest: draft.manifest, title: draft.title }),
    });
    setDirty(false);
    setLastSaved(new Date().toISOString());
  }, [draft, draftId]);

  const manifestHistory = useUndoHistory<DirectorManifest | null>(
    draft?.manifest ?? null,
  );

  const handleManifestUpdate = useCallback(
    (manifest: DirectorManifest) => {
      manifestHistory.push(manifest);
      setDraft((prev) => (prev ? { ...prev, manifest } : prev));
      setTracks(buildTracks(manifest));
      setDirty(true);
    },
    [manifestHistory],
  );

  const handleUndo = useCallback(() => {
    manifestHistory.undo();
    const prev = manifestHistory.state;
    if (prev) {
      setDraft((d) => (d ? { ...d, manifest: prev } : d));
      setTracks(buildTracks(prev));
      setDirty(true);
    }
  }, [manifestHistory]);

  const handleRedo = useCallback(() => {
    manifestHistory.redo();
    const next = manifestHistory.state;
    if (next) {
      setDraft((d) => (d ? { ...d, manifest: next } : d));
      setTracks(buildTracks(next));
      setDirty(true);
    }
  }, [manifestHistory]);

  const handleSplitAtPlayhead = useCallback(() => {
    if (!draft?.manifest) return;
    const fps = draft.manifest.composition?.fps ?? 30;
    const timeline = draft.manifest.timeline ?? [];
    const playheadSec = currentFrame / fps;

    const targetIdx = timeline.findIndex((e) => {
      const start = (e.startAtFrame ?? 0) / fps;
      const dur = (e.duration ?? e.durationInFrames ?? fps * 3) / fps;
      return playheadSec > start && playheadSec < start + dur;
    });
    if (targetIdx < 0) return;

    const entry = timeline[targetIdx];
    const startFrame = entry.startAtFrame ?? 0;
    const totalDur = entry.duration ?? entry.durationInFrames ?? fps * 3;
    const splitFrame = currentFrame - startFrame;
    if (splitFrame <= 0 || splitFrame >= totalDur) return;

    const first = {
      ...entry,
      duration: splitFrame,
      durationInFrames: splitFrame,
    };
    const second = {
      ...entry,
      startAtFrame: startFrame + splitFrame,
      duration: totalDur - splitFrame,
      durationInFrames: totalDur - splitFrame,
    };
    const updated = [
      ...timeline.slice(0, targetIdx),
      first,
      second,
      ...timeline.slice(targetIdx + 1),
    ];
    handleManifestUpdate({ ...draft.manifest, timeline: updated });
  }, [draft, currentFrame, handleManifestUpdate]);

  const hasIntro =
    draft?.manifest?.timeline?.some((e) => e.type === "intro_card") ?? false;
  const hasOutro =
    draft?.manifest?.timeline?.some((e) => e.type === "outro_card") ?? false;

  const handleAddScene = useCallback(() => {
    if (!draft?.manifest) return;
    const fps = draft.manifest.composition?.fps ?? 30;
    const timeline = draft.manifest.timeline ?? [];
    const sceneDuration = fps * 3;

    const visualTypes = new Set(["image_scene", "video_clip"]);
    let insertAfterIdx = -1;
    if (inspector.sceneIndex !== null) {
      let sceneCount = 0;
      for (let i = 0; i < timeline.length; i++) {
        if (visualTypes.has(timeline[i].type)) {
          if (sceneCount === inspector.sceneIndex) {
            insertAfterIdx = i;
            break;
          }
          sceneCount++;
        }
      }
    }
    if (insertAfterIdx < 0) {
      for (let i = timeline.length - 1; i >= 0; i--) {
        if (visualTypes.has(timeline[i].type)) {
          insertAfterIdx = i;
          break;
        }
      }
    }

    const insertAt = insertAfterIdx >= 0 ? insertAfterIdx + 1 : timeline.length;
    const prevEnd =
      insertAfterIdx >= 0
        ? (timeline[insertAfterIdx].startAtFrame ?? 0) +
          (timeline[insertAfterIdx].duration ??
            timeline[insertAfterIdx].durationInFrames ??
            fps * 3)
        : 0;

    const newScene: TimelineEntry = {
      type: "image_scene",
      title: "New Scene",
      scriptText: "",
      startAtFrame: prevEnd,
      duration: sceneDuration,
    };

    const updated = [...timeline];
    updated.splice(insertAt, 0, newScene);

    let frame = 0;
    for (const entry of updated) {
      entry.startAtFrame = frame;
      frame += entry.duration ?? entry.durationInFrames ?? fps * 3;
    }

    handleManifestUpdate({ ...draft.manifest, timeline: updated });
  }, [draft, inspector.sceneIndex, handleManifestUpdate]);

  const handleDeleteScene = useCallback(
    (sceneIndex: number) => {
      if (!draft?.manifest) return;
      const fps = draft.manifest.composition?.fps ?? 30;
      const timeline = draft.manifest.timeline ?? [];
      const visualTypes = new Set(["image_scene", "video_clip"]);

      let targetIdx = -1;
      let sceneCount = 0;
      for (let i = 0; i < timeline.length; i++) {
        if (visualTypes.has(timeline[i].type)) {
          if (sceneCount === sceneIndex) {
            targetIdx = i;
            break;
          }
          sceneCount++;
        }
      }
      if (targetIdx < 0) return;

      const updated = timeline.filter((_, i) => i !== targetIdx);

      let frame = 0;
      for (const entry of updated) {
        entry.startAtFrame = frame;
        frame += entry.duration ?? entry.durationInFrames ?? fps * 3;
      }

      handleManifestUpdate({ ...draft.manifest, timeline: updated });
      if (inspector.sceneIndex === sceneIndex) {
        setInspector({ sceneIndex: null, entry: null });
      } else if (
        inspector.sceneIndex !== null &&
        inspector.sceneIndex > sceneIndex
      ) {
        setInspector((prev) => ({
          sceneIndex: (prev.sceneIndex ?? 1) - 1,
          entry: prev.entry,
        }));
      }
    },
    [draft, inspector.sceneIndex, handleManifestUpdate],
  );

  const handleAddIntro = useCallback(() => {
    if (!draft?.manifest || hasIntro) return;
    const fps = draft.manifest.composition?.fps ?? 30;
    const introDuration = fps * 4;

    const shifted = (draft.manifest.timeline ?? []).map((e) => ({
      ...e,
      startAtFrame: (e.startAtFrame ?? 0) + introDuration,
    }));

    const introEntry: TimelineEntry = {
      type: "intro_card",
      title: draft.manifest.projectTitle || "Untitled",
      startAtFrame: 0,
      duration: introDuration,
      animation: "fade-in",
    };

    const updated: DirectorManifest = {
      ...draft.manifest,
      timeline: [introEntry, ...shifted],
    };
    handleManifestUpdate(updated);
  }, [draft, hasIntro, handleManifestUpdate]);

  const handleAddOutro = useCallback(() => {
    if (!draft?.manifest || hasOutro) return;
    const fps = draft.manifest.composition?.fps ?? 30;
    const outroDuration = fps * 4;

    const timeline = draft.manifest.timeline ?? [];

    const visualTypes = new Set([
      "image_scene",
      "video_clip",
      "title_card",
      "intro_card",
    ]);
    const lastSceneEnd = timeline.reduce((max, e) => {
      if (!visualTypes.has(e.type)) return max;
      const end =
        (e.startAtFrame ?? 0) + (e.duration ?? e.durationInFrames ?? fps * 3);
      return Math.max(max, end);
    }, 0);

    const outroEntry: TimelineEntry = {
      type: "outro_card",
      title: "Thanks for watching",
      startAtFrame: lastSceneEnd,
      duration: outroDuration,
      animation: "fade-out",
    };

    handleManifestUpdate({
      ...draft.manifest,
      timeline: [...timeline, outroEntry],
    });
  }, [draft, hasOutro, handleManifestUpdate]);

  const handleRemoveCard = useCallback(
    (cardType: "intro_card" | "outro_card") => {
      if (!draft?.manifest) return;
      const fps = draft.manifest.composition?.fps ?? 30;
      const timeline = draft.manifest.timeline ?? [];
      const cardIdx = timeline.findIndex((e) => e.type === cardType);
      if (cardIdx < 0) return;

      const updated = timeline.filter((_, i) => i !== cardIdx);

      let frame = 0;
      for (const entry of updated) {
        entry.startAtFrame = frame;
        frame += entry.duration ?? entry.durationInFrames ?? fps * 3;
      }

      handleManifestUpdate({ ...draft.manifest, timeline: updated });
      const selectedEntry = inspector.entry;
      if (selectedEntry?.type === cardType) {
        setInspector({ sceneIndex: null, entry: null });
      }
    },
    [draft, inspector.entry, handleManifestUpdate],
  );

  useEffect(() => {
    if (!dirty || !draft?.manifest) return;
    const timer = setTimeout(() => {
      fetchJson(`/api/admin/director/drafts/${draftId}`, {
        method: "PUT",
        body: JSON.stringify({ manifest: draft.manifest, title: draft.title }),
      })
        .then(() => {
          setDirty(false);
          setLastSaved(new Date().toISOString());
        })
        .catch(() => {});
    }, 30_000);
    return () => clearTimeout(timer);
  }, [dirty, draft, draftId]);

  const handleSelectScene = useCallback(
    (sceneIndex: number, entry: TimelineEntry) => {
      setInspector({ sceneIndex, entry });
      const frame = entry.startAtFrame ?? 0;
      setCurrentFrame(frame);
      playerRef.current?.seekTo(frame);
    },
    [],
  );

  const handleFrameChange = useCallback(
    (frame: number) => {
      setCurrentFrame(frame);

      if (!draft?.manifest?.timeline) return;
      const timeline = draft.manifest.timeline;
      const visualTypes = new Set(["image_scene", "video_clip"]);
      let sceneIdx = 0;
      for (const entry of timeline) {
        const start = entry.startAtFrame ?? 0;
        const dur = entry.duration ?? entry.durationInFrames ?? 0;
        if (frame >= start && frame < start + dur) {
          if (visualTypes.has(entry.type)) {
            setInspector((prev) => {
              if (prev.sceneIndex === sceneIdx) return prev;
              return { sceneIndex: sceneIdx, entry };
            });
          }
          return;
        }
        if (visualTypes.has(entry.type)) sceneIdx++;
      }
    },
    [draft?.manifest?.timeline],
  );

  const handleSeek = useCallback((frame: number) => {
    setCurrentFrame(frame);
    playerRef.current?.seekTo(frame);
  }, []);

  const handleReorderScenes = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!draft?.manifest) return;
      const timeline = draft.manifest.timeline ?? [];
      const fps = draft.manifest.composition?.fps ?? 30;

      const visualTypes = new Set([
        "image_scene",
        "video_clip",
        "title_card",
        "intro_card",
        "outro_card",
      ]);
      const sceneIndices: number[] = [];
      for (let i = 0; i < timeline.length; i++) {
        if (visualTypes.has(timeline[i].type)) sceneIndices.push(i);
      }
      if (
        fromIndex < 0 ||
        fromIndex >= sceneIndices.length ||
        toIndex < 0 ||
        toIndex >= sceneIndices.length
      )
        return;

      const updated = [...timeline];
      const fromTlIdx = sceneIndices[fromIndex];
      const toTlIdx = sceneIndices[toIndex];
      const [moved] = updated.splice(fromTlIdx, 1);
      const insertAt = toTlIdx > fromTlIdx ? toTlIdx : toTlIdx;
      updated.splice(insertAt, 0, moved);

      let frame = 0;
      for (const entry of updated) {
        entry.startAtFrame = frame;
        frame += entry.duration ?? entry.durationInFrames ?? fps * 3;
      }

      handleManifestUpdate({ ...draft.manifest, timeline: updated });
    },
    [draft, handleManifestUpdate],
  );

  const totalFrames = draft?.manifest?.timeline
    ? (() => {
        const visualTypes = new Set([
          "image_scene",
          "video_clip",
          "title_card",
          "intro_card",
          "outro_card",
        ]);
        return draft.manifest.timeline.reduce(
          (max: number, e: TimelineEntry) => {
            if (!visualTypes.has(e.type)) return max;
            const end =
              (e.startAtFrame ?? 0) + (e.duration ?? e.durationInFrames ?? 0);
            return Math.max(max, end);
          },
          0,
        );
      })()
    : 0;

  const videoSource = draft?.manifest?.timeline?.find(
    (e) => e.type === "video_clip" && e.source,
  )?.source as string | undefined;
  const audioSource = (draft?.manifest?.audioLayer?.voiceover?.src ??
    draft?.manifest?.audioLayer?.voiceover?.source) as string | undefined;

  const [splittingScenes, setSplittingScenes] = useState(false);

  const handleSplitScenes = useCallback(async () => {
    if (!videoSource || !draft?.manifest) return;
    const manifest = draft.manifest;
    const fps = manifest.composition?.fps ?? 30;
    setSplittingScenes(true);
    try {
      const res = await fetchJson<{
        scenes: Array<{
          type: "video_clip";
          source: string;
          title: string;
          startAtFrame: number;
          trimStart: number;
          trimEnd: number;
          duration: number;
          durationInFrames: number;
          sceneType?: string;
          hasSceneChange?: boolean;
        }>;
        totalDuration: number;
        sceneChangeCount: number;
      }>("/api/studio/split-scenes", {
        method: "POST",
        body: JSON.stringify({ source: videoSource, fps }),
      });

      if (res.scenes.length === 0) {
        showToast(
          "No scene boundaries detected — video may be a single scene",
          "info",
        );
        return;
      }

      const nonVideoEntries = (manifest.timeline ?? []).filter(
        (e) => e.type !== "video_clip",
      );
      const newTimeline: TimelineEntry[] = [
        ...res.scenes.map((s) => ({
          type: s.type,
          source: s.source,
          title: s.title,
          startAtFrame: s.startAtFrame,
          trimStart: s.trimStart,
          trimEnd: s.trimEnd,
          duration: s.duration,
          durationInFrames: s.durationInFrames,
        })),
        ...nonVideoEntries,
      ];

      handleManifestUpdate({ ...manifest, timeline: newTimeline });
      showToast(
        `Split into ${res.scenes.length} scenes (${res.sceneChangeCount} scene changes detected)`,
        "success",
      );
    } catch (err) {
      showToast(
        `Scene split failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      setSplittingScenes(false);
    }
  }, [videoSource, draft, handleManifestUpdate]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-pulse text-muted-foreground">
          Loading studio…
        </div>
      </div>
    );
  }

  if (error || !draft) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-destructive">{error ?? "Draft not found"}</p>
          <a href="/director" className="mt-2 text-sm text-primary underline">
            ← Back to Director
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <StudioToolbar
        title={draft.title}
        onSave={handleSave}
        onRestore={handleManifestUpdate}
        draftId={draftId}
        manifest={draft.manifest}
        dirty={dirty}
        lastSaved={lastSaved}
      />

      {renderStatus && (
        <div className="flex items-center gap-3 border-b border-border bg-primary/10 px-4 py-2">
          <div className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          <span className="text-xs font-medium text-foreground">
            Rendering… {Math.round(renderStatus.progress * 100)}%
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{
                width: `${Math.round(renderStatus.progress * 100)}%`,
              }}
            />
          </div>
          <span className="text-[10px] text-muted-foreground capitalize">
            {renderStatus.status}
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-0">
        {/* Left: Player preview */}
        <div className="flex w-3/5 flex-col border-r border-border p-4">
          <PlayerPreview
            manifest={draft.manifest}
            totalFrames={totalFrames}
            currentFrame={currentFrame}
            isPlaying={isPlaying}
            onPlayingChange={setIsPlaying}
            onFrameChange={handleFrameChange}
            playerRef={playerRef}
          />
        </div>

        {/* Right: Inspector + Import */}
        <div className="w-2/5 overflow-y-auto p-4">
          {/* Collapsible Import / Capture */}
          {draft.manifest && (
            <div className="mb-4">
              <ImportSidebarSection
                draftId={draftId}
                manifest={draft.manifest}
                onManifestUpdate={handleManifestUpdate}
              />
            </div>
          )}

          <SceneInspector
            inspector={inspector}
            manifest={draft.manifest}
            draftId={draftId}
            onManifestUpdate={handleManifestUpdate}
            onDeleteScene={handleDeleteScene}
            onRemoveCard={handleRemoveCard}
          />

          {draft.manifest && (
            <div className="mt-4">
              <CaptionStylePanel
                manifest={draft.manifest}
                onManifestUpdate={handleManifestUpdate}
              />
            </div>
          )}

          {draft.manifest && (
            <div className="mt-4">
              <AudioManager
                music={
                  draft.manifest.audioLayer?.music
                    ? {
                        track: draft.manifest.audioLayer.music.track ?? "",
                        volume: draft.manifest.audioLayer.music.volume ?? 0.3,
                        loop: draft.manifest.audioLayer.music.loop ?? true,
                      }
                    : null
                }
                onMusicChange={(music) => {
                  if (!draft.manifest) return;
                  handleManifestUpdate({
                    ...draft.manifest,
                    audioLayer: {
                      ...draft.manifest.audioLayer,
                      music: music
                        ? {
                            track: music.track,
                            volume: music.volume,
                            loop: music.loop,
                          }
                        : null,
                    },
                  });
                }}
                fps={draft.manifest.composition?.fps ?? 30}
              />
            </div>
          )}

          {/* Scene Splitter — only shown when a video_clip is in the timeline */}
          {videoSource && (
            <div className="mt-4 rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Clapperboard className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">
                  Analyze & Split Scenes
                </h3>
              </div>
              <p className="text-xs text-muted-foreground">
                Detects scene boundaries using FFmpeg and splits the video into
                separate timeline entries. No AI required.
              </p>
              <button
                onClick={handleSplitScenes}
                disabled={splittingScenes}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {splittingScenes ? (
                  <>
                    <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
                    Analyzing…
                  </>
                ) : (
                  <>
                    <Clapperboard className="h-3.5 w-3.5" />
                    Split into Scenes
                  </>
                )}
              </button>
            </div>
          )}

          <div className="mt-4">
            <ShortsProposalPanel draftId={draftId} />
          </div>

          <div className="mt-4">
            <ClipExtractorPanel draftId={draftId} videoSource={videoSource} />
          </div>

          <div className="mt-4">
            <AudioCleanerPanel
              draftId={draftId}
              audioSource={audioSource ?? videoSource}
            />
          </div>

          <div className="mt-4">
            <BRollPanel draftId={draftId} videoSource={videoSource} />
          </div>

          {draft.manifest && (
            <div className="mt-4">
              <NLEExportPanel
                draftId={draftId}
                manifest={draft.manifest as unknown as Record<string, unknown>}
                title={draft.title}
              />
            </div>
          )}
        </div>
      </div>

      {/* Bottom: Timeline */}
      <div className="shrink-0 border-t border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Cards
          </span>
          {hasIntro ? (
            <button
              onClick={() => handleRemoveCard("intro_card")}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-emerald-600 hover:bg-red-500/10 hover:text-red-600 transition"
            >
              <X className="h-3 w-3" />
              Remove Intro
            </button>
          ) : (
            <button
              onClick={handleAddIntro}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-emerald-600 hover:bg-emerald-500/10 transition"
            >
              <Plus className="h-3 w-3" />
              Add Intro
            </button>
          )}
          {hasOutro ? (
            <button
              onClick={() => handleRemoveCard("outro_card")}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-rose-600 hover:bg-red-500/10 hover:text-red-600 transition"
            >
              <X className="h-3 w-3" />
              Remove Outro
            </button>
          ) : (
            <button
              onClick={handleAddOutro}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-rose-600 hover:bg-rose-500/10 transition"
            >
              <Plus className="h-3 w-3" />
              Add Outro
            </button>
          )}
          <div className="mx-1 h-4 w-px bg-border" />
          <button
            onClick={handleAddScene}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-500/10 transition"
          >
            <Plus className="h-3 w-3" />
            Add Scene
          </button>
        </div>
        <TimelineToolbar
          zoom={zoom}
          onZoomIn={() => setZoom((z) => Math.min(z * 1.5, 8))}
          onZoomOut={() => setZoom((z) => Math.max(z / 1.5, 0.25))}
          onZoomChange={setZoom}
          snapEnabled={snapEnabled}
          onToggleSnap={() => setSnapEnabled((s) => !s)}
          onSplitAtPlayhead={handleSplitAtPlayhead}
          canUndo={manifestHistory.canUndo}
          canRedo={manifestHistory.canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
        />
        <TimelineRuler
          totalFrames={totalFrames}
          fps={draft.manifest?.composition?.fps ?? 30}
          currentFrame={currentFrame}
          zoom={zoom}
          onSeek={handleSeek}
        />
        <TimelineTracks
          tracks={tracks}
          totalFrames={totalFrames}
          currentFrame={currentFrame}
          fps={draft.manifest?.composition?.fps ?? 30}
          onSelectScene={handleSelectScene}
          onSeek={handleSeek}
          manifest={draft.manifest}
          onReorderScenes={handleReorderScenes}
        />
      </div>
    </div>
  );
}
