"use client";

import { useState } from "react";
import { FieldLabel, TextArea, TextInput, type PropertyEditorProps } from "./shared";
import { RegenerateImageDialog } from "../regenerate-image-dialog";

interface ImageCaptionSlide {
  template: "image_caption";
  content: {
    image: { prompt: string; url: string | null; alt: string };
    caption: string;
    heading?: string;
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const ImageCaptionEditor = ({
  slide,
  onChange,
  deckId,
}: PropertyEditorProps<ImageCaptionSlide>) => {
  const [open, setOpen] = useState(false);
  const c = slide.content;
  const update = (patch: Partial<ImageCaptionSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });
  const updateImage = (patch: Partial<ImageCaptionSlide["content"]["image"]>) =>
    update({ image: { ...c.image, ...patch } });

  return (
    <div data-testid="prop-editor-image-caption">
      <FieldLabel label="Heading" htmlFor="prop-ic-heading">
        <TextInput
          id="prop-ic-heading"
          testId="prop-ic-heading"
          value={c.heading ?? ""}
          maxLength={120}
          onChange={(v) => update({ heading: v || undefined })}
        />
      </FieldLabel>
      <FieldLabel label="Caption" htmlFor="prop-ic-caption">
        <TextArea
          id="prop-ic-caption"
          testId="prop-ic-caption"
          value={c.caption}
          maxLength={280}
          rows={3}
          onChange={(v) => update({ caption: v })}
        />
      </FieldLabel>
      <FieldLabel label="Image alt text" htmlFor="prop-ic-alt">
        <TextInput
          id="prop-ic-alt"
          testId="prop-ic-alt"
          value={c.image.alt}
          maxLength={200}
          onChange={(v) => updateImage({ alt: v })}
        />
      </FieldLabel>
      <FieldLabel label="Image prompt">
        <TextArea
          testId="prop-ic-prompt"
          value={c.image.prompt}
          maxLength={400}
          rows={2}
          onChange={(v) => updateImage({ prompt: v })}
        />
      </FieldLabel>
      <button
        type="button"
        data-testid="prop-ic-regen"
        onClick={() => setOpen(true)}
        className="mt-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted/40"
      >
        Regenerate image…
      </button>
      <RegenerateImageDialog
        open={open}
        onOpenChange={setOpen}
        deckId={deckId}
        slideId={(slide as ImageCaptionSlide & { id?: string }).id ?? ""}
        initialPrompt={c.image.prompt}
        mode="inline"
      />
    </div>
  );
};

export default ImageCaptionEditor;
