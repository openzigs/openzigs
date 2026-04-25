"use client";

import { FieldLabel, TextInput, type PropertyEditorProps } from "./shared";

interface Kpi {
  value: string;
  label: string;
  delta?: string;
}

interface StatsKpiSlide {
  template: "stats_kpi";
  content: {
    heading: string;
    kpis: Kpi[];
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const MAX_KPIS = 6;
const MIN_KPIS = 2;

const StatsKpiEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<StatsKpiSlide>) => {
  const c = slide.content;
  const setKpis = (next: Kpi[]) =>
    onChange({ ...slide, content: { ...c, kpis: next } });

  const updateKpi = (i: number, patch: Partial<Kpi>) =>
    setKpis(c.kpis.map((k, idx) => (idx === i ? { ...k, ...patch } : k)));

  const addKpi = () =>
    c.kpis.length < MAX_KPIS && setKpis([...c.kpis, { value: "", label: "" }]);
  const removeKpi = (i: number) =>
    c.kpis.length > MIN_KPIS && setKpis(c.kpis.filter((_, idx) => idx !== i));

  return (
    <div data-testid="prop-editor-stats-kpi">
      <FieldLabel label="Heading">
        <TextInput
          testId="prop-skpi-heading"
          value={c.heading}
          maxLength={120}
          onChange={(v) => onChange({ ...slide, content: { ...c, heading: v } })}
        />
      </FieldLabel>
      <FieldLabel
        label={`KPIs (${c.kpis.length} / ${MAX_KPIS}, min ${MIN_KPIS})`}
      >
        <ul className="space-y-2" data-testid="prop-skpi-list">
          {c.kpis.map((k, i) => (
            <li
              key={i}
              data-testid={`prop-skpi-row-${i}`}
              className="rounded border border-border p-2"
            >
              <TextInput
                testId={`prop-skpi-value-${i}`}
                value={k.value}
                maxLength={20}
                placeholder="Value (e.g. 42%)"
                onChange={(v) => updateKpi(i, { value: v })}
              />
              <div className="mt-1">
                <TextInput
                  testId={`prop-skpi-label-${i}`}
                  value={k.label}
                  maxLength={60}
                  placeholder="Label"
                  onChange={(v) => updateKpi(i, { label: v })}
                />
              </div>
              <div className="mt-1 flex gap-1">
                <TextInput
                  testId={`prop-skpi-delta-${i}`}
                  value={k.delta ?? ""}
                  maxLength={20}
                  placeholder="Delta (optional)"
                  onChange={(v) => updateKpi(i, { delta: v || undefined })}
                />
                <button
                  type="button"
                  aria-label="Remove KPI"
                  data-testid={`prop-skpi-remove-${i}`}
                  disabled={c.kpis.length <= MIN_KPIS}
                  onClick={() => removeKpi(i)}
                  className="rounded border border-border px-2 text-[10px] disabled:opacity-30"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          data-testid="prop-skpi-add"
          disabled={c.kpis.length >= MAX_KPIS}
          onClick={addKpi}
          className="mt-1 rounded border border-border px-2 py-1 text-[10px] disabled:opacity-50"
        >
          + Add KPI
        </button>
      </FieldLabel>
    </div>
  );
};

export default StatsKpiEditor;
