"use client";

import { useState } from "react";
import { FieldLabel, TextArea, TextInput, type PropertyEditorProps } from "./shared";
import { RegenerateImageDialog } from "../regenerate-image-dialog";

interface BulletListSlide {
  template: "bullet_list";
  content: {
    heading: string;
    bullets: string[];
    image?: { prompt: string; url: string | null; alt: string };
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const MAX_BULLETS = 7;
const BULLET_MAX_CHARS = 160;

const EMPTY_IMAGE = { prompt: "", url: null, alt: "" } as const;

const BulletListEditor = ({
  slide,
  onChange,
  deckId,
}: PropertyEditorProps<BulletListSlide>) => {
  const c = slide.content;
  const [regenOpen, setRegenOpen] = useState(false);

  const setBullets = (next: string[]) =>
    onChange({ ...slide, content: { ...c, bullets: next } });
  const updateImage = (
    patch: Partial<NonNullable<BulletListSlide["content"]["image"]>>,
  ) =>
    onChange({
      ...slide,
      content: { ...c, image: { ...(c.image ?? EMPTY_IMAGE), ...patch } },
    });
  const slideId = (slide as BulletListSlide & { id?: string }).id ?? "";

  const addBullet = () => {
    if (c.bullets.length >= MAX_BULLETS) return;
    setBullets([...c.bullets, ""]);
  };
  const removeBullet = (i: number) =>
    setBullets(c.bullets.filter((_, idx) => idx !== i));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= c.bullets.length) return;
    const next = c.bullets.slice();
    const [pulled] = next.splice(from, 1);
    next.splice(to, 0, pulled);
    setBullets(next);
  };
  const updateBullet = (i: number, value: string) =>
    setBullets(c.bullets.map((b, idx) => (idx === i ? value : b)));

  return (
    <div data-testid="prop-editor-bullet-list">
      <FieldLabel label="Heading" htmlFor="prop-bl-heading">
        <TextInput
          id="prop-bl-heading"
          testId="prop-bl-heading"
          value={c.heading}
          maxLength={120}
          onChange={(v) => onChange({ ...slide, content: { ...c, heading: v } })}
        />
      </FieldLabel>
      <FieldLabel label={`Bullets (${c.bullets.length} / ${MAX_BULLETS})`}>
        <ul className="space-y-1" data-testid="prop-bl-bullets">
          {c.bullets.map((b, i) => (
            <li
              key={i}
              data-testid={`prop-bl-bullet-${i}`}
              className="flex items-start gap-1"
            >
              <textarea
                data-testid={`prop-bl-bullet-input-${i}`}
                value={b}
                maxLength={BULLET_MAX_CHARS}
                rows={2}
                onChange={(e) => updateBullet(i, e.target.value)}
                className="min-w-0 flex-1 resize-y rounded border border-border bg-background px-2 py-1 text-xs"
              />
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  aria-label="Move bullet up"
                  data-testid={`prop-bl-bullet-up-${i}`}
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                  className="rounded border border-border px-1 text-[10px] disabled:opacity-30"
                >
                  ▲
                </button>
                <button
                  type="button"
                  aria-label="Move bullet down"
                  data-testid={`prop-bl-bullet-down-${i}`}
                  disabled={i === c.bullets.length - 1}
                  onClick={() => move(i, i + 1)}
                  className="rounded border border-border px-1 text-[10px] disabled:opacity-30"
                >
                  ▼
                </button>
                <button
                  type="button"
                  aria-label="Remove bullet"
                  data-testid={`prop-bl-bullet-remove-${i}`}
                  disabled={c.bullets.length <= 1}
                  onClick={() => removeBullet(i)}
                  className="rounded border border-border px-1 text-[10px] disabled:opacity-30"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          data-testid="prop-bl-add-bullet"
          disabled={c.bullets.length >= MAX_BULLETS}
          onClick={addBullet}
          className="mt-1 rounded border border-border px-2 py-1 text-[10px] disabled:opacity-50"
        >
          + Add bullet
        </button>
      </FieldLabel>

      {/* Issue (2026-05): expose the optional inline image controls so
          users can author + regenerate the bullet-list thumbnail without
          dropping into JSON. */}
      <fieldset className="mt-3 space-y-2 rounded border border-border p-2">
        <legend className="px-1 text-[11px] font-semibold text-muted-foreground">
          Inline image (optional)
        </legend>
        <FieldLabel label="Alt text" htmlFor="prop-bl-img-alt">
          <TextInput
            id="prop-bl-img-alt"
            testId="prop-bl-img-alt"
            value={c.image?.alt ?? ""}
            maxLength={200}
            onChange={(v) => updateImage({ alt: v })}
          />
        </FieldLabel>
        <FieldLabel label="Prompt">
          <TextArea
            testId="prop-bl-img-prompt"
            value={c.image?.prompt ?? ""}
            maxLength={400}
            rows={2}
            onChange={(v) => updateImage({ prompt: v })}
          />
        </FieldLabel>
        <button
          type="button"
          data-testid="prop-bl-img-regen"
          disabled={!c.image?.prompt}
          onClick={() => setRegenOpen(true)}
          className="mt-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-50"
        >
          Regenerate image…
        </button>
      </fieldset>

      {regenOpen && (
        <RegenerateImageDialog
          open={regenOpen}
          onOpenChange={setRegenOpen}
          deckId={deckId}
          slideId={slideId}
          initialPrompt={c.image?.prompt ?? ""}
          mode="inline"
          slot="image"
        />
      )}
    </div>
  );
};

export default BulletListEditor;
