/**
 * Text converter — passthrough for text-based files.
 *
 * Reads files as UTF-8 and returns the raw content.  Handles: .md, .txt,
 * .json, .csv, .html, .xml, .yaml, .yml, .toml, and all code extensions.
 */

import fs from "node:fs/promises";
import type { ConverterRegistration } from "./types.js";

const TEXT_EXTENSIONS = [
  // Prose / markup
  ".md", ".markdown", ".txt", ".text", ".html", ".htm", ".xml",
  // Data
  ".json", ".csv", ".yaml", ".yml", ".toml",
  // Code
  ".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java",
  ".c", ".cpp", ".h", ".rb", ".php", ".swift", ".kt",
  ".sh", ".bash", ".zsh", ".sql", ".r", ".R",
];

export function createTextConverter(): ConverterRegistration {
  return {
    name: "text",
    extensions: TEXT_EXTENSIONS,
    available: true,
    convert: async (filePath: string) => {
      const text = await fs.readFile(filePath, "utf-8");
      return { text, success: true, converter: "text" };
    },
  };
}
