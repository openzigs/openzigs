import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * MarkItDown MCP tools for converting various file formats to Markdown.
 *
 * Connects to the MarkItDown Docker sidecar (microsoft/markitdown) which
 * converts PDF, DOCX, PPTX, XLSX, HTML, images, and audio into Markdown
 * for LLM consumption.
 */

type MarkItDownOptions = {
  sidecarUrl?: string;
};

const convertToMarkdownSchema = z.object({
  file_path: z.string().describe("Path to the file to convert (relative to /workdir inside the container)"),
  options: z
    .object({
      enableOcr: z.boolean().optional().describe("Enable OCR for images"),
      enableTranscription: z.boolean().optional().describe("Enable audio transcription"),
    })
    .optional(),
});

const callSidecar = async (
  baseUrl: string | undefined,
  method: string,
  params: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!baseUrl) {
    return {
      text: "MarkItDown sidecar not configured. Set MCP_MARKITDOWN_URL in environment variables.",
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
      return { text: `MarkItDown sidecar error: ${errorText}`, isError: true };
    }

    const result = (await response.json()) as { result?: string };
    return { text: result.result ?? JSON.stringify(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Failed to reach MarkItDown sidecar: ${message}`, isError: true };
  }
};

export const createMarkItDownTools = (options: MarkItDownOptions): ToolDefinition[] => {
  return [
    {
      name: "convert-to-markdown",
      description:
        "Convert a file (PDF, DOCX, PPTX, XLSX, HTML, images, audio) to Markdown using Microsoft MarkItDown. " +
        "Preserves document structure and supports OCR for images and transcription for audio.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          options: {
            type: "object",
            properties: {
              enableOcr: { type: "boolean" },
              enableTranscription: { type: "boolean" },
            },
          },
        },
        required: ["file_path"],
      },
      zodSchema: convertToMarkdownSchema,
      category: "documents",
      riskLevel: "low",
      source: "markitdown",
      handler: async (args) => {
        const input = args as z.infer<typeof convertToMarkdownSchema>;
        return callSidecar(options.sidecarUrl, "convert_to_markdown", {
          file_path: input.file_path,
          ...(input.options ?? {}),
        });
      },
    },
  ];
};
