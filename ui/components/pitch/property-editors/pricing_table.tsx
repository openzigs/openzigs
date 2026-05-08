"use client";

/**
 * Pricing Table editor (#1046 AC6).
 *
 * 2..4 tier rows; each tier has a name, price, optional period, an
 * editable comma-separated feature list (1..10), an optional CTA label,
 * and a "highlighted" flag (only one tier may be highlighted — the
 * schema's superRefine catches violations server-side; the UI guards
 * by clearing the flag from siblings when a new one is checked).
 */

import { FieldLabel, TextInput, type PropertyEditorProps } from "./shared";

interface PricingTier {
  name: string;
  price: string;
  period?: string;
  features: string[];
  cta?: string;
  highlighted?: boolean;
}

interface PricingTableSlide {
  template: "pricing_table";
  content: {
    heading: string;
    tiers: PricingTier[];
    footnote?: string;
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const blankTier = (): PricingTier => ({
  name: "New tier",
  price: "$0",
  features: ["Feature"],
});

const PricingTableEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<PricingTableSlide>) => {
  const c = slide.content;
  const update = (patch: Partial<PricingTableSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  const updateTier = (idx: number, patch: Partial<PricingTier>) => {
    const next = c.tiers.map((t, i) => (i === idx ? { ...t, ...patch } : t));
    update({ tiers: next });
  };

  const setHighlighted = (idx: number, on: boolean) => {
    // Schema invariant: at most one highlighted tier.
    const next = c.tiers.map((t, i) => ({
      ...t,
      highlighted: on && i === idx ? true : false,
    }));
    update({ tiers: next });
  };

  const addTier = () => {
    if (c.tiers.length >= 4) return;
    update({ tiers: [...c.tiers, blankTier()] });
  };

  const removeTier = (idx: number) => {
    if (c.tiers.length <= 2) return;
    update({ tiers: c.tiers.filter((_, i) => i !== idx) });
  };

  return (
    <div data-testid="prop-editor-pricing-table">
      <FieldLabel label="Heading" htmlFor="prop-pt-heading">
        <TextInput
          id="prop-pt-heading"
          testId="prop-pt-heading"
          value={c.heading}
          maxLength={120}
          onChange={(v) => update({ heading: v })}
        />
      </FieldLabel>

      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
        <span>Tiers ({c.tiers.length}/4)</span>
        <button
          type="button"
          data-testid="prop-pt-add-tier"
          disabled={c.tiers.length >= 4}
          onClick={addTier}
          className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted/40 disabled:opacity-50"
        >
          + Add tier
        </button>
      </div>

      <div className="space-y-3">
        {c.tiers.map((tier, idx) => (
          <fieldset
            key={idx}
            data-testid={`prop-pt-tier-${idx}`}
            className="space-y-2 rounded border border-border p-2"
          >
            <legend className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              Tier {idx + 1}
            </legend>
            <FieldLabel label="Name">
              <TextInput
                testId={`prop-pt-tier-${idx}-name`}
                value={tier.name}
                maxLength={40}
                onChange={(v) => updateTier(idx, { name: v })}
              />
            </FieldLabel>
            <div className="grid grid-cols-2 gap-2">
              <FieldLabel label="Price">
                <TextInput
                  testId={`prop-pt-tier-${idx}-price`}
                  value={tier.price}
                  maxLength={40}
                  onChange={(v) => updateTier(idx, { price: v })}
                />
              </FieldLabel>
              <FieldLabel label="Period">
                <TextInput
                  testId={`prop-pt-tier-${idx}-period`}
                  value={tier.period ?? ""}
                  maxLength={20}
                  onChange={(v) => updateTier(idx, { period: v || undefined })}
                />
              </FieldLabel>
            </div>
            <FieldLabel
              label="Features (one per line, 1–10)"
              hint="Each line is a bullet on the rendered card."
            >
              <textarea
                data-testid={`prop-pt-tier-${idx}-features`}
                value={tier.features.join("\n")}
                rows={4}
                onChange={(e) => {
                  const lines = e.target.value
                    .split("\n")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0)
                    .slice(0, 10);
                  updateTier(idx, {
                    features: lines.length > 0 ? lines : [""],
                  });
                }}
                className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-xs"
              />
            </FieldLabel>
            <FieldLabel label="CTA (optional)">
              <TextInput
                testId={`prop-pt-tier-${idx}-cta`}
                value={tier.cta ?? ""}
                maxLength={40}
                onChange={(v) => updateTier(idx, { cta: v || undefined })}
              />
            </FieldLabel>
            <label className="flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                data-testid={`prop-pt-tier-${idx}-highlighted`}
                checked={tier.highlighted ?? false}
                onChange={(e) => setHighlighted(idx, e.target.checked)}
              />
              Highlighted (only one tier at a time)
            </label>
            <button
              type="button"
              data-testid={`prop-pt-tier-${idx}-remove`}
              disabled={c.tiers.length <= 2}
              onClick={() => removeTier(idx)}
              className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted/40 disabled:opacity-50"
            >
              Remove tier
            </button>
          </fieldset>
        ))}
      </div>

      <div className="mt-3">
        <FieldLabel label="Footnote (optional)" htmlFor="prop-pt-footnote">
          <TextInput
            id="prop-pt-footnote"
            testId="prop-pt-footnote"
            value={c.footnote ?? ""}
            maxLength={160}
            onChange={(v) => update({ footnote: v || undefined })}
          />
        </FieldLabel>
      </div>
    </div>
  );
};

export default PricingTableEditor;
