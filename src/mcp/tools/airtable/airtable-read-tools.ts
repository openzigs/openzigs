/**
 * Airtable Read MCP Tools
 *
 * Low-risk data tools for reading Airtable bases, tables, records, views, and fields.
 * Output formatted as markdown tables for LLM readability.
 */

import * as z from "zod";
import type { ToolDefinition } from "../../tool-registry.js";
import { AirtableClient } from "./airtable-client.js";
import type { SecretVaultService } from "../../../vault/secret-vault-service.js";
import type { AirtableRecord, AirtableField } from "./types.js";

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
      "No secret with label 'airtable-api-key' found in the Secret Vault. " +
        "Add one via Admin → Vault or Admin → Integrations.",
    );
  }
  return new AirtableClient({ apiKey });
}

function recordsToMarkdownTable(
  records: AirtableRecord[],
  fields?: string[],
): string {
  if (records.length === 0) return "_No records found._";

  // Collect all field names from the records
  const allFields = new Set<string>();
  for (const r of records) {
    for (const key of Object.keys(r.fields)) allFields.add(key);
  }
  const columns =
    fields && fields.length > 0
      ? fields.filter((f) => allFields.has(f))
      : Array.from(allFields);

  if (columns.length === 0) return "_No fields to display._";

  // Build markdown table
  const header = `| ID | ${columns.join(" | ")} |`;
  const separator = `| --- | ${columns.map(() => "---").join(" | ")} |`;
  const rows = records.map((r) => {
    const cells = columns.map((col) => {
      const val = r.fields[col];
      if (val === undefined || val === null) return "";
      if (Array.isArray(val)) return val.join(", ");
      return String(val).replace(/\|/g, "\\|").replace(/\n/g, " ");
    });
    return `| ${r.id} | ${cells.join(" | ")} |`;
  });

  return [header, separator, ...rows].join("\n");
}

function fieldsToMarkdownTable(fields: AirtableField[]): string {
  if (fields.length === 0) return "_No fields._";
  const header = "| Name | Type | Description |";
  const separator = "| --- | --- | --- |";
  const rows = fields.map(
    (f) => `| ${f.name} | ${f.type} | ${f.description ?? ""} |`,
  );
  return [header, separator, ...rows].join("\n");
}

// ── Schemas ──────────────────────────────────────────────────────────────

const listBasesSchema = z.object({
  offset: z
    .string()
    .optional()
    .describe("Pagination cursor from previous response"),
});

const listTablesSchema = z.object({
  baseId: z.string().describe("Airtable base ID (e.g., appXXXXXXXXXXXXXX)"),
});

const readRecordsSchema = z.object({
  baseId: z.string().describe("Airtable base ID"),
  tableIdOrName: z.string().describe("Table ID or name"),
  fields: z.array(z.string()).optional().describe("Specific fields to return"),
  filterByFormula: z
    .string()
    .optional()
    .describe(
      "Airtable formula to filter records (e.g., {Status}='Active'). " +
        "Syntax: {FieldName} for field refs, AND(), OR(), NOT() for logic, " +
        "=, !=, <, >, <=, >= for comparisons.",
    ),
  sort: z
    .array(
      z.object({
        field: z.string(),
        direction: z.enum(["asc", "desc"]).optional(),
      }),
    )
    .optional()
    .describe("Sort order"),
  maxRecords: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("Max records (default: 20)"),
  view: z.string().optional().describe("View name or ID to read from"),
  offset: z.string().optional().describe("Pagination cursor"),
});

const listViewsSchema = z.object({
  baseId: z.string().describe("Airtable base ID"),
  tableIdOrName: z.string().describe("Table ID or name"),
});

