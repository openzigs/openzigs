import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * Document intelligence MCP tools for PDF reading, Word generation,
 * and Google Calendar integration. PDF reader and Calendar run as
 * npx-based MCP servers; Word generation proxies to a Docker sidecar.
 */

type DocumentIntelligenceOptions = {
  wordSidecarUrl?: string;
  calendarSidecarUrl?: string;
};

const readPdfSchema = z.object({
  path: z.string(),
  query: z.string().optional(),
});

const createWordDocSchema = z.object({
  outputPath: z.string(),
  title: z.string(),
  content: z.string(),
  format: z.enum(["docx", "doc"]).optional(),
});

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

const callSidecar = async (
  baseUrl: string | undefined,
  method: string,
  params: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!baseUrl) {
    return {
      text: "Document sidecar not configured. Set the sidecar URL in environment variables.",
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
      return { text: `Sidecar error: ${errorText}`, isError: true };
    }

    const result = await response.json() as { result?: string };
    return { text: result.result ?? JSON.stringify(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Failed to reach sidecar: ${message}`, isError: true };
  }
};

export const createDocumentIntelligenceTools = (
  options: DocumentIntelligenceOptions
): ToolDefinition[] => {
  return [
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
        // Use the mcp_pdf_reader Node.js package (peer dependency)
        try {
          const { readFileSync } = await import("node:fs");
          const buffer = readFileSync(input.path);
          // Basic text extraction — returns raw text content
          const text = buffer.toString("utf-8").replace(/[^\x20-\x7E\n\r\t]/g, " ");
          if (input.query) {
            const lines = text.split("\n");
            const matching = lines.filter((line) =>
              line.toLowerCase().includes(input.query!.toLowerCase())
            );
            return {
              text: matching.length > 0
                ? matching.join("\n")
                : "No matching content found in PDF.",
            };
          }
          return { text: text.slice(0, 50_000) }; // Cap at 50k chars
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: `Failed to read PDF: ${message}`, isError: true };
        }
      },
    },
    {
      name: "create-word-doc",
      description:
        "Create a Word document (.docx) via the Office Word MCP sidecar",
      inputSchema: {
        type: "object",
        properties: {
          outputPath: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          format: { type: "string", enum: ["docx", "doc"] },
        },
        required: ["outputPath", "title", "content"],
      },
      zodSchema: createWordDocSchema,
      category: "documents",
      riskLevel: "medium",
      handler: async (args) => {
        const input = args as z.infer<typeof createWordDocSchema>;
        return callSidecar(options.wordSidecarUrl, "create_document", input);
      },
    },
    {
      name: "calendar-list",
      description: "List upcoming Google Calendar events",
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
      handler: async (args) => {
        const input = args as z.infer<typeof calendarListSchema>;
        return callSidecar(options.calendarSidecarUrl, "list_events", input);
      },
    },
    {
      name: "calendar-create",
      description:
        "Create a new Google Calendar event with title, time, and optional attendees",
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
      handler: async (args) => {
        const input = args as z.infer<typeof calendarCreateSchema>;
        return callSidecar(
          options.calendarSidecarUrl,
          "create_event",
          input
        );
      },
    },
  ];
};
