/**
 * DOCX converter — extracts text from .docx files using `mammoth`.
 *
 * Uses `mammoth.extractRawText()` which ignores formatting and returns
 * clean paragraph text.  The dependency is loaded dynamically so the
 * service still starts when `mammoth` is not installed.
 */

import path from "node:path";
import type { ConverterRegistration } from "./types.js";

const DOCX_EXTENSIONS = [".docx"];

type ExtractFn = (input: { path: string }) => Promise<{ value: string; messages: unknown[] }>;

export async function createDocxConverter(): Promise<ConverterRegistration> {
  let extractRawText: ExtractFn | null = null;

  try {
    const mod: unknown = await import("mammoth");
    const m = mod as Record<string, unknown>;
    const obj = (m.default ?? m) as Record<string, unknown>;
    if (typeof obj.extractRawText === "function") {
      extractRawText = obj.extractRawText as ExtractFn;
    }
  } catch {
    // mammoth not installed.
  }

  if (!extractRawText) {
    return {
      name: "docx",
      extensions: DOCX_EXTENSIONS,
      available: false,
      unavailableReason: "Install mammoth: pnpm add mammoth",
      convert: async () => ({
        text: "",
        success: false,
        converter: "docx",
        error: "mammoth is not installed",
      }),
    };
  }

  const extract = extractRawText;

  return {
    name: "docx",
    extensions: DOCX_EXTENSIONS,
    available: true,
    convert: async (filePath: string) => {
      const result = await extract({ path: filePath });
      const fileName = path.basename(filePath, ".docx");
      const header = `# ${fileName}\n\n`;
      const text = header + result.value.trim();

      return {
        text,
        success: true,
        converter: "docx",
        metadata: {
          messageCount: result.messages.length,
        },
      };
    },
  };
}
