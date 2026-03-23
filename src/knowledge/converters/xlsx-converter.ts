/**
 * Excel converter — extracts text from .xlsx/.xls spreadsheets.
 *
 * Uses the `exceljs` package to read workbook sheets and converts each sheet
 * to CSV text blocks in markdown so they can be chunked/indexed by the
 * Knowledge pipeline.
 */

import path from "node:path";
import type { ConverterRegistration } from "./types.js";

const XLSX_EXTENSIONS = [".xlsx", ".xls"];

function csvEscape(value: string): string {
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function createXlsxConverter(): Promise<ConverterRegistration> {
  let ExcelJS: typeof import("exceljs") | null = null;

  try {
    ExcelJS = await import("exceljs");
  } catch {
    // exceljs not installed.
  }

  if (!ExcelJS) {
    return {
      name: "xlsx",
      extensions: XLSX_EXTENSIONS,
      available: false,
      unavailableReason: "Install exceljs: pnpm add exceljs",
      convert: async () => ({
        text: "",
        success: false,
        converter: "xlsx",
        error: "exceljs is not installed",
      }),
    };
  }

  const ExcelJSRef = ExcelJS;

  return {
    name: "xlsx",
    extensions: XLSX_EXTENSIONS,
    available: true,
    convert: async (filePath: string) => {
      const workbook = new ExcelJSRef.Workbook();
      await workbook.xlsx.readFile(filePath);

      const fileName = path.basename(filePath, path.extname(filePath));
      const parts: string[] = [`# ${fileName}`, ""];
      let nonEmptySheets = 0;
      let totalSheets = 0;

      workbook.eachSheet((worksheet) => {
        totalSheets += 1;
        const rows: string[] = [];

        worksheet.eachRow((row) => {
          const cells: string[] = [];
          row.eachCell({ includeEmpty: false }, (cell) => {
            const val = cell.value;
            if (val === null || val === undefined) {
              cells.push("");
            } else if (typeof val === "object") {
              if ("richText" in val) {
                // ExcelJS rich text cell: { richText: [{ text, font? }] }
                cells.push(
                  (val as { richText: Array<{ text: string }> }).richText
                    .map((r) => r.text)
                    .join(""),
                );
              } else if ("result" in val) {
                // Formula cell: { formula, result }
                cells.push(String((val as { result?: unknown }).result ?? ""));
              } else if ("text" in val) {
                // Hyperlink cell: { text, hyperlink }
                cells.push(String((val as { text?: unknown }).text ?? ""));
              } else if ("error" in val) {
                cells.push("");
              } else {
                cells.push(String(val));
              }
            } else {
              cells.push(String(val));
            }
          });
          if (cells.length > 0) {
            rows.push(cells.map(csvEscape).join(","));
          }
        });

        const csv = rows.join("\n").trim();
        if (!csv) return;

        nonEmptySheets += 1;
        parts.push(`## Sheet: ${worksheet.name}`);
        parts.push("");
        parts.push("```csv");
        parts.push(csv);
        parts.push("```");
        parts.push("");
      });

      if (nonEmptySheets === 0) {
        return {
          text: "",
          success: false,
          converter: "xlsx",
          error: "No readable cells found in workbook",
          metadata: {
            sheetCount: totalSheets,
            nonEmptySheets,
          },
        };
      }

      return {
        text: parts.join("\n"),
        success: true,
        converter: "xlsx",
        metadata: {
          sheetCount: totalSheets,
          nonEmptySheets,
        },
      };
    },
  };
}
