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

interface MermaidSlide {
  template: "mermaid";
  content: {
    heading?: string;
    diagram_type:
      | "flowchart"
      | "sequence"
      | "gantt"
      | "class"
      | "state"
      | "er"
      | "pie"
      | "timeline";
    source: string;
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const DIAGRAM_TYPES: MermaidSlide["content"]["diagram_type"][] = [
  "flowchart",
  "sequence",
  "gantt",
  "class",
  "state",
  "er",
  "pie",
  "timeline",
];

const MermaidEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<MermaidSlide>) => {
  const c = slide.content;
  const [error, setError] = useState<string | null>(null);

  const update = (patch: Partial<MermaidSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  // Lazy-validate on source change. `mermaid.parse` is dynamic-imported so it
  // doesn't bloat editors that never touch a mermaid slide.
  useEffect(() => {
    let cancelled = false;
    if (!c.source.trim()) {
      setError(null);
      return;
    }
    (async () => {
      try {
        const mermaid = await import("mermaid");
        // `mermaid.parse` throws on invalid syntax in v10/v11.
        await mermaid.default.parse(c.source);
        if (!cancelled) setError(null);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [c.source]);

  return (
    <div data-testid="prop-editor-mermaid">
      <FieldLabel label="Heading (optional)">
        <TextInput
          testId="prop-mm-heading"
          value={c.heading ?? ""}
          maxLength={120}
          onChange={(v) => update({ heading: v || undefined })}
        />
      </FieldLabel>
      <FieldLabel label="Diagram type">
        <Select
          value={c.diagram_type}
          onValueChange={(v) =>
            update({
              diagram_type: v as MermaidSlide["content"]["diagram_type"],
            })
          }
        >
          <SelectTrigger
            data-testid="prop-mm-type-trigger"
            className="h-8 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIAGRAM_TYPES.map((t) => (
              <SelectItem
                key={t}
                value={t}
                data-testid={`prop-mm-type-${t}`}
              >
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldLabel>
      <FieldLabel label="Source">
        <TextArea
          testId="prop-mm-source"
          value={c.source}
          maxLength={4000}
          rows={10}
          monospace
          invalid={error !== null}
          onChange={(v) => update({ source: v })}
        />
        {error && (
          <span
            data-testid="prop-mm-source-error"
            className="mt-1 block text-[10px] text-red-500"
          >
            {error}
          </span>
        )}
      </FieldLabel>
    </div>
  );
};

export default MermaidEditor;
