"use client";

import dynamic from "next/dynamic";
import type { RevealCanvasImplProps } from "./reveal-canvas-impl";

/**
 * SSR-safe wrapper around the real Reveal.js canvas. Reveal.js touches
 * `window` at module evaluation time, so the implementation must only run
 * in the browser. `dynamic({ ssr: false })` is the documented Next.js way
 * to gate that.
 *
 * The `key` prop on the inner component (driven by deck content version)
 * forces React to fully unmount + remount when slides are reordered or
 * structurally changed, which is the cleanest way to force a Reveal
 * re-init without poking its private API.
 */
const RevealCanvasImpl = dynamic(() => import("./reveal-canvas-impl"), {
  ssr: false,
  loading: () => (
    <div
      data-testid="reveal-canvas-skeleton"
      className="h-full w-full animate-pulse rounded-lg bg-muted/30"
    />
  ),
});

export interface RevealCanvasProps extends RevealCanvasImplProps {
  /** Optional cache-buster: pass `${deckId}-${slideCount}-${updatedAt}`. */
  cacheKey?: string;
}

export const RevealCanvas = ({ cacheKey, ...rest }: RevealCanvasProps) => (
  <RevealCanvasImpl key={cacheKey ?? "default"} {...rest} />
);

export default RevealCanvas;
