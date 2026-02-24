import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { LocalMcpServerManager } from "../local-mcp-server-manager.js";

type LinkedInToolsOptions = {
  localServerManager?: LocalMcpServerManager;
};

const getProfileSchema = z.object({});

const getPostsSchema = z.object({
  count: z.number().min(1).max(100).optional().describe("Number of posts (default: 20)"),
});

const createPostSchema = z.object({
  text: z.string().max(3000).describe("Post text content"),
  visibility: z.enum(["PUBLIC", "CONNECTIONS"]).optional(),
});

const getCompanySchema = z.object({
  company_id: z.string().describe("LinkedIn company/organization ID"),
});

const sendMessageSchema = z.object({
  recipient_urn: z.string().describe("LinkedIn member URN (urn:li:person:xxx)"),
  subject: z.string().optional().describe("Message subject"),
  body: z.string().max(8000).describe("Message body text"),
});

const getConversationsSchema = z.object({
  count: z.number().min(1).max(50).optional(),
});

const callLocalServer = async (
  manager: LocalMcpServerManager | undefined,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!manager) {
    return { text: "Local MCP server manager not configured.", isError: true };
  }
  if (!manager.isRunning("linkedin")) {
    return { text: "LinkedIn MCP server is not running. Check LINKEDIN_ACCESS_TOKEN env var.", isError: true };
  }
  return manager.callTool("linkedin", toolName, args);
};

export const createLinkedInTools = (options: LinkedInToolsOptions): ToolDefinition[] => {
  const mgr = options.localServerManager;

  return [
    {
      name: "linkedin-get-profile",
      description: "Get authenticated LinkedIn user profile information.",
      inputSchema: { type: "object", properties: {} },
      zodSchema: getProfileSchema,
      category: "social",
      riskLevel: "low",
      source: "linkedin",
      handler: async (args) => callLocalServer(mgr, "linkedin_get_profile", args),
    },
    {
      name: "linkedin-get-posts",
      description: "Get recent LinkedIn posts from the authenticated user.",
      inputSchema: { type: "object", properties: { count: { type: "number" } } },
      zodSchema: getPostsSchema,
      category: "social",
      riskLevel: "low",
      source: "linkedin",
      handler: async (args) => callLocalServer(mgr, "linkedin_get_posts", args),
    },
    {
      name: "linkedin-create-post",
      description: "Create and publish a post on LinkedIn.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, visibility: { type: "string" } }, required: ["text"] },
      zodSchema: createPostSchema,
      category: "social",
      riskLevel: "high",
      source: "linkedin",
      handler: async (args) => callLocalServer(mgr, "linkedin_create_post", args),
    },
    {
      name: "linkedin-get-company",
      description: "Get LinkedIn company/organization page details.",
      inputSchema: { type: "object", properties: { company_id: { type: "string" } }, required: ["company_id"] },
      zodSchema: getCompanySchema,
      category: "social",
      riskLevel: "low",
      source: "linkedin",
      handler: async (args) => callLocalServer(mgr, "linkedin_get_company", args),
    },
    {
      name: "linkedin-send-message",
      description: "Send a LinkedIn direct message to a connection.",
      inputSchema: { type: "object", properties: { recipient_urn: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["recipient_urn", "body"] },
      zodSchema: sendMessageSchema,
      category: "social",
      riskLevel: "high",
      source: "linkedin",
      handler: async (args) => callLocalServer(mgr, "linkedin_send_message", args),
    },
    {
      name: "linkedin-get-conversations",
      description: "Get recent LinkedIn messaging conversations.",
      inputSchema: { type: "object", properties: { count: { type: "number" } } },
      zodSchema: getConversationsSchema,
      category: "social",
      riskLevel: "high",
      source: "linkedin",
      handler: async (args) => callLocalServer(mgr, "linkedin_get_conversations", args),
    },
  ];
};
