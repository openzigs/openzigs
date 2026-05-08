"use client";

/**
 * Agenda editor (#1052 AC6).
 *
 * The schema models two modes:
 *  - "auto" — items are derived from the deck's `section_divider`
 *    slides at render time. The manual list is hidden in this mode.
 *  - "manual" — explicit ordered list of 1..20 items.
 *
 * The toggle wires straight to `content.mode`.
 */

import { FieldLabel, TextInput, type PropertyEditorProps } from "./shared";

interface AgendaSlide {
  template: "agenda";
  content: {
    heading?: string;
    mode: "auto" | "manual";
    items?: string[];
    numbered?: boolean;
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const AgendaEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<AgendaSlide>) => {
  const c = slide.content;
  const update = (patch: Partial<AgendaSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  const items = c.items ?? [];

  const updateItem = (idx: number, value: string) => {
    const next = items.map((v, i) => (i === idx ? value : v));
    update({ items: next });
  };
  const addItem = () => {
    if (items.length >= 20) return;
    update({ items: [...items, "New item"] });
  };
  const removeItem = (idx: number) =>
    update({ items: items.filter((_, i) => i !== idx) });

  return (
    <div data-testid="prop-editor-agenda">
      <FieldLabel label="Heading (optional)" htmlFor="prop-ag-heading">
        <TextInput
          id="prop-ag-heading"
          testId="prop-ag-heading"
          value={c.heading ?? ""}
          maxLength={120}
          onChange={(v) => update({ heading: v || undefined })}
        />
      </FieldLabel>

      <label className="mb-3 flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          data-testid="prop-ag-auto"
          checked={c.mode === "auto"}
          onChange={(e) =>
            update({ mode: e.target.checked ? "auto" : "manual" })
          }
        />
        Auto-derive from deck (uses section dividers as agenda items)
      </label>

      <label className="mb-3 flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          data-testid="prop-ag-numbered"
          checked={c.numbered ?? false}
          onChange={(e) => update({ numbered: e.target.checked || undefined })}
        />
        Numbered list
      </label>

      {c.mode === "auto" ? (
        <p
          data-testid="prop-ag-auto-note"
          className="rounded border border-border bg-muted/30 p-2 text-[11px] text-muted-foreground"
        >
          Items will be derived automatically from the deck&apos;s section
          dividers at render time. Switch off &ldquo;Auto-derive&rdquo; to
          author a manual list.
        </p>
      ) : (
        <fieldset className="space-y-2 rounded border border-border p-2">
          <legend className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Items ({items.length}/20)
          </legend>
          {items.map((it, idx) => (
            <div key={idx} className="flex items-center gap-1">
              <input
                type="text"
                data-testid={`prop-ag-item-${idx}`}
                value={it}
                maxLength={120}
                onChange={(e) => updateItem(idx, e.target.value)}
                className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
              />
              <button
                type="button"
                data-testid={`prop-ag-item-${idx}-remove`}
                onClick={() => removeItem(idx)}
                className="rounded border border-border px-1 py-0.5 text-[10px] hover:bg-muted/40"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            data-testid="prop-ag-add-item"
            disabled={items.length >= 20}
            onClick={addItem}
            className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted/40 disabled:opacity-50"
          >
            + Add item
          </button>
        </fieldset>
      )}
    </div>
  );
};

export default AgendaEditor;
