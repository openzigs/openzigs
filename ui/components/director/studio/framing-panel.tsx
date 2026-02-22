"use client";

import { useState, useCallback } from "react";
import { Move, RotateCcw } from "lucide-react";

interface FramingPanelProps {
  /** Current horizontal offset (0–100, 50 = center) */
  offset: number;
  /** Callback when user adjusts the offset */
  onChange: (offset: number) => void;
}

/**
 * Horizontal crop offset slider for 9:16 framing of 16:9 source video.
 * Shows in the Scene Inspector when editing a Shorts video clip.
 */
export function FramingPanel({ offset, onChange }: FramingPanelProps) {
  const [localOffset, setLocalOffset] = useState(offset);

  const handleChange = useCallback(
    (value: number) => {
      setLocalOffset(value);
      onChange(value);
    },
    [onChange],
  );

  const handleReset = useCallback(() => {
    setLocalOffset(50);
    onChange(50);
  }, [onChange]);

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Move className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-[11px] font-medium text-foreground">9:16 Framing</p>
        </div>
        <button
          onClick={handleReset}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted transition"
          title="Reset to center"
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </button>
      </div>

      {/* Visual preview of crop region */}
      <div className="relative mb-3 h-12 overflow-hidden rounded bg-muted">
        {/* 16:9 source representation */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative h-full w-full bg-muted-foreground/10">
            {/* 9:16 crop window indicator */}
            <div
              className="absolute top-0 h-full border-2 border-primary/60 bg-primary/10 transition-all duration-100"
              style={{
                width: "33.75%", // 9:16 within 16:9 ≈ (9/16) / (16/9) ≈ 31.6%, but visually ~34%
                left: `${(localOffset / 100) * (100 - 33.75)}%`,
              }}
            />
          </div>
        </div>
        <p className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
          {localOffset}%
        </p>
      </div>

      {/* Slider */}
      <input
        type="range"
        min={0}
        max={100}
        value={localOffset}
        onChange={(e) => handleChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
      <div className="mt-1 flex justify-between text-[9px] text-muted-foreground">
        <span>Left</span>
        <span>Center</span>
        <span>Right</span>
      </div>
    </div>
  );
}
