import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * Gmail MCP tools for reading, searching, drafting, and sending emails.
 *
 * Connects to the Gmail MCP Docker sidecar (GongRzhe/Gmail-MCP-Server)
 * which provides Gmail API access via Google Cloud OAuth 2.0 credentials.
 */

type GmailToolsOptions = {
  sidecarUrl?: string;
};

const gmailSearchSchema = z.object({
  query: z.string().describe("Gmail search query (same syntax as Gmail search bar)"),
  maxResults: z.number().optional().describe("Maximum number of results to return"),
});

const gmailReadSchema = z.object({
  messageId: z.string().describe("Gmail message ID to read"),
});

const gmailDraftSchema = z.object({
  to: z.string().describe("Recipient email address"),
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Email body content"),
  cc: z.string().optional().describe("CC recipients (comma-separated)"),
  bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
});

const gmailSendSchema = z.object({
  to: z.string().describe("Recipient email address"),
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Email body content"),
  cc: z.string().optional().describe("CC recipients (comma-separated)"),
  bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
});

const callSidecar = async (
  baseUrl: string | undefined,
  method: string,
  params: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!baseUrl) {
    return {
      text: "Gmail sidecar not configured. Set MCP_GMAIL_URL in environment variables and ensure Google OAuth credentials are set up.",
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
      return { text: `Gmail sidecar error: ${errorText}`, isError: true };
    }

    const result = (await response.json()) as { result?: string };
    return { text: result.result ?? JSON.stringify(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Failed to reach Gmail sidecar: ${message}`, isError: true };
  }
};

export const createGmailTools = (options: GmailToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "gmail-search",
      description: "Search Gmail messages using Gmail search syntax (e.g., 'from:user@example.com subject:invoice').",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          maxResults: { type: "number" },
        },
        required: ["query"],
      },
      zodSchema: gmailSearchSchema,
      category: "documents",
      riskLevel: "low",
      handler: async (args) => {
        const input = args as z.infer<typeof gmailSearchSchema>;
        return callSidecar(options.sidecarUrl, "gmail_search", input);
      },
    },
    {
      name: "gmail-read",
      description: "Read a specific Gmail message by its ID. Returns subject, from, to, date, and body.",
      inputSchema: {
        type: "object",
        properties: {
          messageId: { type: "string" },
        },
        required: ["messageId"],
      },
      zodSchema: gmailReadSchema,
      category: "documents",
      riskLevel: "low",
      handler: async (args) => {
        const input = args as z.infer<typeof gmailReadSchema>;
        return callSidecar(options.sidecarUrl, "gmail_read", input);
      },
    },
    {
      name: "gmail-draft",
      description: "Create a draft email in Gmail. The email is saved as a draft and NOT sent.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          cc: { type: "string" },
          bcc: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
      zodSchema: gmailDraftSchema,
      category: "documents",
      riskLevel: "medium",
      handler: async (args) => {
        const input = args as z.infer<typeof gmailDraftSchema>;
        return callSidecar(options.sidecarUrl, "gmail_draft", input);
      },
    },
    {
      name: "gmail-send",
      description: "Send an email via Gmail. WARNING: This actually sends the email. Requires human approval.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          cc: { type: "string" },
          bcc: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
      zodSchema: gmailSendSchema,
      category: "documents",
      riskLevel: "high",
      handler: async (args) => {
        const input = args as z.infer<typeof gmailSendSchema>;
        return callSidecar(options.sidecarUrl, "gmail_send", input);
      },
    },
  ];
};
