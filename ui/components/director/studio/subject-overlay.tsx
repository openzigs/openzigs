"use client";

import { useEffect, useRef, useState } from "react";

export interface BoundingBox {
  /** Time (s) the box applies to. */
  timestamp: number;
  /** Box geometry as fractions of source frame size [0,1]. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SubjectOverlayProps {
  /** Tracking data — boxes ordered by timestamp. */
  boxes: BoundingBox[];
  /** Ref to the underlying <video> for the source frame. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Override frame poll interval (ms). Defaults to ~60 fps via rAF. */
  pollIntervalMs?: number;
  /** Stroke color for the overlay. */
  color?: string;
}

/**
 * Find the closest bounding box for a given time using binary search.
 * Returns the box whose timestamp <= time (the active sample).
 */
export function findBoxAt(
  boxes: BoundingBox[],
  time: number,
): BoundingBox | null {
  if (boxes.length === 0) return null;
  if (time <= boxes[0].timestamp) return boxes[0];
  if (time >= boxes[boxes.length - 1].timestamp) return boxes[boxes.length - 1];

  let lo = 0;
  let hi = boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (boxes[mid].timestamp <= time) lo = mid;
    else hi = mid - 1;
  }
  return boxes[lo];
}

/**
 * SVG bounding-box overlay for AI-tracked subjects on the source 16:9 video.
 * Updates via requestAnimationFrame, synced to `videoRef.current.currentTime`.
 *
 * Renders nothing if no boxes exist or no box applies at the current time.
 * Used inside ReframePreview to visualize the tracking region (#834).
 */
export function SubjectOverlay({
  boxes,
  videoRef,
  pollIntervalMs,
  color = "#3b82f6",
}: SubjectOverlayProps) {
  const [box, setBox] = useState<BoundingBox | null>(() => findBoxAt(boxes, 0));
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (boxes.length === 0) {
      setBox(null);
      return;
    }
    let cancelled = false;
    let lastTime = -1;

    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const t = v.currentTime;
        if (t !== lastTime) {
          lastTime = t;
          const next = findBoxAt(boxes, t);
          setBox((prev) => (prev?.timestamp === next?.timestamp ? prev : next));
        }
      }
      if (cancelled) return;
      if (pollIntervalMs && pollIntervalMs > 0) {
        rafRef.current = window.setTimeout(
          tick,
          pollIntervalMs,
        ) as unknown as number;
      } else {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    tick();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        if (pollIntervalMs && pollIntervalMs > 0) {
          clearTimeout(rafRef.current);
        } else {
          cancelAnimationFrame(rafRef.current);
        }
      }
    };
  }, [boxes, videoRef, pollIntervalMs]);

  if (!box) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      role="img"
      aria-label="Subject tracking overlay"
      data-testid="subject-overlay"
    >
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        fill="none"
        stroke={color}
        strokeWidth={0.005}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
