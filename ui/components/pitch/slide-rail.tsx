"use client";

import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MoreVertical, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { authorizeRenderedMedia, fetchWithAuth } from "@/lib/api";

export interface SlideRailItem {
  id: string;
  position: number;
  template: string;
  /** Already-sanitized title preview (≤ 40 chars). */
  titlePreview: string;
}

export interface SlideRailProps {
  items: SlideRailItem[];
  selectedSlideId: string | null;
  onSelect: (slideId: string) => void;
  onReorder: (slideId: string, newPosition: number) => Promise<void> | void;
  onAddAbove: (slideId: string) => void;
  onAddBelow: (slideId: string) => void;
  onDuplicate: (slideId: string) => void;
  onDelete: (slideId: string) => void;
  /**
   * Optional — when present, surfaces a "Regenerate text" menu item that
   * fires the per-slide LLM regenerate task. Wired in the editor shell
   * (`ui/app/pitch/[deckId]/page.tsx`) to POST
   * `/decks/:deckId/slides/:slideId/regenerate`.
   */
  onRegenerate?: (slideId: string) => void;
  /**
   * Optional — when present, renders an image-status badge on each row
   * driven by Socket.IO `pitch:image:*` events (#993). Returns the
   * worst-of slot status for the slide.
   */
  imageStatusOf?: (slideId: string) => "idle" | "queued" | "ready" | "failed";
  /**
   * Optional — invoked when the user clicks a failed-status badge to
   * retry image generation for the slide.
   */
  onRetryImage?: (slideId: string) => void;
  /**
   * Sub-issue #996 — when set, every row renders a real iframe-based
   * thumbnail loaded from
   * `/api/admin/pitch/decks/{deckId}/render?mode=embedded&slide={slideId}`.
   * The thumbnail is lazily mounted on first viewport intersection and
   * gracefully degrades to the existing text-only tile on iframe load
   * failure. Omit `deckId` (or this whole block) to keep the legacy
   * text-only rendering used by tests.
   */
  thumbnails?: {
    deckId: string;
    /** Bearer token forwarded as `?token=` since iframes cannot set headers. */
    token?: string;
    /** Cache-buster bumped by the parent when slide content changes. */
    cacheKey?: number;
  };
}

