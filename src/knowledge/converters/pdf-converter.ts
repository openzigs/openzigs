/**
 * PDF converter — extracts text from PDF files using `pdf-parse` v2.
 *
 * pdf-parse v2 exports a `PDFParse` class (not a function).
 * Usage: `new PDFParse(uint8Array)` → `.getText()` returns `{ pages, text, total }`.
 * pdfjs-dist v5 requires `Uint8Array`, not `Buffer`.
 *
 * The dependency is loaded dynamically so the service still starts
 * when `pdf-parse` is not installed (graceful degradation).
 *
 * **OCR fallback for scanned PDFs:**
 * When text extraction yields empty results (scanned / image-based PDF),
 * the converter falls back to:
 *   1. ImageMagick (`magick`) to render each page to a PNG
 *   2. tesseract.js to OCR those PNGs
 * Both are checked at startup; OCR gracefully degrades if either is missing.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConverterRegistration } from "./types.js";
import { isTesseractAvailable, ocrImage } from "./ocr-engine.js";
import { logger } from "../../logging/logger.js";

const execFileAsync = promisify(execFile);

const PDF_EXTENSIONS = [".pdf"];

/** Shape returned by PDFParse.getText() in v2. */
interface PdfTextResult {
  pages: string[];
  text: string;
  total: number;
}

/** Minimal typing for the PDFParse class constructor + methods we use. */
interface PdfParserInstance {
  getText(): Promise<PdfTextResult>;
}
type PdfParseConstructor = new (data: Uint8Array) => PdfParserInstance;

/**
 * Check whether ImageMagick (`magick`) and Ghostscript (`gs`) are available.
 * ImageMagick delegates PDF rendering to Ghostscript, so both are required.
 */
async function isPdfRenderingAvailable(): Promise<{ magick: boolean; gs: boolean }> {
  let magick = false;
  let gs = false;
  try {
    await execFileAsync("magick", ["--version"]);
    magick = true;
  } catch {
    // ImageMagick not installed.
  }
  try {
    await execFileAsync("gs", ["--version"]);
    gs = true;
  } catch {
    // Ghostscript not installed.
  }
  return { magick, gs };
}

/**
 * Render a single PDF page to a PNG using ImageMagick.
 * Returns the path to the generated PNG file.
 */
async function renderPdfPageToPng(
  pdfPath: string,
  pageIndex: number,
  tmpDir: string,
): Promise<string> {
  const outPath = path.join(tmpDir, `page-${pageIndex}.png`);
  // ImageMagick v7: use `magick` directly (not `magick convert`).
  await execFileAsync("magick", [
    "-density", "300",
    "-quality", "100",
    `${pdfPath}[${pageIndex}]`,
    "-flatten",
    outPath,
  ]);
  return outPath;
}

/**
 * OCR a scanned PDF by rendering each page to PNG and running tesseract.js.
 * Returns the combined OCR text from all pages.
 */
