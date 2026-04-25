/**
 * Pitch — speaker-notes PDF export (Phase 6 / sub-issue #973).
 *
 * Builds a minimal HTML doc (no Reveal.js) — one section per slide
 * containing the slide number, slide title, and the speaker notes — and
 * runs it through the shared `htmlToPdf` Decktape pipeline using the
 * `generic` command (which handles plain HTML pages instead of slide
 * frameworks).
 */
import type { Deck, Slide } from "./pitch-schema.js";
import { htmlToPdf, safeFilename, type HtmlToPdfOpts } from "./pitch-export-utils.js";

export interface ExportNotesPdfOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  spawnImpl?: HtmlToPdfOpts["spawnImpl"];
  decktapeBin?: string;
}

export interface ExportNotesPdfResult {
  buffer: Buffer;
  filename: string;
  contentType: "application/pdf";
}

export async function exportNotesToPdf(
  deck: Deck,
  opts: ExportNotesPdfOpts = {},
): Promise<ExportNotesPdfResult> {
  // Defence-in-depth (#977): early-return if the signal is already aborted
  // \u2014 mirrors `exportDeckToPdf`. Avoids the HTML-build + tempfile churn.
  if (opts.signal?.aborted) {
    throw new Error("Notes PDF export aborted");
  }
  const html = buildNotesHtml(deck);
  const buffer = await htmlToPdf(html, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    spawnImpl: opts.spawnImpl,
    decktapeBin: opts.decktapeBin,
    command: "generic",
  });
  return {
    buffer,
    filename: safeFilename(`${deck.title}-notes`, deck.id, ".pdf"),
    contentType: "application/pdf",
  };
}

function buildNotesHtml(deck: Deck): string {
  const sections = deck.slides
    .map((slide, i) => renderNotesSection(slide, i + 1))
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(deck.title)} — Speaker Notes</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #111; }
  section { page-break-after: always; padding: 2rem 0; border-top: 1px solid #ddd; }
  h1 { font-size: 24px; margin: 0 0 .5rem; }
  h2 { font-size: 16px; color: #555; margin: 0 0 1rem; font-weight: 500; }
  pre { white-space: pre-wrap; font-family: inherit; font-size: 14px; line-height: 1.5; }
</style>
</head>
<body>
<h1>${escapeHtml(deck.title)} — Speaker Notes</h1>
${sections}
</body>
</html>`;
}

function renderNotesSection(slide: Slide, slideNumber: number): string {
  const title = slideTitle(slide);
  const notes = slide.speaker_notes?.trim() || "(no speaker notes)";
  return `<section>
  <h1>Slide ${slideNumber}</h1>
  <h2>${escapeHtml(title)}</h2>
  <pre>${escapeHtml(notes)}</pre>
</section>`;
}

function slideTitle(slide: Slide): string {
  const c = slide.content as Record<string, unknown>;
  if (typeof c.title === "string") return c.title;
  if (typeof c.heading === "string") return c.heading;
  return slide.template;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
