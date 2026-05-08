"use client";

import { useState } from "react";
import { FieldLabel, TextArea, TextInput, type PropertyEditorProps } from "./shared";
import { RegenerateImageDialog } from "../regenerate-image-dialog";

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

/** Default shape for an inline image slot when the user opts in. */
const EMPTY_IMAGE = { prompt: "", url: null, alt: "" } as const;

const TwoColumnEditor = ({
  slide,
  onChange,
  deckId,
}: PropertyEditorProps<TwoColumnSlide>) => {
  const c = slide.content;
  // Track which slot's regenerate dialog is open. Null = closed.
  const [regenSlot, setRegenSlot] = useState<
    "left_image" | "right_image" | null
  >(null);

  const update = (patch: Partial<TwoColumnSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });
  const updateLeftImage = (
    patch: Partial<NonNullable<TwoColumnSlide["content"]["left_image"]>>,
  ) =>
    update({
      left_image: { ...(c.left_image ?? EMPTY_IMAGE), ...patch },
    });
  const updateRightImage = (
    patch: Partial<NonNullable<TwoColumnSlide["content"]["right_image"]>>,
  ) =>
    update({
      right_image: { ...(c.right_image ?? EMPTY_IMAGE), ...patch },
    });
  const slideId = (slide as TwoColumnSlide & { id?: string }).id ?? "";

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

      {/* Issue (2026-05): expose inline image controls so two_column
          slides can carry left/right column imagery without dropping
          into the JSON editor. Each slot has its own prompt + alt + a
          Regenerate button that opens the shared dialog scoped to the
          correct slot. */}
      <fieldset className="mt-3 space-y-2 rounded border border-border p-2">
        <legend className="px-1 text-[11px] font-semibold text-muted-foreground">
          Left image (optional)
        </legend>
        <FieldLabel label="Alt text" htmlFor="prop-tc-left-img-alt">
          <TextInput
            id="prop-tc-left-img-alt"
            testId="prop-tc-left-img-alt"
            value={c.left_image?.alt ?? ""}
            maxLength={200}
            onChange={(v) => updateLeftImage({ alt: v })}
          />
        </FieldLabel>
        <FieldLabel label="Prompt">
          <TextArea
            testId="prop-tc-left-img-prompt"
            value={c.left_image?.prompt ?? ""}
            maxLength={400}
            rows={2}
            onChange={(v) => updateLeftImage({ prompt: v })}
          />
        </FieldLabel>
        <button
          type="button"
          data-testid="prop-tc-left-img-regen"
          disabled={!c.left_image?.prompt}
          onClick={() => setRegenSlot("left_image")}
          className="mt-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-50"
        >
          Regenerate image…
        </button>
      </fieldset>

      <fieldset className="mt-3 space-y-2 rounded border border-border p-2">
        <legend className="px-1 text-[11px] font-semibold text-muted-foreground">
          Right image (optional)
        </legend>
        <FieldLabel label="Alt text" htmlFor="prop-tc-right-img-alt">
          <TextInput
            id="prop-tc-right-img-alt"
            testId="prop-tc-right-img-alt"
            value={c.right_image?.alt ?? ""}
            maxLength={200}
            onChange={(v) => updateRightImage({ alt: v })}
          />
        </FieldLabel>
        <FieldLabel label="Prompt">
          <TextArea
            testId="prop-tc-right-img-prompt"
            value={c.right_image?.prompt ?? ""}
            maxLength={400}
            rows={2}
            onChange={(v) => updateRightImage({ prompt: v })}
          />
        </FieldLabel>
        <button
          type="button"
          data-testid="prop-tc-right-img-regen"
          disabled={!c.right_image?.prompt}
          onClick={() => setRegenSlot("right_image")}
          className="mt-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-50"
        >
          Regenerate image…
        </button>
      </fieldset>

      {regenSlot !== null && (
        <RegenerateImageDialog
          open={regenSlot !== null}
          onOpenChange={(o) => {
            if (!o) setRegenSlot(null);
          }}
          deckId={deckId}
          slideId={slideId}
          initialPrompt={
            regenSlot === "left_image"
              ? c.left_image?.prompt ?? ""
              : regenSlot === "right_image"
              ? c.right_image?.prompt ?? ""
              : ""
          }
          mode="inline"
          slot={regenSlot ?? undefined}
        />
      )}
    </div>
  );
};

export default TwoColumnEditor;
