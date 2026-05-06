"use client";

/**
 * Logo Grid editor (#1049 AC6).
 *
 * Repeating editor for 4..24 logo entries (alt + imageUrl + optional
 * href) plus a deck-level grayscale toggle.
 */

import { FieldLabel, TextInput, type PropertyEditorProps } from "./shared";

interface LogoEntry {
  alt: string;
  imageUrl: string;
  href?: string;
}

interface LogoGridSlide {
  template: "logo_grid";
  content: {
    heading?: string;
    caption?: string;
    grayscale?: boolean;
    logos: LogoEntry[];
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const blankLogo = (): LogoEntry => ({ alt: "Logo", imageUrl: "" });

const LogoGridEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<LogoGridSlide>) => {
  const c = slide.content;
  const update = (patch: Partial<LogoGridSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  const updateLogo = (idx: number, patch: Partial<LogoEntry>) => {
    const next = c.logos.map((l, i) => (i === idx ? { ...l, ...patch } : l));
    update({ logos: next });
  };

  const addLogo = () => {
    if (c.logos.length >= 24) return;
    update({ logos: [...c.logos, blankLogo()] });
  };

  const removeLogo = (idx: number) => {
    if (c.logos.length <= 4) return;
    update({ logos: c.logos.filter((_, i) => i !== idx) });
  };

  return (
    <div data-testid="prop-editor-logo-grid">
      <FieldLabel label="Heading (optional)" htmlFor="prop-lg-heading">
        <TextInput
          id="prop-lg-heading"
          testId="prop-lg-heading"
          value={c.heading ?? ""}
          maxLength={120}
          onChange={(v) => update({ heading: v || undefined })}
        />
      </FieldLabel>
      <FieldLabel label="Caption (optional)" htmlFor="prop-lg-caption">
        <TextInput
          id="prop-lg-caption"
          testId="prop-lg-caption"
          value={c.caption ?? ""}
          maxLength={120}
          onChange={(v) => update({ caption: v || undefined })}
        />
      </FieldLabel>
      <label className="mb-2 flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          data-testid="prop-lg-grayscale"
          checked={c.grayscale ?? false}
          onChange={(e) => update({ grayscale: e.target.checked || undefined })}
        />
        Render logos in grayscale
      </label>

      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
        <span>Logos ({c.logos.length}/24)</span>
        <button
          type="button"
          data-testid="prop-lg-add-logo"
          disabled={c.logos.length >= 24}
          onClick={addLogo}
          className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted/40 disabled:opacity-50"
        >
          + Add logo
        </button>
      </div>

      <div className="space-y-2">
        {c.logos.map((logo, idx) => (
          <fieldset
            key={idx}
            data-testid={`prop-lg-logo-${idx}`}
            className="space-y-1 rounded border border-border p-2"
          >
            <FieldLabel label="Alt text">
              <TextInput
                testId={`prop-lg-logo-${idx}-alt`}
                value={logo.alt}
                maxLength={80}
                onChange={(v) => updateLogo(idx, { alt: v })}
              />
            </FieldLabel>
            <FieldLabel label="Image URL">
              <TextInput
                testId={`prop-lg-logo-${idx}-image`}
                value={logo.imageUrl}
                maxLength={500}
                onChange={(v) => updateLogo(idx, { imageUrl: v })}
              />
            </FieldLabel>
            <FieldLabel label="Link URL (optional)">
              <TextInput
                testId={`prop-lg-logo-${idx}-href`}
                value={logo.href ?? ""}
                maxLength={500}
                onChange={(v) => updateLogo(idx, { href: v || undefined })}
              />
            </FieldLabel>
            <button
              type="button"
              data-testid={`prop-lg-logo-${idx}-remove`}
              disabled={c.logos.length <= 4}
              onClick={() => removeLogo(idx)}
              className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted/40 disabled:opacity-50"
            >
              Remove
            </button>
          </fieldset>
        ))}
      </div>
    </div>
  );
};

export default LogoGridEditor;
