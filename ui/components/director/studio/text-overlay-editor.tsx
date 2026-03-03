"use client";

import { useState, useCallback } from "react";
import { Plus, Trash2, Type, ChevronDown } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────
type OverlayPosition = "center" | "bottom-third" | "top-third" | "custom";
type OverlayAnimation = "fade-in" | "slide-up" | "typewriter" | "none";

interface TextOverlayDef {
  id: string;
  text: string;
  position: OverlayPosition;
  fontSize?: number;
  fontWeight?: "normal" | "bold" | "light";
  color?: string;
  backgroundColor?: string;
  animation: OverlayAnimation;
  startFrame: number;
  durationFrames: number;
}

interface TextOverlayEditorProps {
  overlays: TextOverlayDef[];
  sceneDurationFrames: number;
  fps: number;
  onOverlaysChange: (overlays: TextOverlayDef[]) => void;
}

const POSITION_OPTIONS: { value: OverlayPosition; label: string }[] = [
  { value: "center", label: "Center" },
  { value: "bottom-third", label: "Lower Third" },
  { value: "top-third", label: "Upper Third" },
];

const ANIMATION_OPTIONS: { value: OverlayAnimation; label: string }[] = [
  { value: "fade-in", label: "Fade In" },
  { value: "slide-up", label: "Slide Up" },
  { value: "typewriter", label: "Typewriter" },
  { value: "none", label: "None" },
];