export const SlideRail = ({
  items,
  selectedSlideId,
  onSelect,
  onReorder,
  onAddAbove,
  onAddBelow,
  onDuplicate,
  onDelete,
  onRegenerate,
  imageStatusOf,
  onRetryImage,
  thumbnails,
}: SlideRailProps) => {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // Local copy so we can do optimistic reorder + rollback on failure.
  const [localItems, setLocalItems] = useState<SlideRailItem[] | null>(null);
  const view = localItems ?? items;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = view.findIndex((s) => s.id === active.id);
    const newIdx = view.findIndex((s) => s.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const optimistic = arrayMove(view, oldIdx, newIdx).map((s, i) => ({
      ...s,
      position: i,
    }));
    const previous = view;
    setLocalItems(optimistic);
    try {
      await onReorder(String(active.id), newIdx);
      // Server is now source of truth; clear local override on next prop sync.
      setLocalItems(null);
    } catch {
      // Rollback.
      setLocalItems(previous);
    }
  };

  const confirmDelete = () => {
    if (pendingDelete) {
      onDelete(pendingDelete);
      setPendingDelete(null);
    }
  };

  return (
    <aside
      className="flex h-full w-44 flex-col border-r border-border bg-card"
      data-testid="slide-rail"
    >
      <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Slides ({view.length})
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={view.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col gap-1">
              {view.map((item, idx) => (
                <SlideRailRow
                  key={item.id}
                  item={item}
                  index={idx}
                  selected={selectedSlideId === item.id}
                  onSelect={onSelect}
                  onAddAbove={onAddAbove}
                  onAddBelow={onAddBelow}
                  onDuplicate={onDuplicate}
                  onRegenerate={onRegenerate}
                  onRequestDelete={(id) => setPendingDelete(id)}
                  imageStatus={imageStatusOf?.(item.id) ?? "idle"}
                  onRetryImage={onRetryImage}
                  thumbnails={thumbnails}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title="Delete slide"
          message="This action cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </aside>
  );
};

interface RowProps {
  item: SlideRailItem;
  index: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onAddAbove: (id: string) => void;
  onAddBelow: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRegenerate?: (id: string) => void;
  onRequestDelete: (id: string) => void;
  imageStatus: "idle" | "queued" | "ready" | "failed";
  onRetryImage?: (id: string) => void;
  thumbnails?: SlideRailProps["thumbnails"];
}

const SlideRailRow = ({
  item,
  index,
  selected,
  onSelect,
  onAddAbove,
  onAddBelow,
  onDuplicate,
  onRegenerate,
  onRequestDelete,
  imageStatus,
  onRetryImage,
  thumbnails,
}: RowProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`slide-rail-row-${item.id}`}
      className={`group relative cursor-pointer rounded-md border p-2 text-xs ${
        selected
          ? "border-primary bg-primary/10"
          : "border-border bg-background hover:bg-muted/50"
      }`}
      onClick={() => onSelect(item.id)}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>
              {index + 1} · {item.template}
            </span>
            <ImageStatusBadge
              status={imageStatus}
              slideIndex={index + 1}
              onRetry={
                onRetryImage ? () => onRetryImage(item.id) : undefined
              }
            />
          </div>
          {thumbnails ? (
            <SlideThumbnail
              slideId={item.id}
              slideIndex={index + 1}
              titleFallback={item.titlePreview || "Untitled"}
              deckId={thumbnails.deckId}
              token={thumbnails.token}
              cacheKey={thumbnails.cacheKey}
            />
          ) : null}
          <div className="mt-0.5 truncate font-medium text-foreground">
            {item.titlePreview || "Untitled"}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Slide ${index + 1} actions`}
              data-testid={`slide-rail-actions-${item.id}`}
              className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <MoreVertical className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onAddAbove(item.id)}>
              Add slide above
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAddBelow(item.id)}>
              Add slide below
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDuplicate(item.id)}>
              Duplicate
            </DropdownMenuItem>
            {onRegenerate && (
              <DropdownMenuItem
                data-testid={`slide-rail-regenerate-${item.id}`}
                onSelect={() => onRegenerate(item.id)}
              >
                Regenerate text
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => onRequestDelete(item.id)}
              className="text-red-500 focus:text-red-500"
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
};

export default SlideRail;

/**
 * Tiny image-status pill for the rail row (#993). Hidden when status is
 * `idle`. When `failed`, the pill becomes a clickable retry trigger.
 */
interface BadgeProps {
  status: "idle" | "queued" | "ready" | "failed";
  slideIndex: number;
  onRetry?: () => void;
}

const ImageStatusBadge = ({ status, slideIndex, onRetry }: BadgeProps) => {
  if (status === "idle") return null;
  const common = "ml-1 inline-flex h-3 w-3 items-center justify-center";
  if (status === "queued") {
    return (
      <span
        data-testid={`slide-rail-image-status-${slideIndex}`}
        data-status="queued"
        title="Image generating"
        className={common}
      >
        <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
      </span>
    );
  }
  if (status === "ready") {
    return (
      <span
        data-testid={`slide-rail-image-status-${slideIndex}`}
        data-status="ready"
        title="Image ready"
        className={common}
      >
        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
      </span>
    );
  }
  // failed
  return (
    <button
      type="button"
      data-testid={`slide-rail-image-status-${slideIndex}`}
      data-status="failed"
      title="Image generation failed — click to retry"
      onClick={(e) => {
        e.stopPropagation();
        onRetry?.();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={`${common} text-red-500 hover:text-red-400`}
    >
      <AlertCircle className="h-3 w-3" />
    </button>
  );
};
/**
 * Sub-issue #996 � real iframe-based slide thumbnail.
 *
 * Strategy:
 *   1. Wrapper renders a fixed-size 16:9 box with a static fallback (text
 *      title) so the rail row paints immediately on first render.
 *   2. IntersectionObserver lazily mounts the `<iframe>` only once the
 *      tile scrolls into view; rails of 30+ slides therefore avoid
 *      hammering `/decks/:deckId/render` with 30 simultaneous requests.
 *   3. The iframe loads the embedded-mode renderer scoped to the single
 *      slide via the `?slide={slideId}` query the renderer added in
 *      sub-issue #996. Auth is forwarded via `?token=` because iframes
 *      cannot set request headers; this matches the existing Present
 *      button pattern (PR #1003) and is no-op in dev (no auth).
 *   4. CSS scales the rendered slide down with `transform: scale(0.18)`
 *      and `transform-origin: top left`; the wrapper has
 *      `overflow: hidden` so the off-screen overflow is clipped.
 *   5. On `<iframe>` `onerror` we hide the iframe and surface the text
 *      fallback so a render-failure tile is still legible.
 */
interface SlideThumbnailProps {
  slideId: string;
  slideIndex: number;
  titleFallback: string;
  deckId: string;
  token?: string;
  cacheKey?: number;
}

const SlideThumbnail = ({
  slideId,
  slideIndex,
  titleFallback,
  deckId,
  token,
  cacheKey,
}: SlideThumbnailProps) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [errored, setErrored] = useState(false);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (visible) return;
    if (typeof window === "undefined") return;
    const node = wrapRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [visible]);

  // Bug-fix 2026-04-28 — fetch the embedded HTML with a Bearer header
  // (via fetchWithAuth) and feed it into the iframe via `srcDoc`. The
  // previous `<iframe src=...?token=...>` approach (a) leaked the admin
  // token in URL / Referer / access logs, and (b) was blocked entirely
  // by the Next.js dev server's default `X-Frame-Options: DENY` header
  // on the proxied response. `srcDoc` sidesteps both problems and keeps
  // thumbnails consistent with the canvas (which already does the same).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const params = new URLSearchParams({ mode: "embedded", slide: slideId });
    if (cacheKey !== undefined) params.set("v", String(cacheKey));
    const path = `/api/admin/pitch/decks/${encodeURIComponent(deckId)}/render?${params.toString()}`;
    (async () => {
      try {
        const res = await fetchWithAuth(path);
        if (!res.ok) {
          if (!cancelled) setErrored(true);
          return;
        }
        const text = authorizeRenderedMedia(await res.text());
        if (!cancelled) setHtml(text);
      } catch {
        if (!cancelled) setErrored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, slideId, deckId, cacheKey]);

  // `token` is intentionally unused now — retained on the props type
  // for backward compatibility but no longer placed in the URL.
  void token;

  return (
    <div
      ref={wrapRef}
      data-testid={`slide-rail-thumbnail-${slideId}`}
      className="relative mt-1 aspect-video w-full overflow-hidden rounded border border-border bg-muted/40"
      aria-label={`Slide ${slideIndex} thumbnail: ${titleFallback}`}
    >
      {visible && !errored && html !== null ? (
        <iframe
          title={`Slide ${slideIndex} thumbnail`}
          srcDoc={html}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin"
          tabIndex={-1}
          onError={() => setErrored(true)}
          style={{
            width: `${100 / 0.18}%`,
            height: `${100 / 0.18}%`,
            transform: "scale(0.18)",
            transformOrigin: "top left",
            border: "0",
            pointerEvents: "none",
          }}
        />
      ) : null}
      {!visible || errored || (visible && html === null && !errored) ? (
        <div
          data-testid={`slide-rail-thumbnail-fallback-${slideId}`}
          className="absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] font-medium text-muted-foreground"
        >
          {titleFallback}
        </div>
      ) : null}
    </div>
  );
};
