/**
 * Airtable Write MCP Tools
 *
 * Medium-risk data tools for creating, updating, and deleting Airtable records.
 * Batch operations limited to 10 records per request (Airtable API limit).
 */

import * as z from "zod";
import type { ToolDefinition } from "../../tool-registry.js";
import { AirtableClient } from "./airtable-client.js";
import type { SecretVaultService } from "../../../vault/secret-vault-service.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function getClient(vault: SecretVaultService | null): AirtableClient {
  if (!vault || !vault.isUnlocked()) {
    throw new Error(
      "Airtable requires an API key stored in the Secret Vault. " +
        "Add a secret with label 'airtable-api-key' via Admin → Vault.",
    );
  }
  const apiKey = vault.getByLabel("airtable-api-key");
  if (!apiKey) {
    throw new Error(
      "No secret with label 'airtable-api-key' found in the Secret Vault.",
    );
  }
  return new AirtableClient({ apiKey });
}

// ── Schemas ──────────────────────────────────────────────────────────────

const createRecordsSchema = z.object({
  baseId: z.string().describe("Airtable base ID (e.g., appXXXXXXXXXXXXXX)"),
  tableIdOrName: z.string().describe("Table ID or name"),
  records: z
    .array(z.object({ fields: z.record(z.unknown()) }))
    .min(1)
    .max(10)
    .describe("Records to create (max 10). Each has a 'fields' object."),
  typecast: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Auto-convert field values to matching types (e.g., string→linked record)",
    ),
});

const updateRecordsSchema = z.object({
  baseId: z.string().describe("Airtable base ID"),
  tableIdOrName: z.string().describe("Table ID or name"),
  records: z
    .array(
      z.object({
        id: z.string().describe("Record ID to update"),
        fields: z.record(z.unknown()),
      }),
    )
    .min(1)
    .max(10)
    .describe("Records to update (max 10). Each has 'id' and 'fields'."),
  typecast: z
    .boolean()
    .optional()
    .default(false)
    .describe("Auto-convert field values to matching types"),
});

const deleteRecordsSchema = z.object({
  baseId: z.string().describe("Airtable base ID"),
  tableIdOrName: z.string().describe("Table ID or name"),
  recordIds: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe("Record IDs to delete (max 10)"),
});

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createAirtableWriteTools(
  vault: SecretVaultService | null,
): ToolDefinition[] {
  return [
    // ── airtable-create-records ──
    {
      name: "airtable-create-records",
      description:
        "Create new records in an Airtable table (batch up to 10). " +
        "Each record is an object with a 'fields' key mapping field names to values. " +
        "Enable typecast to auto-convert values to the expected field type.",
      inputSchema: {
        type: "object" as const,
        properties: {
          baseId: { type: "string", description: "Airtable base ID" },
          tableIdOrName: { type: "string", description: "Table ID or name" },
          records: {
            type: "array",
            description: "Records to create (max 10)",
            items: {
              type: "object",
              properties: { fields: { type: "object" } },
              required: ["fields"],
            },
          },
          typecast: { type: "boolean", description: "Auto-convert types" },
        },
        required: ["baseId", "tableIdOrName", "records"],
      },
      zodSchema: createRecordsSchema,
      category: "data" as const,
      riskLevel: "medium" as const,
      handler: async (args) => {
        try {
          const parsed = createRecordsSchema.parse(args);
          const client = getClient(vault);
          const result = await client.createRecords(
            parsed.baseId,
            parsed.tableIdOrName,
            parsed.records,
            parsed.typecast,
          );
          const ids = result.records.map((r) => r.id).join(", ");
          return {
            text: `✅ Created ${result.records.length} record(s) in ${parsed.tableIdOrName}.\n\nRecord IDs: ${ids}`,
          };
        } catch (err) {
          return {
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    // ── airtable-update-records ──
    {
      name: "airtable-update-records",
      description:
        "Update existing records in an Airtable table (batch up to 10). " +
        "Each record must include its 'id' and the 'fields' to update (partial update). " +
        "Enable typecast to auto-convert values.",
      inputSchema: {
        type: "object" as const,
        properties: {
          baseId: { type: "string", description: "Airtable base ID" },
          tableIdOrName: { type: "string", description: "Table ID or name" },
          records: {
            type: "array",
            description: "Records to update (max 10)",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                fields: { type: "object" },
              },
              required: ["id", "fields"],
            },
          },
          typecast: { type: "boolean", description: "Auto-convert types" },
        },
        required: ["baseId", "tableIdOrName", "records"],
      },
      zodSchema: updateRecordsSchema,
      category: "data" as const,
      riskLevel: "medium" as const,
      handler: async (args) => {
        try {
          const parsed = updateRecordsSchema.parse(args);
          const client = getClient(vault);
          const result = await client.updateRecords(
            parsed.baseId,
            parsed.tableIdOrName,
            parsed.records,
            parsed.typecast,
          );
          const ids = result.records.map((r) => r.id).join(", ");
          return {
            text: `✅ Updated ${result.records.length} record(s) in ${parsed.tableIdOrName}.\n\nRecord IDs: ${ids}`,
          };
        } catch (err) {
          return {
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    // ── airtable-delete-records ──
    {
      name: "airtable-delete-records",
      description:
        "Delete records from an Airtable table (batch up to 10). " +
        "⚠️ This permanently removes records. Provide an array of record IDs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          baseId: { type: "string", description: "Airtable base ID" },
          tableIdOrName: { type: "string", description: "Table ID or name" },
          recordIds: {
            type: "array",
            description: "Record IDs to delete (max 10)",
            items: { type: "string" },
          },
        },
        required: ["baseId", "tableIdOrName", "recordIds"],
      },
      zodSchema: deleteRecordsSchema,
      category: "data" as const,
      riskLevel: "medium" as const,
      handler: async (args) => {
        try {
          const parsed = deleteRecordsSchema.parse(args);
          const client = getClient(vault);
          const result = await client.deleteRecords(
            parsed.baseId,
            parsed.tableIdOrName,
            parsed.recordIds,
          );
          const deleted = result.records.filter((r) => r.deleted).length;
          return {
            text: `✅ Deleted ${deleted} record(s) from ${parsed.tableIdOrName}.`,
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
