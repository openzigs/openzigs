/**
 * Data Output Helper
 *
 * Shared utility for writing structured row data to Airtable tables or
 * Google Sheets spreadsheets.  Used by site-to-dataset and lead-extract.
 */

import * as z from "zod";
import { AirtableClient } from "./airtable/airtable-client.js";
import { SheetsClient, validateA1Notation } from "./sheets/sheets-client.js";
import type { SecretVaultService } from "../../vault/secret-vault-service.js";

// ── Schema ───────────────────────────────────────────────────────────────

export const outputToSchema = z
  .object({
    type: z.enum(["airtable", "sheets"]),
    // Airtable fields
    baseId: z.string().optional(),
    tableIdOrName: z.string().optional(),
    // Sheets fields
    spreadsheetId: z.string().optional(),
    range: z.string().optional(),
  })
  .optional();

export type OutputTo = z.infer<typeof outputToSchema>;

// ── Result ───────────────────────────────────────────────────────────────

export interface OutputResult {
  success: boolean;
  recordsWritten: number;
  destination: string;
  error?: string;
}

// ── Write to Airtable ────────────────────────────────────────────────────

async function writeToAirtable(
  config: { baseId: string; tableIdOrName: string },
  rows: Record<string, unknown>[],
  vault: SecretVaultService | null,
): Promise<OutputResult> {
  if (!vault || !vault.isUnlocked()) {
    return {
      success: false,
      recordsWritten: 0,
      destination: `airtable://${config.baseId}/${config.tableIdOrName}`,
      error: "Secret Vault is locked. Cannot access Airtable API key.",
    };
  }

  const apiKey = vault.getByLabel("airtable-api-key");
  if (!apiKey) {
    return {
      success: false,
      recordsWritten: 0,
      destination: `airtable://${config.baseId}/${config.tableIdOrName}`,
      error:
        "No 'airtable-api-key' found in Secret Vault. Add one via Admin → Vault.",
    };
  }

  const client = new AirtableClient({ apiKey });
  const destination = `airtable://${config.baseId}/${config.tableIdOrName}`;
  let totalWritten = 0;

  // Airtable batch limit: 10 records per call
  const BATCH_SIZE = 10;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const result = await client.createRecords(
      config.baseId,
      config.tableIdOrName,
      batch.map((fields) => ({ fields })),
      true, // typecast: auto-convert field types
    );
    totalWritten += result.records.length;
  }

  return { success: true, recordsWritten: totalWritten, destination };
}

// ── Write to Sheets ──────────────────────────────────────────────────────

async function writeToSheets(
  config: { spreadsheetId: string; range: string },
  rows: Record<string, unknown>[],
  vault: SecretVaultService | null,
): Promise<OutputResult> {
  if (!vault || !vault.isUnlocked()) {
    return {
      success: false,
      recordsWritten: 0,
      destination: `sheets://${config.spreadsheetId}/${config.range}`,
      error: "Secret Vault is locked. Cannot access Google Sheets credentials.",
    };
  }

  const accessToken = vault.getByLabel("google-sheets-oauth-token");
  if (!accessToken) {
    return {
      success: false,
      recordsWritten: 0,
      destination: `sheets://${config.spreadsheetId}/${config.range}`,
      error:
        "No 'google-sheets-oauth-token' found in Secret Vault. Write operations require OAuth2.",
    };
  }

  if (!validateA1Notation(config.range)) {
    return {
      success: false,
      recordsWritten: 0,
      destination: `sheets://${config.spreadsheetId}/${config.range}`,
      error: `Invalid A1 notation: "${config.range}"`,
    };
  }

  const client = new SheetsClient({
    accessToken,
    refreshToken: vault.getByLabel("google-sheets-refresh-token"),
    clientId: vault.getByLabel("google-sheets-client-id"),
    clientSecret: vault.getByLabel("google-sheets-client-secret"),
  });

  const destination = `sheets://${config.spreadsheetId}/${config.range}`;

  if (rows.length === 0) {
    return { success: true, recordsWritten: 0, destination };
  }

  // Collect all headers across all rows
  const headerSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      headerSet.add(key);
    }
  }
  const headers = [...headerSet];

  // Build 2D array with header row + data rows
  const values: unknown[][] = [
    headers,
    ...rows.map((row) =>
      headers.map((h) => {
        const v = row[h];
        if (v === undefined || v === null) return "";
        if (Array.isArray(v)) return v.join(", ");
        return v;
      }),
    ),
  ];

  const result = await client.appendValues(
    config.spreadsheetId,
    config.range,
    values,
    "USER_ENTERED",
  );

  return {
    success: true,
    recordsWritten: result.updates?.updatedRows ?? rows.length,
    destination,
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────

/**
 * Write rows to the specified output destination.
 * Returns a summary result; never throws — callers can degrade gracefully.
 */
export async function writeToOutput(
  outputTo: OutputTo,
  rows: Record<string, unknown>[],
  vault: SecretVaultService | null,
): Promise<OutputResult | null> {
  if (!outputTo) return null;

  try {
    if (outputTo.type === "airtable") {
      if (!outputTo.baseId || !outputTo.tableIdOrName) {
        return {
          success: false,
          recordsWritten: 0,
          destination: "airtable://",
          error:
            "Airtable output requires 'baseId' and 'tableIdOrName' fields.",
        };
      }
      return await writeToAirtable(
        { baseId: outputTo.baseId, tableIdOrName: outputTo.tableIdOrName },
        rows,
        vault,
      );
    }

    if (outputTo.type === "sheets") {
      if (!outputTo.spreadsheetId || !outputTo.range) {
        return {
          success: false,
          recordsWritten: 0,
          destination: "sheets://",
          error: "Sheets output requires 'spreadsheetId' and 'range' fields.",
        };
      }
      return await writeToSheets(
        {
          spreadsheetId: outputTo.spreadsheetId,
          range: outputTo.range,
        },
        rows,
        vault,
      );
    }

    return {
      success: false,
      recordsWritten: 0,
      destination: `unknown://${String(outputTo.type)}`,
      error: `Unknown output type: ${String(outputTo.type)}`,
    };
  } catch (err) {
    return {
      success: false,
      recordsWritten: 0,
      destination: `${outputTo.type}://`,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build a human-readable summary line for the output result.
 */
export function outputSummaryLine(result: OutputResult | null): string {
  if (!result) return "";
  if (result.success) {
    return `\n**Output**: ${result.recordsWritten} records written to ${result.destination}`;
  }
  return `\n**Output failed**: ${result.error ?? "Unknown error"} (data is still available above)`;
}
