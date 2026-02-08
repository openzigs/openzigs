import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { LocalMcpServerManager } from "../local-mcp-server-manager.js";

/**
 * Document intelligence MCP tools for PDF reading, Word generation,
 * and Google Calendar integration.
 *
 * - PDF reader: native Node.js (reads file buffer, extracts text).
 * - Word/Office: delegates to local Python MCP server via LocalMcpServerManager.
 * - Google Calendar: delegates to local Node.js MCP server via LocalMcpServerManager.
 */

type DocumentIntelligenceOptions = {
  /** LocalMcpServerManager instance for subprocess-based MCP servers */
  localServerManager?: LocalMcpServerManager;
};

// ── PDF Schemas ──

const readPdfSchema = z.object({
  path: z.string(),
  query: z.string().optional(),
});

// ── Word Schemas (proxied to local Python MCP server) ──

const createWordDocSchema = z.object({
  content: z.string().describe("Text content to put in the document"),
  output_path: z.string().describe("Absolute path for the output .docx file"),
});

const wordAddHeadingSchema = z.object({
  text: z.string(),
  level: z.number().min(1).max(6).optional(),
});

const wordAddParagraphSchema = z.object({
  text: z.string(),
  style: z.string().optional(),
});

const wordAddTableSchema = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

const wordReadDocSchema = z.object({
  file_path: z.string().describe("Absolute path to the .docx file to read"),
});

const wordToPdfSchema = z.object({
  input_path: z.string().describe("Absolute path to the .docx file"),
  output_path: z
    .string()
    .describe("Absolute path for the output PDF")
    .optional(),
});

// ── Calendar Schemas (proxied to local Node.js MCP server) ──

const calendarListSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  maxResults: z.number().optional(),
});

const calendarCreateSchema = z.object({
  summary: z.string(),
  description: z.string().optional(),
  startTime: z.string(),
  endTime: z.string(),
  timezone: z.string().optional(),
  attendees: z.array(z.string()).optional(),
});

const calendarSearchSchema = z.object({
  query: z.string(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

const calendarFreebusySchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
  calendars: z.array(z.string()).optional(),
});

// ── Helpers ──

/**
 * Proxy a tool call to a local MCP subprocess server.
 * Returns an error message if the server is not running.
 */
const callLocalServer = async (
  manager: LocalMcpServerManager | undefined,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!manager) {
    return {
      text: `Local MCP server manager not configured. Cannot call tool "${toolName}".`,
      isError: true,
    };
  }

  if (!manager.isRunning(serverName)) {
    return {
      text: `Local MCP server "${serverName}" is not running. Start it from the admin panel or check that the required runtime is installed.`,
      isError: true,
    };
  }

  return manager.callTool(serverName, toolName, args);
};

// ── Tool Factory ──

