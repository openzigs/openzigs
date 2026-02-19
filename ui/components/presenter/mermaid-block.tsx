"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

let mermaidInitialized = false;

function initMermaid() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "neutral",
    securityLevel: "antiscript",
    fontFamily: "Inter, system-ui, sans-serif",
  });
  mermaidInitialized = true;
}

let renderCounter = 0;

/**
 * Mermaid node labels containing parentheses, ampersands, or curly braces
 * cause parse errors unless wrapped in double quotes.
 */
function sanitizeMermaidDefinition(def: string): string {
  return def.replace(/\[([^\]"\\]*[()&|{}][^\]"\\]*)\]/g, '["$1"]');
}

const MIN_SCALE = 0.15;
const MAX_SCALE = 5;
const ZOOM_STEP = 0.18;

type XY = { x: number; y: number };
type Transform = XY & { scale: number };

export function MermaidBlock({ definition }: { definition: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });

  // Refs so event handlers always see latest values without stale closures.
  const transformRef = useRef(transform);
  useEffect(() => { transformRef.current = transform; }, [transform]);
  const isDraggingRef = useRef(false);
  const dragOrigin = useRef<{ mouse: XY; tx: number; ty: number }>({ mouse: { x: 0, y: 0 }, tx: 0, ty: 0 });

  /** Center the (unscaled) content inside the viewport. */
  const centerContent = useCallback(() => {
    if (!contentRef.current || !viewportRef.current) return;
    const vW = viewportRef.current.clientWidth;
    const vH = viewportRef.current.clientHeight;
    const cW = contentRef.current.scrollWidth;
    const cH = contentRef.current.scrollHeight;
    setTransform({ x: Math.max(0, (vW - cW) / 2), y: Math.max(0, (vH - cH) / 2), scale: 1 });
  }, []);

  useEffect(() => {
    const sanitized = sanitizeMermaidDefinition(definition);
    if (!sanitized.trim()) return;
    initMermaid();

    let cancelled = false;
    const renderId = `mermaid-${++renderCounter}`;

    void mermaid
      .render(renderId, sanitized)
      .then(({ svg }) => {
        if (cancelled || !contentRef.current) return;
        contentRef.current.innerHTML = svg;
        const svgEl = contentRef.current.querySelector("svg");
        if (svgEl) svgEl.style.maxWidth = "none";
        setError(null);
        requestAnimationFrame(centerContent);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to render diagram");
      });

    return () => { cancelled = true; };
  }, [definition, centerContent]);

  /** Zoom toward the mouse cursor position. */
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1 + ZOOM_STEP : 1 - ZOOM_STEP;
    setTransform((prev) => {
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor));
      const ratio = newScale / prev.scale;
      return { scale: newScale, x: mx - ratio * (mx - prev.x), y: my - ratio * (my - prev.y) };
    });
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const { x, y } = transformRef.current;
    dragOrigin.current = { mouse: { x: e.clientX, y: e.clientY }, tx: x, ty: y };
    isDraggingRef.current = true;
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    const { mouse, tx, ty } = dragOrigin.current;
    setTransform((prev) => ({
      scale: prev.scale,
      x: tx + (e.clientX - mouse.x),
      y: ty + (e.clientY - mouse.y),
    }));
  }, []);

  const stopDrag = useCallback(() => {
    isDraggingRef.current = false;
    setIsDragging(false);
  }, []);

  const zoomIn = () =>
    setTransform((p) => ({ ...p, scale: Math.min(MAX_SCALE, p.scale * (1 + ZOOM_STEP)) }));
  const zoomOut = () =>
    setTransform((p) => ({ ...p, scale: Math.max(MIN_SCALE, p.scale * (1 - ZOOM_STEP)) }));

  if (error) {
    return (
      <div className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-xs text-destructive">Diagram error: {error}</p>
        <pre className="mt-1 text-[10px] text-muted-foreground">{definition}</pre>
      </div>
    );
  }

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-black/10">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border-b border-black/10 bg-gray-100 px-2 py-1">
        <button
          type="button"
          onClick={zoomIn}
          title="Zoom in"
          className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-800"
        >
          <ZoomIn size={13} />
        </button>
        <button
          type="button"
          onClick={zoomOut}
          title="Zoom out"
          className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-800"
        >
          <ZoomOut size={13} />
        </button>
        <button
          type="button"
          onClick={centerContent}
          title="Reset view"
          className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-800"
        >
          <RotateCcw size={13} />
        </button>
        <span className="ml-1 tabular-nums text-[10px] text-gray-400">
          {Math.round(transform.scale * 100)}%
        </span>
        <span className="ml-auto select-none text-[10px] text-gray-400">
          scroll to zoom · drag to pan
        </span>
      </div>

      {/* Viewport */}
      <div
        ref={viewportRef}
        className="relative overflow-hidden bg-white"
        style={{ height: 260, cursor: isDragging ? "grabbing" : "grab" }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
      >
        <div
          ref={contentRef}
          style={{
            position: "absolute",
            transformOrigin: "0 0",
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
        />
      </div>
    </div>
  );
}
