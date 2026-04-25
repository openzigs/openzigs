"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { buildUrl, fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { RevealCanvas } from "@/components/pitch/reveal-canvas";
import { SlideRail, type SlideRailItem } from "@/components/pitch/slide-rail";

interface DeckSlideRow {
  id: string;
  deck_id: string;
  position: number;
  // The schema is a discriminated union; we only read a few common fields here.
  slide: {
    template: string;
    content: Record<string, unknown>;
    speaker_notes?: string;
  };
  created_at: string;
  updated_at: string;
}

interface DeckPayload {
  deck: {
    id: string;
    title: string;
    brand_kit_id: string;
    aspect_ratio: string;
    metadata: {
      source_script: string;
      tone?: string;
      audience?: string;
    };
    created_at: string;
    updated_at: string;
  };
  slides: DeckSlideRow[];
}

type SaveState = "idle" | "saving" | "error";

const AUTH_TOKEN =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? ""
    : "";

function deriveTitlePreview(slide: DeckSlideRow["slide"]): string {
  const c = slide.content as Record<string, unknown>;
  const candidate =
    (typeof c.title === "string" && c.title) ||
    (typeof c.heading === "string" && c.heading) ||
    (typeof c.quote === "string" && (c.quote as string).slice(0, 40)) ||
    (typeof c.caption === "string" && c.caption) ||
    "";
  return String(candidate).slice(0, 40);
}

async function fetchRenderHtml(deckId: string): Promise<string> {
  const url = buildUrl(`/api/admin/pitch/decks/${deckId}/render?mode=embedded`);
  const headers: HeadersInit = AUTH_TOKEN
    ? { Authorization: `Bearer ${AUTH_TOKEN}` }
    : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`render failed: ${res.status}`);
  }
  return res.text();
}

