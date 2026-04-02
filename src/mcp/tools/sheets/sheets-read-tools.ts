/**
 * Google Sheets Read MCP Tools
 *
 * Low-risk data tools for reading spreadsheets, cell ranges, and metadata.
 * Output formatted as markdown tables for LLM readability.
 */

import * as z from "zod";
import type { ToolDefinition } from "../../tool-registry.js";
import { SheetsClient } from "./sheets-client.js";
import type { SecretVaultService } from "../../../vault/secret-vault-service.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function getClient(vault: SecretVaultService | null): SheetsClient {
  if (!vault || !vault.isUnlocked()) {
    throw new Error(
      "Google Sheets requires credentials stored in the Secret Vault. " +
        "Add a secret with label 'google-sheets-api-key' or 'google-sheets-oauth-token' via Admin → Vault.",
    );
  }

  const apiKey = vault.getByLabel("google-sheets-api-key");
  const accessToken = vault.getByLabel("google-sheets-oauth-token");
  const refreshToken = vault.getByLabel("google-sheets-refresh-token");
  const clientId = vault.getByLabel("google-sheets-client-id");
  const clientSecret = vault.getByLabel("google-sheets-client-secret");

  if (!apiKey && !accessToken) {
    throw new Error(
      "No Google Sheets credentials found. Add 'google-sheets-api-key' (read-only) " +
        "or 'google-sheets-oauth-token' (read/write) to the Secret Vault.",
    );
  }

  return new SheetsClient({
    apiKey,
    accessToken,
    refreshToken,
    clientId,
    clientSecret,
  });
}

function valuesToMarkdownTable(values: unknown[][]): string {
  if (!values || values.length === 0) return "_No data._";

  // First row is headers
  const headers = values[0].map((h) => String(h ?? ""));
  const header = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const rows = values.slice(1).map((row) => {
    const cells = headers.map((_, i) => {
      const val = row[i];
      if (val === undefined || val === null) return "";
      return String(val)
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
    });
    return `| ${cells.join(" | ")} |`;
  });

  return [header, separator, ...rows].join("\n");
}

// ── Schemas ──────────────────────────────────────────────────────────────

const listSpreadsheetsSchema = z.object({
  pageToken: z
    .string()
    .optional()
    .describe("Pagination token from previous response"),
});

const readRangeSchema = z.object({
  spreadsheetId: z
    .string()
    .describe("Google Sheets spreadsheet ID (from the URL)"),
  range: z
    .string()
    .describe(
      "A1 notation range (e.g., 'Sheet1!A1:D10', 'A:B', '1:5'). " +
        "Format: [SheetName!]ColumnRow[:ColumnRow]",
    ),
});

const getMetadataSchema = z.object({
  spreadsheetId: z.string().describe("Google Sheets spreadsheet ID"),
});

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createSheetsReadTools(
  vault: SecretVaultService | null,
): ToolDefinition[] {
  return [
    // ── sheets-list-spreadsheets ──
    {
      name: "sheets-list-spreadsheets",
      description:
        "List Google Sheets spreadsheets accessible with the configured credentials. " +
        "Returns spreadsheet IDs, names, and last modified times. Requires OAuth2 token.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageToken: { type: "string", description: "Pagination token" },
        },
      },
      zodSchema: listSpreadsheetsSchema,
      category: "data" as const,
      riskLevel: "low" as const,
      handler: async (args) => {
        try {
          const { pageToken } = listSpreadsheetsSchema.parse(args);
          const client = getClient(vault);
          const result = await client.listSpreadsheets(pageToken);
          const lines: string[] = [
            `## Google Spreadsheets (${result.files.length})\n`,
          ];
          const header = "| ID | Name | Modified |";
          const sep = "| --- | --- | --- |";
          const rows = result.files.map(
            (f) => `| ${f.id} | ${f.name} | ${f.modifiedTime ?? "—"} |`,
          );
          lines.push(header, sep, ...rows);
          if (result.nextPageToken) {
            lines.push(
              `\n_More results. Use pageToken: \`${result.nextPageToken}\`_`,
            );
          }
          return { text: lines.join("\n") };
        } catch (err) {
          return {
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    // ── sheets-read-range ──
    {
      name: "sheets-read-range",
      description:
        "Read a range of cells from a Google Sheet using A1 notation.\n\n" +
        "**A1 notation examples**:\n" +
        "- `Sheet1!A1:D10` — specific range on Sheet1\n" +
        "- `A:B` — entire columns A and B\n" +
        "- `1:5` — rows 1 through 5\n" +
        "- `'My Sheet'!A1:C20` — range on a sheet with spaces in the name\n\n" +
        "The first row is treated as column headers in the output.",
      inputSchema: {
        type: "object" as const,
        properties: {
          spreadsheetId: { type: "string", description: "Spreadsheet ID" },
          range: { type: "string", description: "A1 notation range" },
        },
        required: ["spreadsheetId", "range"],
      },
      zodSchema: readRangeSchema,
      category: "data" as const,
      riskLevel: "low" as const,
      handler: async (args) => {
        try {
          const { spreadsheetId, range } = readRangeSchema.parse(args);
          const client = getClient(vault);
          const result = await client.getValues(spreadsheetId, range);
          const rowCount = result.values?.length ?? 0;
          const lines: string[] = [
            `## Sheet Data: ${result.range} (${Math.max(0, rowCount - 1)} data rows)\n`,
          ];
          lines.push(valuesToMarkdownTable(result.values));
          return { text: lines.join("\n") };
        } catch (err) {
          return {
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    // ── sheets-get-metadata ──
    {
      name: "sheets-get-metadata",
      description:
        "Get metadata for a Google Spreadsheet — title, sheets (tabs), and grid dimensions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        },
        required: ["spreadsheetId"],
      },
      zodSchema: getMetadataSchema,
      category: "data" as const,
      riskLevel: "low" as const,
      handler: async (args) => {
        try {
          const { spreadsheetId } = getMetadataSchema.parse(args);
          const client = getClient(vault);
          const result = await client.getSpreadsheet(spreadsheetId);
          const lines: string[] = [
            `## Spreadsheet: ${result.properties.title}\n`,
            `**ID**: ${result.spreadsheetId}`,
            `**URL**: ${result.spreadsheetUrl}`,
            `**Sheets**: ${result.sheets.length}\n`,
          ];
          const header = "| Sheet ID | Title | Rows | Columns |";
          const sep = "| --- | --- | --- | --- |";
          const rows = result.sheets.map(
            (s) =>
              `| ${s.properties.sheetId} | ${s.properties.title} | ${s.properties.gridProperties?.rowCount ?? "—"} | ${s.properties.gridProperties?.columnCount ?? "—"} |`,
          );
          lines.push(header, sep, ...rows);
          return { text: lines.join("\n") };
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