const getFieldsSchema = z.object({
  baseId: z.string().describe("Airtable base ID"),
  tableIdOrName: z.string().describe("Table ID or name"),
});

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createAirtableReadTools(
  vault: SecretVaultService | null,
): ToolDefinition[] {
  return [
    // ── airtable-list-bases ──
    {
      name: "airtable-list-bases",
      description:
        "List all Airtable bases accessible with the configured API key. " +
        "Returns base IDs, names, and permission levels.",
      inputSchema: {
        type: "object" as const,
        properties: {
          offset: { type: "string", description: "Pagination cursor" },
        },
      },
      zodSchema: listBasesSchema,
      category: "data" as const,
      riskLevel: "low" as const,
      handler: async (args) => {
        try {
          const { offset } = listBasesSchema.parse(args);
          const client = getClient(vault);
          const result = await client.listBases(offset);
          const lines: string[] = [
            `## Airtable Bases (${result.bases.length})\n`,
          ];
          const header = "| ID | Name | Permission |";
          const sep = "| --- | --- | --- |";
          const rows = result.bases.map(
            (b) => `| ${b.id} | ${b.name} | ${b.permissionLevel} |`,
          );
          lines.push(header, sep, ...rows);
          if (result.offset) {
            lines.push(
              `\n_More results available. Use offset: \`${result.offset}\`_`,
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

    // ── airtable-list-tables ──
    {
      name: "airtable-list-tables",
      description:
        "List all tables in an Airtable base. Returns table IDs, names, " +
        "field counts, and view counts.",
      inputSchema: {
        type: "object" as const,
        properties: {
          baseId: { type: "string", description: "Airtable base ID" },
        },
        required: ["baseId"],
      },
      zodSchema: listTablesSchema,
      category: "data" as const,
      riskLevel: "low" as const,
      handler: async (args) => {
        try {
          const { baseId } = listTablesSchema.parse(args);
          const client = getClient(vault);
          const result = await client.listTables(baseId);
          const lines: string[] = [
            `## Tables in ${baseId} (${result.tables.length})\n`,
          ];
          const header = "| ID | Name | Fields | Views |";
          const sep = "| --- | --- | --- | --- |";
          const rows = result.tables.map(
            (t) =>
              `| ${t.id} | ${t.name} | ${t.fields.length} | ${t.views.length} |`,
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

    // ── airtable-read-records ──
    {
      name: "airtable-read-records",
      description:
        "Read records from an Airtable table. Supports filtering by formula, " +
        "sorting, field selection, views, and pagination.\n\n" +
        "**Filter formula syntax**: `{FieldName}` for field references, " +
        "`AND(cond1, cond2)`, `OR()`, `NOT()` for logic, " +
        "`=`, `!=`, `<`, `>`, `<=`, `>=` for comparisons. " +
        "Example: `AND({Status}='Active', {Score}>80)`",
      inputSchema: {
        type: "object" as const,
        properties: {
          baseId: { type: "string", description: "Airtable base ID" },
          tableIdOrName: { type: "string", description: "Table ID or name" },
          fields: { type: "array", description: "Fields to return" },
          filterByFormula: { type: "string", description: "Airtable formula" },
          sort: { type: "array", description: "Sort order" },
          maxRecords: { type: "number", description: "Max records (1-100)" },
          view: { type: "string", description: "View name or ID" },
          offset: { type: "string", description: "Pagination cursor" },
        },
        required: ["baseId", "tableIdOrName"],
      },
      zodSchema: readRecordsSchema,
      category: "data" as const,
      riskLevel: "low" as const,
      handler: async (args) => {
        try {
          const parsed = readRecordsSchema.parse(args);
          const client = getClient(vault);
          const result = await client.listRecords(
            parsed.baseId,
            parsed.tableIdOrName,
            {
              fields: parsed.fields,
              filterByFormula: parsed.filterByFormula,
              sort: parsed.sort,
              maxRecords: parsed.maxRecords,
              view: parsed.view,
              offset: parsed.offset,
            },
          );
          const lines: string[] = [
            `## Records from ${parsed.tableIdOrName} (${result.records.length})\n`,
          ];
          lines.push(recordsToMarkdownTable(result.records, parsed.fields));
          if (result.offset) {
            lines.push(
              `\n_More results available. Use offset: \`${result.offset}\`_`,
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

    // ── airtable-list-views ──
    {
      name: "airtable-list-views",
      description: "List all views in an Airtable table.",
      inputSchema: {
        type: "object" as const,
        properties: {
          baseId: { type: "string", description: "Airtable base ID" },
          tableIdOrName: { type: "string", description: "Table ID or name" },
        },
        required: ["baseId", "tableIdOrName"],
      },
      zodSchema: listViewsSchema,
      category: "data" as const,
      riskLevel: "low" as const,
      handler: async (args) => {
        try {
          const { baseId, tableIdOrName } = listViewsSchema.parse(args);
          const client = getClient(vault);
          const result = await client.listTables(baseId);
          const table = result.tables.find(
            (t) => t.id === tableIdOrName || t.name === tableIdOrName,
          );
          if (!table) {
            return {
              text: `Table "${tableIdOrName}" not found in base ${baseId}.`,
              isError: true,
            };
          }
          const lines: string[] = [`## Views in ${table.name}\n`];
          const header = "| ID | Name | Type |";
          const sep = "| --- | --- | --- |";
          const rows = table.views.map(
            (v) => `| ${v.id} | ${v.name} | ${v.type} |`,
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

    // ── airtable-get-fields ──
    {
      name: "airtable-get-fields",
      description:
        "Get the field schema for an Airtable table — names, types, and descriptions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          baseId: { type: "string", description: "Airtable base ID" },
          tableIdOrName: { type: "string", description: "Table ID or name" },
        },
        required: ["baseId", "tableIdOrName"],
      },
      zodSchema: getFieldsSchema,
      category: "data" as const,
      riskLevel: "low" as const,
      handler: async (args) => {
        try {
          const { baseId, tableIdOrName } = getFieldsSchema.parse(args);
          const client = getClient(vault);
          const result = await client.listTables(baseId);
          const table = result.tables.find(
            (t) => t.id === tableIdOrName || t.name === tableIdOrName,
          );
          if (!table) {
            return {
              text: `Table "${tableIdOrName}" not found in base ${baseId}.`,
              isError: true,
            };
          }
          const lines: string[] = [`## Fields in ${table.name}\n`];
          lines.push(fieldsToMarkdownTable(table.fields));
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
