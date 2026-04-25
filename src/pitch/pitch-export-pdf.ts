/**
 * Pitch — PDF export (Phase 6 / sub-issue #974).
 *
 * Renders the deck through the Phase-4 standalone Reveal renderer and
 * pipes the resulting HTML into Decktape via the shared `htmlToPdf`
 * helper. The helper owns subprocess lifecycle (timeout, abort, kill,
 * temp cleanup) so this module stays focused on the deck-to-buffer
 * orchestration.
 */
import type { BrandKit, Deck } from "./pitch-schema.js";
import { renderDeckToHtml } from "./pitch-renderer.js";
import {
  DEFAULT_PDF_TIMEOUT_MS,
  htmlToPdf,
  safeFilename,
  type HtmlToPdfOpts,
} from "./pitch-export-utils.js";

export interface ExportPdfOpts {
  /** Hard cap on total decktape runtime (ms). Defaults to 60 000. */
  timeoutMs?: number;
  /** Abort signal — propagates to the decktape subprocess. */
  signal?: AbortSignal;
  /** Slide size, default `1920x1080`. */
  size?: string;
  /** Test-only spawn override forwarded to `htmlToPdf`. */
  spawnImpl?: HtmlToPdfOpts["spawnImpl"];
  /** Test-only decktape binary override. */
  decktapeBin?: string;
}

export interface ExportPdfResult {
  buffer: Buffer;
  filename: string;
  contentType: "application/pdf";
}

/**
 * Render a deck to a PDF. Cleans temp files on every code path including
 * timeout + abort. Throws if the subprocess exits non-zero.
 */
export async function exportDeckToPdf(
  deck: Deck,
  brandKit: BrandKit,
  opts: ExportPdfOpts = {},
): Promise<ExportPdfResult> {
  // Defence-in-depth (#977): if the caller's AbortSignal is already in the
  // aborted state, fail fast \u2014 don't render the deck HTML, don't spawn
  // decktape, don't touch the disk. The downstream `htmlToPdf` helper also
  // honours the signal, but we'd still pay for the renderer + tempfile
  // setup before noticing.
  if (opts.signal?.aborted) {
    throw new Error("PDF export aborted");
  }

  const { html } = renderDeckToHtml(deck, brandKit, "standalone");
  const buffer = await htmlToPdf(html, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_PDF_TIMEOUT_MS,
    signal: opts.signal,
    size: opts.size,
    spawnImpl: opts.spawnImpl,
    decktapeBin: opts.decktapeBin,
    command: "reveal",
  });
  return {
    buffer,
    filename: safeFilename(deck.title, deck.id, ".pdf"),
    contentType: "application/pdf",
  };
}
