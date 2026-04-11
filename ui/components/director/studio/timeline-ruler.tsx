"use client";

import { useRef, useEffect, useCallback } from "react";

interface TimelineRulerProps {
  totalFrames: number;
  fps: number;
  currentFrame: number;
  zoom: number; // 0.5 = half, 1 = normal, 2 = double
  onSeek: (frame: number) => void;
}

/**
 * Canvas-based time ruler with zoom support and playhead indicator.
 * #824 — Enhanced Timeline Editor
 */
export function TimelineRuler({
  totalFrames,
  fps,
  currentFrame,
  zoom,
  onSeek,
}: TimelineRulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const totalDuration = fps > 0 ? totalFrames / fps : 0;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    // Background
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, width, height);

    const effectiveWidth = width * zoom;

    // Compute tick interval based on zoom
    let tickInterval = 1; // seconds
    if (zoom > 2) tickInterval = 0.5;
    if (zoom > 4) tickInterval = 0.25;
    if (zoom < 0.5) tickInterval = 5;
    if (zoom < 0.25) tickInterval = 10;

    // Draw ticks
    ctx.fillStyle = "#e2e8f0";
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 1;
    ctx.font = "10px Inter, sans-serif";
    ctx.textAlign = "center";

    const pxPerSecond = effectiveWidth / Math.max(totalDuration, 1);
    const scrollOffset = 0; // Could be scrolled in container

    for (let t = 0; t <= totalDuration; t += tickInterval) {
      const x = t * pxPerSecond - scrollOffset;
      if (x < 0 || x > width) continue;

      const isMajor = t % (tickInterval * 5) < 0.001 || tickInterval >= 1;
      const tickH = isMajor ? 16 : 8;

      ctx.beginPath();
      ctx.moveTo(x, height - tickH);
      ctx.lineTo(x, height);
      ctx.stroke();

      if (isMajor) {
        const minutes = Math.floor(t / 60);
        const seconds = Math.floor(t % 60);
        const label = `${minutes}:${String(seconds).padStart(2, "0")}`;
        ctx.fillText(label, x, height - tickH - 3);
      }
    }

    // Playhead
    const playheadX =
      fps > 0 ? (currentFrame / fps) * pxPerSecond - scrollOffset : 0;
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.moveTo(playheadX - 5, 0);
    ctx.lineTo(playheadX + 5, 0);
    ctx.lineTo(playheadX, 8);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
  }, [totalFrames, fps, currentFrame, zoom, totalDuration]);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        canvas.width = width;
        canvas.height = 36;
        draw();
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [draw]);

  // Redraw on state change
  useEffect(() => {
    draw();
  }, [draw]);

  // Click to seek
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const effectiveWidth = canvas.width * zoom;
      const pxPerSecond = effectiveWidth / Math.max(totalDuration, 1);
      const t = x / pxPerSecond;
      const frame = Math.round(t * fps);
      onSeek(Math.max(0, Math.min(frame, totalFrames)));
    },
    [zoom, totalDuration, fps, totalFrames, onSeek],
  );

  return (
    <div
      ref={containerRef}
      className="w-full h-9 relative"
      data-testid="timeline-ruler"
    >
      <canvas
        ref={canvasRef}
        height={36}
        className="w-full h-full cursor-pointer"
        onClick={handleClick}
      />
    </div>
  );
}
