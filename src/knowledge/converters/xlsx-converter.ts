/**
 * Excel converter — extracts text from .xlsx/.xls spreadsheets.
 *
 * Uses the `xlsx` package to read workbook sheets and converts each sheet
 * to CSV text blocks in markdown so they can be chunked/indexed by the
 * Knowledge pipeline.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ConverterRegistration } from "./types.js";

const XLSX_EXTENSIONS = [".xlsx", ".xls"];

type Worksheet = Record<string, unknown>;
type Workbook = {
  SheetNames: string[];
  Sheets: Record<string, Worksheet>;
};

type XlsxModule = {
  read(data: Buffer | Uint8Array, opts?: Record<string, unknown>): Workbook;
  utils: {
    sheet_to_csv(sheet: Worksheet, opts?: Record<string, unknown>): string;
  };
};

export async function createXlsxConverter(): Promise<ConverterRegistration> {
  let xlsx: XlsxModule | null = null;

  try {
    const mod: unknown = await import("xlsx");
    const m = mod as Record<string, unknown>;
    const candidate = (m.default ?? m) as unknown;

    if (candidate && typeof candidate === "object") {
      const maybe = candidate as Record<string, unknown>;
      if (typeof maybe.read === "function" && maybe.utils && typeof maybe.utils === "object") {
        const utils = maybe.utils as Record<string, unknown>;
        if (typeof utils.sheet_to_csv === "function") {
          xlsx = maybe as unknown as XlsxModule;
        }
      }
    }
  } catch {
    // xlsx not installed.
  }

  if (!xlsx) {
    return {
      name: "xlsx",
      extensions: XLSX_EXTENSIONS,
      available: false,
      unavailableReason: "Install xlsx: pnpm add xlsx",
      convert: async () => ({
        text: "",
        success: false,
        converter: "xlsx",
        error: "xlsx is not installed",
      }),
    };
  }

  const parser = xlsx;

  return {
    name: "xlsx",
    extensions: XLSX_EXTENSIONS,
    available: true,
    convert: async (filePath: string) => {
      const buffer = await fs.readFile(filePath);
      const workbook = parser.read(buffer, {
        type: "buffer",
        cellDates: true,
        raw: false,
      });

      const fileName = path.basename(filePath, path.extname(filePath));
      const parts: string[] = [`# ${fileName}`, ""];
      let nonEmptySheets = 0;

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;

        const csv = parser.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
        if (!csv) continue;

        nonEmptySheets += 1;
        parts.push(`## Sheet: ${sheetName}`);
        parts.push("");
        parts.push("```csv");
        parts.push(csv);
        parts.push("```");
        parts.push("");
      }

      if (nonEmptySheets === 0) {
        return {
          text: "",
          success: false,
          converter: "xlsx",
          error: "No readable cells found in workbook",
          metadata: {
            sheetCount: workbook.SheetNames.length,
            nonEmptySheets,
          },
        };
      }

      return {
        text: parts.join("\n"),
        success: true,
        converter: "xlsx",
        metadata: {
          sheetCount: workbook.SheetNames.length,
          nonEmptySheets,
        },
      };
    },
  };
}
