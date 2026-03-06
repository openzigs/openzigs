"use client";

import { useRef, useCallback, useMemo } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TimelineTrack, TimelineTrackEntry, TimelineEntry, DirectorManifest } from "../types";

interface TimelineTracksProps {
  tracks: TimelineTrack[];
  totalFrames: number;
  currentFrame: number;
  fps: number;
  onSelectScene: (sceneIndex: number, entry: TimelineEntry) => void;
  onSeek: (frame: number) => void;
  manifest: DirectorManifest | null;
  onReorderScenes?: (fromIndex: number, toIndex: number) => void;
}

// ── Sortable Scene Entry ──────────────────────────────────────
interface SortableEntryProps {
  entry: TimelineTrackEntry;
  totalFrames: number;
  onClick: (e: React.MouseEvent) => void;
}

function SortableEntry({ entry, totalFrames, onClick }: SortableEntryProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `scene-${entry.timelineIndex}` });

  const left = totalFrames > 0 ? (entry.startFrame / totalFrames) * 100 : 0;
  const width = totalFrames > 0 ? (entry.durationFrames / totalFrames) * 100 : 0;

  const style = {
    left: `${left}%`,
    width: `${Math.max(width, 0.5)}%`,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`absolute top-1 bottom-1 rounded-sm ${entry.color} text-[10px] font-medium text-white px-1 truncate hover:brightness-110 transition cursor-grab active:cursor-grabbing`}
      style={style}
      title={`${entry.label} (drag to reorder)`}
      onClick={onClick}
      data-testid={`scene-entry-${entry.timelineIndex}`}
    >
      {entry.label}
    </button>
  );
}

export function TimelineTracks({
  tracks,
  totalFrames,
  currentFrame,
  fps,
  onSelectScene,
  onSeek,
  manifest,
  onReorderScenes,
}: TimelineTracksProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

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

  // DnD scene reorder
  const scenesTrack = tracks.find((t) => t.type === "scenes");
  const sortableIds = useMemo(
    () => (scenesTrack?.entries ?? []).map((e) => `scene-${e.timelineIndex}`),
    [scenesTrack],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || !onReorderScenes || !scenesTrack) return;

      const oldIdx = scenesTrack.entries.findIndex((e) => `scene-${e.timelineIndex}` === active.id);
      const newIdx = scenesTrack.entries.findIndex((e) => `scene-${e.timelineIndex}` === over.id);
      if (oldIdx === -1 || newIdx === -1) return;

      onReorderScenes(oldIdx, newIdx);
    },
    [onReorderScenes, scenesTrack],
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
    <div className="flex flex-col bg-muted/30" data-testid="timeline-tracks">
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
        <div
          className="absolute bottom-0 top-0 w-0.5 bg-red-500 z-10"
          style={{ left: `${playheadPercent}%` }}
        />
      </div>

      {/* Tracks */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="relative max-h-[200px] overflow-y-auto">
          {tracks.map((track) => (
            <div key={track.id} className="flex h-10 items-center border-b border-border last:border-0">
              <div className="w-24 shrink-0 border-r border-border px-2 text-[11px] font-medium text-muted-foreground truncate">
                {track.label}
              </div>
              <div className="relative flex-1 h-full" onClick={handleTrackClick}>
                {track.type === "scenes" ? (
                  <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
                    {track.entries.map((entry) => (
                      <SortableEntry
                        key={`${entry.timelineIndex}`}
                        entry={entry}
                        totalFrames={totalFrames}
                        onClick={(e) => handleEntryClick(entry.timelineIndex, e)}
                      />
                    ))}
                  </SortableContext>
                ) : (
                  track.entries.map((entry, i) => {
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
                  })
                )}
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
      </DndContext>
    </div>
  );
}
