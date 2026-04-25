"use client";

/**
 * Script panel — bottom-of-editor collapsible (Phase 5, sub-issue #969).
 *
 * Bidirectional script ↔ slide highlight is conditioned on the slide
 * carrying a `source_range: { start, end }` field. The Phase-1 schema
 * does NOT include that field yet, so this panel degrades gracefully:
 * with no `source_range`, clicking a slide does NOT scroll, clicking in
 * the script does NOT select a slide, and a one-time hint surfaces in
 * the panel header.
 *
 * Adding `source_range` is tracked as a separate Phase-1 follow-up.
 */

import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { showToast } from "@/components/toast";

interface SourceRange {
  start: number;
  end: number;
}

interface ScriptSlide {
  id: string;
  slide: {
    template: string;
    content: Record<string, unknown>;
    source_range?: SourceRange;
  };
}

export interface ScriptPanelProps {
  deckId: string;
  brandKitId: string;
  script: string;
  slides: ScriptSlide[];
  selectedSlideId: string | null;
  onSelectSlide: (slideId: string) => void;
}

const COLLAPSED_PX = 32;
const EXPANDED_PX = 288;
const MIN_EXPANDED_PX = 120;
const MAX_EXPANDED_PX = 480;

function rangeOf(slide: ScriptSlide): SourceRange | null {
  const r = slide.slide.source_range;
  if (!r) return null;
  if (typeof r.start !== "number" || typeof r.end !== "number") return null;
  if (r.end < r.start || r.start < 0) return null;
  return r;
}

export const ScriptPanel = ({
  deckId,
  brandKitId,
  script,
  slides,
  selectedSlideId,
  onSelectSlide,
}: ScriptPanelProps) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(EXPANDED_PX);
  const [confirming, setConfirming] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Has any slide carried `source_range`? Drives the "feature unavailable"
  // hint and avoids attaching click handlers when no slide can answer them.
  const hasAnyRange = useMemo(
    () => slides.some((s) => rangeOf(s) !== null),
    [slides],
  );

  // Selecting a slide → scroll the textarea to that range and visually
  // highlight via setSelectionRange. We DON'T focus the textarea (would
  // steal focus from the canvas), but we set the selection so the browser
  // shows it on next focus and the test can assert it.
  useEffect(() => {
    if (!open || !selectedSlideId) return;
    const slide = slides.find((s) => s.id === selectedSlideId);
    if (!slide) return;
    const r = rangeOf(slide);
    if (!r) return;
    const el = textareaRef.current;
    if (!el) return;
    el.setSelectionRange(r.start, Math.min(r.end, script.length));
    // Approximate scroll: jump to a line proportional to the offset.
    const ratio = r.start / Math.max(1, script.length);
    el.scrollTop = Math.max(0, el.scrollHeight * ratio - 40);
  }, [open, selectedSlideId, slides, script.length]);

  const handleScriptClick = useCallback(
    (e: ReactMouseEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      const offset = el.selectionStart ?? 0;
      const owners = slides.filter((s) => {
        const r = rangeOf(s);
        return r !== null && offset >= r.start && offset <= r.end;
      });
      if (owners.length === 0) return; // graceful no-op
      onSelectSlide(owners[0].id);
    },
    [slides, onSelectSlide],
  );

  const reRunDraftMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/admin/pitch/decks/draft`, {
        method: "POST",
        body: JSON.stringify({
          script,
          brandKitId,
          // Targeting the existing deck to replace its slides is up to the
          // backend; the current router will create a NEW deck. We surface
          // that to the user via the toast.
        }),
      }),
    onSuccess: () => {
      showToast(
        "Re-drafted. A new deck was created from the script.",
        "success",
      );
      queryClient.invalidateQueries({ queryKey: ["pitch", "deck", deckId] });
      queryClient.invalidateQueries({ queryKey: ["pitch", "render", deckId] });
    },
    onError: (err) => {
      showToast(
        `Re-draft failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    },
  });

  // Resize via drag handle.
  const onDragStart = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: globalThis.MouseEvent) => {
      const next = startH - (ev.clientY - startY);
      setHeight(Math.max(MIN_EXPANDED_PX, Math.min(MAX_EXPANDED_PX, next)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <section
      className="border-t border-border bg-card"
      data-testid="pitch-script-panel"
      style={{ height: open ? height : COLLAPSED_PX }}
    >
      <div className="flex items-center justify-between px-4 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <button
          type="button"
          data-testid="pitch-script-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 hover:text-foreground"
        >
          <span>Script</span>
          {!hasAnyRange && open && (
            <span
              data-testid="pitch-script-degraded-hint"
              className="text-[10px] font-normal normal-case tracking-normal text-amber-600"
              title="Slides have no source_range — bidirectional highlight is unavailable."
            >
              (highlight unavailable)
            </span>
          )}
          <span className="ml-auto">{open ? "▼" : "▲"}</span>
        </button>
        {open && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Resize script panel"
              data-testid="pitch-script-drag-handle"
              onMouseDown={onDragStart}
              className="cursor-row-resize px-2 text-[10px]"
            >
              ≡
            </button>
            <button
              type="button"
              data-testid="pitch-script-rerun-draft"
              disabled={reRunDraftMutation.isPending}
              onClick={() => setConfirming(true)}
              className="rounded border border-border px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal hover:bg-muted/40 disabled:opacity-50"
            >
              Re-run draft…
            </button>
          </div>
        )}
      </div>
      {open && (
        <textarea
          ref={textareaRef}
          data-testid="pitch-script-textarea"
          readOnly
          value={script}
          onClick={handleScriptClick}
          onKeyUp={(e) =>
            handleScriptClick(
              e as unknown as ReactMouseEvent<HTMLTextAreaElement>,
            )
          }
          className="w-full resize-none border-t border-border bg-background p-2 text-xs"
          style={{ height: height - COLLAPSED_PX }}
        />
      )}
      {confirming && (
        <div data-testid="pitch-script-rerun-confirm-host">
          <ConfirmDialog
            title="Re-run draft?"
            message="This generates a fresh deck from the current script. Your current slides will NOT be deleted; a new deck is created. Continue?"
            confirmLabel="Re-draft"
            variant="danger"
            onConfirm={() => {
              setConfirming(false);
              reRunDraftMutation.mutate();
            }}
            onCancel={() => setConfirming(false)}
          />
        </div>
      )}
    </section>
  );
};
