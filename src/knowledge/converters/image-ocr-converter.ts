/**
 * Image OCR converter — extracts text from images using tesseract.js.
 *
 * Handles common image formats: .jpg, .jpeg, .png, .tiff, .tif, .bmp, .webp, .gif
 *
 * tesseract.js runs entirely in WebAssembly — no system Tesseract binary required.
 * The dependency is loaded dynamically for graceful degradation.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ConverterRegistration } from "./types.js";
import { isTesseractAvailable, ocrImage } from "./ocr-engine.js";

const IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".tiff",
  ".tif",
  ".bmp",
  ".webp",
  ".gif",
];

export async function createImageOcrConverter(): Promise<ConverterRegistration> {
  const available = await isTesseractAvailable();

  if (!available) {
    return {
      name: "image-ocr",
      extensions: IMAGE_EXTENSIONS,
      available: false,
      unavailableReason: "Install tesseract.js: pnpm add tesseract.js",
      convert: async () => ({
        text: "",
        success: false,
        converter: "image-ocr",
        error: "tesseract.js is not installed",
      }),
    };
  }

  return {
    name: "image-ocr",
    extensions: IMAGE_EXTENSIONS,
    available: true,
    convert: async (filePath: string) => {
      const buffer = await fs.readFile(filePath);
      const text = await ocrImage(buffer);

      const trimmed = text.trim();
      if (!trimmed) {
        return {
          text: "",
          success: false,
          converter: "image-ocr",
          error: "No text detected in image",
        };
      }

      const fileName = path.basename(filePath, path.extname(filePath));
      const header = `# ${fileName}\n\n`;
      const meta = `> **Source:** OCR (tesseract.js) | **File:** ${path.basename(filePath)}\n\n`;

      return {
        text: header + meta + trimmed,
        success: true,
        converter: "image-ocr",
        metadata: {
          originalFile: path.basename(filePath),
          textLength: trimmed.length,
        },
      };
    },
  };
}
