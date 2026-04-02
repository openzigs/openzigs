/**
 * Google Sheets Write MCP Tools
 *
 * Medium-risk data tools for writing, appending, creating spreadsheets/sheets,
 * and formatting cells.
 */

import * as z from "zod";
import type { ToolDefinition } from "../../tool-registry.js";
import { SheetsClient } from "./sheets-client.js";
import type { SecretVaultService } from "../../../vault/secret-vault-service.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function getClient(vault: SecretVaultService | null): SheetsClient {
  if (!vault || !vault.isUnlocked()) {
    throw new Error(
      "Google Sheets write operations require OAuth2 credentials in the Secret Vault.",
    );
  }

  const accessToken = vault.getByLabel("google-sheets-oauth-token");
  const refreshToken = vault.getByLabel("google-sheets-refresh-token");
  const clientId = vault.getByLabel("google-sheets-client-id");
  const clientSecret = vault.getByLabel("google-sheets-client-secret");

  if (!accessToken) {
    throw new Error(
      "No OAuth2 access token found. Add 'google-sheets-oauth-token' to the Secret Vault. " +
        "Write operations require OAuth2 (API key is read-only).",
    );
  }

  return new SheetsClient({
    accessToken,
    refreshToken,
    clientId,
    clientSecret,
  });
}

// ── Schemas ──────────────────────────────────────────────────────────────

const writeRangeSchema = z.object({
  spreadsheetId: z.string().describe("Google Sheets spreadsheet ID"),
  range: z
    .string()
    .describe("A1 notation range to write to (e.g., 'Sheet1!A1:C3')"),
  values: z
    .array(z.array(z.unknown()))
    .describe("2D array of values (rows × columns)"),
  inputOption: z
    .enum(["RAW", "USER_ENTERED"])
    .optional()
    .default("USER_ENTERED")
    .describe(
      "RAW: values stored as-is. USER_ENTERED: parsed like user typed them (formulas, dates).",
    ),
});

const appendRowsSchema = z.object({
  spreadsheetId: z.string().describe("Google Sheets spreadsheet ID"),
  range: z
    .string()
    .describe("A1 notation range to append to (e.g., 'Sheet1!A:E')"),
  values: z.array(z.array(z.unknown())).describe("Rows to append (2D array)"),
  inputOption: z
    .enum(["RAW", "USER_ENTERED"])
    .optional()
    .default("USER_ENTERED"),
});

const createSpreadsheetSchema = z.object({
  title: z.string().describe("Title for the new spreadsheet"),
});

const createSheetSchema = z.object({
  spreadsheetId: z.string().describe("Google Sheets spreadsheet ID"),
  title: z.string().describe("Title for the new sheet tab"),
});

