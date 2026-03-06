"use client";

import { useCallback } from "react";
import { ArrowRightLeft } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────
export type TransitionStyle =
  | "cut"
  | "crossfade"
  | "dissolve"
  | "wipe-left"
  | "wipe-right"
  | "slide"
  | "flip"
  | "clock-wipe";

interface TransitionOption {
  value: TransitionStyle;
  label: string;
  icon: string;
}

const TRANSITION_OPTIONS: TransitionOption[] = [
  { value: "cut", label: "Cut", icon: "✂️" },
  { value: "crossfade", label: "Crossfade", icon: "🔀" },
  { value: "dissolve", label: "Dissolve", icon: "💫" },
  { value: "wipe-left", label: "Wipe Left", icon: "◀" },
  { value: "wipe-right", label: "Wipe Right", icon: "▶" },
  { value: "slide", label: "Slide", icon: "📥" },
  { value: "flip", label: "Flip", icon: "🔄" },
  { value: "clock-wipe", label: "Clock Wipe", icon: "🕐" },
];

const DURATION_OPTIONS = [
  { value: 10, label: "0.3s" },
  { value: 15, label: "0.5s" },
  { value: 30, label: "1s" },
  { value: 45, label: "1.5s" },
  { value: 60, label: "2s" },
];

interface TransitionPickerProps {
  currentStyle: TransitionStyle;
  currentDuration: number;
  fps?: number;
  onStyleChange: (style: TransitionStyle) => void;
  onDurationChange: (frames: number) => void;
}

export function TransitionPicker({
  currentStyle,
  currentDuration,
  onStyleChange,
  onDurationChange,
}: TransitionPickerProps) {
  const handleStyleChange = useCallback(
    (style: TransitionStyle) => {
      onStyleChange(style);
    },
    [onStyleChange],
  );

  return (
    <div className="rounded-lg border border-border p-3" data-testid="transition-picker">
      <div className="mb-2 flex items-center gap-1.5">
        <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-[11px] font-medium text-foreground">Transition</p>
      </div>

      {/* Style grid */}
      <div className="mb-3 grid grid-cols-4 gap-1" data-testid="transition-styles">
        {TRANSITION_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => handleStyleChange(opt.value)}
            className={`flex flex-col items-center gap-0.5 rounded px-1.5 py-1.5 text-[10px] font-medium transition ${
              currentStyle === opt.value
                ? "bg-primary text-primary-foreground"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
            data-testid={`transition-${opt.value}`}
          >
            <span className="text-sm">{opt.icon}</span>
            <span>{opt.label}</span>
          </button>
        ))}
      </div>

      {/* Duration selector */}
      {currentStyle !== "cut" && (
        <div>
          <p className="mb-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Duration</p>
          <div className="flex gap-1" data-testid="transition-durations">
            {DURATION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onDurationChange(opt.value)}
                className={`flex-1 rounded px-1.5 py-1 text-[10px] font-medium transition ${
                  currentDuration === opt.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted"
                }`}
                data-testid={`duration-${opt.value}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline Transition Indicator ────────────────────────────────
// Used in the timeline between scene entries to show/edit transitions
interface TransitionIndicatorProps {
  style: TransitionStyle;
  onClick: () => void;
}

export function TransitionIndicator({ style, onClick }: TransitionIndicatorProps) {
  const opt = TRANSITION_OPTIONS.find((o) => o.value === style);
  return (
    <button
      onClick={onClick}
      className="mx-0.5 inline-flex h-6 items-center gap-0.5 rounded border border-border bg-background px-1 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground transition"
      title={`Transition: ${opt?.label ?? style}`}
      data-testid="transition-indicator"
    >
      <ArrowRightLeft className="h-2.5 w-2.5" />
      <span>{opt?.icon ?? "✂️"}</span>
    </button>
  );
}
