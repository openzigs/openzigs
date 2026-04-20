"use client";

import { useCallback, useState } from "react";
import { Type } from "lucide-react";

export interface CaptionWord {
  word: string;
  start: number;
  end: number;
  color?: string;
  emphasis?: "normal" | "bold" | "italic" | "highlight";
  size?: "sm" | "md" | "lg" | "xl";
}

export interface CaptionWordEditorProps {
  words: CaptionWord[];
  onChange: (words: CaptionWord[]) => void;
  /** Frames per second for time display. Defaults to 30. */
  fps?: number;
  /** Allowed colors. */
  colors?: string[];
}

const DEFAULT_COLORS = ["#ffffff", "#FFD700", "#10b981", "#3b82f6", "#ef4444"];

const EMPHASIS_OPTIONS: CaptionWord["emphasis"][] = [
  "normal",
  "bold",
  "italic",
  "highlight",
];

const SIZE_OPTIONS: CaptionWord["size"][] = ["sm", "md", "lg", "xl"];

function formatTime(frames: number, fps: number): string {
  const sec = frames / fps;
  return `${sec.toFixed(2)}s`;
}

/**
 * Per-word caption editor. Lets the user fine-tune timing and apply
 * per-word color, emphasis, and size overrides on top of a template.
 *
 * Issue #830 — Caption Style Panel improvements.
 */
export function CaptionWordEditor({
  words,
  onChange,
  fps = 30,
  colors = DEFAULT_COLORS,
}: CaptionWordEditorProps) {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const updateWord = useCallback(
    (idx: number, patch: Partial<CaptionWord>) => {
      const next = words.map((w, i) => (i === idx ? { ...w, ...patch } : w));
      onChange(next);
    },
    [words, onChange],
  );

  const adjustTiming = useCallback(
    (idx: number, edge: "start" | "end", delta: number) => {
      const word = words[idx];
      if (!word) return;
      const nextValue = Math.max(0, word[edge] + delta);
      // Enforce ordering: start < end.
      if (edge === "start" && nextValue >= word.end) return;
      if (edge === "end" && nextValue <= word.start) return;
      updateWord(idx, { [edge]: nextValue });
    },
    [words, updateWord],
  );

  if (words.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-3 text-center text-[11px] text-muted-foreground">
        <Type className="mx-auto mb-1 h-4 w-4 opacity-60" />
        No caption words to edit. Generate captions first.
      </div>
    );
  }

  const selected = selectedIdx !== null ? words[selectedIdx] : null;

  return (
    <div
      className="rounded-lg border border-border p-3"
      data-testid="caption-word-editor"
    >
      <div className="mb-2 flex items-center gap-1.5">
        <Type className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-[11px] font-medium">Word-level Editor</p>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {words.length} word{words.length === 1 ? "" : "s"}
        </span>
      </div>
      <div
        className="flex max-h-32 flex-wrap gap-1 overflow-y-auto rounded bg-muted p-2"
        role="listbox"
        aria-label="Caption words"
      >
        {words.map((w, i) => (
          <button
            key={`${w.word}-${i}`}
            type="button"
            role="option"
            aria-selected={selectedIdx === i}
            onClick={() => setSelectedIdx(i)}
            className={`rounded px-1.5 py-0.5 text-[11px] transition ${
              selectedIdx === i
                ? "bg-primary text-primary-foreground"
                : "bg-background hover:bg-background/70"
            } ${
              w.emphasis === "bold"
                ? "font-bold"
                : w.emphasis === "italic"
                  ? "italic"
                  : ""
            }`}
            style={{
              color: selectedIdx === i ? undefined : (w.color ?? undefined),
            }}
            data-testid={`word-${i}`}
          >
            {w.word}
          </button>
        ))}
      </div>

      {selected && selectedIdx !== null && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-medium">{selected.word}</span>
            <span className="text-muted-foreground">
              {formatTime(selected.start, fps)} →{" "}
              {formatTime(selected.end, fps)}
            </span>
          </div>

          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-muted-foreground">Start:</span>
            <button
              type="button"
              onClick={() => adjustTiming(selectedIdx, "start", -1)}
              aria-label="Decrease start"
              className="rounded border border-border px-1.5 hover:bg-muted"
            >
              −
            </button>
            <button
              type="button"
              onClick={() => adjustTiming(selectedIdx, "start", 1)}
              aria-label="Increase start"
              className="rounded border border-border px-1.5 hover:bg-muted"
            >
              +
            </button>
            <span className="text-muted-foreground">End:</span>
            <button
              type="button"
              onClick={() => adjustTiming(selectedIdx, "end", -1)}
              aria-label="Decrease end"
              className="rounded border border-border px-1.5 hover:bg-muted"
            >
              −
            </button>
            <button
              type="button"
              onClick={() => adjustTiming(selectedIdx, "end", 1)}
              aria-label="Increase end"
              className="rounded border border-border px-1.5 hover:bg-muted"
            >
              +
            </button>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">Color:</span>
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => updateWord(selectedIdx, { color: c })}
                aria-label={`Color ${c}`}
                className={`h-4 w-4 rounded border ${
                  selected.color === c
                    ? "border-foreground ring-1 ring-foreground/40"
                    : "border-border"
                }`}
                style={{ background: c }}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-muted-foreground">Emphasis:</span>
            {EMPHASIS_OPTIONS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => updateWord(selectedIdx, { emphasis: e })}
                className={`rounded border px-1.5 py-0.5 text-[10px] capitalize ${
                  (selected.emphasis ?? "normal") === e
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-muted"
                }`}
              >
                {e}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-muted-foreground">Size:</span>
            {SIZE_OPTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => updateWord(selectedIdx, { size: s })}
                className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${
                  (selected.size ?? "md") === s
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-muted"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
