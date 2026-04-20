"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { SubjectOverlay, type BoundingBox } from "./subject-overlay";

export interface ReframePreviewProps {
  /** Source video URL (16:9). */
  sourceUrl: string;
  /** Reframed (9:16) preview URL. Optional — if omitted, only source plays. */
  reframedUrl?: string;
  /** Subject tracking boxes. */
  boxes?: BoundingBox[];
  /** Optional caption above the preview. */
  caption?: string;
  /** Threshold (s) for treating playback drift as "out of sync". */
  syncToleranceSec?: number;
}

/**
 * Side-by-side preview of source 16:9 and reframed 9:16 video.
 * Both videos play in sync — clicking play/pause/scrub on either keeps
 * the other within `syncToleranceSec` (default 0.05s).
 *
 * Renders the SubjectOverlay on the source player to visualize the tracked
 * subject region. Issue #834.
 */
export function ReframePreview({
  sourceUrl,
  reframedUrl,
  boxes = [],
  caption,
  syncToleranceSec = 0.05,
}: ReframePreviewProps) {
  const sourceRef = useRef<HTMLVideoElement>(null);
  const reframedRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  // Block re-entrant sync events when one player drives the other.
  const syncingRef = useRef(false);

  const syncFrom = useCallback(
    (origin: "source" | "reframed") => {
      if (!reframedRef.current || !sourceRef.current) return;
      if (syncingRef.current) return;
      syncingRef.current = true;
      try {
        const src = sourceRef.current;
        const re = reframedRef.current;
        const driver = origin === "source" ? src : re;
        const follower = origin === "source" ? re : src;
        if (
          Math.abs(driver.currentTime - follower.currentTime) > syncToleranceSec
        ) {
          follower.currentTime = driver.currentTime;
        }
      } finally {
        syncingRef.current = false;
      }
    },
    [syncToleranceSec],
  );

  const handlePlay = useCallback(async () => {
    if (!sourceRef.current) return;
    setPlaying(true);
    await sourceRef.current.play().catch(() => {});
    if (reframedRef.current) {
      await reframedRef.current.play().catch(() => {});
    }
  }, []);

  const handlePause = useCallback(() => {
    setPlaying(false);
    sourceRef.current?.pause();
    reframedRef.current?.pause();
  }, []);

  const togglePlay = useCallback(() => {
    if (playing) handlePause();
    else void handlePlay();
  }, [playing, handlePause, handlePlay]);

  // Keep the follower in sync via timeupdate. We attach to BOTH so whichever
  // player is "ahead" pulls the other along.
  useEffect(() => {
    const src = sourceRef.current;
    const re = reframedRef.current;
    if (!src) return;
    const onSrcTime = () => syncFrom("source");
    const onReTime = () => syncFrom("reframed");
    src.addEventListener("timeupdate", onSrcTime);
    re?.addEventListener("timeupdate", onReTime);
    return () => {
      src.removeEventListener("timeupdate", onSrcTime);
      re?.removeEventListener("timeupdate", onReTime);
    };
  }, [syncFrom, reframedUrl]);

  return (
    <div
      className="rounded-lg border border-border p-3"
      data-testid="reframe-preview"
    >
      {caption && (
        <p className="mb-2 text-[11px] font-medium text-muted-foreground">
          {caption}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Source (16:9)
          </p>
          <div className="relative aspect-video overflow-hidden rounded bg-black">
            <video
              ref={sourceRef}
              src={sourceUrl}
              className="h-full w-full"
              playsInline
              muted
              preload="metadata"
              data-testid="reframe-source-video"
            />
            <SubjectOverlay boxes={boxes} videoRef={sourceRef} />
          </div>
        </div>
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Reframed (9:16)
          </p>
          <div className="relative mx-auto aspect-[9/16] h-32 overflow-hidden rounded bg-black">
            {reframedUrl ? (
              <video
                ref={reframedRef}
                src={reframedUrl}
                className="h-full w-full"
                playsInline
                muted
                preload="metadata"
                data-testid="reframe-reframed-video"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
                Render preview
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? "Pause preview" : "Play preview"}
          className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted"
        >
          {playing ? (
            <Pause className="h-3 w-3" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          {playing ? "Pause" : "Play"}
        </button>
        <span className="text-[10px] text-muted-foreground">
          {boxes.length > 0
            ? `${boxes.length} tracking sample${boxes.length === 1 ? "" : "s"}`
            : "No tracking data"}
        </span>
      </div>
    </div>
  );
}
