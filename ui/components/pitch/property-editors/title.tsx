"use client";

import { useState } from "react";
import { FieldLabel, TextArea, TextInput, type PropertyEditorProps } from "./shared";
import { RegenerateImageDialog } from "../regenerate-image-dialog";

interface TitleSlide {
  template: "title";
  content: {
    title: string;
    subtitle?: string;
    eyebrow?: string;
  };
  speaker_notes?: string;
  transition?: string;
  fragments?: string[];
  background_image_prompt?: string;
  source_anchor?: string;
}

const TitleEditor = ({ slide, onChange, deckId }: PropertyEditorProps<TitleSlide>) => {
  const [open, setOpen] = useState(false);
  const c = slide.content;

  const update = (patch: Partial<TitleSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  return (
    <div data-testid="prop-editor-title">
      <FieldLabel label="Title" htmlFor="prop-title-title">
        <TextInput
          id="prop-title-title"
          testId="prop-title-title"
          value={c.title ?? ""}
          maxLength={120}
          onChange={(v) => update({ title: v })}
        />
      </FieldLabel>
      <FieldLabel label="Eyebrow" htmlFor="prop-title-eyebrow">
        <TextInput
          id="prop-title-eyebrow"
          testId="prop-title-eyebrow"
          value={c.eyebrow ?? ""}
          maxLength={60}
          onChange={(v) => update({ eyebrow: v || undefined })}
        />
      </FieldLabel>
      <FieldLabel label="Subtitle" htmlFor="prop-title-subtitle">
        <TextArea
          id="prop-title-subtitle"
          testId="prop-title-subtitle"
          value={c.subtitle ?? ""}
          maxLength={200}
          rows={2}
          onChange={(v) => update({ subtitle: v || undefined })}
        />
      </FieldLabel>
      <FieldLabel label="Background image prompt">
        <TextArea
          testId="prop-title-bg-prompt"
          value={slide.background_image_prompt ?? ""}
          maxLength={400}
          rows={2}
          onChange={(v) =>
            onChange({
              ...slide,
              background_image_prompt: v || undefined,
            })
          }
        />
      </FieldLabel>
      <button
        type="button"
        data-testid="prop-title-regen-bg"
        onClick={() => setOpen(true)}
        className="mt-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted/40"
      >
        Regenerate background image…
      </button>
      <RegenerateImageDialog
        open={open}
        onOpenChange={setOpen}
        deckId={deckId}
        slideId={(slide as TitleSlide & { id?: string }).id ?? ""}
        initialPrompt={slide.background_image_prompt ?? c.title ?? ""}
        mode="background"
      />
    </div>
  );
};

export default TitleEditor;
