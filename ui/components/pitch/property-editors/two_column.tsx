"use client";

import { FieldLabel, TextArea, TextInput, type PropertyEditorProps } from "./shared";

interface TwoColumnSlide {
  template: "two_column";
  content: {
    heading: string;
    left: string;
    right: string;
    left_image?: { prompt: string; url: string | null; alt: string };
    right_image?: { prompt: string; url: string | null; alt: string };
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const TwoColumnEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<TwoColumnSlide>) => {
  const c = slide.content;
  const update = (patch: Partial<TwoColumnSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  return (
    <div data-testid="prop-editor-two-column">
      <FieldLabel label="Heading" htmlFor="prop-tc-heading">
        <TextInput
          id="prop-tc-heading"
          testId="prop-tc-heading"
          value={c.heading}
          maxLength={120}
          onChange={(v) => update({ heading: v })}
        />
      </FieldLabel>
      <FieldLabel label="Left column" htmlFor="prop-tc-left">
        <TextArea
          id="prop-tc-left"
          testId="prop-tc-left"
          value={c.left}
          maxLength={800}
          rows={5}
          onChange={(v) => update({ left: v })}
        />
      </FieldLabel>
      <FieldLabel label="Right column" htmlFor="prop-tc-right">
        <TextArea
          id="prop-tc-right"
          testId="prop-tc-right"
          value={c.right}
          maxLength={800}
          rows={5}
          onChange={(v) => update({ right: v })}
        />
      </FieldLabel>
    </div>
  );
};

export default TwoColumnEditor;
