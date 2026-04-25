"use client";

import { FieldLabel, TextArea, TextInput, type PropertyEditorProps } from "./shared";

interface QuoteSlide {
  template: "quote";
  content: {
    quote: string;
    attribution: string;
    source?: string;
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const QuoteEditor = ({ slide, onChange }: PropertyEditorProps<QuoteSlide>) => {
  const c = slide.content;
  const update = (patch: Partial<QuoteSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  return (
    <div data-testid="prop-editor-quote">
      <FieldLabel label="Quote" htmlFor="prop-q-quote">
        <TextArea
          id="prop-q-quote"
          testId="prop-q-quote"
          value={c.quote}
          maxLength={500}
          rows={4}
          onChange={(v) => update({ quote: v })}
        />
      </FieldLabel>
      <FieldLabel label="Attribution" htmlFor="prop-q-attr">
        <TextInput
          id="prop-q-attr"
          testId="prop-q-attr"
          value={c.attribution}
          maxLength={120}
          onChange={(v) => update({ attribution: v })}
        />
      </FieldLabel>
      <FieldLabel label="Source (optional)" htmlFor="prop-q-source">
        <TextInput
          id="prop-q-source"
          testId="prop-q-source"
          value={c.source ?? ""}
          maxLength={120}
          onChange={(v) => update({ source: v || undefined })}
        />
      </FieldLabel>
    </div>
  );
};

export default QuoteEditor;
