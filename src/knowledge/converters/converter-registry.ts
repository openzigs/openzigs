/**
 * Converter Registry — maps file extensions to converter functions.
 *
 * The registry auto-detects available converters at startup (e.g. checks
 * whether `pdf-parse` or `ffmpeg` are installed) and exposes a single
 * `convert(filePath)` entry point used by KnowledgeIngestionService.
 */

import path from "node:path";
import type { ConversionResult, ConverterRegistration } from "./types.js";
import { createTextConverter } from "./text-converter.js";
import { createPdfConverter } from "./pdf-converter.js";
import { createDocxConverter } from "./docx-converter.js";
import { createMediaConverter } from "./media-converter.js";
import { createImageOcrConverter } from "./image-ocr-converter.js";
import { terminateOcrEngine } from "./ocr-engine.js";
import { logger } from "../../logging/logger.js";

export class ConverterRegistry {
  private converters = new Map<string, ConverterRegistration>();

  /** Register a converter for a set of extensions. */
  register(registration: ConverterRegistration): void {
    for (const ext of registration.extensions) {
      const normalizedExt = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
      this.converters.set(normalizedExt, registration);
    }
  }

  /** Check whether a given file extension has a registered converter. */
  canConvert(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    const reg = this.converters.get(ext);
    return reg !== undefined && reg.available;
  }

  /** Check whether a converter exists (even if unavailable). */
  hasConverter(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.converters.has(ext);
  }

  /** Get the converter registration for a file, or undefined. */
  getConverter(filePath: string): ConverterRegistration | undefined {
    const ext = path.extname(filePath).toLowerCase();
    return this.converters.get(ext);
  }

  /** Convert a file to text using the appropriate converter. */
  async convert(filePath: string): Promise<ConversionResult> {
    const ext = path.extname(filePath).toLowerCase();
    const reg = this.converters.get(ext);

    if (!reg) {
      return {
        text: "",
        success: false,
        converter: "none",
        error: `No converter registered for extension: ${ext}`,
      };
    }

    if (!reg.available) {
      return {
        text: "",
        success: false,
        converter: reg.name,
        error: reg.unavailableReason ?? `Converter "${reg.name}" is not available`,
      };
    }

    try {
      return await reg.convert(filePath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        text: "",
        success: false,
        converter: reg.name,
        error: msg,
      };
    }
  }

  /** List all registered converters with their availability status. */
  listConverters(): Array<{ name: string; extensions: string[]; available: boolean; reason?: string }> {
    const seen = new Map<string, { name: string; extensions: string[]; available: boolean; reason?: string }>();

    for (const [ext, reg] of this.converters) {
      const existing = seen.get(reg.name);
      if (existing) {
        existing.extensions.push(ext);
      } else {
        seen.set(reg.name, {
          name: reg.name,
          extensions: [ext],
          available: reg.available,
          reason: reg.unavailableReason,
        });
      }
    }

    return Array.from(seen.values());
  }
}

/**
 * Create a fully-initialized converter registry with all built-in converters.
 * Auto-detects which converters are available at startup.
 */
export async function createDefaultRegistry(): Promise<ConverterRegistry> {
  const registry = new ConverterRegistry();

  // Text / code / markup — always available (reads files as UTF-8).
  registry.register(createTextConverter());

  // PDF — available if pdf-parse can be imported.
  const pdfConverter = await createPdfConverter();
  registry.register(pdfConverter);
  if (pdfConverter.available) {
    logger.info("[Knowledge] PDF converter available (pdf-parse)");
  } else {
    logger.warn(`[Knowledge] PDF converter unavailable: ${pdfConverter.unavailableReason}`);
  }

  // DOCX — available if mammoth can be imported.
  const docxConverter = await createDocxConverter();
  registry.register(docxConverter);
  if (docxConverter.available) {
    logger.info("[Knowledge] DOCX converter available (mammoth)");
  } else {
    logger.warn(`[Knowledge] DOCX converter unavailable: ${docxConverter.unavailableReason}`);
  }

  // Image OCR — available if tesseract.js is installed.
  const imageOcrConverter = await createImageOcrConverter();
  registry.register(imageOcrConverter);
  if (imageOcrConverter.available) {
    logger.info("[Knowledge] Image OCR converter available (tesseract.js)");
  } else {
    logger.info(`[Knowledge] Image OCR converter unavailable: ${imageOcrConverter.unavailableReason}`);
  }

  // Media (mp4, mp3, wav, m4a) — available if ffmpeg is on PATH.
  const mediaConverter = await createMediaConverter();
  registry.register(mediaConverter);
  if (mediaConverter.available) {
    logger.info("[Knowledge] Media converter available (ffmpeg)");
  } else {
    logger.info(`[Knowledge] Media converter unavailable: ${mediaConverter.unavailableReason}`);
  }

  return registry;
}

/**
 * Shut down any long-lived resources held by converters (e.g. OCR worker).
 * Call when the KnowledgeIngestionService stops.
 */
export async function shutdownConverters(): Promise<void> {
  await terminateOcrEngine();
}