export default function PitchDeckEditorPage() {
  const params = useParams<{ deckId: string }>();
  const deckId = params.deckId;
  const queryClient = useQueryClient();
  const { socket } = useSocket();

  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [scriptOpen, setScriptOpen] = useState(false);

  const deckQuery = useQuery({
    queryKey: ["pitch", "deck", deckId],
    queryFn: () => fetchJson<DeckPayload>(`/api/admin/pitch/decks/${deckId}`),
    enabled: !!deckId,
  });

  const renderQuery = useQuery({
    queryKey: ["pitch", "render", deckId],
    queryFn: () => fetchRenderHtml(deckId),
    enabled: !!deckId,
  });

  // ── Mutations ────────────────────────────────────────────────────────

  const renameMutation = useMutation({
    mutationFn: async (title: string) =>
      fetchJson(`/api/admin/pitch/decks/${deckId}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      }),
    onMutate: () => setSaveState("saving"),
    onSuccess: () => {
      setSaveState("idle");
      queryClient.invalidateQueries({ queryKey: ["pitch", "deck", deckId] });
      queryClient.invalidateQueries({ queryKey: ["pitch", "render", deckId] });
    },
    onError: () => {
      setSaveState("error");
      showToast("Could not rename deck.", "error");
    },
  });

  const reorderMutation = useMutation({
    mutationFn: async ({
      slideId,
      position,
    }: {
      slideId: string;
      position: number;
    }) =>
      fetchJson(
        `/api/admin/pitch/decks/${deckId}/slides/${slideId}/move`,
        {
          method: "PUT",
          body: JSON.stringify({ position }),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pitch", "deck", deckId] });
      queryClient.invalidateQueries({ queryKey: ["pitch", "render", deckId] });
    },
    onError: () => showToast("Reorder failed — restored.", "error"),
  });

  const addSlideMutation = useMutation({
    mutationFn: async (position: number) =>
      fetchJson(`/api/admin/pitch/decks/${deckId}/slides`, {
        method: "POST",
        body: JSON.stringify({
          position,
          slide: {
            template: "title",
            content: { title: "New slide" },
            speaker_notes: "",
            transition: "slide",
            fragments: [],
          },
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pitch", "deck", deckId] });
      queryClient.invalidateQueries({ queryKey: ["pitch", "render", deckId] });
    },
    onError: () => showToast("Add slide failed.", "error"),
  });

  const deleteSlideMutation = useMutation({
    mutationFn: async (slideId: string) =>
      fetchJson(`/api/admin/pitch/decks/${deckId}/slides/${slideId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pitch", "deck", deckId] });
      queryClient.invalidateQueries({ queryKey: ["pitch", "render", deckId] });
    },
    onError: () => showToast("Delete slide failed.", "error"),
  });

  const duplicateSlideMutation = useMutation({
    mutationFn: async (slideId: string) => {
      const payload = deckQuery.data;
      const target = payload?.slides.find((s) => s.id === slideId);
      if (!target) throw new Error("slide not found");
      return fetchJson(`/api/admin/pitch/decks/${deckId}/slides`, {
        method: "POST",
        body: JSON.stringify({
          position: target.position + 1,
          slide: target.slide,
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pitch", "deck", deckId] });
      queryClient.invalidateQueries({ queryKey: ["pitch", "render", deckId] });
    },
    onError: () => showToast("Duplicate slide failed.", "error"),
  });

  // ── Socket subscriptions ─────────────────────────────────────────────

  useEffect(() => {
    if (!socket || !deckId) return;
    const invalidateAll = (data?: { deckId?: string }) => {
      if (data?.deckId && data.deckId !== deckId) return;
      queryClient.invalidateQueries({ queryKey: ["pitch", "deck", deckId] });
      queryClient.invalidateQueries({ queryKey: ["pitch", "render", deckId] });
    };
    const events = [
      "pitch:deck:updated",
      "pitch:slide:created",
      "pitch:slide:updated",
      "pitch:slide:deleted",
      "pitch:slide:moved",
    ];
    events.forEach((evt) => socket.on(evt, invalidateAll));
    return () => {
      events.forEach((evt) => socket.off(evt, invalidateAll));
    };
  }, [socket, deckId, queryClient]);

  // ── Derived view models ──────────────────────────────────────────────

  const deck = deckQuery.data?.deck;
  const slides = deckQuery.data?.slides ?? [];

  const railItems: SlideRailItem[] = useMemo(
    () =>
      slides.map((row) => ({
        id: row.id,
        position: row.position,
        template: row.slide.template,
        titlePreview: deriveTitlePreview(row.slide),
      })),
    [slides],
  );

  const selectedSlide =
    slides.find((s) => s.id === selectedSlideId) ?? slides[0] ?? null;

  // ── Handlers ─────────────────────────────────────────────────────────

  const handleCanvasClick = (target: HTMLElement) => {
    let cursor: HTMLElement | null = target;
    while (cursor) {
      const field = cursor.getAttribute?.("data-pitch-field");
      if (field) {
        setSelectedField(field);
        return;
      }
      cursor = cursor.parentElement;
    }
    setSelectedField(null);
  };

  const handleTitleCommit = () => {
    if (!deck || titleDraft == null) {
      setTitleEditing(false);
      return;
    }
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === deck.title) {
      setTitleEditing(false);
      setTitleDraft(null);
      return;
    }
    renameMutation.mutate(trimmed);
    setTitleEditing(false);
    setTitleDraft(null);
  };

  // ── Render ──────────────────────────────────────────────────────────

  if (deckQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading deck…
      </div>
    );
  }
  if (deckQuery.isError || !deck) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-red-500">
        Could not load deck {deckId}.
      </div>
    );
  }

  const cacheKey = `${deck.id}-${slides.length}-${deck.updated_at}`;

  return (
    <div
      className="grid h-full min-h-0 w-full grid-cols-[11rem_minmax(0,1fr)_20rem] grid-rows-[3rem_minmax(0,1fr)_auto]"
      data-testid="pitch-editor-shell"
    >
      {/* Top bar (spans all 3 columns) */}
      <header
        className="col-span-3 flex h-12 items-center justify-between border-b border-border bg-card px-4"
        data-testid="pitch-editor-topbar"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {titleEditing ? (
            <input
              autoFocus
              data-testid="pitch-editor-title-input"
              value={titleDraft ?? deck.title}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleCommit}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTitleCommit();
                if (e.key === "Escape") {
                  setTitleEditing(false);
                  setTitleDraft(null);
                }
              }}
              className="rounded border border-border bg-background px-2 py-1 text-sm font-semibold"
            />
          ) : (
            <button
              type="button"
              data-testid="pitch-editor-title"
              onClick={() => {
                setTitleEditing(true);
                setTitleDraft(deck.title);
              }}
              className="truncate text-sm font-semibold text-foreground hover:underline"
              title="Click to rename"
            >
              {deck.title}
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            disabled
            data-testid="pitch-editor-brand-kit"
            title="Coming in Phase 5"
            className="rounded border border-border px-2 py-1 text-xs opacity-50"
          >
            Brand kit
          </button>
          <button
            disabled
            data-testid="pitch-editor-export"
            title="Coming in Phase 6"
            className="rounded border border-border px-2 py-1 text-xs opacity-50"
          >
            Export
          </button>
          <span
            data-testid="pitch-editor-save-state"
            data-state={saveState}
            className={`inline-block h-2 w-2 rounded-full ${
              saveState === "saving"
                ? "bg-amber-500"
                : saveState === "error"
                  ? "bg-red-500"
                  : "bg-emerald-500"
            }`}
            title={`Save state: ${saveState}`}
          />
        </div>
      </header>

      {/* Slide rail */}
      <SlideRail
        items={railItems}
        selectedSlideId={selectedSlide?.id ?? null}
        onSelect={(id) => setSelectedSlideId(id)}
        onReorder={async (slideId, pos) => {
          await reorderMutation.mutateAsync({ slideId, position: pos });
        }}
        onAddAbove={(slideId) => {
          const idx = slides.findIndex((s) => s.id === slideId);
          if (idx < 0) return;
          addSlideMutation.mutate(idx);
        }}
        onAddBelow={(slideId) => {
          const idx = slides.findIndex((s) => s.id === slideId);
          if (idx < 0) return;
          addSlideMutation.mutate(idx + 1);
        }}
        onDuplicate={(slideId) => duplicateSlideMutation.mutate(slideId)}
        onDelete={(slideId) => deleteSlideMutation.mutate(slideId)}
      />

      {/* Canvas */}
      <main
        className="min-h-0 overflow-hidden bg-background"
        data-testid="pitch-editor-canvas"
      >
        {renderQuery.isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Rendering…
          </div>
        ) : renderQuery.isError ? (
          <div className="flex h-full items-center justify-center text-sm text-red-500">
            Could not render deck.
          </div>
        ) : (
          <RevealCanvas
            cacheKey={cacheKey}
            html={renderQuery.data ?? ""}
            onContainerClick={handleCanvasClick}
          />
        )}
      </main>

      {/* Properties panel (right) */}
      <aside
        className="min-h-0 overflow-y-auto border-l border-border bg-card p-3 text-xs"
        data-testid="pitch-editor-properties"
      >
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Properties
        </h2>
        <div data-testid="pitch-editor-selected-field">
          Selected: {selectedField ?? "—"}
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground">
          Real property editors arrive in Phase 5 (#971).
        </p>
      </aside>

      {/* Script panel (bottom, collapsible) */}
      <section
        className="col-span-3 border-t border-border bg-card"
        data-testid="pitch-editor-script-panel"
      >
        <button
          type="button"
          data-testid="pitch-editor-script-toggle"
          onClick={() => setScriptOpen((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/50"
        >
          <span>Script</span>
          <span>{scriptOpen ? "▼" : "▲"}</span>
        </button>
        {scriptOpen && (
          <textarea
            data-testid="pitch-editor-script-textarea"
            readOnly
            value={deck.metadata.source_script ?? ""}
            className="h-32 w-full resize-none border-t border-border bg-background p-2 text-xs"
          />
        )}
      </section>
    </div>
  );
}
