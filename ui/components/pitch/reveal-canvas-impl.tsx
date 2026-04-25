"use client";

import { useEffect, useRef } from "react";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- reveal.js ESM build ships its own types only via @types/reveal.js
import Reveal from "reveal.js";

export interface RevealCanvasImplProps {
  /**
   * Embedded HTML fragment from `GET /decks/:deckId/render?mode=embedded`.
   * Should look like `<div class="pitch-deck-wrap">…<div class="reveal">…</div></div>`.
   */
  html: string;
  /** Forwarded so click handlers in the parent can react to slide content. */
  onContainerClick?: (target: HTMLElement) => void;
}

/**
 * Real Reveal.js mount point. Only loaded client-side (see reveal-canvas.tsx).
 * Reveal touches `window`/`document` at import time, so this file must NEVER
 * be imported from a server component or a regular `import` chain that runs
 * during `next build` SSG.
 */
export default function RevealCanvasImpl({
  html,
  onContainerClick,
}: RevealCanvasImplProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const deckRef = useRef<{ destroy?: () => void } | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const revealEl = root.querySelector<HTMLDivElement>(".reveal");
    if (!revealEl) return;

    let cancelled = false;
    let deck: { destroy?: () => void } | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const RevealCtor = Reveal as unknown as new (
        el: HTMLElement,
        opts?: Record<string, unknown>,
      ) => { initialize: () => Promise<void>; destroy?: () => void };
      deck = new RevealCtor(revealEl, {
        embedded: true,
        hash: false,
        controls: true,
        progress: true,
        transition: "slide",
      });
      deckRef.current = deck;
      void (deck as { initialize: () => Promise<void> }).initialize().catch(() => {
        /* swallow — initialize can throw if container is detached mid-render */
      });
    } catch {
      /* swallow — reveal init failure should not crash the editor */
    }

    return () => {
      cancelled = true;
      void cancelled;
      try {
        deckRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      deckRef.current = null;
    };
  }, [html]);

  return (
    <div
      ref={containerRef}
      data-testid="reveal-canvas-impl"
      className="reveal-canvas-root h-full w-full"
      onClick={(e) => {
        if (!onContainerClick) return;
        const target = e.target as HTMLElement;
        onContainerClick(target);
      }}
      // The HTML is sanitized server-side by pitch-renderer (DOMPurify with
      // strict FORBID_TAGS/FORBID_ATTR list). We trust it here because:
      //   1. It only contains tags/attrs that survived sanitization
      //   2. The render endpoint never echoes user input verbatim
      //   3. Reveal.js needs real DOM nodes to mount, so a parsed-ast
      //      approach would force a full re-implementation of section-attr
      //      handling.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
