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
 * Note: Scanned / image-based PDFs yield empty text — OCR (e.g. Tesseract)
 * would be needed for those and is not currently implemented.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ConverterRegistration } from "./types.js";

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
      if (!bodyText || bodyText.length === 0) {
        return {
          text: "",
          success: false,
          converter: "pdf",
          error:
            "No extractable text in PDF (likely a scanned / image-based document). " +
            "OCR support is not yet implemented.",
          metadata: { pages: data.total },
        };
      }

      const meta = `> **Pages:** ${data.total}\n\n`;
      const text = header + meta + bodyText;

      return {
        text,
        success: true,
        converter: "pdf",
        metadata: { pages: data.total },
      };
    },
  };
}
