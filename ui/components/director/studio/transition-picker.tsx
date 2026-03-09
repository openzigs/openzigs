"use client";

import { useCallback } from "react";
import { ArrowRightLeft, Info } from "lucide-react";

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
  hint: string;
}

const TRANSITION_OPTIONS: TransitionOption[] = [
  { value: "cut", label: "Cut", icon: "✂️", hint: "Instant switch between scenes — no transition effect" },
  { value: "crossfade", label: "Crossfade", icon: "🔀", hint: "Both scenes overlap, fading from one to the other" },
  { value: "dissolve", label: "Dissolve", icon: "💫", hint: "Gradual blend where one scene dissolves into the next" },
  { value: "wipe-left", label: "Wipe Left", icon: "◀", hint: "Next scene slides in from right, pushing the current scene left" },
  { value: "wipe-right", label: "Wipe Right", icon: "▶", hint: "Next scene slides in from left, pushing the current scene right" },
  { value: "slide", label: "Slide", icon: "📥", hint: "Next scene slides down over the current scene" },
  { value: "flip", label: "Flip", icon: "🔄", hint: "3D card-flip rotation revealing the next scene" },
  { value: "clock-wipe", label: "Clock Wipe", icon: "🕐", hint: "Circular sweep like a clock hand revealing the next scene" },
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
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-[11px] font-medium text-foreground">Transition</p>
        </div>
        <a
          href="https://en.wikipedia.org/wiki/Film_transition"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-0.5 text-[9px] text-muted-foreground hover:text-primary transition"
          title="Learn about film transitions"
        >
          <Info className="h-3 w-3" />
          <span>Learn more</span>
        </a>
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
            title={opt.hint}
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
