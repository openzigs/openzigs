"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel, TextArea, TextInput, type PropertyEditorProps } from "./shared";

interface SeriesPoint {
  x: string;
  y: number;
}
interface Series {
  name: string;
  data: SeriesPoint[];
}
interface ChartSlide {
  template: "chart";
  content: {
    heading: string;
    chart_type: "bar" | "line" | "pie" | "area";
    series: Series[];
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const CHART_TYPES: ChartSlide["content"]["chart_type"][] = [
  "bar",
  "line",
  "pie",
  "area",
];

/**
 * Validates and parses a JSON snippet that the user types in the Series
 * textarea. Expected shape:
 *
 *   [{ "name": "Sales", "data": [{ "x": "Q1", "y": 12 }, ...] }]
 *
 * Returns either the parsed series array or an error message.
 */
function tryParseSeries(text: string):
  | { ok: true; value: Series[] }
  | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "JSON parse error" };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "Series must be an array" };
  }
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "Each series must be an object" };
    }
    const obj = item as { name?: unknown; data?: unknown };
    if (typeof obj.name !== "string") {
      return { ok: false, error: "Each series needs a string `name`" };
    }
    if (!Array.isArray(obj.data)) {
      return { ok: false, error: "Each series needs an array `data`" };
    }
    for (const p of obj.data) {
      if (!p || typeof p !== "object") {
        return { ok: false, error: "Each data point must be an object" };
      }
      const pt = p as { x?: unknown; y?: unknown };
      if (typeof pt.x !== "string" || typeof pt.y !== "number") {
        return { ok: false, error: "Each point needs string x + number y" };
      }
    }
  }
  return { ok: true, value: raw as Series[] };
}

const ChartEditor = ({ slide, onChange }: PropertyEditorProps<ChartSlide>) => {
  const c = slide.content;
  const [seriesText, setSeriesText] = useState(() =>
    JSON.stringify(c.series, null, 2),
  );
  const [seriesError, setSeriesError] = useState<string | null>(null);

  // When the slide id changes (different slide selected), refresh the textarea
  // from the new slide's series.
  const slideKey = (slide as ChartSlide & { id?: string }).id ?? "";
  useEffect(() => {
    setSeriesText(JSON.stringify(c.series, null, 2));
    setSeriesError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideKey]);

  const update = (patch: Partial<ChartSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  const handleSeriesChange = (text: string) => {
    setSeriesText(text);
    const result = tryParseSeries(text);
    if (result.ok) {
      setSeriesError(null);
      update({ series: result.value });
    } else {
      setSeriesError(result.error);
    }
  };

  return (
    <div data-testid="prop-editor-chart">
      <FieldLabel label="Heading">
        <TextInput
          testId="prop-chart-heading"
          value={c.heading}
          maxLength={120}
          onChange={(v) => update({ heading: v })}
        />
      </FieldLabel>
      <FieldLabel label="Chart type">
        <Select
          value={c.chart_type}
          onValueChange={(v) =>
            update({ chart_type: v as ChartSlide["content"]["chart_type"] })
          }
        >
          <SelectTrigger
            data-testid="prop-chart-type-trigger"
            className="h-8 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHART_TYPES.map((t) => (
              <SelectItem
                key={t}
                value={t}
                data-testid={`prop-chart-type-${t}`}
              >
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldLabel>
      <FieldLabel
        label="Series (JSON)"
        hint='Shape: [{"name":"Sales","data":[{"x":"Q1","y":12}]}]'
      >
        <TextArea
          testId="prop-chart-series"
          value={seriesText}
          rows={10}
          monospace
          invalid={seriesError !== null}
          onChange={handleSeriesChange}
        />
        {seriesError && (
          <span
            data-testid="prop-chart-series-error"
            className="mt-1 block text-[10px] text-red-500"
          >
            {seriesError}
          </span>
        )}
      </FieldLabel>
    </div>
  );
};

export default ChartEditor;