function generateId(): string {
  return `overlay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export function TextOverlayEditor({
  overlays,
  sceneDurationFrames,
  fps,
  onOverlaysChange,
}: TextOverlayEditorProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleAddOverlay = useCallback(() => {
    const newOverlay: TextOverlayDef = {
      id: generateId(),
      text: "New Text",
      position: "bottom-third",
      fontSize: 48,
      fontWeight: "bold",
      color: "#ffffff",
      backgroundColor: "rgba(0,0,0,0.6)",
      animation: "fade-in",
      startFrame: 0,
      durationFrames: sceneDurationFrames,
    };
    const updated = [...overlays, newOverlay];
    onOverlaysChange(updated);
    setExpandedId(newOverlay.id);
  }, [overlays, sceneDurationFrames, onOverlaysChange]);

  const handleRemoveOverlay = useCallback(
    (id: string) => {
      onOverlaysChange(overlays.filter((o) => o.id !== id));
      if (expandedId === id) setExpandedId(null);
    },
    [overlays, expandedId, onOverlaysChange],
  );

  const handleUpdateOverlay = useCallback(
    (id: string, updates: Partial<TextOverlayDef>) => {
      onOverlaysChange(
        overlays.map((o) => (o.id === id ? { ...o, ...updates } : o)),
      );
    },
    [overlays, onOverlaysChange],
  );

  return (
    <div className="rounded-lg border border-border p-3" data-testid="text-overlay-editor">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Type className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-[11px] font-medium text-foreground">Text Overlays</p>
        </div>
        <button
          onClick={handleAddOverlay}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 transition"
          data-testid="add-overlay"
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </div>

      {overlays.length === 0 && (
        <p className="text-[10px] text-muted-foreground italic">No text overlays. Click Add to create one.</p>
      )}

      <div className="space-y-1.5" data-testid="overlay-list">
        {overlays.map((overlay) => (
          <div key={overlay.id} className="rounded border border-border bg-muted/20">
            {/* Header */}
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <button
                onClick={() => setExpandedId(expandedId === overlay.id ? null : overlay.id)}
                className="flex flex-1 items-center gap-1 text-[10px] font-medium text-foreground"
                data-testid={`overlay-toggle-${overlay.id}`}
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${expandedId === overlay.id ? "rotate-0" : "-rotate-90"}`} />
                <span className="truncate">{overlay.text || "Empty"}</span>
              </button>
              <button
                onClick={() => handleRemoveOverlay(overlay.id)}
                className="rounded p-0.5 text-muted-foreground hover:text-destructive transition"
                data-testid={`overlay-remove-${overlay.id}`}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>

            {/* Expanded editor */}
            {expandedId === overlay.id && (
              <div className="space-y-2 border-t border-border px-2 py-2" data-testid={`overlay-editor-${overlay.id}`}>
                {/* Text input */}
                <div>
                  <label className="mb-0.5 block text-[10px] text-muted-foreground">Text</label>
                  <input
                    type="text"
                    value={overlay.text}
                    onChange={(e) => handleUpdateOverlay(overlay.id, { text: e.target.value })}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground"
                    data-testid="overlay-text-input"
                  />
                </div>

                {/* Position */}
                <div>
                  <label className="mb-0.5 block text-[10px] text-muted-foreground">Position</label>
                  <div className="flex gap-1">
                    {POSITION_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => handleUpdateOverlay(overlay.id, { position: opt.value })}
                        className={`flex-1 rounded px-1.5 py-1 text-[10px] font-medium transition ${
                          overlay.position === opt.value
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted/50 text-muted-foreground hover:bg-muted"
                        }`}
                        data-testid={`overlay-pos-${opt.value}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Animation */}
                <div>
                  <label className="mb-0.5 block text-[10px] text-muted-foreground">Animation</label>
                  <div className="flex gap-1">
                    {ANIMATION_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => handleUpdateOverlay(overlay.id, { animation: opt.value })}
                        className={`flex-1 rounded px-1.5 py-1 text-[10px] font-medium transition ${
                          overlay.animation === opt.value
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted/50 text-muted-foreground hover:bg-muted"
                        }`}
                        data-testid={`overlay-anim-${opt.value}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Styling */}
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <label className="mb-0.5 block text-[10px] text-muted-foreground">Size</label>
                    <input
                      type="number"
                      min={12}
                      max={120}
                      value={overlay.fontSize ?? 48}
                      onChange={(e) => handleUpdateOverlay(overlay.id, { fontSize: parseInt(e.target.value) || 48 })}
                      className="w-full rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground tabular-nums"
                      data-testid="overlay-font-size"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="mb-0.5 block text-[10px] text-muted-foreground">Color</label>
                    <input
                      type="color"
                      value={overlay.color ?? "#ffffff"}
                      onChange={(e) => handleUpdateOverlay(overlay.id, { color: e.target.value })}
                      className="h-6 w-full rounded border border-border"
                      data-testid="overlay-color"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="mb-0.5 block text-[10px] text-muted-foreground">Weight</label>
                    <select
                      value={overlay.fontWeight ?? "bold"}
                      onChange={(e) => handleUpdateOverlay(overlay.id, { fontWeight: e.target.value as "normal" | "bold" | "light" })}
                      className="w-full rounded border border-border bg-background px-1 py-0.5 text-[10px] text-foreground"
                      data-testid="overlay-font-weight"
                    >
                      <option value="light">Light</option>
                      <option value="normal">Normal</option>
                      <option value="bold">Bold</option>
                    </select>
                  </div>
                </div>

                {/* Timing */}
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <label className="mb-0.5 block text-[10px] text-muted-foreground">Start (sec)</label>
                    <input
                      type="number"
                      min={0}
                      max={sceneDurationFrames / fps}
                      step={0.5}
                      value={(overlay.startFrame / fps).toFixed(1)}
                      onChange={(e) => handleUpdateOverlay(overlay.id, { startFrame: Math.round(parseFloat(e.target.value) * fps) })}
                      className="w-full rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground tabular-nums"
                      data-testid="overlay-start"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="mb-0.5 block text-[10px] text-muted-foreground">Duration (sec)</label>
                    <input
                      type="number"
                      min={0.5}
                      max={sceneDurationFrames / fps}
                      step={0.5}
                      value={(overlay.durationFrames / fps).toFixed(1)}
                      onChange={(e) => handleUpdateOverlay(overlay.id, { durationFrames: Math.round(parseFloat(e.target.value) * fps) })}
                      className="w-full rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground tabular-nums"
                      data-testid="overlay-duration"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