export const createDocumentIntelligenceTools = (
  options: DocumentIntelligenceOptions
): ToolDefinition[] => {
  const mgr = options.localServerManager;

  return [
    // ────── PDF ──────
    {
      name: "read-pdf",
      description:
        "Extract text from a PDF file. Optionally search for specific content within the PDF.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          query: { type: "string" },
        },
        required: ["path"],
      },
      zodSchema: readPdfSchema,
      category: "documents",
      riskLevel: "low",
      handler: async (args) => {
        const input = args as z.infer<typeof readPdfSchema>;
        try {
          const { readFileSync } = await import("node:fs");
          const buffer = readFileSync(input.path);
          // Basic text extraction from PDF buffer
          const text = buffer
            .toString("utf-8")
            .replace(/[^\x20-\x7E\n\r\t]/g, " ");
          if (input.query) {
            const lines = text.split("\n");
            const matching = lines.filter((line) =>
              line.toLowerCase().includes(input.query!.toLowerCase())
            );
            return {
              text:
                matching.length > 0
                  ? matching.join("\n")
                  : "No matching content found in PDF.",
            };
          }
          return { text: text.slice(0, 50_000) };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return { text: `Failed to read PDF: ${message}`, isError: true };
        }
      },
    },

    // ────── Word/Office (local Python MCP server) ──────
    {
      name: "create-word-doc",
      description:
        "Create a Word document (.docx) with the given text content. Uses the Office Word MCP server (Python).",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
          output_path: { type: "string" },
        },
        required: ["content", "output_path"],
      },
      zodSchema: createWordDocSchema,
      category: "documents",
      riskLevel: "medium",
      source: "word",
      handler: async (args) => {
        const input = args as z.infer<typeof createWordDocSchema>;
        return callLocalServer(mgr, "word", "create_document", input);
      },
    },
    {
      name: "word-add-heading",
      description: "Add a heading to the active Word document.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          level: { type: "number" },
        },
        required: ["text"],
      },
      zodSchema: wordAddHeadingSchema,
      category: "documents",
      riskLevel: "medium",
      source: "word",
      handler: async (args) => {
        const input = args as z.infer<typeof wordAddHeadingSchema>;
        return callLocalServer(mgr, "word", "add_heading", input);
      },
    },
    {
      name: "word-add-paragraph",
      description: "Add a paragraph to the active Word document.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          style: { type: "string" },
        },
        required: ["text"],
      },
      zodSchema: wordAddParagraphSchema,
      category: "documents",
      riskLevel: "medium",
      source: "word",
      handler: async (args) => {
        const input = args as z.infer<typeof wordAddParagraphSchema>;
        return callLocalServer(mgr, "word", "add_paragraph", input);
      },
    },
    {
      name: "word-add-table",
      description: "Add a table to the active Word document.",
      inputSchema: {
        type: "object",
        properties: {
          headers: { type: "array", items: { type: "string" } },
          rows: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
          },
        },
        required: ["headers", "rows"],
      },
      zodSchema: wordAddTableSchema,
      category: "documents",
      riskLevel: "medium",
      source: "word",
      handler: async (args) => {
        const input = args as z.infer<typeof wordAddTableSchema>;
        return callLocalServer(mgr, "word", "add_table", input);
      },
    },
    {
      name: "word-read-doc",
      description: "Read and extract text from a Word document (.docx).",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
        },
        required: ["file_path"],
      },
      zodSchema: wordReadDocSchema,
      category: "documents",
      riskLevel: "low",
      source: "word",
      handler: async (args) => {
        const input = args as z.infer<typeof wordReadDocSchema>;
        return callLocalServer(mgr, "word", "read_document", input);
      },
    },
    {
      name: "word-to-pdf",
      description: "Convert a Word document (.docx) to PDF format.",
      inputSchema: {
        type: "object",
        properties: {
          input_path: { type: "string" },
          output_path: { type: "string" },
        },
        required: ["input_path"],
      },
      zodSchema: wordToPdfSchema,
      category: "documents",
      riskLevel: "medium",
      source: "word",
      handler: async (args) => {
        const input = args as z.infer<typeof wordToPdfSchema>;
        return callLocalServer(mgr, "word", "convert_to_pdf", input);
      },
    },

    // ────── Google Calendar (local Node.js MCP server) ──────
    {
      name: "calendar-list",
      description: "List upcoming Google Calendar events.",
      inputSchema: {
        type: "object",
        properties: {
          startDate: { type: "string" },
          endDate: { type: "string" },
          maxResults: { type: "number" },
        },
      },
      zodSchema: calendarListSchema,
      category: "documents",
      riskLevel: "low",
      source: "calendar",
      handler: async (args) => {
        const input = args as z.infer<typeof calendarListSchema>;
        return callLocalServer(mgr, "calendar", "list-events", input);
      },
    },
    {
      name: "calendar-create",
      description:
        "Create a new Google Calendar event with title, time, and optional attendees.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          description: { type: "string" },
          startTime: { type: "string" },
          endTime: { type: "string" },
          timezone: { type: "string" },
          attendees: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "startTime", "endTime"],
      },
      zodSchema: calendarCreateSchema,
      category: "documents",
      riskLevel: "medium",
      source: "calendar",
      handler: async (args) => {
        const input = args as z.infer<typeof calendarCreateSchema>;
        return callLocalServer(mgr, "calendar", "create-event", input);
      },
    },
    {
      name: "calendar-search",
      description: "Search Google Calendar events by keyword.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: "string" },
        },
        required: ["query"],
      },
      zodSchema: calendarSearchSchema,
      category: "documents",
      riskLevel: "low",
      source: "calendar",
      handler: async (args) => {
        const input = args as z.infer<typeof calendarSearchSchema>;
        return callLocalServer(mgr, "calendar", "search-events", input);
      },
    },
    {
      name: "calendar-freebusy",
      description:
        "Check free/busy status for specified time range and calendars.",
      inputSchema: {
        type: "object",
        properties: {
          startTime: { type: "string" },
          endTime: { type: "string" },
          calendars: { type: "array", items: { type: "string" } },
        },
        required: ["startTime", "endTime"],
      },
      zodSchema: calendarFreebusySchema,
      category: "documents",
      riskLevel: "low",
      source: "calendar",
      handler: async (args) => {
        const input = args as z.infer<typeof calendarFreebusySchema>;
        return callLocalServer(mgr, "calendar", "get-freebusy", input);
      },
    },
  ];
};
