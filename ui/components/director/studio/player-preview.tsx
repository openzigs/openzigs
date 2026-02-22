"use client";

import { useEffect, useCallback, useImperativeHandle, useRef, type MutableRefObject } from "react";
import { Play, Pause } from "lucide-react";
import type { DirectorManifest } from "../types";

interface PlayerPreviewProps {
  manifest: DirectorManifest | null;
  totalFrames: number;
  currentFrame: number;
  isPlaying: boolean;
  onPlayingChange: (playing: boolean) => void;
  onFrameChange: (frame: number) => void;
  playerRef: MutableRefObject<{
    seekTo: (frame: number) => void;
    play: () => void;
    pause: () => void;
  } | null>;
}

export function PlayerPreview({
  manifest,
  totalFrames,
  currentFrame,
  isPlaying,
  onPlayingChange,
  onFrameChange,
  playerRef,
}: PlayerPreviewProps) {
  const fps = manifest?.composition.fps ?? 30;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameRef = useRef(currentFrame);

  // Keep frame ref in sync
  useEffect(() => {
    frameRef.current = currentFrame;
  }, [currentFrame]);

  // Simple playback simulation (the actual @remotion/player integration requires
  // bundling the Remotion composition which lives in the backend project).
  // This preview shows a frame-accurate scrubber with scene thumbnails.
  const play = useCallback(() => {
    onPlayingChange(true);
    intervalRef.current = setInterval(() => {
      frameRef.current += 1;
      if (frameRef.current >= totalFrames) {
        frameRef.current = 0;
      }
      onFrameChange(frameRef.current);
    }, 1000 / fps);
  }, [fps, totalFrames, onFrameChange, onPlayingChange]);

  const pause = useCallback(() => {
    onPlayingChange(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, [onPlayingChange]);

  const seekTo = useCallback(
    (frame: number) => {
      frameRef.current = Math.max(0, Math.min(frame, totalFrames - 1));
      onFrameChange(frameRef.current);
    },
    [totalFrames, onFrameChange],
  );

  // Expose player controls to parent
  useImperativeHandle(
    playerRef,
    () => ({ seekTo, play, pause }),
    [seekTo, play, pause],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const formatTime = (frame: number) => {
    const totalSec = frame / fps;
    const min = Math.floor(totalSec / 60);
    const sec = Math.floor(totalSec % 60);
    return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  // Find current scene for preview
  const currentScene = manifest?.timeline.find((e) => {
    if (e.type !== "image_scene" && e.type !== "video_clip" && e.type !== "title_card" && e.type !== "intro_card" && e.type !== "outro_card") return false;
    const start = e.startAtFrame ?? 0;
    const dur = e.duration ?? e.durationInFrames ?? 0;
    return currentFrame >= start && currentFrame < start + dur;
  });

  if (!manifest) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border">
        <p className="text-sm text-muted-foreground">No manifest loaded</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Preview area */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-lg bg-black">
        {currentScene?.src ? (
          <img
            src={`/api/admin/director/files/${encodeURIComponent(currentScene.src.split("/").pop() ?? "")}`}
            alt="Scene preview"
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-white/50">
            <Film className="h-12 w-12" />
            <p className="text-sm">
              {currentScene?.title ?? currentScene?.type ?? "No scene at current frame"}
            </p>
          </div>
        )}

        {/* Frame overlay */}
        <div className="absolute bottom-2 right-2 rounded bg-black/70 px-2 py-0.5 text-xs text-white/80 tabular-nums">
          {formatTime(currentFrame)} / {formatTime(totalFrames)}
        </div>
      </div>

      {/* Transport controls */}
      <div className="flex items-center gap-3">
        <button
          onClick={isPlaying ? pause : play}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition"
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
        </button>

        {/* Scrubber */}
        <input
          type="range"
          min={0}
          max={Math.max(totalFrames - 1, 1)}
          value={currentFrame}
          onChange={(e) => seekTo(Number(e.target.value))}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        />

        <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">
          Frame {currentFrame} / {totalFrames}
        </span>
      </div>
    </div>
  );
}

function Film(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M7 3v18M17 3v18M3 7.5h4M17 7.5h4M3 12h18M3 16.5h4M17 16.5h4" />
    </svg>
  );
}
