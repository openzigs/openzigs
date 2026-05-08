"use client";

/**
 * Big Number editor (#1046 AC6).
 *
 * Three primary inputs map to the schema's `value`, `label`, `support`.
 * Trend + trend label are tucked behind an optional toggle so the
 * default editor stays calm.
 */

import { FieldLabel, TextArea, TextInput, type PropertyEditorProps } from "./shared";

interface BigNumberSlide {
  template: "big_number";
  content: {
    value: string;
    label: string;
    support?: string;
    trend?: "up" | "down" | "flat";
    trend_label?: string;
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const TREND_OPTIONS: ("up" | "down" | "flat")[] = ["up", "down", "flat"];

const BigNumberEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<BigNumberSlide>) => {
  const c = slide.content;
  const update = (patch: Partial<BigNumberSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  return (
    <div data-testid="prop-editor-big-number">
      <FieldLabel label="Value" htmlFor="prop-bn-value" hint="Hero metric, e.g. 42% or 1.2M.">
        <TextInput
          id="prop-bn-value"
          testId="prop-bn-value"
          value={c.value}
          maxLength={20}
          onChange={(v) => update({ value: v })}
        />
      </FieldLabel>
      <FieldLabel label="Label" htmlFor="prop-bn-label" hint="Short caption shown above the value.">
        <TextInput
          id="prop-bn-label"
          testId="prop-bn-label"
          value={c.label}
          maxLength={80}
          onChange={(v) => update({ label: v })}
        />
      </FieldLabel>
      <FieldLabel label="Supporting text (optional)" htmlFor="prop-bn-support" hint="Sub-caption shown below the value.">
        <TextArea
          id="prop-bn-support"
          testId="prop-bn-support"
          value={c.support ?? ""}
          maxLength={240}
          rows={3}
          onChange={(v) => update({ support: v || undefined })}
        />
      </FieldLabel>
      <FieldLabel label="Trend (optional)" htmlFor="prop-bn-trend">
        <select
          id="prop-bn-trend"
          data-testid="prop-bn-trend"
          value={c.trend ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            update({ trend: v === "" ? undefined : (v as "up" | "down" | "flat") });
          }}
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="">— none —</option>
          {TREND_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </FieldLabel>
      <FieldLabel label="Trend label (optional)" htmlFor="prop-bn-trend-label">
        <TextInput
          id="prop-bn-trend-label"
          testId="prop-bn-trend-label"
          value={c.trend_label ?? ""}
          maxLength={40}
          onChange={(v) => update({ trend_label: v || undefined })}
        />
      </FieldLabel>
    </div>
  );
};

export default BigNumberEditor;
