import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { LocalMcpServerManager } from "../local-mcp-server-manager.js";

type FacebookToolsOptions = {
  localServerManager?: LocalMcpServerManager;
};

const emptySchema = z.object({});

const publishPostSchema = z.object({
  message: z.string().describe("Post text content"),
  link: z.string().optional().describe("Optional URL to share"),
});

const conversationMessagesSchema = z.object({
  conversation_id: z.string().describe("Conversation ID"),
  limit: z.number().min(1).max(100).optional(),
});

const sendMessageSchema = z.object({
  recipient_id: z.string().describe("Recipient Page-scoped user ID"),
  message: z.string().max(2000).describe("Message text (max 2000 chars)"),
});

const replyToCommentSchema = z.object({
  comment_id: z.string().describe("Comment ID to reply to"),
  message: z.string().describe("Reply text"),
});

const callLocalServer = async (
  manager: LocalMcpServerManager | undefined,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> => {
  if (!manager) {
    return { text: "Local MCP server manager not configured.", isError: true };
  }
  if (!manager.isRunning("facebook")) {
    return { text: "Facebook MCP server is not running. Check FACEBOOK_PAGE_TOKEN env var.", isError: true };
  }
  return manager.callTool("facebook", toolName, args);
};

export const createFacebookTools = (options: FacebookToolsOptions): ToolDefinition[] => {
  const mgr = options.localServerManager;

  return [
    {
      name: "fb_get_page_info",
      description: "Get Facebook Page profile info (name, followers, category, etc.).",
      inputSchema: { type: "object", properties: {} },
      zodSchema: emptySchema,
      category: "social",
      riskLevel: "low",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_page_info", args),
    },
    {
      name: "fb_get_page_posts",
      description: "Get recent posts from the Facebook Page with engagement metrics.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Number of posts (max 100)" },
          after: { type: "string", description: "Pagination cursor" },
        },
      },
      zodSchema: z.object({ limit: z.number().min(1).max(100).optional(), after: z.string().optional() }),
      category: "social",
      riskLevel: "low",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_page_posts", args),
    },
    {
      name: "fb_get_post_insights",
      description: "Get detailed insights for a specific Facebook post.",
      inputSchema: {
        type: "object",
        properties: { post_id: { type: "string", description: "Facebook post ID" } },
        required: ["post_id"],
      },
      zodSchema: z.object({ post_id: z.string() }),
      category: "social",
      riskLevel: "low",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_post_insights", args),
    },
    {
      name: "fb_publish_post",
      description: "Publish a new post to the Facebook Page.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Post text content" },
          link: { type: "string", description: "Optional URL to share" },
        },
        required: ["message"],
      },
      zodSchema: publishPostSchema,
      category: "social",
      riskLevel: "high",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_publish_post", args),
    },
    {
      name: "fb_get_conversations",
      description: "List Facebook Page Messenger conversations.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", description: "Number of conversations (max 100)" } },
      },
      zodSchema: z.object({ limit: z.number().min(1).max(100).optional() }),
      category: "social",
      riskLevel: "low",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_conversations", args),
    },
    {
      name: "fb_get_conversation_messages",
      description: "Get messages from a Messenger conversation.",
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: { type: "string", description: "Conversation ID" },
          limit: { type: "integer" },
        },
        required: ["conversation_id"],
      },
      zodSchema: conversationMessagesSchema,
      category: "social",
      riskLevel: "low",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_conversation_messages", args),
    },
    {
      name: "fb_send_message",
      description: "Send a Messenger reply to a user (within 24h window).",
      inputSchema: {
        type: "object",
        properties: {
          recipient_id: { type: "string", description: "Recipient Page-scoped user ID" },
          message: { type: "string", description: "Message text (max 2000 chars)" },
        },
        required: ["recipient_id", "message"],
      },
      zodSchema: sendMessageSchema,
      category: "social",
      riskLevel: "high",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_send_message", args),
    },
    {
      name: "fb_get_page_insights",
      description: "Get Page-level analytics (impressions, engaged users, fan adds).",
      inputSchema: {
        type: "object",
        properties: { period: { type: "string", enum: ["day", "week", "days_28"] } },
      },
      zodSchema: z.object({ period: z.enum(["day", "week", "days_28"]).optional() }),
      category: "social",
      riskLevel: "low",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_page_insights", args),
    },
    {
      name: "fb_get_post_comments",
      description: "Get comments on a Facebook Page post.",
      inputSchema: {
        type: "object",
        properties: {
          post_id: { type: "string", description: "Facebook post ID" },
          limit: { type: "integer" },
        },
        required: ["post_id"],
      },
      zodSchema: z.object({ post_id: z.string(), limit: z.number().min(1).max(100).optional() }),
      category: "social",
      riskLevel: "low",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_get_post_comments", args),
    },
    {
      name: "fb_reply_to_comment",
      description: "Reply to a comment on a Facebook Page post.",
      inputSchema: {
        type: "object",
        properties: {
          comment_id: { type: "string", description: "Comment ID to reply to" },
          message: { type: "string", description: "Reply text" },
        },
        required: ["comment_id", "message"],
      },
      zodSchema: replyToCommentSchema,
      category: "social",
      riskLevel: "high",
      source: "facebook",
      handler: async (args) => callLocalServer(mgr, "fb_reply_to_comment", args),
    },
  ];
};
