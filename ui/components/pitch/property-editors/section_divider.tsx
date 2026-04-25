"use client";

import { FieldLabel, TextInput, type PropertyEditorProps } from "./shared";

interface SectionDividerSlide {
  template: "section_divider";
  content: {
    section_number: number;
    title: string;
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const SectionDividerEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<SectionDividerSlide>) => {
  const update = (patch: Partial<SectionDividerSlide["content"]>) =>
    onChange({ ...slide, content: { ...slide.content, ...patch } });

  return (
    <div data-testid="prop-editor-section-divider">
      <FieldLabel label="Section title" htmlFor="prop-sd-title">
        <TextInput
          id="prop-sd-title"
          testId="prop-sd-title"
          value={slide.content.title}
          maxLength={120}
          onChange={(v) => update({ title: v })}
        />
      </FieldLabel>
      <FieldLabel label="Section number">
        <input
          type="number"
          data-testid="prop-sd-number"
          min={1}
          max={99}
          value={slide.content.section_number}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            update({ section_number: Math.max(1, Math.min(99, n)) });
          }}
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
        />
      </FieldLabel>
    </div>
  );
};

export default SectionDividerEditor;
