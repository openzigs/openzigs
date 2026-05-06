"use client";

/**
 * Properties panel — right rail of the deck editor (Phase 5, sub-issue #971).
 *
 * Switches on `slide.template` and lazy-imports the matching editor from
 * `./property-editors/<template>.tsx` so the editor bundle doesn't
 * eagerly load every template editor.
 *
 * Mutations:
 *   - editors call `onChange(nextSlide)` synchronously
 *   - this panel maintains an optimistic local copy and DEBOUNCES a
 *     PATCH `/api/admin/pitch/decks/:deckId/slides/:slideId` by 400 ms
 *   - rollback on PATCH failure (toast + revert local state)
 *   - cross-tab consistency comes from `pitch:slide:updated` socket
 *     events handled by the editor shell (this panel just owns the
 *     pending edit)
 */

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import type { PitchBrandKitShape, PitchSlideShape } from "./property-editors/shared";

// `dynamic()` keeps each editor's bundle out of the main chunk.
// `ssr: false` is fine because the editor is client-only anyway.
//
// Each per-template editor narrows `slide`/`onChange` to its own discriminated
// shape (e.g. `TitleSlide`). The registry stores them under a wider
// `PitchSlideShape` props type so the panel can dispatch generically; we
// cast through `unknown` because TS treats `onChange` as contravariant and
// would otherwise reject the assignment.
type RegistryEditor = ReturnType<
  typeof dynamic<{
    slide: PitchSlideShape;
    onChange: (next: PitchSlideShape) => void;
    deckId: string;
    brandKit?: PitchBrandKitShape | null;
  }>
>;
const editorComponents: Record<string, RegistryEditor> = {
  title: dynamic(() => import("./property-editors/title"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  section_divider: dynamic(() => import("./property-editors/section_divider"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  bullet_list: dynamic(() => import("./property-editors/bullet_list"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  two_column: dynamic(() => import("./property-editors/two_column"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  image_caption: dynamic(() => import("./property-editors/image_caption"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  quote: dynamic(() => import("./property-editors/quote"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  stats_kpi: dynamic(() => import("./property-editors/stats_kpi"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  comparison_table: dynamic(
    () => import("./property-editors/comparison_table"),
    { ssr: false },
  ) as unknown as RegistryEditor,
  timeline: dynamic(() => import("./property-editors/timeline"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  full_bleed: dynamic(() => import("./property-editors/full_bleed"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  code: dynamic(() => import("./property-editors/code"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  qa: dynamic(() => import("./property-editors/qa"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  chart: dynamic(() => import("./property-editors/chart"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  mermaid: dynamic(() => import("./property-editors/mermaid"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  // Six new templates from epic #1045 — inline editors so the amber
  // "No editor available" notice no longer fires for these.
  pricing_table: dynamic(() => import("./property-editors/pricing_table"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  big_number: dynamic(() => import("./property-editors/big_number"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  team_grid: dynamic(() => import("./property-editors/team_grid"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  logo_grid: dynamic(() => import("./property-editors/logo_grid"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  roadmap: dynamic(() => import("./property-editors/roadmap"), {
    ssr: false,
  }) as unknown as RegistryEditor,
  agenda: dynamic(() => import("./property-editors/agenda"), {
    ssr: false,
  }) as unknown as RegistryEditor,
};

const DEBOUNCE_MS = 400;

export interface PropertiesPanelProps {
  deckId: string;
  /** The currently-selected slide row (id + slide payload). */
  selectedSlide: {
    id: string;
    slide: PitchSlideShape;
  } | null;
  brandKit?: PitchBrandKitShape | null;
}

export const PropertiesPanel = ({
  deckId,
  selectedSlide,
  brandKit,
}: PropertiesPanelProps) => {
  const queryClient = useQueryClient();
  const slideId = selectedSlide?.id ?? null;
  const incoming = selectedSlide?.slide ?? null;

  // Optimistic local copy. Reset whenever the selected slide changes
  // OR whenever the backend pushes new data (incoming reference changes).
  const [draft, setDraft] = useState<PitchSlideShape | null>(incoming);
  const lastSyncedRef = useRef<PitchSlideShape | null>(incoming);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft(incoming);
    lastSyncedRef.current = incoming;
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [slideId, incoming]);

  const patchMutation = useMutation({
    mutationFn: (slide: PitchSlideShape) => {
      if (!slideId) throw new Error("no slide selected");
      return fetchJson(
        `/api/admin/pitch/decks/${deckId}/slides/${slideId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ slide }),
        },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pitch", "deck", deckId] });
      queryClient.invalidateQueries({ queryKey: ["pitch", "render", deckId] });
    },
    onError: () => {
      // Rollback to last known server-confirmed value.
      setDraft(lastSyncedRef.current);
      showToast("Could not save slide.", "error");
    },
  });

  const handleEditorChange = (next: PitchSlideShape) => {
    setDraft(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      patchMutation.mutate(next);
    }, DEBOUNCE_MS);
  };

  const EditorComponent = useMemo(() => {
    if (!draft) return null;
    return editorComponents[draft.template] ?? null;
  }, [draft]);

  return (
    <aside
      className="min-h-0 overflow-y-auto border-l border-border bg-card p-3 text-xs"
      data-testid="pitch-properties-panel"
    >
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Properties
      </h2>
      {!draft || !slideId ? (
        <p
          data-testid="pitch-properties-empty"
          className="text-[11px] text-muted-foreground"
        >
          Pick a slide on the left to edit its content.
        </p>
      ) : EditorComponent ? (
        <>
          <div
            data-testid="pitch-properties-template-label"
            className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground"
          >
            {draft.template}
          </div>
          <EditorComponent
            slide={
              // attach id so editors that need it (regenerate-image dialog)
              // can read it.
              { ...draft, id: slideId } as PitchSlideShape
            }
            onChange={handleEditorChange}
            deckId={deckId}
            brandKit={brandKit ?? null}
          />
          <div className="mt-4 border-t border-border pt-3">
            <label
              htmlFor="pitch-properties-speaker-notes"
              className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Speaker notes
            </label>
            <textarea
              id="pitch-properties-speaker-notes"
              data-testid="pitch-properties-speaker-notes"
              value={draft.speaker_notes ?? ""}
              onChange={(e) =>
                handleEditorChange({
                  ...draft,
                  speaker_notes: e.target.value,
                } as PitchSlideShape)
              }
              rows={4}
              maxLength={2000}
              placeholder="Notes shown only to the presenter\u2026"
              className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-xs"
            />
          </div>
        </>
      ) : (
        <div
          data-testid="pitch-properties-unknown-template"
          className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-600"
        >
          No editor available for template{" "}
          <code className="font-mono">{draft.template}</code>.
        </div>
      )}
    </aside>
  );
};
