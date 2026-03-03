"use client";

import { useRef, useCallback } from "react";
import type { TimelineTrack, TimelineEntry, DirectorManifest } from "../types";

interface TimelineTracksProps {
  tracks: TimelineTrack[];
  totalFrames: number;
  currentFrame: number;
  fps: number;
  onSelectScene: (sceneIndex: number, entry: TimelineEntry) => void;
  onSeek: (frame: number) => void;
  manifest: DirectorManifest | null;
}

export function TimelineTracks({
  tracks,
  totalFrames,
  currentFrame,
  fps,
  onSelectScene,
  onSeek,
  manifest,
}: TimelineTracksProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleTrackClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current || totalFrames === 0) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const fraction = Math.max(0, Math.min(1, x / rect.width));
      onSeek(Math.round(fraction * totalFrames));
    },
    [totalFrames, onSeek],
  );

  const handleEntryClick = useCallback(
    (timelineIndex: number, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!manifest) return;
      const tl = manifest.timeline ?? [];
      const entry = tl[timelineIndex];
      if (!entry) return;

      // Compute scene index among visual scenes (image_scene / video_clip only)
      // to stay consistent with SceneInspector's entry derivation.
      // Card types (intro_card, outro_card, title_card) are matched by type, not index.
      const visualTypes = new Set(["image_scene", "video_clip"]);
      let sceneIdx = 0;
      for (let i = 0; i < tl.length; i++) {
        if (i === timelineIndex) break;
        if (visualTypes.has(tl[i].type)) sceneIdx++;
      }
      onSelectScene(sceneIdx, entry);
    },
    [manifest, onSelectScene],
  );

  const playheadPercent = totalFrames > 0 ? (currentFrame / totalFrames) * 100 : 0;

  // Time markers
  const markerCount = Math.min(10, Math.max(2, Math.floor(totalFrames / fps / 5)));
  const markers = Array.from({ length: markerCount + 1 }, (_, i) => {
    const frame = Math.round((i / markerCount) * totalFrames);
    const sec = frame / fps;
    const min = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return { frame, label: `${min}:${String(s).padStart(2, "0")}` };
  });

  return (
    <div className="flex flex-col bg-muted/30">
      {/* Time ruler */}
      <div className="relative flex h-6 items-end border-b border-border px-0" ref={containerRef} onClick={handleTrackClick}>
        {markers.map((m) => (
          <div
            key={m.frame}
            className="absolute bottom-0 text-[10px] text-muted-foreground"
            style={{ left: totalFrames > 0 ? `${(m.frame / totalFrames) * 100}%` : "0%" }}
          >
            <div className="h-2 w-px bg-border" />
            <span className="ml-0.5">{m.label}</span>
          </div>
        ))}
        {/* Playhead on ruler */}
        <div
          className="absolute bottom-0 top-0 w-0.5 bg-red-500 z-10"
          style={{ left: `${playheadPercent}%` }}
        />
      </div>

      {/* Tracks */}
      <div className="relative max-h-[200px] overflow-y-auto">
        {tracks.map((track) => (
          <div key={track.id} className="flex h-10 items-center border-b border-border last:border-0">
            {/* Track label */}
            <div className="w-24 shrink-0 border-r border-border px-2 text-[11px] font-medium text-muted-foreground truncate">
              {track.label}
            </div>
            {/* Track content */}
            <div className="relative flex-1 h-full" onClick={handleTrackClick}>
              {track.entries.map((entry, i) => {
                const left = totalFrames > 0 ? (entry.startFrame / totalFrames) * 100 : 0;
                const width = totalFrames > 0 ? (entry.durationFrames / totalFrames) * 100 : 0;
                return (
                  <button
                    key={`${entry.timelineIndex}-${i}`}
                    className={`absolute top-1 bottom-1 rounded-sm ${entry.color} text-[10px] font-medium text-white px-1 truncate hover:brightness-110 transition cursor-pointer`}
                    style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
                    title={entry.label}
                    onClick={(e) => handleEntryClick(entry.timelineIndex, e)}
                  >
                    {entry.label}
                  </button>
                );
              })}
              {/* Playhead */}
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10 pointer-events-none"
                style={{ left: `${playheadPercent}%` }}
              />
            </div>
          </div>
        ))}

        {tracks.every((t) => t.entries.length === 0) && (
          <div className="flex h-20 items-center justify-center text-xs text-muted-foreground">
            No timeline entries
          </div>
        )}
      </div>
    </div>
  );
}
