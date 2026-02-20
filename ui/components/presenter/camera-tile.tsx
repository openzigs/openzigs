"use client";

import { useRef, useEffect, useState, useCallback, memo } from "react";
import { VideoOff } from "lucide-react";

interface CameraTileProps {
  stream: MediaStream | null;
  isVideoMuted: boolean;
  /** Label text shown on the tile (e.g. "You") */
  label?: string;
}

/**
 * Teams-style draggable Picture-in-Picture camera tile that overlays
 * the presentation video. Defaults to bottom-right and can be dragged
 * to any corner. Always renders a single <video> element to keep the
 * ref stable — shows VideoOff overlay when the camera track is disabled.
 */
export const CameraTile = memo(function CameraTile({
  stream,
  isVideoMuted,
  label = "You",
}: CameraTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);

  // Corner-based resting position; live pixel position while dragging
  const [corner, setCorner] = useState<"br" | "bl" | "tr" | "tl">("br");
  const [dragPos, setDragPos] = useState<{ left: number; top: number } | null>(null);
  const dragOrigin = useRef<{ pointerX: number; pointerY: number; tileLeft: number; tileTop: number } | null>(null);

  // Attach stream to the single video element. Re-run when stream ref changes.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (stream) {
      el.srcObject = stream;
      el.play()?.catch(() => {/* autoplay blocked — expected when muted */});
    } else {
      el.srcObject = null;
    }
    return () => {
      el.srcObject = null;
    };
  }, [stream]);

  const hasVideo = stream
    ? stream.getVideoTracks().some((t) => t.enabled) && !isVideoMuted
    : false;

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const tile = tileRef.current;
    if (!tile) return;
    const rect = tile.getBoundingClientRect();
    const parent = tile.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    dragOrigin.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      tileLeft: rect.left - parentRect.left,
      tileTop: rect.top - parentRect.top,
    };
    tile.setPointerCapture(e.pointerId);
    setDragPos({ left: rect.left - parentRect.left, top: rect.top - parentRect.top });
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragOrigin.current || !tileRef.current) return;
    const tile = tileRef.current;
    const parent = tile.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const dx = e.clientX - dragOrigin.current.pointerX;
    const dy = e.clientY - dragOrigin.current.pointerY;
    const newLeft = dragOrigin.current.tileLeft + dx;
    const newTop = dragOrigin.current.tileTop + dy;
    const maxLeft = parentRect.width - tile.offsetWidth;
    const maxTop = parentRect.height - tile.offsetHeight;
    setDragPos({
      left: Math.max(0, Math.min(newLeft, maxLeft)),
      top: Math.max(0, Math.min(newTop, maxTop)),
    });
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragOrigin.current || !tileRef.current) return;
    const dx = e.clientX - dragOrigin.current.pointerX;
    const dy = e.clientY - dragOrigin.current.pointerY;
    dragOrigin.current = null;
    setDragPos(null);
    // Treat tiny movements as clicks, not drags
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    const parent = tileRef.current.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const cx = e.clientX - parentRect.left;
    const cy = e.clientY - parentRect.top;
    if (cy > parentRect.height / 2 && cx > parentRect.width / 2) setCorner("br");
    else if (cy > parentRect.height / 2) setCorner("bl");
    else if (cx > parentRect.width / 2) setCorner("tr");
    else setCorner("tl");
  }, []);

  const cornerStyle: React.CSSProperties = {
    br: { bottom: 12, right: 12 },
    bl: { bottom: 12, left: 12 },
    tr: { top: 12, right: 12 },
    tl: { top: 12, left: 12 },
  }[corner];

  const posStyle: React.CSSProperties = dragPos
    ? { left: dragPos.left, top: dragPos.top, transition: "none" }
    : { ...cornerStyle, transition: "all 0.2s ease" };

  if (!stream) return null;

  return (
    <div
      ref={tileRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={posStyle}
      className="absolute z-10 h-20 w-28 cursor-grab select-none touch-none overflow-hidden rounded-xl border-2 border-white/20 shadow-2xl active:cursor-grabbing sm:h-24 sm:w-36 md:h-28 md:w-40"
    >
      {/* Single stable <video> — always mounted so srcObject stays attached */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`pointer-events-none h-full w-full object-cover ${hasVideo ? "" : "hidden"}`}
        style={{ transform: "scaleX(-1)" }}
      />
      {/* Camera-off overlay */}
      {!hasVideo && (
        <div className="pointer-events-none flex h-full w-full items-center justify-center bg-zinc-800">
          <VideoOff className="h-5 w-5 text-zinc-500" />
        </div>
      )}
      <div className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-white backdrop-blur sm:text-[10px]">
        {label}
      </div>
    </div>
  );
});
