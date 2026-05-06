"use client";

/**
 * Roadmap editor (#1052 AC6).
 *
 * Schema is a matrix: `columns[]` (e.g. quarters) × `tracks[]` (e.g.
 * "Backend", "Mobile") with `items[]` referencing them by index. The
 * editor surfaces three sections — column labels, track labels, and an
 * item list where each item picks its column + track + status. Reorder
 * is deferred; add/remove keeps v1 useful without bloat.
 */

import { FieldLabel, TextInput, type PropertyEditorProps } from "./shared";

type RoadmapStatus = "planned" | "in_progress" | "done";

interface RoadmapItem {
  column: number;
  track: number;
  label: string;
  status?: RoadmapStatus;
}

interface RoadmapSlide {
  template: "roadmap";
  content: {
    heading: string;
    columns: string[];
    tracks: string[];
    items: RoadmapItem[];
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const STATUSES: RoadmapStatus[] = ["planned", "in_progress", "done"];

const RoadmapEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<RoadmapSlide>) => {
  const c = slide.content;
  const update = (patch: Partial<RoadmapSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  const updateColumn = (idx: number, value: string) => {
    const next = c.columns.map((v, i) => (i === idx ? value : v));
    update({ columns: next });
  };
  const addColumn = () => {
    if (c.columns.length >= 6) return;
    update({ columns: [...c.columns, `Q${c.columns.length + 1}`] });
  };
  const removeColumn = (idx: number) => {
    if (c.columns.length <= 2) return;
    update({
      columns: c.columns.filter((_, i) => i !== idx),
      // Drop items pointing at the removed column; shift higher indices down.
      items: c.items
        .filter((it) => it.column !== idx)
        .map((it) => (it.column > idx ? { ...it, column: it.column - 1 } : it)),
    });
  };

  const updateTrack = (idx: number, value: string) => {
    const next = c.tracks.map((v, i) => (i === idx ? value : v));
    update({ tracks: next });
  };
  const addTrack = () => {
    if (c.tracks.length >= 4) return;
    update({ tracks: [...c.tracks, `Track ${c.tracks.length + 1}`] });
  };
  const removeTrack = (idx: number) => {
    if (c.tracks.length <= 1) return;
    update({
      tracks: c.tracks.filter((_, i) => i !== idx),
      items: c.items
        .filter((it) => it.track !== idx)
        .map((it) => (it.track > idx ? { ...it, track: it.track - 1 } : it)),
    });
  };

  const updateItem = (idx: number, patch: Partial<RoadmapItem>) => {
    const next = c.items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    update({ items: next });
  };
  const addItem = () => {
    update({
      items: [
        ...c.items,
        { column: 0, track: 0, label: "New item", status: "planned" },
      ],
    });
  };
  const removeItem = (idx: number) =>
    update({ items: c.items.filter((_, i) => i !== idx) });

  return (
    <div data-testid="prop-editor-roadmap">
      <FieldLabel label="Heading" htmlFor="prop-rm-heading">
        <TextInput
          id="prop-rm-heading"
          testId="prop-rm-heading"
          value={c.heading}
          maxLength={120}
          onChange={(v) => update({ heading: v })}
        />
      </FieldLabel>

      <fieldset className="mb-3 space-y-2 rounded border border-border p-2">
        <legend className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Columns ({c.columns.length}/6)
        </legend>
        {c.columns.map((col, idx) => (
          <div key={idx} className="flex items-center gap-1">
            <input
              type="text"
              data-testid={`prop-rm-column-${idx}`}
              value={col}
              maxLength={40}
              onChange={(e) => updateColumn(idx, e.target.value)}
              className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
            />
            <button
              type="button"
              data-testid={`prop-rm-column-${idx}-remove`}
              disabled={c.columns.length <= 2}
              onClick={() => removeColumn(idx)}
              className="rounded border border-border px-1 py-0.5 text-[10px] hover:bg-muted/40 disabled:opacity-50"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          data-testid="prop-rm-add-column"
          disabled={c.columns.length >= 6}
          onClick={addColumn}
          className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted/40 disabled:opacity-50"
        >
          + Add column
        </button>
      </fieldset>

      <fieldset className="mb-3 space-y-2 rounded border border-border p-2">
        <legend className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Tracks ({c.tracks.length}/4)
        </legend>
        {c.tracks.map((tr, idx) => (
          <div key={idx} className="flex items-center gap-1">
            <input
              type="text"
              data-testid={`prop-rm-track-${idx}`}
              value={tr}
              maxLength={40}
              onChange={(e) => updateTrack(idx, e.target.value)}
              className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
            />
            <button
              type="button"
              data-testid={`prop-rm-track-${idx}-remove`}
              disabled={c.tracks.length <= 1}
              onClick={() => removeTrack(idx)}
              className="rounded border border-border px-1 py-0.5 text-[10px] hover:bg-muted/40 disabled:opacity-50"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          data-testid="prop-rm-add-track"
          disabled={c.tracks.length >= 4}
          onClick={addTrack}
          className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted/40 disabled:opacity-50"
        >
          + Add track
        </button>
      </fieldset>

      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
        <span>Items ({c.items.length}/60)</span>
        <button
          type="button"
          data-testid="prop-rm-add-item"
          disabled={c.items.length >= 60}
          onClick={addItem}
          className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted/40 disabled:opacity-50"
        >
          + Add item
        </button>
      </div>

      <div className="space-y-2">
        {c.items.map((it, idx) => (
          <fieldset
            key={idx}
            data-testid={`prop-rm-item-${idx}`}
            className="space-y-1 rounded border border-border p-2"
          >
            <input
              type="text"
              data-testid={`prop-rm-item-${idx}-label`}
              value={it.label}
              maxLength={80}
              onChange={(e) => updateItem(idx, { label: e.target.value })}
              className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
            />
            <div className="grid grid-cols-3 gap-1">
              <select
                data-testid={`prop-rm-item-${idx}-column`}
                value={it.column}
                onChange={(e) =>
                  updateItem(idx, { column: Number(e.target.value) })
                }
                className="rounded border border-border bg-background px-1 py-1 text-xs"
              >
                {c.columns.map((col, ci) => (
                  <option key={ci} value={ci}>
                    {col}
                  </option>
                ))}
              </select>
              <select
                data-testid={`prop-rm-item-${idx}-track`}
                value={it.track}
                onChange={(e) =>
                  updateItem(idx, { track: Number(e.target.value) })
                }
                className="rounded border border-border bg-background px-1 py-1 text-xs"
              >
                {c.tracks.map((tr, ti) => (
                  <option key={ti} value={ti}>
                    {tr}
                  </option>
                ))}
              </select>
              <select
                data-testid={`prop-rm-item-${idx}-status`}
                value={it.status ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  updateItem(idx, {
                    status: v === "" ? undefined : (v as RoadmapStatus),
                  });
                }}
                className="rounded border border-border bg-background px-1 py-1 text-xs"
              >
                <option value="">—</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              data-testid={`prop-rm-item-${idx}-remove`}
              onClick={() => removeItem(idx)}
              className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted/40"
            >
              Remove
            </button>
          </fieldset>
        ))}
      </div>
    </div>
  );
};

export default RoadmapEditor;
