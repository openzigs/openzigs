"use client";

import { useCallback } from "react";

export interface RevealCanvasImplProps {
  /**
   * Full HTML document from `GET /decks/:deckId/render?mode=embedded`.
   * Includes Reveal.js CSS/theme/init — rendered inside an iframe so the
   * styles do not leak into the parent Next.js page.
   */
  html: string;
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
 * Click forwarding: clicks inside the iframe stay inside the iframe; we
 * only proxy clicks that land on the wrapper itself (e.g. surrounding
 * padding) — slide selection is driven by the slide rail, not the canvas.
 */
export default function RevealCanvasImpl({
  html,
  onContainerClick,
}: RevealCanvasImplProps) {
  const handleWrapClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!onContainerClick) return;
      const target = e.target as HTMLElement;
      onContainerClick(target);
    },
    [onContainerClick],
  );

  return (
    <div
      data-testid="reveal-canvas-impl"
      className="reveal-canvas-root h-full w-full"
      onClick={handleWrapClick}
    >
      <iframe
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
