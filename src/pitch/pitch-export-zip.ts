/**
 * Pitch — HTML zip export (Phase 6 / sub-issue #973).
 *
 * Bundles the standalone Reveal HTML doc + a lightweight `README.txt`
 * into a single zip via `archiver`. Reveal.js itself is loaded from CDN
 * inside the standalone HTML, so we don't need to copy `node_modules`
 * assets into the zip — that keeps payload size reasonable and avoids
 * shipping 300+ files per export.
 *
 * Image assets referenced by the deck (those with concrete URLs) are
 * NOT downloaded server-side here — the standalone HTML keeps the
 * absolute URL the renderer emitted. A future enhancement can copy
 * local-file assets in; this is tracked under Phase 7 polish.
 *
 * Filename hygiene: every entry path is constructed server-side from
 * trusted constants. We never use any user-supplied string as a path
 * component, so path-traversal is structurally impossible.
 */
import archiver from "archiver";
import { renderDeckToHtml } from "./pitch-renderer.js";
import type { BrandKit, Deck } from "./pitch-schema.js";
import { safeFilename } from "./pitch-export-utils.js";

export interface ExportZipResult {
  buffer: Buffer;
  filename: string;
  contentType: "application/zip";
}

export async function exportDeckToZip(
  deck: Deck,
  brandKit: BrandKit,
): Promise<ExportZipResult> {
  const { html } = renderDeckToHtml(deck, brandKit, "standalone");

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.once("error", reject);
    archive.once("end", () => resolve(Buffer.concat(chunks)));

    archive.append(html, { name: "index.html" });
    archive.append(buildReadme(deck), { name: "README.txt" });
    void archive.finalize();
  });

  return {
    buffer,
    filename: safeFilename(deck.title, deck.id, ".zip"),
    contentType: "application/zip",
  };
}

function buildReadme(deck: Deck): string {
  return [
    `OpenZigs Pitch — ${deck.title}`,
    `Slides: ${deck.slides.length}`,
    "",
    "Open `index.html` in a browser to view the deck.",
    "Reveal.js is loaded from a public CDN — an internet connection is",
    "required for first render. Press `S` for speaker notes view.",
    "",
  ].join("\n");
}
