"use client";

import { useEffect, useCallback, useImperativeHandle, useRef, useMemo, type MutableRefObject } from "react";
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
  const fps = manifest?.composition?.fps ?? 30;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameRef = useRef(currentFrame);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Keep frame ref in sync
  useEffect(() => {
    frameRef.current = currentFrame;
  }, [currentFrame]);

  // Find current scene for preview
  const currentScene = manifest?.timeline?.find((e) => {
    if (e.type !== "image_scene" && e.type !== "video_clip" && e.type !== "title_card" && e.type !== "intro_card" && e.type !== "outro_card") return false;
    const start = e.startAtFrame ?? 0;
    const dur = e.duration ?? e.durationInFrames ?? 0;
    return currentFrame >= start && currentFrame < start + dur;
  });

  // Sync <video> currentTime with the scrubber frame for video_clip entries
  const isVideoClip = currentScene?.type === "video_clip" && !!currentScene.source;
  const trimStartFrames = isVideoClip ? (Number(currentScene.trimStart) || 0) : 0;
  const sceneStartFrame = currentScene?.startAtFrame ?? 0;

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !isVideoClip) return;
    // Map composition frame → source video time, accounting for trimStart
    const frameInClip = currentFrame - sceneStartFrame;
    const sourceTime = (trimStartFrames + frameInClip) / fps;
    // Only seek if difference is significant (avoid micro-seeks during playback)
    if (Math.abs(vid.currentTime - sourceTime) > 0.15) {
      vid.currentTime = sourceTime;
    }
  }, [currentFrame, isVideoClip, trimStartFrames, sceneStartFrame, fps]);

  // Play/pause the actual <video> element in sync
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !isVideoClip) return;
    if (isPlaying) {
      vid.play().catch(() => {});
    } else {
      vid.pause();
    }
  }, [isPlaying, isVideoClip]);

  // When the <video> loads, seek to the trimStart position
  const handleVideoLoaded = useCallback(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const frameInClip = currentFrame - sceneStartFrame;
    vid.currentTime = (trimStartFrames + Math.max(0, frameInClip)) / fps;
  }, [trimStartFrames, sceneStartFrame, currentFrame, fps]);

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

  // Compute 9:16 vertical crop style for video_clip
  const isVertical = manifest?.composition?.height === 1920;
  const cropOffset = isVideoClip ? (Number(currentScene.horizontalCropOffset) ?? 50) : 50;
  const fitMode = isVideoClip ? (currentScene.fitMode as string ?? "cover") : "cover";

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
        {/* Draft preview badge */}
        <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded bg-amber-500/90 px-2 py-0.5 text-[10px] font-semibold text-black shadow">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-black/60 animate-pulse" />
          DRAFT PREVIEW
        </div>
        {isVideoClip ? (
          <div
            className="relative flex h-full items-center justify-center overflow-hidden"
            style={isVertical ? { aspectRatio: "9/16", maxHeight: "100%" } : undefined}
          >
            <video
              ref={videoRef}
              src={`/api/admin/director/files/${encodeURIComponent(String(currentScene.source).split("/").pop() ?? "")}`}
              className="h-full"
              style={
                isVertical
                  ? fitMode === "contain"
                    ? { objectFit: "contain" as const, maxWidth: "100%", maxHeight: "100%" }
                    : { objectFit: "cover" as const, objectPosition: `${cropOffset}% center` }
                  : { objectFit: "contain" as const, maxWidth: "100%", maxHeight: "100%" }
              }
              muted
              playsInline
              onLoadedMetadata={handleVideoLoaded}
            />
            {/* Script text overlay — simulates what Remotion renders */}
            <ScriptTextOverlay
              manifest={manifest}
              currentFrame={currentFrame}
            />
          </div>
        ) : currentScene?.src ? (
          <div
            className="relative flex items-center justify-center overflow-hidden bg-black"
            style={isVertical
              ? { aspectRatio: "9/16", height: "100%", maxHeight: "100%" }
              : { width: "100%", height: "100%" }}
          >
            <img
              src={`/api/admin/director/files/${encodeURIComponent(currentScene.src.split("/").pop() ?? "")}`}
              alt="Scene preview"
              className="h-full w-full object-cover"
            />
            <ScriptTextOverlay
              manifest={manifest}
              currentFrame={currentFrame}
            />
          </div>
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

        {/* Render info */}
        <div className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-0.5 text-[9px] text-white/50">
          Captions &amp; effects render with final video
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

/**
 * Simulates the Remotion SmartCaptions and scriptText overlays in the preview.
 * Shows the current scene's script text at the bottom of the video,
 * and karaoke-style caption words when a SmartCaptions overlay exists.
 */
function ScriptTextOverlay({
  manifest,
  currentFrame,
}: {
  manifest: DirectorManifest;
  currentFrame: number;
}) {
  // Find SmartCaptions overlay
  const captionOverlay = manifest.timeline?.find(
    (e) => e.type === "overlay" && (e as Record<string, unknown>).component === "SmartCaptions",
  );
  const captionProps = captionOverlay
    ? ((captionOverlay as Record<string, unknown>).props as Record<string, unknown> | undefined)
    : undefined;
  const words = captionProps?.words as Array<{ word: string; start: number; end: number }> | undefined;
  const captionStyle = (captionProps?.style as string) ?? "karaoke";
  const captionPosition = (captionProps?.position as string) ?? "bottom";

  // Find current scene's scriptText
  const currentScene = manifest.timeline?.find((e) => {
    if (e.type !== "video_clip" && e.type !== "image_scene") return false;
    const start = e.startAtFrame ?? 0;
    const dur = e.duration ?? e.durationInFrames ?? 0;
    return currentFrame >= start && currentFrame < start + dur;
  });
  const scriptText = currentScene?.scriptText as string | undefined;

  // Get active caption words for current frame.
  // If no word is active yet, show the next upcoming group so captions are
  // visible at frame 0 / before playback starts.
  const activeWords = useMemo(() => {
    if (!words || words.length === 0) return [];
    const activeIdx = words.findIndex((w) => w.start <= currentFrame && w.end >= currentFrame);
    if (activeIdx !== -1) {
      const windowStart = Math.max(0, activeIdx - 1);
      const windowEnd = Math.min(words.length, activeIdx + 6);
      return words.slice(windowStart, windowEnd).filter((w) => w.start <= currentFrame + 30);
    }
    // No active word — show the next upcoming group as a preview
    const nextIdx = words.findIndex((w) => w.start > currentFrame);
    if (nextIdx === -1) return [];
    return words.slice(nextIdx, nextIdx + 6);
  }, [words, currentFrame]);

  if (!scriptText && activeWords.length === 0) return null;

  return (
    <>
      {/* Caption words */}
      {activeWords.length > 0 && (
        <div
          className={`absolute left-0 right-0 flex flex-wrap items-center justify-center gap-1 px-3 pointer-events-none ${
            captionPosition === "top" ? "top-[8%]" : captionPosition === "center" ? "top-1/2 -translate-y-1/2" : "bottom-[12%]"
          }`}
        >
          {captionStyle === "boxed" && (
            <div className="absolute inset-0 -mx-1 -my-0.5 rounded-md bg-black/60" />
          )}
          {activeWords.map((w, i) => {
            const isActive = w.start <= currentFrame && w.end >= currentFrame;
            const isFuture = w.start > currentFrame;
            return (
              <span
                key={`${w.word}-${w.start}-${i}`}
                className="relative text-white font-bold transition-all duration-100"
                style={getPreviewWordStyle(captionStyle, isActive, isFuture)}
              >
                {w.word}
              </span>
            );
          })}
        </div>
      )}

      {/* Script text (narration) */}
      {scriptText && (
        <div className="absolute bottom-[2%] left-0 right-0 flex justify-center px-2 pointer-events-none">
          <p
            className="max-w-[90%] truncate rounded bg-black/60 px-2 py-0.5 text-center text-white/70"
            style={{ fontSize: "clamp(8px, 1.5vw, 11px)" }}
          >
            {scriptText}
          </p>
        </div>
      )}
    </>
  );
}

function getPreviewWordStyle(
  style: string,
  isActive: boolean,
  isFuture: boolean,
): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: "clamp(14px, 3.5vw, 24px)",
    opacity: isFuture ? 0.4 : isActive ? 1 : 0.5,
    textShadow: "0 2px 4px rgba(0,0,0,0.8)",
  };

  switch (style) {
    case "pill":
      return {
        ...base,
        color: "#ffffff",
        backgroundColor: isActive ? "rgba(0,0,0,0.75)" : "transparent",
        borderRadius: 12,
        padding: "2px 8px",
      };
    case "underline":
      return {
        ...base,
        color: "#ffffff",
        borderBottom: isActive ? "2px solid #ffffff" : "2px solid transparent",
        paddingBottom: 2,
      };
    case "boxed":
      return {
        ...base,
        color: "#ffffff",
        transform: isActive ? "scale(1.1)" : "scale(1)",
        fontWeight: isActive ? 800 : 600,
      };
    case "karaoke":
    default:
      return {
        ...base,
        color: isActive ? "#facc15" : "#ffffff",
        transform: isActive ? "scale(1.1)" : "scale(1)",
        textShadow: isActive
          ? "0 0 10px rgba(250, 204, 21, 0.5), 0 2px 4px rgba(0,0,0,0.8)"
          : "0 2px 4px rgba(0,0,0,0.8)",
      };
  }
}
