"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { fetchJson } from "@/lib/api";
import { StudioToolbar } from "./studio-toolbar";
import { PlayerPreview } from "./player-preview";
import { SceneInspector } from "./scene-inspector";
import { TimelineTracks } from "./timeline-tracks";
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
        scenesEntries.push({
          timelineIndex: i,
          startFrame,
          durationFrames: dur,
          label: entry.title ?? entry.scriptText?.slice(0, 30) ?? `Scene ${sceneCounter}`,
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
          label: (entry as Record<string, unknown>).component as string ?? "Overlay",
          color: "bg-teal-500/70",
        });
        break;
      case "transition":
        // Transitions are visual bridges, shown as thin markers on scene track
        break;
    }
  }

  // Music track
  if (manifest.audioLayer?.music) {
    const totalFrames = timeline.reduce((max, e) => {
      const end = (e.startAtFrame ?? 0) + (e.duration ?? e.durationInFrames ?? 0);
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
    { id: "scenes", label: "Scenes", type: "scenes" as const, entries: scenesEntries },
    { id: "voiceover", label: "Voiceover", type: "voiceover" as const, entries: voiceoverEntries },
    { id: "overlay", label: "Overlays", type: "overlay" as const, entries: overlayEntries },
    { id: "audio", label: "Audio", type: "audio" as const, entries: audioEntries },
  ];
}

export function StudioLayout({ draftId }: { draftId: string }) {
  const [draft, setDraft] = useState<DraftFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [inspector, setInspector] = useState<InspectorState>({ sceneIndex: null, entry: null });
  const [tracks, setTracks] = useState<TimelineTrack[]>([]);
  const [dirty, setDirty] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const playerRef = useRef<{ seekTo: (frame: number) => void; play: () => void; pause: () => void } | null>(null);

  const loadDraft = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchJson<DraftFull>(`/api/admin/director/drafts/${draftId}`);
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
    setDraft((prev) => prev ? { ...prev, manifest } : prev);
    setTracks(buildTracks(manifest));
    setDirty(true);
  }, []);

  // Auto-save every 30 seconds when dirty
  useEffect(() => {
    if (!dirty || !draft?.manifest) return;
    const timer = setTimeout(() => {
      fetchJson(`/api/admin/director/drafts/${draftId}`, {
        method: "PUT",
        body: JSON.stringify({ manifest: draft.manifest, title: draft.title }),
      }).then(() => {
        setDirty(false);
        setLastSaved(new Date().toISOString());
      }).catch(() => { /* silent — user can still manual save */ });
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

  const handleFrameChange = useCallback((frame: number) => {
    setCurrentFrame(frame);
  }, []);

  const handleSeek = useCallback((frame: number) => {
    setCurrentFrame(frame);
    playerRef.current?.seekTo(frame);
  }, []);

  const totalFrames = draft?.manifest?.timeline
    ? draft.manifest.timeline.reduce((max: number, e: TimelineEntry) => {
        const end = (e.startAtFrame ?? 0) + (e.duration ?? e.durationInFrames ?? 0);
        return Math.max(max, end);
      }, 0)
    : 0;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading studio…</div>
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
        draftId={draftId}
        manifest={draft.manifest}
        dirty={dirty}
        lastSaved={lastSaved}
      />

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
          />
        </div>
      </div>

      {/* Bottom: Timeline */}
      <div className="shrink-0 border-t border-border">
        <TimelineTracks
          tracks={tracks}
          totalFrames={totalFrames}
          currentFrame={currentFrame}
          fps={draft.manifest?.composition?.fps ?? 30}
          onSelectScene={handleSelectScene}
          onSeek={handleSeek}
          manifest={draft.manifest}
        />
      </div>
    </div>
  );
}