const formatCellsSchema = z.object({
  spreadsheetId: z.string().describe("Google Sheets spreadsheet ID"),
  sheetId: z
    .number()
    .int()
    .describe("Sheet ID (numeric, from sheets-get-metadata)"),
  startRow: z.number().int().min(0).describe("Start row index (0-based)"),
  endRow: z
    .number()
    .int()
    .min(1)
    .describe("End row index (exclusive, 0-based)"),
  startCol: z.number().int().min(0).describe("Start column index (0-based)"),
  endCol: z
    .number()
    .int()
    .min(1)
    .describe("End column index (exclusive, 0-based)"),
  bold: z.boolean().optional().describe("Make text bold"),
  italic: z.boolean().optional().describe("Make text italic"),
  fontSize: z.number().int().optional().describe("Font size in points"),
  horizontalAlignment: z.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
});

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createSheetsWriteTools(
  vault: SecretVaultService | null,
): ToolDefinition[] {
  return [
    // ── sheets-write-range ──
    {
      name: "sheets-write-range",
      description:
        "Write data to a specific range in a Google Sheet. " +
        "Overwrites existing data in the range. " +
        "Input is a 2D array of values (rows × columns).",
      inputSchema: {
        type: "object" as const,
        properties: {
          spreadsheetId: { type: "string", description: "Spreadsheet ID" },
          range: { type: "string", description: "A1 notation range" },
          values: { type: "array", description: "2D array of values" },
          inputOption: { type: "string", enum: ["RAW", "USER_ENTERED"] },
        },
        required: ["spreadsheetId", "range", "values"],
      },
      zodSchema: writeRangeSchema,
      category: "data" as const,
      riskLevel: "medium" as const,
      handler: async (args) => {
        try {
          const parsed = writeRangeSchema.parse(args);
          const client = getClient(vault);
          const result = await client.updateValues(
            parsed.spreadsheetId,
            parsed.range,
            parsed.values,
            parsed.inputOption,
          );
          return {
            text: `✅ Wrote to ${result.updatedRange}: ${result.updatedRows} rows, ${result.updatedColumns} columns (${result.updatedCells} cells).`,
          };
        } catch (err) {
          return {
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    // ── sheets-append-rows ──
    {
      name: "sheets-append-rows",
      description:
        "Append rows to the end of existing data in a Google Sheet. " +
        "Finds the last row with data and adds below it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          spreadsheetId: { type: "string", description: "Spreadsheet ID" },
          range: {
            type: "string",
            description: "A1 notation range (e.g., 'Sheet1!A:E')",
          },
          values: { type: "array", description: "Rows to append (2D array)" },
          inputOption: { type: "string", enum: ["RAW", "USER_ENTERED"] },
        },
        required: ["spreadsheetId", "range", "values"],
      },
      zodSchema: appendRowsSchema,
      category: "data" as const,
      riskLevel: "medium" as const,
      handler: async (args) => {
        try {
          const parsed = appendRowsSchema.parse(args);
          const client = getClient(vault);
          const result = await client.appendValues(
            parsed.spreadsheetId,
            parsed.range,
            parsed.values,
            parsed.inputOption,
          );
          return {
            text: `✅ Appended ${result.updates.updatedRows} rows to ${result.tableRange} (${result.updates.updatedCells} cells).`,
          };
        } catch (err) {
          return {
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    // ── sheets-create-spreadsheet ──
    {
      name: "sheets-create-spreadsheet",
      description: "Create a new Google Spreadsheet with the given title.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Spreadsheet title" },
        },
        required: ["title"],
      },
      zodSchema: createSpreadsheetSchema,
      category: "data" as const,
      riskLevel: "medium" as const,
      handler: async (args) => {
        try {
          const { title } = createSpreadsheetSchema.parse(args);
          const client = getClient(vault);
          const result = await client.createSpreadsheet(title);
          return {
            text:
              `✅ Created spreadsheet "${result.properties.title}"\n\n` +
              `**ID**: ${result.spreadsheetId}\n` +
              `**URL**: ${result.spreadsheetUrl}`,
          };
        } catch (err) {
          return {
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    // ── sheets-create-sheet ──
    {
      name: "sheets-create-sheet",
      description: "Add a new sheet (tab) to an existing Google Spreadsheet.",
      inputSchema: {
        type: "object" as const,
        properties: {
          spreadsheetId: { type: "string", description: "Spreadsheet ID" },
          title: { type: "string", description: "New sheet tab title" },
        },
        required: ["spreadsheetId", "title"],
      },
      zodSchema: createSheetSchema,
      category: "data" as const,
      riskLevel: "medium" as const,
      handler: async (args) => {
        try {
          const { spreadsheetId, title } = createSheetSchema.parse(args);
          const client = getClient(vault);
          await client.addSheet(spreadsheetId, title);
          return {
            text: `✅ Created sheet tab "${title}" in spreadsheet ${spreadsheetId}.`,
          };
        } catch (err) {
          return {
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    // ── sheets-format-cells ──
    {
      name: "sheets-format-cells",
      description:
        "Format cells in a Google Sheet — bold, italic, font size, alignment. " +
        "Specify the range using 0-based row/column indices.",
      inputSchema: {
        type: "object" as const,
        properties: {
          spreadsheetId: { type: "string" },
          sheetId: { type: "number", description: "Numeric sheet ID" },
          startRow: { type: "number" },
          endRow: { type: "number" },
          startCol: { type: "number" },
          endCol: { type: "number" },
          bold: { type: "boolean" },
          italic: { type: "boolean" },
          fontSize: { type: "number" },
          horizontalAlignment: {
            type: "string",
            enum: ["LEFT", "CENTER", "RIGHT"],
          },
        },
        required: [
          "spreadsheetId",
          "sheetId",
          "startRow",
          "endRow",
          "startCol",
          "endCol",
        ],
      },
      zodSchema: formatCellsSchema,
      category: "data" as const,
      riskLevel: "medium" as const,
      handler: async (args) => {
        try {
          const parsed = formatCellsSchema.parse(args);
          const client = getClient(vault);
          await client.formatCells(
            parsed.spreadsheetId,
            parsed.sheetId,
            parsed.startRow,
            parsed.endRow,
            parsed.startCol,
            parsed.endCol,
            {
              bold: parsed.bold,
              italic: parsed.italic,
              fontSize: parsed.fontSize,
              horizontalAlignment: parsed.horizontalAlignment,
            },
          );
          return {
            text: `✅ Formatted cells [${parsed.startRow}:${parsed.endRow}, ${parsed.startCol}:${parsed.endCol}].`,
          };
        } catch (err) {
          return {
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ];
}
