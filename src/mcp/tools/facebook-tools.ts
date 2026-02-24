import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { LocalMcpServerManager } from "../local-mcp-server-manager.js";

type FacebookToolsOptions = {
  localServerManager?: LocalMcpServerManager;
};

const getPageInfoSchema = z.object({
  page_id: z.string().optional().describe("Facebook Page ID (uses configured page if not provided)"),
});

const getPagePostsSchema = z.object({
  page_id: z.string().optional(),
  limit: z.number().min(1).max(100).optional().describe("Number of posts (default: 25)"),
});

const getPostInsightsSchema = z.object({
  post_id: z.string().describe("Facebook post ID"),
});

const publishPostSchema = z.object({
  page_id: z.string().optional(),
  message: z.string().describe("Post text content"),
  link: z.string().url().optional().describe("URL to attach to the post"),
});

const getConversationsSchema = z.object({
  page_id: z.string().optional(),
  limit: z.number().min(1).max(100).optional(),
});

const getConversationMessagesSchema = z.object({
  conversation_id: z.string().describe("Facebook conversation ID"),
  limit: z.number().min(1).max(100).optional(),
});

const sendMessageSchema = z.object({
  recipient_id: z.string().describe("Facebook user ID of recipient"),
  message: z.string().max(2000).describe("Message text"),
});

const getPageInsightsSchema = z.object({
  page_id: z.string().optional(),
  period: z.enum(["day", "week", "days_28"]).optional(),
});

const callLocalServer = async (
  manager: LocalMcpServerManager | undefined,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!manager) {
    return { text: "Local MCP server manager not configured.", isError: true };
  }
  if (!manager.isRunning("facebook")) {
    return { text: "Facebook MCP server is not running. Check FACEBOOK_PAGE_ACCESS_TOKEN env var.", isError: true };
  }
  return manager.callTool("facebook", toolName, args);
};

export const createFacebookTools = (options: FacebookToolsOptions): ToolDefinition[] => {
  const mgr = options.localServerManager;

  return [
    {
      name: "facebook-get-page-info",
      description: "Get Facebook Page profile information including followers, category, and about.",
      inputSchema: { type: "object", properties: { page_id: { type: "string" } } },
      zodSchema: getPageInfoSchema,
      category: "social",
      riskLevel: "low",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_page_info", args),
    },
    {
      name: "facebook-get-posts",
      description: "Get recent posts from a Facebook Page.",
      inputSchema: { type: "object", properties: { page_id: { type: "string" }, limit: { type: "number" } } },
      zodSchema: getPagePostsSchema,
      category: "social",
      riskLevel: "low",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_page_posts", args),
    },
    {
      name: "facebook-get-post-insights",
      description: "Get engagement insights for a specific Facebook post.",
      inputSchema: { type: "object", properties: { post_id: { type: "string" } }, required: ["post_id"] },
      zodSchema: getPostInsightsSchema,
      category: "social",
      riskLevel: "low",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_post_insights", args),
    },
    {
      name: "facebook-publish-post",
      description: "Publish a new post on a Facebook Page.",
      inputSchema: { type: "object", properties: { page_id: { type: "string" }, message: { type: "string" }, link: { type: "string" } }, required: ["message"] },
      zodSchema: publishPostSchema,
      category: "social",
      riskLevel: "high",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_publish_post", args),
    },
    {
      name: "facebook-get-conversations",
      description: "Get Facebook Page Messenger conversations.",
      inputSchema: { type: "object", properties: { page_id: { type: "string" }, limit: { type: "number" } } },
      zodSchema: getConversationsSchema,
      category: "social",
      riskLevel: "high",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_conversations", args),
    },
    {
      name: "facebook-get-messages",
      description: "Get messages from a specific Facebook conversation.",
      inputSchema: { type: "object", properties: { conversation_id: { type: "string" }, limit: { type: "number" } }, required: ["conversation_id"] },
      zodSchema: getConversationMessagesSchema,
      category: "social",
      riskLevel: "high",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_conversation_messages", args),
    },
    {
      name: "facebook-send-message",
      description: "Send a message via Facebook Page Messenger.",
      inputSchema: { type: "object", properties: { recipient_id: { type: "string" }, message: { type: "string" } }, required: ["recipient_id", "message"] },
      zodSchema: sendMessageSchema,
      category: "social",
      riskLevel: "high",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_send_message", args),
    },
    {
      name: "facebook-get-page-insights",
      description: "Get page-level analytics and insights from Facebook.",
      inputSchema: { type: "object", properties: { page_id: { type: "string" }, period: { type: "string" } } },
      zodSchema: getPageInsightsSchema,
      category: "social",
      riskLevel: "low",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_page_insights", args),
    },
  ];
};
