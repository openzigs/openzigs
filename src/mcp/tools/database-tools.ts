import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * JDBC Database MCP tools for querying databases.
 *
 * Connects to the Database MCP sidecar (quarkiverse/quarkus-mcp-servers/jdbc)
 * which provides SQL access to any JDBC-compatible database (PostgreSQL, MySQL,
 * SQLite, H2). Can run via Docker or natively with JBang.
 */

type DatabaseToolsOptions = {
  sidecarUrl?: string;
};

const dbListTablesSchema = z.object({
  schema: z.string().optional().describe("Database schema to list tables from (default: public)"),
});

const dbDescribeSchema = z.object({
  table: z.string().describe("Name of the table to describe"),
  schema: z.string().optional().describe("Database schema (default: public)"),
});

const dbQuerySchema = z.object({
  query: z.string().describe("SQL query to execute"),
  maxRows: z.number().optional().describe("Maximum number of rows to return (default: 100)"),
});

const callSidecar = async (
  baseUrl: string | undefined,
  method: string,
  params: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!baseUrl) {
    return {
      text: "Database sidecar not configured. Set MCP_DATABASE_URL and JDBC_URL in environment variables.",
      isError: true,
    };
  }

  try {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { text: `Database sidecar error: ${errorText}`, isError: true };
    }

    const result = (await response.json()) as { result?: string };
    return { text: result.result ?? JSON.stringify(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Failed to reach Database sidecar: ${message}`, isError: true };
  }
};

export const createDatabaseTools = (options: DatabaseToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "db-list-tables",
      description: "List all tables in the connected JDBC database.",
      inputSchema: {
        type: "object",
        properties: {
          schema: { type: "string" },
        },
      },
      zodSchema: dbListTablesSchema,
      category: "documents",
      riskLevel: "low",
      handler: async (args) => {
        const input = args as z.infer<typeof dbListTablesSchema>;
        return callSidecar(options.sidecarUrl, "db_list_tables", input);
      },
    },
    {
      name: "db-describe",
      description: "Describe a database table's columns, types, and constraints.",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string" },
          schema: { type: "string" },
        },
        required: ["table"],
      },
      zodSchema: dbDescribeSchema,
      category: "documents",
      riskLevel: "low",
      handler: async (args) => {
        const input = args as z.infer<typeof dbDescribeSchema>;
        return callSidecar(options.sidecarUrl, "db_describe", input);
      },
    },
    {
      name: "db-query",
      description:
        "Execute a SQL query against the connected JDBC database. WARNING: This runs arbitrary SQL. Requires human approval.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          maxRows: { type: "number" },
        },
        required: ["query"],
      },
      zodSchema: dbQuerySchema,
      category: "documents",
      riskLevel: "high",
      handler: async (args) => {
        const input = args as z.infer<typeof dbQuerySchema>;
        return callSidecar(options.sidecarUrl, "db_query", input);
      },
    },
  ];
};
