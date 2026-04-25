"use client";

import { FieldLabel, TextInput, type PropertyEditorProps } from "./shared";

interface Row {
  label: string;
  cells: string[];
}

interface ComparisonTableSlide {
  template: "comparison_table";
  content: {
    heading: string;
    columns: string[];
    rows: Row[];
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const MAX_COLS = 5;
const MIN_COLS = 2;
const MAX_ROWS = 8;

const ComparisonTableEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<ComparisonTableSlide>) => {
  const c = slide.content;
  const update = (patch: Partial<ComparisonTableSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  const updateColumn = (i: number, value: string) =>
    update({ columns: c.columns.map((col, idx) => (idx === i ? value : col)) });

  const addColumn = () => {
    if (c.columns.length >= MAX_COLS) return;
    update({
      columns: [...c.columns, ""],
      rows: c.rows.map((r) => ({ ...r, cells: [...r.cells, ""] })),
    });
  };
  const removeColumn = (i: number) => {
    if (c.columns.length <= MIN_COLS) return;
    update({
      columns: c.columns.filter((_, idx) => idx !== i),
      rows: c.rows.map((r) => ({
        ...r,
        cells: r.cells.filter((_, idx) => idx !== i),
      })),
    });
  };

  const updateRow = (i: number, patch: Partial<Row>) =>
    update({ rows: c.rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
  const updateCell = (rowIdx: number, colIdx: number, value: string) => {
    const row = c.rows[rowIdx];
    if (!row) return;
    updateRow(rowIdx, {
      cells: row.cells.map((cell, idx) => (idx === colIdx ? value : cell)),
    });
  };
  const addRow = () => {
    if (c.rows.length >= MAX_ROWS) return;
    update({
      rows: [
        ...c.rows,
        { label: "", cells: c.columns.map(() => "") },
      ],
    });
  };
  const removeRow = (i: number) => {
    if (c.rows.length <= 1) return;
    update({ rows: c.rows.filter((_, idx) => idx !== i) });
  };

  return (
    <div data-testid="prop-editor-comparison-table">
      <FieldLabel label="Heading">
        <TextInput
          testId="prop-ct-heading"
          value={c.heading}
          maxLength={120}
          onChange={(v) => update({ heading: v })}
        />
      </FieldLabel>
      <FieldLabel label={`Columns (${c.columns.length}, min ${MIN_COLS})`}>
        <ul className="space-y-1" data-testid="prop-ct-columns">
          {c.columns.map((col, i) => (
            <li key={i} className="flex gap-1">
              <TextInput
                testId={`prop-ct-col-${i}`}
                value={col}
                maxLength={40}
                onChange={(v) => updateColumn(i, v)}
              />
              <button
                type="button"
                aria-label="Remove column"
                data-testid={`prop-ct-col-remove-${i}`}
                disabled={c.columns.length <= MIN_COLS}
                onClick={() => removeColumn(i)}
                className="rounded border border-border px-1 text-[10px] disabled:opacity-30"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          data-testid="prop-ct-col-add"
          disabled={c.columns.length >= MAX_COLS}
          onClick={addColumn}
          className="mt-1 rounded border border-border px-2 py-1 text-[10px] disabled:opacity-50"
        >
          + Add column
        </button>
      </FieldLabel>
      <FieldLabel label={`Rows (${c.rows.length} / ${MAX_ROWS})`}>
        <ul className="space-y-2" data-testid="prop-ct-rows">
          {c.rows.map((row, ri) => (
            <li
              key={ri}
              data-testid={`prop-ct-row-${ri}`}
              className="rounded border border-border p-2"
            >
              <TextInput
                testId={`prop-ct-row-label-${ri}`}
                value={row.label}
                maxLength={60}
                placeholder="Row label"
                onChange={(v) => updateRow(ri, { label: v })}
              />
              <div className="mt-1 grid grid-cols-1 gap-1">
                {c.columns.map((_, ci) => (
                  <TextInput
                    key={ci}
                    testId={`prop-ct-cell-${ri}-${ci}`}
                    value={row.cells[ci] ?? ""}
                    maxLength={120}
                    placeholder={c.columns[ci]}
                    onChange={(v) => updateCell(ri, ci, v)}
                  />
                ))}
              </div>
              <button
                type="button"
                aria-label="Remove row"
                data-testid={`prop-ct-row-remove-${ri}`}
                disabled={c.rows.length <= 1}
                onClick={() => removeRow(ri)}
                className="mt-1 rounded border border-border px-2 text-[10px] disabled:opacity-30"
              >
                Remove row
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          data-testid="prop-ct-row-add"
          disabled={c.rows.length >= MAX_ROWS}
          onClick={addRow}
          className="mt-1 rounded border border-border px-2 py-1 text-[10px] disabled:opacity-50"
        >
          + Add row
        </button>
      </FieldLabel>
    </div>
  );
};

export default ComparisonTableEditor;
