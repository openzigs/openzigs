"use client";

import { FieldLabel, TextInput, type PropertyEditorProps } from "./shared";

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

const BulletListEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<BulletListSlide>) => {
  const c = slide.content;

  const setBullets = (next: string[]) =>
    onChange({ ...slide, content: { ...c, bullets: next } });

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
    </div>
  );
};

export default BulletListEditor;
