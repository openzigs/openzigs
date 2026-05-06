"use client";

/**
 * Brand kit picker — dropdown of available kits + edit/new buttons
 * (Phase 5, sub-issue #970).
 *
 * Uses native <select> for testability (Radix Select uses pointer events
 * that jsdom doesn't fully simulate). Keeps the swatch row + names visible
 * inline so the user sees the colours before choosing.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";

export interface BrandKitListEntry {
  id: string;
  name: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fontHeading?: string | null;
  fontBody?: string | null;
  /** Footer text the editor pre-fills for round-trip (Sub-issue #1047). */
  footerText?: string | null;
  /** Default logo corner (Sub-issue #1047). */
  defaultLogoPlacement?:
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "none"
    | null;
  /** Deck-wide slide-number toggle (Sub-issue #1047). */
  showSlideNumbers?: boolean | null;
  isStarter?: boolean;
}

interface BrandKitsResponse {
  brandKits: BrandKitListEntry[];
}

export interface BrandKitPickerProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (kit: BrandKitListEntry) => void;
  onCreate: () => void;
}

export const BrandKitPicker = ({
  selectedId,
  onSelect,
  onEdit,
  onCreate,
}: BrandKitPickerProps) => {
  const kitsQuery = useQuery({
    queryKey: ["pitch", "brand-kits"],
    queryFn: () => fetchJson<BrandKitsResponse>("/api/admin/pitch/brand-kits"),
  });

  const kits = kitsQuery.data?.brandKits ?? [];
  const selected = kits.find((k) => k.id === selectedId) ?? null;

  return (
    <div
      data-testid="pitch-brand-kit-picker"
      className="flex items-center gap-1"
    >
      <select
        data-testid="pitch-brand-kit-select"
        aria-label="Brand kit"
        value={selectedId ?? ""}
        onChange={(e) => {
          const id = e.target.value;
          if (id) onSelect(id);
        }}
        disabled={kitsQuery.isLoading || kits.length === 0}
        className="h-7 rounded border border-border bg-background px-2 text-xs"
      >
        {!selectedId && <option value="">— pick a kit —</option>}
        {kits.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
            {k.isStarter ? " (starter)" : ""}
          </option>
        ))}
      </select>
      {selected && (
        <span
          data-testid="pitch-brand-kit-swatch"
          aria-hidden
          className="inline-flex items-center gap-0.5"
        >
          <span
            className="inline-block h-3 w-3 rounded border border-border"
            style={{ background: selected.primaryColor }}
          />
          <span
            className="inline-block h-3 w-3 rounded border border-border"
            style={{ background: selected.secondaryColor }}
          />
          <span
            className="inline-block h-3 w-3 rounded border border-border"
            style={{ background: selected.accentColor }}
          />
        </span>
      )}
      <button
        type="button"
        data-testid="pitch-brand-kit-edit"
        disabled={!selected}
        onClick={() => selected && onEdit(selected)}
        className="rounded border border-border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-50"
      >
        Edit kit
      </button>
      <button
        type="button"
        data-testid="pitch-brand-kit-new"
        onClick={onCreate}
        className="rounded border border-border px-2 py-1 text-xs hover:bg-muted/40"
      >
        + New
      </button>
    </div>
  );
};
