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
import { PropertiesPanel } from "@/components/pitch/properties-panel";
import { ScriptPanel } from "@/components/pitch/script-panel";
import {
  BrandKitPicker,
  type BrandKitListEntry,
} from "@/components/pitch/brand-kit-picker";
import { BrandKitEditor } from "@/components/pitch/brand-kit-editor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

interface ExportFormat {
  id: "pdf" | "pptx" | "md" | "notes" | "zip";
  label: string;
  /** Path appended to `/api/admin/pitch/decks/:deckId`. */
  suffix: string;
}

const EXPORT_FORMATS: ReadonlyArray<ExportFormat> = [
  { id: "pdf", label: "PDF", suffix: "/export.pdf" },
  { id: "pptx", label: "PowerPoint (.pptx)", suffix: "/export.pptx" },
  { id: "md", label: "Markdown", suffix: "/export.md" },
  { id: "notes", label: "Speaker Notes (PDF)", suffix: "/export.notes.pdf" },
  { id: "zip", label: "ZIP Bundle", suffix: "/export.zip" },
];

/**
 * Trigger an authenticated download via fetch \u2192 blob \u2192 anchor click.
 * We can't just `window.open` the URL because the API requires the bearer
 * token in the `Authorization` header, not a query string. On non-2xx the
 * backend's structured `{ error: { message } }` envelope is surfaced.
 */
async function downloadExport(
  deckId: string,
  format: ExportFormat,
): Promise<void> {
  const url = buildUrl(`/api/admin/pitch/decks/${deckId}${format.suffix}`);
  const headers: HeadersInit = AUTH_TOKEN
    ? { Authorization: `Bearer ${AUTH_TOKEN}` }
    : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch {
      // not JSON \u2014 fall back to status text
      if (res.statusText) detail = res.statusText;
    }
    throw new Error(detail);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(cd);
  const filename = match?.[1] ?? `deck-${deckId}${format.suffix.replace("/export", "")}`;
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke async so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export default function PitchDeckEditorPage() {
  const params = useParams<{ deckId: string }>();
  const deckId = params.deckId;
  const queryClient = useQueryClient();
  const { socket } = useSocket();

  const [, setSelectedField] = useState<string | null>(null);
  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [brandKitDialogOpen, setBrandKitDialogOpen] = useState(false);
  const [brandKitEditTarget, setBrandKitEditTarget] =
    useState<BrandKitListEntry | null>(null);

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

  const brandKitChangeMutation = useMutation({
    mutationFn: async (brandKitId: string) =>
      fetchJson(`/api/admin/pitch/decks/${deckId}`, {
        method: "PATCH",
        body: JSON.stringify({ brand_kit_id: brandKitId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pitch", "deck", deckId] });
      queryClient.invalidateQueries({ queryKey: ["pitch", "render", deckId] });
    },
    onError: () => showToast("Could not change brand kit.", "error"),
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

  const regenerateSlideMutation = useMutation({
    mutationFn: async (slideId: string) =>
      fetchJson<{ taskId: string }>(
        `/api/admin/pitch/decks/${deckId}/slides/${slideId}/regenerate`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    onSuccess: () => showToast("Regenerating slide text\u2026", "success"),
    onError: (err) =>
      showToast(
        `Regenerate failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      ),
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
          <BrandKitPicker
            selectedId={deck.brand_kit_id}
            onSelect={(id) =>
              brandKitChangeMutation.mutate(id)
            }
            onEdit={(kit) => {
              setBrandKitEditTarget(kit);
              setBrandKitDialogOpen(true);
            }}
            onCreate={() => {
              setBrandKitEditTarget(null);
              setBrandKitDialogOpen(true);
            }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="pitch-editor-export"
                className="rounded border border-border px-2 py-1 text-xs hover:bg-muted/40"
              >
                Export
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {EXPORT_FORMATS.map((fmt) => (
                <DropdownMenuItem
                  key={fmt.id}
                  data-testid={`pitch-editor-export-${fmt.id}`}
                  onSelect={async () => {
                    try {
                      await downloadExport(deckId, fmt);
                    } catch (err) {
                      showToast(
                        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
                        "error",
                      );
                    }
                  }}
                >
                  {fmt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
        onRegenerate={(slideId) => regenerateSlideMutation.mutate(slideId)}
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
      <PropertiesPanel
        deckId={deckId}
        selectedSlide={
          selectedSlide
            ? { id: selectedSlide.id, slide: selectedSlide.slide }
            : null
        }
        brandKit={null}
      />

      {/* Script panel (bottom, collapsible) */}
      <div
        className="col-span-3"
        data-testid="pitch-editor-script-panel"
      >
        <ScriptPanel
          deckId={deckId}
          brandKitId={deck.brand_kit_id}
          script={deck.metadata.source_script ?? ""}
          slides={slides.map((s) => ({ id: s.id, slide: s.slide }))}
          selectedSlideId={selectedSlide?.id ?? null}
          onSelectSlide={(id) => setSelectedSlideId(id)}
        />
      </div>

      <BrandKitEditor
        open={brandKitDialogOpen}
        onOpenChange={setBrandKitDialogOpen}
        kit={brandKitEditTarget}
        onSaved={(id) => {
          brandKitChangeMutation.mutate(id);
        }}
      />
    </div>
  );
}
