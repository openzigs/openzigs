"use client";

import { FieldLabel, TextInput, type PropertyEditorProps } from "./shared";

interface QaSlide {
  template: "qa";
  content: {
    heading: string;
    contact?: string;
  };
  speaker_notes?: string;
  source_anchor?: string;
}

/**
 * The schema for `qa` is a single closing slide, NOT an array of Q/A pairs.
 * If a future Phase 1 follow-up extends `QaSlideSchema` with an `items`
 * array, add a list editor here mirroring `timeline.tsx`.
 */
const QaEditor = ({ slide, onChange }: PropertyEditorProps<QaSlide>) => {
  const c = slide.content;
  const update = (patch: Partial<QaSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  return (
    <div data-testid="prop-editor-qa">
      <FieldLabel label="Heading">
        <TextInput
          testId="prop-qa-heading"
          value={c.heading ?? "Questions?"}
          maxLength={120}
          onChange={(v) => update({ heading: v })}
        />
      </FieldLabel>
      <FieldLabel label="Contact (optional)">
        <TextInput
          testId="prop-qa-contact"
          value={c.contact ?? ""}
          maxLength={160}
          placeholder="email / handle / URL"
          onChange={(v) => update({ contact: v || undefined })}
        />
      </FieldLabel>
    </div>
  );
};

export default QaEditor;
