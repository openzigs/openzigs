"use client";

import { ZoomIn, ZoomOut, Scissors, Undo2, Redo2, Magnet } from "lucide-react";

interface TimelineToolbarProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  snapEnabled: boolean;
  onToggleSnap: () => void;
  onSplitAtPlayhead: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

/**
 * Toolbar for the interactive timeline editor.
 * #824 — Enhanced Timeline Editor
 */
export function TimelineToolbar({
  zoom,
  onZoomIn,
  onZoomOut,
  snapEnabled,
  onToggleSnap,
  onSplitAtPlayhead,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: TimelineToolbarProps) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-t border-zinc-700 text-xs"
      data-testid="timeline-toolbar"
    >
      {/* Undo / Redo */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        className="p-1 rounded hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
        title="Undo (Ctrl+Z)"
        data-testid="timeline-undo"
      >
        <Undo2 className="w-4 h-4" />
      </button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        className="p-1 rounded hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
        title="Redo (Ctrl+Shift+Z)"
        data-testid="timeline-redo"
      >
        <Redo2 className="w-4 h-4" />
      </button>

      <div className="w-px h-5 bg-zinc-600" />

      {/* Split */}
      <button
        onClick={onSplitAtPlayhead}
        className="p-1 rounded hover:bg-zinc-700"
        title="Split at Playhead (S)"
        data-testid="timeline-split"
      >
        <Scissors className="w-4 h-4" />
      </button>

      <div className="w-px h-5 bg-zinc-600" />

      {/* Snap */}
      <button
        onClick={onToggleSnap}
        className={`p-1 rounded hover:bg-zinc-700 ${snapEnabled ? "text-blue-400" : "text-zinc-400"}`}
        title={`Snap ${snapEnabled ? "On" : "Off"}`}
        data-testid="timeline-snap"
      >
        <Magnet className="w-4 h-4" />
      </button>

      <div className="w-px h-5 bg-zinc-600" />

      {/* Zoom */}
      <button
        onClick={onZoomOut}
        disabled={zoom <= 0.25}
        className="p-1 rounded hover:bg-zinc-700 disabled:opacity-30"
        title="Zoom Out"
        data-testid="timeline-zoom-out"
      >
        <ZoomOut className="w-4 h-4" />
      </button>

      <span
        className="text-zinc-400 min-w-[3ch] text-center"
        data-testid="timeline-zoom-level"
      >
        {Math.round(zoom * 100)}%
      </span>

      <button
        onClick={onZoomIn}
        disabled={zoom >= 8}
        className="p-1 rounded hover:bg-zinc-700 disabled:opacity-30"
        title="Zoom In"
        data-testid="timeline-zoom-in"
      >
        <ZoomIn className="w-4 h-4" />
      </button>

      {/* Zoom slider */}
      <input
        type="range"
        min={25}
        max={800}
        value={Math.round(zoom * 100)}
        onChange={(e) => {
          const newZoom = Number(e.target.value) / 100;
          if (newZoom > zoom) onZoomIn();
          else if (newZoom < zoom) onZoomOut();
        }}
        className="w-20 accent-blue-500"
        title="Zoom"
        data-testid="timeline-zoom-slider"
      />
    </div>
  );
}
