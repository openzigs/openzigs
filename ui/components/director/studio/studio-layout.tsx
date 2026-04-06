"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { fetchJson } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { showToast } from "@/components/toast";
import { StudioToolbar } from "./studio-toolbar";
import { PlayerPreview } from "./player-preview";
import { SceneInspector } from "./scene-inspector";
import { CaptionStylePanel } from "./caption-style-panel";
import { TimelineTracks } from "./timeline-tracks";
import { AudioManager } from "./audio-manager";
import { ShortsProposalPanel } from "./shorts-proposal-panel";
import { ClipExtractorPanel } from "./clip-extractor-panel";
import { AudioCleanerPanel } from "./audio-cleaner-panel";
import { BRollPanel } from "./broll-panel";
import { NLEExportPanel } from "./nle-export-panel";
import { Plus, X } from "lucide-react";
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
        // Transitions are visual bridges, shown as thin markers on scene track
        break;
    }
  }

  // Global voiceover track (e.g. Shorts pipeline)
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

  // Music track
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

export function StudioLayout({ draftId }: { draftId: string }) {
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

  // Listen for render events via Socket.IO
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
      // Reload draft to reflect updated status
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

  const handleManifestUpdate = useCallback((manifest: DirectorManifest) => {
    setDraft((prev) => (prev ? { ...prev, manifest } : prev));
    setTracks(buildTracks(manifest));
    setDirty(true);
  }, []);

  const hasIntro =
    draft?.manifest?.timeline?.some((e) => e.type === "intro_card") ?? false;
  const hasOutro =
    draft?.manifest?.timeline?.some((e) => e.type === "outro_card") ?? false;

  const handleAddScene = useCallback(() => {
    if (!draft?.manifest) return;
    const fps = draft.manifest.composition?.fps ?? 30;
    const timeline = draft.manifest.timeline ?? [];
    const sceneDuration = fps * 3; // 3 seconds default

    // Insert after the currently selected scene, or at the end of scenes
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
      // Find last visual scene
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

    // Recalculate startAtFrame for entries after the insertion
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

      // Recalculate startAtFrame
      let frame = 0;
      for (const entry of updated) {
        entry.startAtFrame = frame;
        frame += entry.duration ?? entry.durationInFrames ?? fps * 3;
      }

      handleManifestUpdate({ ...draft.manifest, timeline: updated });
      // Clear inspector if deleted scene was selected
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
    const introDuration = fps * 4; // 4 seconds

    // Shift all existing entries forward
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
    const outroDuration = fps * 4; // 4 seconds

    const timeline = draft.manifest.timeline ?? [];

    // Only look at visual scene entries — overlays and transitions are positioned
    // relative to scenes and must not push the outro position further out.
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

      // Recalculate startAtFrame
      let frame = 0;
      for (const entry of updated) {
        entry.startAtFrame = frame;
        frame += entry.duration ?? entry.durationInFrames ?? fps * 3;
      }

      handleManifestUpdate({ ...draft.manifest, timeline: updated });
      // Clear inspector if the removed card was selected
      const selectedEntry = inspector.entry;
      if (selectedEntry?.type === cardType) {
        setInspector({ sceneIndex: null, entry: null });
      }
    },
    [draft, inspector.entry, handleManifestUpdate],
  );

  // Auto-save every 30 seconds when dirty
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
        .catch(() => {
          /* silent — user can still manual save */
        });
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

      // Auto-sync inspector to the scene at the current frame during playback
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

      // Collect visual scene timeline indices
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

      // Recalculate startAtFrame for all entries
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

      {/* Render progress banner */}
      {renderStatus && (
        <div className="flex items-center gap-3 border-b border-border bg-primary/10 px-4 py-2">
          <div className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          <span className="text-xs font-medium text-foreground">
            Rendering… {Math.round(renderStatus.progress * 100)}%
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${Math.round(renderStatus.progress * 100)}%` }}
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

        {/* Right: Inspector */}
        <div className="w-2/5 overflow-y-auto p-4">
          <SceneInspector
            inspector={inspector}
            manifest={draft.manifest}
            draftId={draftId}
            onManifestUpdate={handleManifestUpdate}
            onDeleteScene={handleDeleteScene}
            onRemoveCard={handleRemoveCard}
          />

          {/* Global caption settings */}
          {draft.manifest && (
            <div className="mt-4">
              <CaptionStylePanel
                manifest={draft.manifest}
                onManifestUpdate={handleManifestUpdate}
              />
            </div>
          )}

          {/* Audio / Music management */}
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

          {/* Shorts Generator */}
          <div className="mt-4">
            <ShortsProposalPanel draftId={draftId} />
          </div>

          {/* Clip Extractor */}
          <div className="mt-4">
            <ClipExtractorPanel draftId={draftId} />
          </div>

          {/* Audio Cleaner */}
          <div className="mt-4">
            <AudioCleanerPanel draftId={draftId} />
          </div>

          {/* B-Roll Suggestions */}
          <div className="mt-4">
            <BRollPanel draftId={draftId} />
          </div>

          {/* NLE Export */}
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
        {/* Intro/Outro controls */}
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
