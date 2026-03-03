"use client";

import { useState, useCallback, useEffect } from "react";
import { Clock } from "lucide-react";

interface DurationControlProps {
  durationFrames: number;
  fps: number;
  onDurationChange: (frames: number) => void;
  minSeconds?: number;
  maxSeconds?: number;
}

export function DurationControl({
  durationFrames,
  fps,
  onDurationChange,
  minSeconds = 1,
  maxSeconds = 30,
}: DurationControlProps) {
  const durationSeconds = durationFrames / fps;
  const [localSeconds, setLocalSeconds] = useState(durationSeconds);

  useEffect(() => {
    setLocalSeconds(durationFrames / fps);
  }, [durationFrames, fps]);

  const handleSliderChange = useCallback(
    (value: number) => {
      setLocalSeconds(value);
      onDurationChange(Math.round(value * fps));
    },
    [fps, onDurationChange],
  );

  const handleInputChange = useCallback(
    (value: string) => {
      const num = parseFloat(value);
      if (Number.isNaN(num)) return;
      const clamped = Math.max(minSeconds, Math.min(maxSeconds, num));
      setLocalSeconds(clamped);
      onDurationChange(Math.round(clamped * fps));
    },
    [fps, minSeconds, maxSeconds, onDurationChange],
  );

  return (
    <div className="rounded-lg border border-border p-3" data-testid="duration-control">
      <div className="mb-2 flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-[11px] font-medium text-foreground">Duration</p>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="range"
          min={minSeconds}
          max={maxSeconds}
          step={0.5}
          value={localSeconds}
          onChange={(e) => handleSliderChange(parseFloat(e.target.value))}
          className="h-1 flex-1 appearance-none rounded-full bg-muted accent-primary"
          data-testid="duration-slider"
        />
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={minSeconds}
            max={maxSeconds}
            step={0.5}
            value={localSeconds.toFixed(1)}
            onChange={(e) => handleInputChange(e.target.value)}
            className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[11px] text-foreground tabular-nums"
            data-testid="duration-input"
          />
          <span className="text-[10px] text-muted-foreground">sec</span>
        </div>
      </div>

      <p className="mt-1 text-[10px] text-muted-foreground">
        {durationFrames} frames at {fps}fps
      </p>
    </div>
  );
}
