"use client";

import { useCallback, useEffect, useRef } from "react";

export interface RevealCanvasImplProps {
  /**
   * Full HTML document from `GET /decks/:deckId/render?mode=embedded`.
   * Includes Reveal.js CSS/theme/init — rendered inside an iframe so the
   * styles do not leak into the parent Next.js page.
   */
  html: string;
  /**
   * 0-based index of the slide to focus. The parent page changes this
   * when the user clicks a row in the slide rail; the canvas drives Reveal
   * via `postMessage` so the iframe does NOT have to be rebuilt on every
   * selection (which would flash + reset Reveal back to slide 0).
   */
  selectedSlideIndex?: number;
  /** Forwarded so click handlers in the parent can react to canvas clicks. */
  onContainerClick?: (target: HTMLElement) => void;
}

/**
 * Embedded-mode Reveal.js preview mounted inside an `<iframe srcDoc=…>`.
 *
 * Why an iframe?
 *   - The `/render?mode=embedded` endpoint emits a full HTML document with
 *     reveal.css, the theme CSS and the Reveal init script. Inlining that
 *     into the parent page (the previous dangerouslySetInnerHTML +
 *     in-parent Reveal init approach) never loaded those CSS/JS assets, so
 *     slides rendered as unstyled HTML — text appeared invisible against
 *     brand-colored backgrounds and Reveal could not lay out the deck.
 *     Bug report 2026-04-28.
 *   - The slide-rail thumbnails already render the same endpoint inside
 *     iframes, so canvas + thumbnails now share one render path.
 *
 * Selection navigation: the iframe's init script installs a `message`
 * listener that accepts `{type:"openzigs:navigate", index:N}`. We post
 * that message whenever `selectedSlideIndex` changes. If the iframe is
 * still booting we queue the latest index and flush it when it announces
 * `openzigs:reveal-ready`.
 */
export default function RevealCanvasImpl({
  html,
  selectedSlideIndex,
  onContainerClick,
}: RevealCanvasImplProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const pendingIndexRef = useRef<number | null>(null);

  const handleWrapClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!onContainerClick) return;
      const target = e.target as HTMLElement;
      onContainerClick(target);
    },
    [onContainerClick],
  );

  // Listen for the `openzigs:reveal-ready` handshake from the iframe so
  // we know when it's safe to drive Reveal via postMessage. Reset on
  // every srcDoc change (new html means the listener inside is gone).
  useEffect(() => {
    readyRef.current = false;
    const onMessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "openzigs:reveal-ready") {
        readyRef.current = true;
        const queued = pendingIndexRef.current;
        if (queued !== null && iframeRef.current?.contentWindow) {
          iframeRef.current.contentWindow.postMessage(
            { type: "openzigs:navigate", index: queued },
            "*",
          );
          pendingIndexRef.current = null;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [html]);

  // Drive navigation when the parent's selection changes. Queue the
  // index if the iframe hasn't reported ready yet — it'll be flushed by
  // the handshake handler above.
  useEffect(() => {
    if (selectedSlideIndex === undefined) return;
    if (!Number.isInteger(selectedSlideIndex) || selectedSlideIndex < 0) return;
    if (readyRef.current && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: "openzigs:navigate", index: selectedSlideIndex },
        "*",
      );
    } else {
      pendingIndexRef.current = selectedSlideIndex;
    }
  }, [selectedSlideIndex]);

  return (
    <div
      data-testid="reveal-canvas-impl"
      className="reveal-canvas-root h-full w-full"
      onClick={handleWrapClick}
    >
      <iframe
        ref={iframeRef}
        data-testid="reveal-canvas-iframe"
        title="Slide preview"
        srcDoc={html}
        className="h-full w-full border-0 bg-transparent"
        // `allow-same-origin` lets reveal.js read the linked stylesheets;
        // `allow-scripts` lets the inline Reveal init script execute. We
        // intentionally do NOT grant `allow-top-navigation` or
        // `allow-popups` so a tampered deck cannot navigate the parent.
        // The HTML body is sanitized server-side via DOMPurify
        // (pitch-sanitize.ts) before reaching the iframe.
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  );
}
