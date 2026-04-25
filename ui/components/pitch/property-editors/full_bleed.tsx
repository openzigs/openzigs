"use client";

import { useState } from "react";
import { FieldLabel, TextArea, type PropertyEditorProps } from "./shared";
import { RegenerateImageDialog } from "../regenerate-image-dialog";

interface FullBleedSlide {
  template: "full_bleed";
  content: {
    image: { prompt: string; url: string | null; alt: string };
    overlay_text?: string;
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const FullBleedEditor = ({
  slide,
  onChange,
  deckId,
}: PropertyEditorProps<FullBleedSlide>) => {
  const [open, setOpen] = useState(false);
  const c = slide.content;
  const updateImage = (patch: Partial<FullBleedSlide["content"]["image"]>) =>
    onChange({
      ...slide,
      content: { ...c, image: { ...c.image, ...patch } },
    });

  return (
    <div data-testid="prop-editor-full-bleed">
      <FieldLabel label="Image prompt">
        <TextArea
          testId="prop-fb-prompt"
          value={c.image.prompt}
          maxLength={400}
          rows={3}
          onChange={(v) => updateImage({ prompt: v })}
        />
      </FieldLabel>
      <FieldLabel label="Image alt text">
        <TextArea
          testId="prop-fb-alt"
          value={c.image.alt}
          maxLength={200}
          rows={2}
          onChange={(v) => updateImage({ alt: v })}
        />
      </FieldLabel>
      <FieldLabel label="Overlay text (optional)">
        <TextArea
          testId="prop-fb-overlay"
          value={c.overlay_text ?? ""}
          maxLength={200}
          rows={2}
          onChange={(v) =>
            onChange({
              ...slide,
              content: { ...c, overlay_text: v || undefined },
            })
          }
        />
      </FieldLabel>
      <button
        type="button"
        data-testid="prop-fb-regen"
        onClick={() => setOpen(true)}
        className="mt-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted/40"
      >
        Regenerate image…
      </button>
      <RegenerateImageDialog
        open={open}
        onOpenChange={setOpen}
        deckId={deckId}
        slideId={(slide as FullBleedSlide & { id?: string }).id ?? ""}
        initialPrompt={c.image.prompt}
        mode="background"
      />
    </div>
  );
};

export default FullBleedEditor;