async function ocrPdfPages(
  pdfPath: string,
  totalPages: number,
): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-pdf-ocr-"));

  try {
    const pageTexts: string[] = [];

    for (let i = 0; i < totalPages; i++) {
      try {
        const pngPath = await renderPdfPageToPng(pdfPath, i, tmpDir);
        const pageBuffer = await fs.readFile(pngPath);
        const pageText = await ocrImage(pageBuffer);
        const trimmed = pageText.trim();
        if (trimmed) {
          pageTexts.push(trimmed);
        }
        // Clean up the PNG immediately to save disk space.
        await fs.unlink(pngPath).catch(() => {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[Knowledge] PDF OCR page ${i + 1} failed: ${msg}`);
      }
    }

    return pageTexts.join("\n\n---\n\n");
  } finally {
    // Best-effort cleanup of the temp directory.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function createPdfConverter(): Promise<ConverterRegistration> {
  let PdfParseClass: PdfParseConstructor | null = null;

  try {
    const mod: unknown = await import("pdf-parse");
    const m = mod as Record<string, unknown>;
    if (typeof m.PDFParse === "function") {
      PdfParseClass = m.PDFParse as PdfParseConstructor;
    }
  } catch {
    // pdf-parse not installed.
  }

  if (!PdfParseClass) {
    return {
      name: "pdf",
      extensions: PDF_EXTENSIONS,
      available: false,
      unavailableReason: "Install pdf-parse: pnpm add pdf-parse",
      convert: async () => ({
        text: "",
        success: false,
        converter: "pdf",
        error: "pdf-parse is not installed",
      }),
    };
  }

  // Probe OCR capabilities for scanned-PDF fallback.
  const hasOcr = await isTesseractAvailable();
  const { magick: hasMagick, gs: hasGs } = await isPdfRenderingAvailable();
  const ocrAvailable = hasOcr && hasMagick && hasGs;

  if (ocrAvailable) {
    logger.info("[Knowledge] PDF OCR fallback available (ImageMagick + Ghostscript + tesseract.js)");
  } else {
    const missing: string[] = [];
    if (!hasMagick) missing.push("ImageMagick (`brew install imagemagick`)");
    if (!hasGs) missing.push("Ghostscript (`brew install ghostscript`)");
    if (!hasOcr) missing.push("tesseract.js (`pnpm add tesseract.js`)");
    if (missing.length > 0) {
      logger.info(`[Knowledge] PDF OCR fallback unavailable: missing ${missing.join(", ")}`);
    }
  }

  const ParserClass = PdfParseClass;

  return {
    name: "pdf",
    extensions: PDF_EXTENSIONS,
    available: true,
    convert: async (filePath: string) => {
      const buffer = await fs.readFile(filePath);
      // pdfjs-dist v5 requires Uint8Array, not Buffer.
      const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const parser = new ParserClass(uint8);
      const data = await parser.getText();

      const fileName = path.basename(filePath, ".pdf");
      const header = `# ${fileName}\n\n`;

      // pdf-parse v2 inserts "-- N of M --" page separators; strip them
      // before checking whether the PDF actually contains extractable text.
      const bodyText = data.text
        .replace(/--\s*\d+\s*of\s*\d+\s*--/g, "")
        .trim();

      // If text extraction yielded content, use it directly.
      if (bodyText && bodyText.length > 0) {
        const meta = `> **Pages:** ${data.total}\n\n`;
        return {
          text: header + meta + bodyText,
          success: true,
          converter: "pdf",
          metadata: { pages: data.total },
        };
      }

      // ── Scanned PDF — attempt OCR fallback ──
      if (!ocrAvailable) {
        const missing: string[] = [];
        if (!hasMagick) missing.push("ImageMagick (`brew install imagemagick`)");
        if (!hasGs) missing.push("Ghostscript (`brew install ghostscript`)");
        if (!hasOcr) missing.push("tesseract.js (`pnpm add tesseract.js`)");
        return {
          text: "",
          success: false,
          converter: "pdf",
          error:
            "No extractable text in PDF (scanned / image-based). " +
            `Install ${missing.join(" and ")} for OCR support.`,
          metadata: { pages: data.total, scanned: true },
        };
      }

      logger.info(`[Knowledge] Scanned PDF detected — running OCR on ${data.total} pages: ${path.basename(filePath)}`);
      const ocrText = await ocrPdfPages(filePath, data.total);

      if (!ocrText || ocrText.trim().length === 0) {
        return {
          text: "",
          success: false,
          converter: "pdf+ocr",
          error: "OCR completed but no text was recognized from the scanned pages.",
          metadata: { pages: data.total, scanned: true, ocrAttempted: true },
        };
      }

      const meta = `> **Pages:** ${data.total} | **Method:** OCR (tesseract.js)\n\n`;
      return {
        text: header + meta + ocrText.trim(),
        success: true,
        converter: "pdf+ocr",
        metadata: { pages: data.total, scanned: true, ocrAttempted: true },
      };
    },
  };
}
