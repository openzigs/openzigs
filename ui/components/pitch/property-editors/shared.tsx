"use client";

/**
 * Shared building blocks for the 14 per-template property editors.
 *
 * Every editor receives the same prop shape:
 *
 *   { slide, onChange, deckId, brandKit }
 *
 * `slide` is an entry from the `Slide` discriminated union in
 * `src/pitch/pitch-schema.ts`. Editors call `onChange(next)` with a new
 * slide of the SAME `template`. The properties-panel debounces those calls
 * by 400 ms before issuing a PATCH.
 *
 * Tests live next to each editor (e.g. `title.test.tsx`).
 */

import { type ChangeEvent, type ReactNode } from "react";

export interface PitchSlideShape {
  template: string;
  content: Record<string, unknown>;
  speaker_notes?: string;
  transition?: string;
  fragments?: string[];
  background_image_prompt?: string;
  source_anchor?: string;
}

export interface PitchBrandKitShape {
  id: string;
  name: string;
  fontHeading?: string | null;
  fontBody?: string | null;
}

export interface PropertyEditorProps<TSlide extends PitchSlideShape = PitchSlideShape> {
  slide: TSlide;
  onChange: (next: TSlide) => void;
  deckId: string;
  brandKit?: PitchBrandKitShape | null;
}

export const FieldLabel = ({
  label,
  children,
  htmlFor,
  hint,
}: {
  label: string;
  children: ReactNode;
  htmlFor?: string;
  hint?: string;
}) => (
  <label className="mb-3 block text-xs">
    <span className="mb-1 block font-semibold text-foreground" {...(htmlFor ? { htmlFor } : {})}>
      {label}
    </span>
    {children}
    {hint && (
      <span className="mt-0.5 block text-[10px] text-muted-foreground">{hint}</span>
    )}
  </label>
);

export const TextInput = ({
  value,
  onChange,
  placeholder,
  maxLength,
  testId,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  testId?: string;
  id?: string;
}) => (
  <input
    type="text"
    id={id}
    data-testid={testId}
    value={value}
    placeholder={placeholder}
    maxLength={maxLength}
    onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
    className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
  />
);

export const TextArea = ({
  value,
  onChange,
  placeholder,
  maxLength,
  rows = 4,
  testId,
  id,
  monospace,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  rows?: number;
  testId?: string;
  id?: string;
  monospace?: boolean;
  invalid?: boolean;
}) => (
  <textarea
    id={id}
    data-testid={testId}
    value={value}
    placeholder={placeholder}
    maxLength={maxLength}
    rows={rows}
    onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
    className={`w-full resize-y rounded border bg-background px-2 py-1 text-xs ${
      invalid ? "border-red-500" : "border-border"
    } ${monospace ? "font-mono" : ""}`}
  />
);
