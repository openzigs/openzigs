"use client";

import { useState, useCallback } from "react";
import { Move, RotateCcw, Maximize2, Crop } from "lucide-react";
import { ReframePreview, type ReframePreviewProps } from "./reframe-preview";
import type { BoundingBox } from "./subject-overlay";

interface FramingPanelProps {
  /** Current horizontal offset (0–100, 50 = center) */
  offset: number;
  /** Callback when user adjusts the offset */
  onChange: (offset: number) => void;
  /** Fit mode: "cover" crops to fill, "contain" shows full frame with blur bg */
  fitMode?: "cover" | "contain";
  /** Callback when fit mode changes */
  onFitModeChange?: (mode: "cover" | "contain") => void;
  /** Optional source video URL for live reframe preview (#834). */
  sourceVideoUrl?: string;
  /** Optional rendered 9:16 reframed preview URL. */
  reframedVideoUrl?: string;
  /** AI subject tracking boxes for the source video. */
  trackingBoxes?: BoundingBox[];
  /** Customize ReframePreview behaviour. */
  reframePreviewProps?: Omit<
    ReframePreviewProps,
    "sourceUrl" | "reframedUrl" | "boxes"
  >;
}

/**
 * Horizontal crop offset slider for 9:16 framing of 16:9 source video.
 * Shows in the Scene Inspector when editing a Shorts video clip.
 */
export function FramingPanel({
  offset,
  onChange,
  fitMode = "cover",
  onFitModeChange,
  sourceVideoUrl,
  reframedVideoUrl,
  trackingBoxes,
  reframePreviewProps,
}: FramingPanelProps) {
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
          <p className="text-[11px] font-medium text-foreground">
            9:16 Framing
          </p>
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

      {/* Fit mode toggle */}
      {onFitModeChange && (
        <>
          <p className="mb-1.5 text-[9px] text-muted-foreground">
            Choose how horizontal (16:9) footage fits a vertical (9:16) frame
          </p>
          <div className="mb-3 flex gap-1 rounded-md bg-muted p-0.5">
            <button
              onClick={() => onFitModeChange("contain")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[10px] font-medium transition ${
                fitMode === "contain"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Show full frame with blurred background"
            >
              <Maximize2 className="h-3 w-3" />
              Fit (Blur BG)
            </button>
            <button
              onClick={() => onFitModeChange("cover")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[10px] font-medium transition ${
                fitMode === "cover"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Crop to fill 9:16 frame"
            >
              <Crop className="h-3 w-3" />
              Crop
            </button>
          </div>
        </>
      )}

      {/* Visual preview of crop region */}
      <div
        className={`relative mb-3 h-12 overflow-hidden rounded bg-muted ${fitMode === "contain" ? "opacity-40" : ""}`}
      >
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
          {fitMode === "contain" ? "Full frame" : `${localOffset}%`}
        </p>
      </div>

      {/* Slider — disabled in contain mode */}
      <input
        type="range"
        min={0}
        max={100}
        value={localOffset}
        onChange={(e) => handleChange(Number(e.target.value))}
        disabled={fitMode === "contain"}
        className="w-full accent-primary disabled:opacity-40"
      />
      <div className="mt-1 flex justify-between text-[9px] text-muted-foreground">
        <span>Left</span>
        <span>Center</span>
        <span>Right</span>
      </div>

      {sourceVideoUrl && (
        <div className="mt-3">
          <ReframePreview
            sourceUrl={sourceVideoUrl}
            reframedUrl={reframedVideoUrl}
            boxes={trackingBoxes}
            caption="Reframe preview"
            {...reframePreviewProps}
          />
        </div>
      )}
    </div>
  );
}
